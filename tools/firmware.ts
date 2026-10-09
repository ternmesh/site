// Fetches the firmware release the site offers (src/data/firmware.json) into public/firmware/,
// checked against the release's own SHA256SUMS. It runs before every build: the flash page
// reads the images from this site, since a browser may not read them from GitHub.
//
//     node tools/firmware.ts
//
// Which images it fetches depends on the release: one from before the OTA layout (up to
// 0.1.0-alpha.4) has no -boot.bin or -update.bin, and its SHA256SUMS says so. For a release that
// has them it also writes latest.json, the manifest the Tern phone apps read to update a node over
// Bluetooth; for one that has not, there is none, since its app image is not one a phone may send.
//
// TERN_FIRMWARE_DIR, if set, is a directory to copy them from instead: the release/ that
// ports/heltec-v3/release.sh leaves, to try a build that is not released.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import release from "../src/data/firmware.json" with { type: "json" };
import { check, imageNames, layoutOf, manifest, parseSums } from "../src/lib/flash/images.ts";

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
const layout = layoutOf(release.version, sums);
const images = new Map<string, Uint8Array>();
for (const name of imageNames(release.version, layout)) {
    const image = await get(name);
    await check(name, image, sums);
    writeFileSync(join(out, name), image);
    images.set(name, image);
    console.log(`${name}  ${image.length} bytes  ${sums.get(name)}`);
}
if (layout === "ota") {
    const latest = await manifest(release.version, images);
    writeFileSync(join(out, "latest.json"), `${JSON.stringify(latest, null, 4)}\n`);
    console.log("latest.json");
} else {
    console.log(`no latest.json: ${release.version} is from before the OTA layout`);
}
console.log(`firmware ${release.version} (${layout} layout) from ${from ?? release.source}`);
