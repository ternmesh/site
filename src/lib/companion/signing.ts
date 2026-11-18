// Signed images, as draft/companion.md ("Signed images") in ternmesh/spec has them: an image's
// signature is Ed25519 (RFC 8032, not prehashed) by a release key over the 48 bytes
// "TERN-FIRMWARE-V1" || SHA-256(image), the image exactly as published. The firmware publishes it
// beside each file as <file>.sig, the 64 bytes alone, and the site's latest.json carries it as
// `signature`, 128 hex digits (docs/signing.md in ternmesh/firmware).
//
// Verification is @noble/curves', in RFC 8032's strict mode (not ZIP-215): a signature whose S is
// not less than the group order, or that is not 64 bytes, does not verify.

import { ed25519 } from "@noble/curves/ed25519.js";

import { RELEASE_KEYS } from "./release-keys.ts";
import { unhex } from "./protocol.ts";

export const SIGNATURE_LEN = 64;
const PREFIX = new TextEncoder().encode("TERN-FIRMWARE-V1");

/** The 48 bytes a release key signs for an image whose SHA-256 is `digest`. */
export function signedMessage(digest: Uint8Array): Uint8Array {
    if (digest.length !== 32) {
        throw new Error("a SHA-256 is 32 bytes");
    }
    const m = new Uint8Array(PREFIX.length + 32);
    m.set(PREFIX);
    m.set(digest, PREFIX.length);
    return m;
}

/**
 * Whether `signature` verifies over the image whose SHA-256 is `digest` with one of `keys` (hex),
 * the release keys by default. Anything that is not a signature, or a key that is not one, verifies
 * nothing.
 */
export function verifies(
    digest: Uint8Array,
    signature: Uint8Array | null,
    keys: readonly string[] = RELEASE_KEYS,
): boolean {
    if (!signature || signature.length !== SIGNATURE_LEN || digest.length !== 32) {
        return false;
    }
    const message = signedMessage(digest);
    return keys.some((k) => {
        const key = unhex(k);
        if (!key || key.length !== 32) {
            return false;
        }
        try {
            return ed25519.verify(signature, message, key, { zip215: false });
        } catch {
            return false;
        }
    });
}

/**
 * What can be said of an image before it is sent: `verified` by a release key; `unverified`,
 * signed, but not by a key held here (or not over this image); `unsigned`, with no signature at all,
 * as every release before signing (0.6.0-alpha.1 and earlier).
 */
export type Signed = "verified" | "unverified" | "unsigned";

export function signedState(
    digest: Uint8Array,
    signature: Uint8Array | null,
    keys: readonly string[] = RELEASE_KEYS,
): Signed {
    if (!signature || signature.length === 0) {
        return "unsigned";
    }
    return verifies(digest, signature, keys) ? "verified" : "unverified";
}
