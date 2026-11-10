import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Deliverables are untrusted. A page could make our verifier's browser call
 * internal addresses (cloud metadata at 169.254.169.254, localhost admin
 * ports, the private network). Every URL the browser requests is checked here.
 *
 * Two layers use these rules for local browsers: a Playwright route handler,
 * and the egress proxy (egress-proxy.ts), which also sees every redirect hop
 * and connects only to the address it checked (so DNS rebinding fails).
 * Cloud (KERNEL) browsers run outside our network.
 */

const blocked = new BlockList();
// IPv4
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
// IPv6
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["2001:db8::", 32], // documentation
  ["64:ff9b::", 96], // NAT64 (maps to IPv4, checked separately below)
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** True if this IP literal must never be contacted by a verifier. */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped / -translated forms: check the embedded IPv4 address.
    const embedded = lower.match(/^(?:::ffff:(?:0:)?|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (embedded) return isBlockedIp(embedded);
    const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const n = (parseInt(hexMapped[1]!, 16) << 16) | parseInt(hexMapped[2]!, 16);
      return isBlockedIp([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
    }
    return blocked.check(ip, "ipv6");
  }
  return true; // not an IP at all: refuse rather than guess
}

export interface NetworkPolicy {
  /** Origins allowed even if private, e.g. our own demo sites ("http://localhost:3000"). */
  allowOrigins: readonly string[];
  /** DNS resolver; injectable for tests. Returns every address for the host. */
  resolve?: (hostname: string) => Promise<string[]>;
}

export type UrlCheck = { ok: true } | { ok: false; reason: string };

const defaultResolve = async (hostname: string) => (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export async function checkUrl(raw: string, policy: NetworkPolicy): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: `${url.protocol} URLs are not allowed` };
  if (url.username || url.password) return { ok: false, reason: "URLs with credentials are not allowed" };
  if (policy.allowOrigins.includes(url.origin)) return { ok: true };

  // WHATWG URL parsing already normalises tricks like http://2130706433/ and http://0x7f.1/ to 127.0.0.1.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    return isBlockedIp(host) ? { ok: false, reason: `${host} is a private or reserved address` } : { ok: true };
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: `${host} is a local hostname` };
  }
  let addresses: string[];
  try {
    addresses = await (policy.resolve ?? defaultResolve)(host);
  } catch {
    return { ok: false, reason: `${host} does not resolve` };
  }
  if (addresses.length === 0) return { ok: false, reason: `${host} does not resolve` };
  const bad = addresses.find(isBlockedIp);
  return bad ? { ok: false, reason: `${host} resolves to private address ${bad}` } : { ok: true };
}

/** True if a cloud browser could reach this URL (i.e. it is not on our machine or network). */
export function isPubliclyReachable(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) return !isBlockedIp(host);
    return !(host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"));
  } catch {
    return false;
  }
}
