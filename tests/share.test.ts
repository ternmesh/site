// Sharing an address against the specification's vectors (tests/vectors/sharing.json, a copy of
// vectors/sharing.json in ternmesh/spec): its conformance section, as a page that reads links.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { addressLink, addressText, base32, readAddress, shortCode, shortCodeText } from "../src/lib/companion/share.ts";
import { parseAddress } from "../src/lib/companion/ids.ts";

interface Vectors {
    cases: { address: string; text: string; base32: string; link: string; short_code: string; reads: string[] }[];
    refused: string[];
    not_contacts: { link: string; reason: string }[];
    short_code_forms: { value: number; text: string }[];
}

const v: Vectors = JSON.parse(readFileSync(new URL("./vectors/sharing.json", import.meta.url), "utf8"));

test("each address is written as the specification writes it", async () => {
    for (const c of v.cases) {
        assert.equal(addressText(c.address), c.text);
        assert.equal(addressLink(c.address), c.link);
        assert.equal(c.link.endsWith(c.base32), true);
        assert.equal(await shortCode(c.address), c.short_code);
    }
});

test("every spelling reads back, in the box the app takes addresses in too", () => {
    for (const c of v.cases) {
        for (const r of c.reads) {
            assert.equal(readAddress(r), c.address, r);
            assert.equal(parseAddress(r), c.address, r);
        }
    }
});

test("anything else is refused", () => {
    for (const r of v.refused) {
        assert.equal(readAddress(r), null, r);
        assert.equal(parseAddress(r), null, r);
    }
});

test("links to rejected addresses read: the node, not the reader, refuses them as contacts", () => {
    for (const n of v.not_contacts) {
        assert.notEqual(readAddress(n.link), null, n.reason);
    }
});

test("a short code keeps its leading zeros", () => {
    for (const f of v.short_code_forms) {
        assert.equal(shortCodeText(BigInt(f.value)), f.text);
    }
});

test("base32 matches RFC 4648's examples, unpadded", () => {
    const enc = (s: string) => base32(new TextEncoder().encode(s));
    assert.deepEqual(
        ["f", "fo", "foo", "foob", "fooba", "foobar"].map(enc),
        ["MY", "MZXQ", "MZXW6", "MZXW6YQ", "MZXW6YTB", "MZXW6YTBOI"],
    );
});
