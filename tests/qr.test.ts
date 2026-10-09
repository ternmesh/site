// The QR encoder (src/lib/qr.ts) against codes made with segno (tests/vectors/qr.json), module for
// module, each at the mask segno was given; and the segments a join code's link is written in.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { linkSegments, qrEncode } from "../src/lib/qr.ts";
import type { Segment } from "../src/lib/qr.ts";

interface Vectors {
    cases: { segments: Segment[]; mask: number; version: number; modules: string[] }[];
}

const v: Vectors = JSON.parse(readFileSync(new URL("./vectors/qr.json", import.meta.url), "utf8"));

const rows = (m: boolean[][]) => m.map((row) => row.map((d) => (d ? "1" : "0")).join(""));

test("each code is the reference's, module for module", () => {
    for (const c of v.cases) {
        const m = qrEncode(c.segments, { mask: c.mask });
        assert.equal(m.length, 17 + 4 * c.version, c.segments[0]!.text);
        assert.deepEqual(rows(m), c.modules, c.segments[0]!.text);
    }
});

test("a join code's link is alphanumeric but for its #, and fits version 4 at most", () => {
    const longest = "HTTPS://TERNMESH.ORG/G#" + "A".repeat(79);
    assert.deepEqual(
        linkSegments(longest).map((s) => s.mode),
        ["alphanumeric", "byte", "alphanumeric"],
    );
    assert.equal(qrEncode(linkSegments(longest)).length, 33);
    // A name of 12 bytes or fewer, a link of 71 characters or fewer, fits version 3.
    assert.equal(qrEncode(linkSegments(longest.slice(0, 23 + 48))).length, 29);
    // An address's link is one alphanumeric segment, in version 3.
    const address = "HTTPS://TERNMESH.ORG/A/" + "A".repeat(52);
    assert.deepEqual(linkSegments(address), [{ mode: "alphanumeric", text: address }]);
    assert.equal(qrEncode(linkSegments(address)).length, 29);
    // Text that is not alphanumeric goes as bytes.
    assert.deepEqual(linkSegments("https://ternmesh.org/g#x"), [{ mode: "byte", text: "https://ternmesh.org/g#x" }]);
});

test("a mask is always chosen, and the code is the same each time", () => {
    const segs = linkSegments(v.cases[1]!.segments.map((s) => s.text).join(""));
    assert.deepEqual(qrEncode(segs), qrEncode(segs));
    assert.throws(() => qrEncode([{ mode: "byte", text: "x".repeat(200) }]));
});
