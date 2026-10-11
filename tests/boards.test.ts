import assert from "node:assert/strict";
import { test } from "node:test";

import { boardsOf } from "../src/lib/boards.ts";

const v = "0.3.0-alpha.1";
const sums = (names: string[]) => new Map(names.map((n) => [n, "00"]));

test("every board a release names an image for, by any of its kinds of image", () => {
    const boards = boardsOf(
        v,
        sums([
            `tern-heltec-v3-eu868-${v}.bin`,
            `tern-heltec-v3-us915-${v}-app.bin`,
            `tern-heltec-v4-us915-${v}-boot.bin`,
            `tern-heltec-t114-eu868-${v}.uf2`,
            `tern-heltec-wsl-v3-au915-${v}-update.bin`,
        ]),
    );
    assert.deepEqual([...boards].sort(), ["heltec-t114", "heltec-v3", "heltec-v4", "heltec-wsl-v3"]);
});

test("not another version's images, a region it does not know, or a file that is not an image", () => {
    const boards = boardsOf(
        v,
        sums([
            "tern-heltec-v3-eu868-0.2.0-alpha.1.bin",
            `tern-heltec-v3-xx433-${v}.bin`,
            `tern-heltec-v3-eu868-${v}.txt`,
            `tern-heltec-v3-eu868-${v}0.bin`,
            "SHA256SUMS",
        ]),
    );
    assert.equal(boards.size, 0);
});
