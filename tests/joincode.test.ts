// Join codes against the specification's vectors (tests/vectors/groups.json, a copy of
// vectors/groups.json in ternmesh/spec): its join_codes and bad_join_codes, as a page that reads
// them. Making a code is the node's (GROUP_LINK): this side only reads one.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { readJoinCode } from "../src/lib/companion/share.ts";

interface Vectors {
    join_codes: { group_secret: string; name: string; payload: string; link: string; reads: string[] }[];
    bad_join_codes: { why: string; link: string }[];
}

const v: Vectors = JSON.parse(readFileSync(new URL("./vectors/groups.json", import.meta.url), "utf8"));

/** A group's id: Expand(G, "tern v0 group id", 8), worked out here apart from the page's own. */
function groupId(secret: string): string {
    const info = Buffer.concat([Buffer.from("tern v0 group id"), Buffer.from([1])]);
    return createHmac("sha256", Buffer.from(secret, "hex")).update(info).digest().subarray(0, 8).toString("hex");
}

test("every join code reads as its group and name, however it is written", async () => {
    for (const c of v.join_codes) {
        for (const r of [c.link, ...c.reads]) {
            assert.deepEqual(await readJoinCode(r), { group: groupId(c.group_secret), name: c.name }, r);
        }
    }
});

test("anything else is no join code", async () => {
    for (const c of v.bad_join_codes) {
        assert.equal(await readJoinCode(c.link), null, c.why);
    }
    assert.equal(await readJoinCode(""), null);
    assert.equal(await readJoinCode(v.join_codes[0]!.link + " "), null);
});
