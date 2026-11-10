/** Protocol identifier carried in every signed QAPS object. Bump on any breaking format change. */
export const PROTOCOL = "kept-qaps/1";

/** Lowercase hex SHA-256. */
export const HEX64 = /^[0-9a-f]{64}$/;

/** verifier-a, verifier-b, … for a panel of n verifiers. */
export function verifierIds(n: number): string[] {
  if (!Number.isInteger(n) || n < 1 || n > 26) throw new RangeError(`panel size ${n} out of range`);
  return Array.from({ length: n }, (_, i) => `verifier-${String.fromCharCode(97 + i)}`);
}
