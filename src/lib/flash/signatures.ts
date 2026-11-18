// A release's signatures, as tools/firmware.ts checks them before the site offers its images:
// for each file F a signed release carries, the 64 bytes of an Ed25519 signature by a release key
// over "TERN-FIRMWARE-V1" || SHA-256(F) (docs/signing.md in ternmesh/firmware; draft/companion.md,
// "Signed images", in ternmesh/spec). SHA256SUMS is signed too.
//
// A release lists them in one file, SIGNATURES: a line for each file, the signature as 128
// lower-case hex digits, two spaces and the file's name, as SHA256SUMS lists digests. A .sig beside
// every file would put a release over GitHub's limits. A release may instead have F.sig beside each
// F, the 64 bytes alone, as the first signed build did; both are read.
//
// A release is signed if it has SIGNATURES, SHA256SUMS.sig, or the first image's .sig: releases up
// to 0.6.0-alpha.1 were published before signing, carry none, and are offered as before. A release
// that is signed must be signed throughout: a signature that is missing, or does not verify with a
// key in src/lib/companion/release-keys.ts, fails the build, and the site goes on offering the
// release it offered before.

import { unhex } from "../companion/protocol.ts";
import { RELEASE_KEYS } from "../companion/release-keys.ts";
import { SIGNATURE_LEN, verifies } from "../companion/signing.ts";

/** Fetches a file of the release: null if the release has no such file, and throws for anything else. */
export type Fetch = (name: string) => Promise<Uint8Array | null>;

/**
 * The signatures of `names`, by name, and SHA256SUMS's, each checked against `sums` and the
 * release keys; or null for a release from before signing, which has none. Throws if the release
 * is signed and a signature is missing or does not verify.
 */
export async function releaseSignatures(
    names: readonly string[],
    sums: Map<string, string>,
    sumsFile: Uint8Array,
    fetchFile: Fetch,
    keys: readonly string[] = RELEASE_KEYS,
): Promise<Map<string, Uint8Array> | null> {
    const list = await fetchFile("SIGNATURES");
    const listed = list === null ? null : parseSignatures(list);
    const sigOf = async (name: string) => (listed ? (listed.get(name) ?? null) : fetchFile(`${name}.sig`));
    const sumsSig = await sigOf("SHA256SUMS");
    if (listed === null && sumsSig === null && (names.length === 0 || (await fetchFile(`${names[0]}.sig`)) === null)) {
        return null;
    }
    const signatures = new Map<string, Uint8Array>();
    const sumsDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", sumsFile as Uint8Array<ArrayBuffer>));
    signatures.set("SHA256SUMS", checked("SHA256SUMS", sumsDigest, sumsSig, keys));
    for (const name of names) {
        const digest = sums.get(name);
        if (!digest) {
            throw new Error(`SHA256SUMS does not name ${name}`);
        }
        signatures.set(name, checked(name, unhex(digest)!, await sigOf(name), keys));
    }
    return signatures;
}

/**
 * SIGNATURES's lines, by file name: each the signature as 128 lower-case hex digits, two spaces and
 * the name. Throws on a line that is not one, or a name listed twice.
 */
export function parseSignatures(file: Uint8Array): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    for (const line of new TextDecoder().decode(file).split("\n")) {
        if (line === "") {
            continue;
        }
        const m = /^([0-9a-f]{128}) {2}(\S+)$/.exec(line);
        if (!m) {
            throw new Error(`SIGNATURES has a line that is not a signature and a name: ${JSON.stringify(line)}`);
        }
        if (out.has(m[2]!)) {
            throw new Error(`SIGNATURES lists ${m[2]} twice`);
        }
        out.set(m[2]!, unhex(m[1]!)!);
    }
    return out;
}

function checked(name: string, digest: Uint8Array, sig: Uint8Array | null, keys: readonly string[]): Uint8Array {
    if (sig === null) {
        throw new Error(`the release is signed, but has no signature for ${name}: it is not offered`);
    }
    if (sig.length !== SIGNATURE_LEN) {
        throw new Error(`${name}'s signature is ${sig.length} bytes, not ${SIGNATURE_LEN}: it is not offered`);
    }
    if (!verifies(digest, sig, keys)) {
        throw new Error(
            `${name}'s signature does not verify with a release key in src/lib/companion/release-keys.ts: ` +
                "the release is not offered. If the firmware's key has changed, add the new one there.",
        );
    }
    return sig;
}
