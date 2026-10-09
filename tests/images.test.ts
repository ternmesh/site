import assert from "node:assert/strict";
import { test } from "node:test";

import {
    check,
    imageName,
    imageNames,
    layoutOf,
    manifest,
    NVS,
    parseSums,
    sha256,
    sparesNvs,
    writes,
} from "../src/lib/flash/images.ts";

const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

test("an image's name is the release's", () => {
    assert.equal(imageName("0.1.0-alpha.1", "us915", "whole"), "tern-heltec-v3-us915-0.1.0-alpha.1.bin");
    assert.equal(imageName("0.1.0-alpha.1", "eu868", "app"), "tern-heltec-v3-eu868-0.1.0-alpha.1-app.bin");
    assert.equal(imageName("1.0.0", "eu868", "boot"), "tern-heltec-v3-eu868-1.0.0-boot.bin");
    assert.equal(imageName("1.0.0", "us915", "update"), "tern-heltec-v3-us915-1.0.0-update.bin");
    assert.equal(imageNames("1.0.0", "ota").length, 8);
    assert.equal(imageNames("1.0.0", "single").length, 4);
});

test("a release's layout is what its checksums name", () => {
    const names = (layout: "ota" | "single") =>
        parseSums(imageNames("1.0.0", layout).map((n) => `${abc}  ${n}`).join("\n"));
    assert.equal(layoutOf("1.0.0", names("ota")), "ota");
    assert.equal(layoutOf("1.0.0", names("single")), "single");
    assert.equal(layoutOf("2.0.0", names("ota")), "single");
});

test("an update writes the bootloader and everything after NVS, in one go", () => {
    assert.deepEqual(writes("1.0.0", "us915", "new", "ota"), [{ name: "tern-heltec-v3-us915-1.0.0.bin", address: 0 }]);
    assert.deepEqual(writes("1.0.0", "eu868", "update", "ota"), [
        { name: "tern-heltec-v3-eu868-1.0.0-boot.bin", address: 0 },
        { name: "tern-heltec-v3-eu868-1.0.0-update.bin", address: 0xf000 },
    ]);
    assert.deepEqual(writes("0.1.0-alpha.4", "eu868", "update", "single"), [
        { name: "tern-heltec-v3-eu868-0.1.0-alpha.4-app.bin", address: 0x10000 },
    ]);
});

test("an update that would reach NVS is refused", () => {
    sparesNvs("boot", 0, NVS.start);
    sparesNvs("update", NVS.end, 0x400000);
    sparesNvs("app", 0x10000, 0x200000);
    assert.throws(() => sparesNvs("boot", 0, NVS.start + 1), /keys/);
    assert.throws(() => sparesNvs("update", NVS.end - 0x1000, 0x2000), /keys/);
    assert.throws(() => sparesNvs("whole", 0, 0x800000), /keys/);
});

test("latest.json names each region's app image, its size and its SHA-256", async () => {
    const abcd = new TextEncoder().encode("abcd");
    const images = new Map([
        ["tern-heltec-v3-us915-1.0.0-app.bin", new TextEncoder().encode("abc")],
        ["tern-heltec-v3-eu868-1.0.0-app.bin", abcd],
        ["tern-heltec-v3-eu868-1.0.0.bin", new Uint8Array(8)],
    ]);
    assert.deepEqual(await manifest("1.0.0", images), {
        release: "1.0.0",
        images: [
            {
                board: "heltec-v3",
                region: "EU868",
                file: "tern-heltec-v3-eu868-1.0.0-app.bin",
                size: 4,
                sha256: await sha256(abcd),
            },
            { board: "heltec-v3", region: "US915", file: "tern-heltec-v3-us915-1.0.0-app.bin", size: 3, sha256: abc },
        ],
    });
    images.delete("tern-heltec-v3-us915-1.0.0-app.bin");
    await assert.rejects(manifest("1.0.0", images), /needs tern-heltec-v3-us915-1.0.0-app.bin/);
});

test("checksums are read as sha256sum and shasum write them", () => {
    const sums = parseSums(`${abc}  a.bin\n${abc} *b.bin\n\n`);
    assert.equal(sums.get("a.bin"), abc);
    assert.equal(sums.get("b.bin"), abc);
    assert.throws(() => parseSums("<html>Not Found</html>\n"));
    assert.throws(() => parseSums(`${abc.slice(1)}  a.bin\n`));
});

test("an image that is not the release's is refused", async () => {
    const data = new TextEncoder().encode("abc");
    assert.equal(await sha256(data), abc);
    const sums = parseSums(`${abc}  a.bin\n`);
    await check("a.bin", data, sums);
    await assert.rejects(check("a.bin", new TextEncoder().encode("abd"), sums), /not the release's/);
    await assert.rejects(check("c.bin", data, sums), /does not name/);
});
