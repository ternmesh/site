import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
    BLINDED_SINCE,
    blind,
    blindedRoutingId,
    parseAddress,
    routingId,
    routingIdFor,
    routingIdText,
} from "../src/lib/companion/ids.ts";
import { hex, unhex } from "../src/lib/companion/protocol.ts";

// Two boards on the bench: their addresses, and the routing ids their firmware prints for them.
const BOARDS = [
    ["7a03ecced25606bc8392f089695f87ec20bb4c565436bd15682b970879873449", "cc9a8574"],
    ["e15e049d751979e1ca5f224dd70fb2b00c5badfc4433fe72f160ca0f2c67f8df", "482fa614"],
] as const;

test("a routing id is the firmware's for the same address", async () => {
    for (const [address, id] of BOARDS) {
        assert.equal(routingIdText(await routingId(address)), id);
    }
    await assert.rejects(routingId("7a03"));
});

test("an address is 64 hex digits, however it was pasted", () => {
    const a = BOARDS[0][0];
    assert.equal(parseAddress(a), a);
    assert.equal(parseAddress(`  ${a.toUpperCase()}\n`), a);
    assert.equal(parseAddress(a.replace(/(.{8})/g, "$1 ")), a);
    assert.equal(parseAddress(a.replace(/(..)(?!$)/g, "$1:")), a); // colons between bytes
    assert.equal(parseAddress(a.toUpperCase().replace(/(..)(?!$)/g, "$1:")), a);
    assert.equal(parseAddress(a.slice(2)), null);
    assert.equal(parseAddress(a.slice(2) + "zz"), null);
    assert.equal(parseAddress(""), null);
});

// draft/routing.md, "Routing ids", against the specification's vectors (tests/vectors/routing.json):
// from version 14 a node makes routing ids from the key blinded from an address.
const routing: {
    ids: { address: string; blind: string; key: string; id: number }[];
    no_ids: { why: string; address: string }[];
} = JSON.parse(readFileSync(new URL("./vectors/routing.json", import.meta.url), "utf8"));

/** h as the vectors write it: 32 bytes, little-endian. */
function littleEndian(h: bigint): string {
    let out = "";
    for (let i = 0; i < 32; i++) {
        out += Number((h >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0");
    }
    return out;
}

test("routing ids: each address's blinding, routing key and id are the specification's", async () => {
    assert.ok(routing.ids.length >= 7);
    for (const c of routing.ids) {
        const b = blind(unhex(c.address)!)!;
        assert.ok(b, c.address);
        assert.equal(littleEndian(b.h), c.blind, c.address);
        assert.equal(hex(b.key), c.key, c.address);
        assert.equal(await blindedRoutingId(c.address), c.id, c.address);
        assert.equal(await routingIdFor(c.address, 14), c.id, c.address);
        assert.notEqual(hex(b.key), c.address, "the key is not the address");
    }
});

test("routing ids: an address of small order, with a part of small order, or not a point has none", async () => {
    assert.ok(routing.no_ids.length >= 4);
    for (const c of routing.no_ids) {
        assert.equal(blind(unhex(c.address)!), null, c.why);
        assert.equal(await blindedRoutingId(c.address), 0, c.why);
    }
    await assert.rejects(blindedRoutingId("7a03"));
});

test("routing ids: a node of version 14 or later blinds, and one before does not", async () => {
    const a = routing.ids[0]!.address;
    const own = await routingId(a);
    assert.equal(BLINDED_SINCE, 14);
    for (const version of [0, 4, 12, 13]) {
        assert.equal(await routingIdFor(a, version), own, `version ${version}`);
    }
    for (const version of [14, 15]) {
        assert.equal(await routingIdFor(a, version), routing.ids[0]!.id, `version ${version}`);
    }
    assert.notEqual(own, routing.ids[0]!.id);
    // The bench boards' ids are the firmware's from before version 14 too.
    for (const [address, id] of BOARDS) {
        assert.equal(routingIdText(await routingIdFor(address, 13)), id);
    }
});
