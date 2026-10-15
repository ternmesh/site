// Fetches the firmware release the site offers (src/data/firmware.json) into public/firmware/,
// checked against the release's own SHA256SUMS. It runs before every build: the flash page
// reads the images from this site, since a browser may not read them from GitHub.
//
//     node tools/firmware.ts
//
// It fetches the images of every board src/data/boards.ts lists that the release carries: for an
// ESP32 board each region's .bin and, in the OTA layout, its -boot, -update and -app parts; for an
// nRF52840 board each region's .uf2. A release from before the OTA layout (up to 0.1.0-alpha.4)
// has no -boot.bin or -update.bin, and its SHA256SUMS says so. latest.json, the manifest the Tern
// phone apps read to update a node over Bluetooth, names the -app.bin of every ESP32 board in the
// OTA layout; a release with none has no latest.json.
//
// TERN_FIRMWARE_DIR, if set, is a directory to copy them from instead: the release/ that
// ports/esp32/release.sh leaves, to try a build that is not released.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { boards, familyOf } from "../src/data/boards.ts";
import release from "../src/data/firmware.json" with { type: "json" };
import { check, imageNames, layoutOf, manifest, parseSums, regionsOf, uf2Name } from "../src/lib/flash/images.ts";
import type { Region } from "../src/lib/flash/images.ts";

const out = join(import.meta.dirname, "..", "public", "firmware");
const from = process.env.TERN_FIRMWARE_DIR;

async function get(name: string): Promise<Uint8Array> {
    if (from) {
        return readFileSync(join(from, name));
    }
    const url = `${release.source}/v${release.version}/${name}`;
    const answer = await fetch(url);
    if (!answer.ok) {
        throw new Error(`${url}: ${answer.status} ${answer.statusText}`);
    }
    return new Uint8Array(await answer.arrayBuffer());
}

const sumsFile = await get("SHA256SUMS");
const sums = parseSums(new TextDecoder().decode(sumsFile));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "SHA256SUMS"), sumsFile);
const images = new Map<string, Uint8Array>();
const updatable: { board: string; regions: Region[] }[] = [];
let count = 0;
for (const board of boards) {
    const family = familyOf(board);
    const regions = regionsOf(release.version, board.name, family, sums);
    if (regions.length === 0) {
        console.log(`${board.name}: no image in ${release.version}`);
        continue;
    }
    const layout = family === "esp32" ? layoutOf(release.version, board.name, sums) : undefined;
    const names =
        family === "uf2"
            ? regions.map((r) => uf2Name(release.version, board.name, r))
            : imageNames(release.version, board.name, layout!, regions);
    for (const name of names) {
        const image = await get(name);
        await check(name, image, sums);
        writeFileSync(join(out, name), image);
        images.set(name, image);
        count++;
    }
    if (layout === "ota") {
        updatable.push({ board: board.name, regions });
    }
    console.log(`${board.name}: ${names.length} images (${layout ?? family}, ${regions.join(", ")})`);
}
if (count === 0) {
    throw new Error(`SHA256SUMS names no image of ${release.version} for any board the site lists`);
}
if (updatable.length > 0) {
    const latest = await manifest(release.version, updatable, images);
    writeFileSync(join(out, "latest.json"), `${JSON.stringify(latest, null, 4)}\n`);
    console.log(`latest.json: ${latest.images.length} images`);
} else {
    console.log(`no latest.json: ${release.version} has no board in the OTA layout`);
}
console.log(`firmware ${release.version}: ${count} images from ${from ?? release.source}`);
