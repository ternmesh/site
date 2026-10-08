import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAddress, routingId, routingIdText } from "../src/lib/companion/ids.ts";

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
