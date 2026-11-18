// The release keys: the Ed25519 public keys of whoever publishes Tern's firmware, which an image
// must be signed by (draft/companion.md, "Signed images", in ternmesh/spec). The same list as
// ports/node/release_keys.h in ternmesh/firmware, which a node is built with, and docs/signing.md
// there says how a key is made and changed.
//
// The app (/app), the flash page and the feed (tools/firmware.ts) all read this one list. A key
// is changed as the firmware changes it: a release adds the new key beside the old, later ones are
// signed with the new, and a later one still drops the old. Adding one is one line here: its 64
// hex digits, lower case, with a comment saying when it was added, above the others.
//
// The specification's test key (vectors/companion.json's release_key), whose private half anyone
// can read, never goes here: the tests hand it in themselves.
export const RELEASE_KEYS: readonly string[] = [
    // Release key 1, added 2026-11-18 (ternmesh/firmware#120).
    "09800d79c2c3d0cab7f1710a18cd50d6f0e39c57d9cfe395b371195d4942f88d",
];
