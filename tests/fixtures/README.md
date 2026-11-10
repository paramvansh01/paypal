# Test fixtures

`ct-inclusion-probes.json` is converted (base64 → hex, one file) from the
inclusion-proof probes in https://github.com/transparency-dev/merkle
(`testdata/inclusion`), the Certificate Transparency Merkle tree reference
implementation. Copyright Google LLC, licensed under Apache License 2.0.
Leaf inputs and root hashes in `tests/merkle.test.ts` come from the same
repository (`testonly/constants.go`).
