import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { md5 } from "../src/lib/flash/md5.ts";

const text = (s: string) => new TextEncoder().encode(s);

test("the RFC's own examples", () => {
    assert.equal(md5(text("")), "d41d8cd98f00b204e9800998ecf8427e");
    assert.equal(md5(text("abc")), "900150983cd24fb0d6963f7d28e17f72");
    assert.equal(md5(text("message digest")), "f96b697d7cb7938d525a2f31aaf161d0");
});

test("every length across two blocks, and an image's worth, as Node has them", () => {
    const of = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 131 + 7) & 0xff);
    for (const n of [...Array(130).keys(), 4096, 700_001]) {
        const data = of(n);
        assert.equal(md5(data), createHash("md5").update(data).digest("hex"), `length ${n}`);
    }
});
