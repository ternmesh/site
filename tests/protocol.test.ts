// The protocol library against the specification's vectors (tests/vectors/companion.json, a copy
// of vectors/companion.json in ternmesh/spec): its conformance section, as a client.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { StreamReader, VERSION, crc16, decode, encode, hex, unhex, wrap } from "../src/lib/companion/protocol.ts";
import type { Fields } from "../src/lib/companion/protocol.ts";

interface Vectors {
    crc_check: { input: string; crc: number };
    frames: { type: string; seq: number; fields: Fields; frame: string; stream: string }[];
    extended: { type: string; seq: number; fields: Fields; frame: string }[];
    rejected: { why: string; frame: string; answer: number | null }[];
    streams: { why: string; stream: string; items: ({ frame: string } | { text: string })[]; pending: string }[];
    exchange: { from: string; type: string; seq: number; frame: string }[];
    older: { version: number; frames: { from: string; type: string; seq: number; frame: string }[] }[];
    unknown_to_older: { type: string; version: number; frame: string; why: string; answer: number | null }[];
}

const v: Vectors = JSON.parse(readFileSync(new URL("./vectors/companion.json", import.meta.url), "utf8"));
const bytes = (h: string) => unhex(h)!;

function found(reader: StreamReader, data: Uint8Array) {
    return reader.push(data).map((i) => ("frame" in i ? { frame: hex(i.frame) } : { text: hex(i.text) }));
}

test("crc_check", () => {
    assert.equal(crc16(bytes(v.crc_check.input)), v.crc_check.crc);
});

test("frames: built, read, wrapped and found", () => {
    assert.ok(v.frames.length >= 34);
    for (const c of v.frames) {
        assert.equal(hex(encode(c.type, c.seq, c.fields)), c.frame, c.type);
        assert.deepEqual(decode(bytes(c.frame)), { type: c.type, seq: c.seq, fields: c.fields }, c.type);
        assert.equal(hex(wrap(bytes(c.frame))), c.stream, c.type);
        assert.deepEqual(found(new StreamReader(), bytes(c.stream)), [{ frame: c.frame }], c.type);
    }
});

test("extended: bytes after the fields are ignored", () => {
    for (const c of v.extended) {
        assert.deepEqual(decode(bytes(c.frame)), { type: c.type, seq: c.seq, fields: c.fields });
    }
});

test("rejected: a client discards each", () => {
    for (const c of v.rejected) {
        assert.equal(decode(bytes(c.frame)), null, c.why);
    }
});

test("streams: all at once, and a byte at a time", () => {
    for (const c of v.streams) {
        const whole = new StreamReader();
        assert.deepEqual(found(whole, bytes(c.stream)), c.items, c.why);
        assert.equal(hex(whole.pending), c.pending, c.why);

        // A byte at a time the frames are the same and in the same order, with the text between
        // them in as many pieces as it came in.
        const slow = new StreamReader();
        const items: ({ frame: string } | { text: string })[] = [];
        for (const b of bytes(c.stream)) {
            for (const i of found(slow, Uint8Array.of(b))) {
                const last = items[items.length - 1];
                if ("text" in i && last && "text" in last) {
                    last.text += i.text;
                } else {
                    items.push(i);
                }
            }
        }
        assert.deepEqual(items, c.items, c.why);
        assert.equal(hex(slow.pending), c.pending, c.why);
    }
});

test("exchange and older: every frame reads by the version spoken, and builds back to the same bytes", () => {
    const connections = [{ version: VERSION, frames: v.exchange }, ...v.older];
    for (const { version, frames } of connections) {
        for (const c of frames) {
            // Each older client's last request is one its version does not define, sent on purpose
            // to see the node refuse it: it is a frame of a later version.
            const later = c.from === "client" && decode(bytes(c.frame), version) === null;
            const f = decode(bytes(c.frame), later ? VERSION : version);
            assert.ok(f, `${c.type}, version ${version}`);
            assert.equal(f.type, c.type);
            assert.equal(f.seq, c.seq);
            assert.equal(hex(encode(f.type, f.seq, f.fields)), c.frame);
        }
    }
});

test("an INFO is read by the lesser of the two versions, and so is all after it", () => {
    // A node of version 2 says nothing of its board, and its SYNCED carries no count.
    const info = encode("INFO", 1, { version: 2, firmware: "tern 0.1.0" });
    assert.deepEqual(decode(info), { type: "INFO", seq: 1, fields: { version: 2, firmware: "tern 0.1.0" } });
    assert.deepEqual(decode(Uint8Array.of(0x43, 3), 2), { type: "SYNCED", seq: 3, fields: {} });
    assert.equal(decode(Uint8Array.of(0x43, 3)), null);
    // A node of version 6 that leaves them out has cut its INFO short.
    assert.equal(decode(encode("INFO", 1, { version: 6, firmware: "tern 0.1.0" })), null);
});

test("unknown_to_older: news and answers of a later version are not read by an earlier one", () => {
    assert.ok(v.unknown_to_older.length >= 15);
    for (const c of v.unknown_to_older) {
        assert.equal(decode(bytes(c.frame), c.version), null, `${c.type}, version ${c.version}`);
        assert.ok(decode(bytes(c.frame)), `${c.type} is read by version ${VERSION}`);
    }
});

test("a frame that never finishes is given up as text", () => {
    const r = new StreamReader();
    assert.deepEqual(found(r, bytes("f554000240")), []);
    const items = r.stale().map((i) => ("frame" in i ? { frame: hex(i.frame) } : { text: hex(i.text) }));
    assert.deepEqual(items, [{ text: "f554000240" }]);
    assert.equal(r.pending.length, 0);
    // And a frame after it is still found.
    assert.deepEqual(found(r, bytes("f55400024004a7e8")), [{ frame: "4004" }]);
});

test("encode refuses what is not a frame", () => {
    assert.throws(() => encode("NOPE", 1));
    assert.throws(() => encode("SEND", 1, { ref: 1, to: "00", text: "x" }));
    assert.throws(() => encode("SEND", 1, { ref: 1, to: "00".repeat(32), text: "x".repeat(129) }));
    assert.throws(() => encode("SET", 1, { setting: 9, value: 1 }));
    assert.throws(() => encode("HELLO", 1, {}));
    assert.throws(() => encode("UPDATE_DATA", 1, { offset: 0, data: "00".repeat(173) }));
    assert.throws(() => encode("SELF", 0, { address: "00".repeat(32), role: 0, region: "", power: 0, time: 0, card_name: "x" }));
});
