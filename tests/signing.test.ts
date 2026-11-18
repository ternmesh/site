// Signed images (draft/companion.md, "Signed images"; docs/signing.md in ternmesh/firmware): the
// signature check against the specification's vectors, the release keys this site holds, what an
// update offers to nodes of each version, and the feed's check of a release's .sig files.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ed25519 } from "@noble/curves/ed25519.js";

import { hex, unhex } from "../src/lib/companion/protocol.ts";
import { RELEASE_KEYS } from "../src/lib/companion/release-keys.ts";
import { bytesSigned, imageSigned, offerable } from "../src/lib/companion/release.ts";
import { signedMessage, signedState, verifies } from "../src/lib/companion/signing.ts";
import { manifest } from "../src/lib/flash/images.ts";
import type { ManifestImage } from "../src/lib/flash/images.ts";
import { parseSignatures, releaseSignatures } from "../src/lib/flash/signatures.ts";

const v: {
    release_key: string;
    release_seed: string;
    image: string;
    image_digest: string;
    image_signature: string;
    signatures: { why: string; release_key: string; digest: string; message: string; signature: string; verifies: boolean }[];
} = JSON.parse(readFileSync(new URL("./vectors/companion.json", import.meta.url), "utf8"));
const bytes = (h: string) => unhex(h)!;
/** The specification's published test key: only ever handed in here, never held by the site. */
const TEST_KEYS = [v.release_key];
const sha256 = (data: Uint8Array) => new Uint8Array(createHash("sha256").update(data).digest());
const sign = (data: Uint8Array) => ed25519.sign(signedMessage(sha256(data)), bytes(v.release_seed));

test("signatures: each verifies exactly when the specification says", () => {
    assert.ok(v.signatures.length >= 7);
    for (const c of v.signatures) {
        assert.equal(hex(signedMessage(bytes(c.digest))), c.message, c.why);
        assert.equal(verifies(bytes(c.digest), bytes(c.signature), [c.release_key]), c.verifies, c.why);
    }
    // The image's own signature, over the image itself.
    assert.equal(hex(sha256(bytes(v.image))), v.image_digest);
    assert.equal(verifies(bytes(v.image_digest), bytes(v.image_signature), TEST_KEYS), true);
    // A key among others is still found; one that is not a key verifies nothing.
    assert.equal(verifies(bytes(v.image_digest), bytes(v.image_signature), ["00".repeat(32), "zz", v.release_key]), true);
    assert.equal(verifies(bytes(v.image_digest), bytes(v.image_signature), []), false);
});

test("the release keys are Tern's release key 1, and never the specification's test key", () => {
    assert.deepEqual(RELEASE_KEYS, ["09800d79c2c3d0cab7f1710a18cd50d6f0e39c57d9cfe395b371195d4942f88d"]);
    assert.equal(RELEASE_KEYS.includes(v.release_key), false);
    for (const k of RELEASE_KEYS) {
        assert.equal(ed25519.Point.fromBytes(bytes(k), false).isTorsionFree(), true, "a valid key");
    }
    // So an image the test key signed is not taken as the release's.
    assert.equal(verifies(bytes(v.image_digest), bytes(v.image_signature)), false);
    assert.equal(signedState(bytes(v.image_digest), bytes(v.image_signature)), "unverified");
    assert.equal(signedState(bytes(v.image_digest), null), "unsigned");
    assert.equal(signedState(bytes(v.image_digest), bytes(v.image_signature), TEST_KEYS), "verified");
});

test("an image in latest.json is checked before it is downloaded, and again after", async () => {
    const image: ManifestImage = {
        board: "heltec-v3",
        region: "EU868",
        file: "x-app.bin",
        size: 400,
        sha256: v.image_digest,
        signature: v.image_signature,
    };
    assert.equal(imageSigned(image, TEST_KEYS), "verified");
    assert.equal(imageSigned(image), "unverified", "not by a key the site holds");
    assert.equal(imageSigned({ ...image, signature: undefined }, TEST_KEYS), "unsigned");
    assert.equal(imageSigned({ ...image, signature: "nothex" }, TEST_KEYS), "unverified");
    assert.equal(imageSigned({ ...image, sha256: "00".repeat(32) }, TEST_KEYS), "unverified");
    assert.equal(await bytesSigned(bytes(v.image), image, TEST_KEYS), "verified");
    const other = bytes(v.image);
    other[0] ^= 1;
    assert.equal(await bytesSigned(other, image, TEST_KEYS), "unverified");
    assert.equal(await bytesSigned(other, { ...image, signature: undefined }, TEST_KEYS), "unsigned");
});

test("an image with no signature is not offered to a node of version 13 updated over the link", () => {
    // A release from before signing to a node that checks signatures: it would refuse it.
    assert.equal(offerable("unsigned", 13, "link"), false);
    assert.equal(offerable("unsigned", 14, "link"), false);
    // To a node before version 13, and to a bootloader, which check nothing: offered, with a warning.
    assert.equal(offerable("unsigned", 12, "link"), true);
    assert.equal(offerable("unsigned", 14, "bootloader"), true);
    // Signed, but not by a key held here: offered after a warning, which the node may still refuse.
    assert.equal(offerable("unverified", 14, "link"), true);
    assert.equal(offerable("verified", 14, "link"), true);
});

// ----- The feed: tools/firmware.ts's check of a release's .sig files -----

const IMAGES = new Map([
    ["tern-heltec-v3-eu868-1.0.0-app.bin", Uint8Array.of(1, 2, 3)],
    ["tern-heltec-t114-eu868-1.0.0.zip", Uint8Array.of(4, 5, 6, 7)],
]);
const SUMS_FILE = new TextEncoder().encode(
    [...IMAGES].map(([name, data]) => `${hex(sha256(data))}  ${name}\n`).join(""),
);
const SUMS = new Map([...IMAGES].map(([name, data]) => [name, hex(sha256(data))]));
const NAMES = [...IMAGES.keys()];

/** A release's files as the feed fetches them: null for one it does not have. */
function release(files: Map<string, Uint8Array>) {
    const asked: string[] = [];
    const fetchFile = async (name: string) => {
        asked.push(name);
        return files.get(name) ?? null;
    };
    return { fetchFile, asked };
}
function signedRelease(): Map<string, Uint8Array> {
    const files = new Map<string, Uint8Array>([["SHA256SUMS.sig", sign(SUMS_FILE)]]);
    for (const [name, data] of IMAGES) {
        files.set(`${name}.sig`, sign(data));
    }
    return files;
}

test("feed: a signed release's signatures are each checked, and given in latest.json", async () => {
    const { fetchFile } = release(signedRelease());
    const sigs = await releaseSignatures(NAMES, SUMS, SUMS_FILE, fetchFile, TEST_KEYS);
    assert.ok(sigs);
    assert.deepEqual([...sigs.keys()].sort(), ["SHA256SUMS", ...NAMES].sort());
    const latest = await manifest(
        "1.0.0",
        [
            { board: "heltec-v3", regions: ["eu868"], update: "link" },
            { board: "heltec-t114", regions: ["eu868"], update: "bootloader" },
        ],
        IMAGES,
        sigs,
    );
    for (const i of latest.images) {
        assert.match(i.signature!, /^[0-9a-f]{128}$/);
        assert.equal(i.signature, hex(sigs.get(i.file)!));
        assert.equal(imageSigned(i, TEST_KEYS), "verified", i.file);
    }
});

test("feed: a signed release with a .sig missing, short, or by another key fails", async () => {
    const missing = signedRelease();
    missing.delete(`${NAMES[1]}.sig`);
    await assert.rejects(releaseSignatures(NAMES, SUMS, SUMS_FILE, release(missing).fetchFile, TEST_KEYS), /no signature for /);

    const short = signedRelease();
    short.set(`${NAMES[0]}.sig`, short.get(`${NAMES[0]}.sig`)!.subarray(0, 63));
    await assert.rejects(releaseSignatures(NAMES, SUMS, SUMS_FILE, release(short).fetchFile, TEST_KEYS), /63 bytes/);

    const swapped = signedRelease();
    swapped.set(`${NAMES[0]}.sig`, swapped.get(`${NAMES[1]}.sig`)!);
    await assert.rejects(releaseSignatures(NAMES, SUMS, SUMS_FILE, release(swapped).fetchFile, TEST_KEYS), /does not verify/);

    // Signed with the test key, which the site does not hold: refused with its own keys.
    await assert.rejects(releaseSignatures(NAMES, SUMS, SUMS_FILE, release(signedRelease()).fetchFile), /release-keys\.ts/);

    // Images signed but SHA256SUMS not: still a signed release, and SHA256SUMS's is missing.
    const noSums = signedRelease();
    noSums.delete("SHA256SUMS.sig");
    await assert.rejects(releaseSignatures(NAMES, SUMS, SUMS_FILE, release(noSums).fetchFile, TEST_KEYS), /no signature for SHA256SUMS/);
});

/** The same release with its signatures in one SIGNATURES file, as releases from 0.7.0-alpha.1 carry them. */
function listedRelease(edit: (lines: string[]) => string[] = (l) => l): Map<string, Uint8Array> {
    const lines = [`${hex(sign(SUMS_FILE))}  SHA256SUMS`];
    for (const [name, data] of IMAGES) {
        lines.push(`${hex(sign(data))}  ${name}`);
    }
    return new Map([["SIGNATURES", new TextEncoder().encode(edit(lines).join("\n") + "\n")]]);
}

test("feed: a release's SIGNATURES file gives every signature, with no .sig fetched", async () => {
    const { fetchFile, asked } = release(listedRelease());
    const sigs = await releaseSignatures(NAMES, SUMS, SUMS_FILE, fetchFile, TEST_KEYS);
    assert.ok(sigs);
    assert.deepEqual([...sigs.keys()].sort(), ["SHA256SUMS", ...NAMES].sort());
    assert.deepEqual(asked, ["SIGNATURES"], "one file, and no .sig");
    const per = await releaseSignatures(NAMES, SUMS, SUMS_FILE, release(signedRelease()).fetchFile, TEST_KEYS);
    for (const name of NAMES) {
        assert.equal(hex(sigs.get(name)!), hex(per!.get(name)!), name);
    }
});

test("feed: a SIGNATURES file missing a line, malformed, or naming a file twice fails", async () => {
    const missing = listedRelease((l) => l.filter((x) => !x.endsWith(`  ${NAMES[1]}`)));
    await assert.rejects(releaseSignatures(NAMES, SUMS, SUMS_FILE, release(missing).fetchFile, TEST_KEYS), /no signature for /);
    const other = (l: string[]) => l.find((y) => y.endsWith(`  ${NAMES[1]}`))!.slice(0, 128);
    const swapped = listedRelease((l) => l.map((x) => (x.endsWith(`  ${NAMES[0]}`) ? `${other(l)}  ${NAMES[0]}` : x)));
    await assert.rejects(releaseSignatures(NAMES, SUMS, SUMS_FILE, release(swapped).fetchFile, TEST_KEYS), /does not verify/);
    assert.throws(() => parseSignatures(new TextEncoder().encode("abc  x\n")), /not a signature and a name/);
    const line = `${"0".repeat(128)}  x`;
    assert.throws(() => parseSignatures(new TextEncoder().encode(`${line}\n${line}\n`)), /twice/);
});

test("feed: a release from before signing has none, and latest.json is as it was", async () => {
    const { fetchFile, asked } = release(new Map());
    assert.equal(await releaseSignatures(NAMES, SUMS, SUMS_FILE, fetchFile, TEST_KEYS), null);
    assert.deepEqual(asked, ["SIGNATURES", "SHA256SUMS.sig", `${NAMES[0]}.sig`], "three looks, and no more");
    const boards = [{ board: "heltec-v3", regions: ["eu868" as const], update: "link" as const }];
    const latest = await manifest("1.0.0", boards, IMAGES);
    assert.equal("signature" in latest.images[0]!, false);
    assert.equal(
        JSON.stringify(latest),
        JSON.stringify({
            release: "1.0.0",
            images: [{ board: "heltec-v3", region: "EU868", file: NAMES[0], size: 3, sha256: SUMS.get(NAMES[0]) }],
        }),
    );
});
