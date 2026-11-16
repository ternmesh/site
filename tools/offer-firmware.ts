// Offers the latest firmware release, if it is later than the one src/data/firmware.json names:
// given the firmware's release tags on standard input, one a line, it writes the newer version
// there and prints it, or prints nothing. .github/workflows/firmware.yml runs it every hour, then
// the tests and the build, which fetches the release's images and checks them, before it commits.
//
//     gh api --paginate repos/ternmesh/firmware/releases --jq '.[] | select(.draft | not) | .tag_name' |
//         node tools/offer-firmware.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { newerRelease } from "../src/lib/flash/offer.ts";

const path = join(import.meta.dirname, "..", "src", "data", "firmware.json");
const release = JSON.parse(readFileSync(path, "utf8")) as { version: string; source: string };
const version = newerRelease(release.version, readFileSync(0, "utf8").split("\n"));
if (version !== null) {
    writeFileSync(path, JSON.stringify({ ...release, version }, null, 4) + "\n");
    console.log(version);
}
