import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getParty, type Party } from "../core/jobs.js";
import type { Db } from "../db/client.js";

/**
 * Party tokens for the REST API (and the MCP server, T4.1).
 *
 * A token is `<party_id>.<hex HMAC-SHA256(MCP_AUTH_TOKEN, "kept-party:" + party_id)>`.
 * Nothing is stored: the server recomputes the HMAC. Print one with
 * `npm run party-token -- <party_id>`. Rotating MCP_AUTH_TOKEN revokes every token.
 */

const mac = (secret: string, partyId: string) => createHmac("sha256", secret).update(`kept-party:${partyId}`).digest("hex");

export function partyToken(secret: string, partyId: string): string {
  return `${partyId}.${mac(secret, partyId)}`;
}

/** Returns the party ID a token belongs to, or undefined. Constant-time comparison. */
export function partyFromToken(secret: string, token: string): string | undefined {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const partyId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(mac(secret, partyId), "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected) ? partyId : undefined;
}

declare module "express-serve-static-core" {
  interface Request {
    party?: Party;
  }
}

/** Express middleware: requires `Authorization: Bearer <party token>` and sets req.party. */
export function requireParty(db: Db, secret: string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!secret) {
      res.status(503).json({ error: "Writes are disabled: set MCP_AUTH_TOKEN, then get party tokens with `npm run party-token -- <party_id>`." });
      return;
    }
    const m = /^Bearer (\S+)$/.exec(req.get("authorization") ?? "");
    const partyId = m ? partyFromToken(secret, m[1]!) : undefined;
    const party = partyId ? getParty(db, partyId) : undefined;
    if (!party) {
      res.status(401).set("WWW-Authenticate", 'Bearer realm="kept"').json({ error: "missing or invalid party token" });
      return;
    }
    req.party = party;
    next();
  };
}
