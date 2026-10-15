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
    regionsOf,
    sha256,
    sparesNvs,
    uf2Name,
    writes,
} from "../src/lib/flash/images.ts";

const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

const v3 = "heltec-v3";

test("an image's name is the release's, with its board", () => {
    assert.equal(imageName("0.1.0-alpha.1", v3, "us915", "whole"), "tern-heltec-v3-us915-0.1.0-alpha.1.bin");
    assert.equal(imageName("0.1.0-alpha.1", v3, "eu868", "app"), "tern-heltec-v3-eu868-0.1.0-alpha.1-app.bin");
    assert.equal(imageName("1.0.0", v3, "eu868", "boot"), "tern-heltec-v3-eu868-1.0.0-boot.bin");
    assert.equal(imageName("1.0.0", "lilygo-tbeam12", "us915", "update"), "tern-lilygo-tbeam12-us915-1.0.0-update.bin");
    assert.equal(uf2Name("1.0.0", "rak4631", "eu868"), "tern-rak4631-eu868-1.0.0.uf2");
    assert.equal(imageNames("1.0.0", v3, "ota", ["us915", "eu868"]).length, 8);
    assert.equal(imageNames("1.0.0", v3, "single", ["us915", "eu868"]).length, 4);
    assert.equal(imageNames("1.0.0", "heltec-v4", "ota", ["au915", "eu868", "nz915", "us915"]).length, 16);
});

const sumsOf = (names: string[]) => parseSums(names.map((n) => `${abc}  ${n}`).join("\n"));

test("a release offers a board the regions its checksums name for that board, and no others", () => {
    const sums = (regions: ("au915" | "eu868" | "nz915" | "us915")[]) => sumsOf(imageNames("1.0.0", v3, "ota", regions));
    assert.deepEqual(regionsOf("1.0.0", v3, "esp32", sums(["us915", "eu868"])), ["eu868", "us915"]);
    assert.deepEqual(regionsOf("1.0.0", v3, "esp32", sums(["au915", "eu868", "nz915", "us915"])), [
        "au915",
        "eu868",
        "nz915",
        "us915",
    ]);
    assert.deepEqual(regionsOf("2.0.0", v3, "esp32", sums(["us915"])), []);
    assert.deepEqual(regionsOf("1.0.0", "heltec-v4", "esp32", sums(["us915"])), []);
});

test("a UF2 board's regions are those its .uf2 files are named for", () => {
    const sums = sumsOf([uf2Name("1.0.0", "heltec-t114", "us915"), uf2Name("1.0.0", "rak4631", "eu868")]);
    assert.deepEqual(regionsOf("1.0.0", "heltec-t114", "uf2", sums), ["us915"]);
    assert.deepEqual(regionsOf("1.0.0", "rak4631", "uf2", sums), ["eu868"]);
    assert.deepEqual(regionsOf("1.0.0", "rak4631", "esp32", sums), []);
});

test("a board's layout is what its checksums name", () => {
    const names = (layout: "ota" | "single") => sumsOf(imageNames("1.0.0", v3, layout, ["us915", "eu868"]));
    assert.equal(layoutOf("1.0.0", v3, names("ota")), "ota");
    assert.equal(layoutOf("1.0.0", v3, names("single")), "single");
    assert.equal(layoutOf("2.0.0", v3, names("ota")), "single");
    assert.equal(layoutOf("1.0.0", "heltec-v4", names("ota")), "single");
});

test("an update writes the bootloader and everything after NVS, in one go, on any ESP32 board", () => {
    assert.deepEqual(writes("1.0.0", v3, "us915", "new", "ota"), [{ name: "tern-heltec-v3-us915-1.0.0.bin", address: 0 }]);
    assert.deepEqual(writes("1.0.0", v3, "eu868", "update", "ota"), [
        { name: "tern-heltec-v3-eu868-1.0.0-boot.bin", address: 0 },
        { name: "tern-heltec-v3-eu868-1.0.0-update.bin", address: 0xf000 },
    ]);
    assert.deepEqual(writes("1.0.0", "lilygo-t3-v161", "eu868", "update", "ota"), [
        { name: "tern-lilygo-t3-v161-eu868-1.0.0-boot.bin", address: 0 },
        { name: "tern-lilygo-t3-v161-eu868-1.0.0-update.bin", address: 0xf000 },
    ]);
    assert.deepEqual(writes("0.1.0-alpha.4", v3, "eu868", "update", "single"), [
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

test("latest.json names each board's app image for each region, its size and its SHA-256", async () => {
    const abcd = new TextEncoder().encode("abcd");
    const images = new Map([
        ["tern-heltec-v3-us915-1.0.0-app.bin", new TextEncoder().encode("abc")],
        ["tern-heltec-v3-eu868-1.0.0-app.bin", abcd],
        ["tern-heltec-v3-eu868-1.0.0.bin", new Uint8Array(8)],
        ["tern-heltec-v4-eu868-1.0.0-app.bin", abcd],
    ]);
    const boards = [
        { board: "heltec-v4", regions: ["eu868" as const] },
        { board: "heltec-v3", regions: ["us915" as const, "eu868" as const] },
    ];
    assert.deepEqual(await manifest("1.0.0", boards, images), {
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
            {
                board: "heltec-v4",
                region: "EU868",
                file: "tern-heltec-v4-eu868-1.0.0-app.bin",
                size: 4,
                sha256: await sha256(abcd),
            },
        ],
    });
    images.delete("tern-heltec-v3-us915-1.0.0-app.bin");
    await assert.rejects(manifest("1.0.0", boards, images), /needs tern-heltec-v3-us915-1.0.0-app.bin/);
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
