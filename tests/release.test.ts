// Which firmware the site offers a node: Semantic Versioning's order, and the image for its board
// and region, and the way it takes one, in latest.json.
import assert from "node:assert/strict";
import { test } from "node:test";

import { compareVersions, fetchImage, imageFor, offerFor, readManifest } from "../src/lib/companion/release.ts";

test("versions are in Semantic Versioning's order", () => {
    // SemVer 2.0.0, section 11's own example, in order.
    const order = [
        "1.0.0-alpha",
        "1.0.0-alpha.1",
        "1.0.0-alpha.beta",
        "1.0.0-beta",
        "1.0.0-beta.2",
        "1.0.0-beta.11",
        "1.0.0-rc.1",
        "1.0.0",
        "1.0.1",
        "1.10.0",
    ];
    for (let i = 0; i < order.length; i++) {
        for (let j = 0; j < order.length; j++) {
            assert.equal(Math.sign(compareVersions(order[i]!, order[j]!)), Math.sign(i - j), `${order[i]} ${order[j]}`);
        }
    }
    assert.equal(compareVersions("0.3.0-alpha.1", "0.2.0"), 1);
    assert.equal(compareVersions("1.0.0+build", "1.0.0"), 0);
    // A node that names no release can be offered any.
    assert.equal(compareVersions("0.1.0", ""), 1);
});

const manifest = readManifest({
    release: "0.3.0",
    images: [
        { board: "heltec-v3", region: "EU868", file: "tern-heltec-v3-eu868-0.3.0-app.bin", size: 3, sha256: "a".repeat(64) },
        { board: "heltec-v3", region: "US915", file: "../escape", size: 3, sha256: "b".repeat(64) },
        {
            board: "heltec-t114",
            region: "US915",
            file: "tern-heltec-t114-us915-0.3.0.zip",
            size: 3,
            sha256: "c".repeat(64),
            update: "bootloader",
        },
        { board: "heltec-t114", region: "EU868", file: "t.zip", size: 3, sha256: "d".repeat(64), update: "radio" },
    ],
});

test("the image is the one for the node's board and region, and none for a node with no board", () => {
    assert.equal(manifest.images.length, 2, "a file that is not a name in /firmware/ is not read, nor a way not known");
    assert.equal(imageFor(manifest, "heltec-v3", "eu868")?.file, "tern-heltec-v3-eu868-0.3.0-app.bin");
    assert.equal(imageFor(manifest, "heltec-v3", "US915"), null);
    assert.equal(imageFor(manifest, "", "EU868"), null);
    assert.throws(() => readManifest({ images: [] }));
});

test("a node updated by its bootloader is given its package, and one updated over the link never is", () => {
    assert.equal(imageFor(manifest, "heltec-t114", "US915", "bootloader")?.file, "tern-heltec-t114-us915-0.3.0.zip");
    assert.equal(imageFor(manifest, "heltec-t114", "US915"), null, "an entry without update is the link's");
    assert.equal(imageFor(manifest, "heltec-v3", "EU868", "bootloader"), null);
    assert.equal(imageFor(manifest, "heltec-t114", "EU868", "bootloader"), null);
});

function site(files: Record<string, Uint8Array | object>): typeof fetch {
    return (async (url: string) => {
        const body = files[url];
        if (body === undefined) {
            return new Response("", { status: 404 });
        }
        return new Response(body instanceof Uint8Array ? new Blob([body as Uint8Array<ArrayBuffer>]) : JSON.stringify(body));
    }) as typeof fetch;
}

test("a newer release is offered, and an image is checked before it is given", async () => {
    const data = Uint8Array.of(1, 2, 3);
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (b) =>
        b.toString(16).padStart(2, "0"),
    ).join("");
    const image = { board: "heltec-v3", region: "EU868", file: "x-app.bin", size: 3, sha256: sha };
    const fetcher = site({ "/firmware/latest.json": { release: "0.3.0", images: [image] }, "/firmware/x-app.bin": data });
    assert.deepEqual(await offerFor("heltec-v3", "EU868", "0.2.0", "link", fetcher), { release: "0.3.0", image });
    assert.equal(await offerFor("heltec-v3", "EU868", "0.3.0", "link", fetcher), null);
    assert.equal(await offerFor("heltec-v3", "EU868", "0.2.0", "link", site({})), null, "no latest.json, nothing to send");
    assert.equal(await offerFor("heltec-v3", "EU868", "0.2.0", "bootloader", fetcher), null);
    assert.deepEqual(await fetchImage(image as never, fetcher), data);
    await assert.rejects(fetchImage({ ...image, sha256: "0".repeat(64) } as never, fetcher));
    await assert.rejects(fetchImage({ ...image, size: 4 } as never, fetcher));
});
