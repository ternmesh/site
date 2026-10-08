// Fetches the firmware release the site offers (src/data/firmware.json) into public/firmware/,
// checked against the release's own SHA256SUMS. It runs before every build: the flash page
// reads the images from this site, since a browser may not read them from GitHub.
//
//     node tools/firmware.ts
//
// TERN_FIRMWARE_DIR, if set, is a directory to copy them from instead: the release/ that
// ports/heltec-v3/release.sh leaves, to try a build that is not released.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import release from "../src/data/firmware.json" with { type: "json" };
import { check, imageNames, parseSums } from "../src/lib/flash/images.ts";

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
for (const name of imageNames(release.version)) {
    const image = await get(name);
    await check(name, image, sums);
    writeFileSync(join(out, name), image);
    console.log(`${name}  ${image.length} bytes  ${sums.get(name)}`);
}
console.log(`firmware ${release.version} from ${from ?? release.source}`);
