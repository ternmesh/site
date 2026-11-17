// The legacy DFU client against a bootloader played by the test: the exchange as tools/ble_dfu.py
// in ternmesh/firmware has it, what it does when the bootloader refuses a step or says nothing,
// and the package read from a zip as adafruit-nrfutil makes one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";

import { DfuFailed, EVERY, PACKET_BYTES, readPackage, sendPackage } from "../src/lib/companion/dfu.ts";
import type { DfuLink, DfuProgress, Package } from "../src/lib/companion/dfu.ts";

const quick = { pace: 0, erase: 200, step: 100, receipt: 60, received: 100 };

/** An image of `n` bytes, each its offset's low byte. */
const imageOf = (n: number) => Uint8Array.from({ length: n }, (_, i) => i & 0xff);

/**
 * A bootloader that keeps what it is sent, and answers as Adafruit's does unless `script` says
 * otherwise: `refuse` an op with a status, stay `silent` after an op, or send no receipts.
 */
class Bootloader implements DfuLink {
    onNotify: (data: Uint8Array) => void = () => {};
    onClose: (why: string) => void = () => {};
    controls: number[][] = [];
    packets: Uint8Array[] = [];
    image: number[] = [];
    init: number[] = [];
    closed = false;
    /** Whether a packet was sent while a receipt was owed: what the flow control forbids. */
    overran = false;
    private state: "idle" | "sizes" | "init" | "ready" | "image" = "idle";
    private every = 0;
    private since = 0;
    private owed = false;
    private size = 0;

    private readonly script: { refuse?: [number, number]; silent?: number; noReceipts?: boolean };

    constructor(script: { refuse?: [number, number]; silent?: number; noReceipts?: boolean } = {}) {
        this.script = script;
    }

    private say(...bytes: number[]): void {
        // A notification comes after the write that caused it, as on a real link.
        queueMicrotask(() => this.onNotify(Uint8Array.from(bytes)));
    }
    private answer(op: number): void {
        if (this.script.silent === op) {
            return;
        }
        this.say(0x10, op, this.script.refuse?.[0] === op ? this.script.refuse[1] : 1);
    }

    async control(data: Uint8Array): Promise<void> {
        this.controls.push([...data]);
        const op = data[0]!;
        if (op === 0x01) {
            assert.deepEqual([...data], [0x01, 0x04]);
            this.state = "sizes";
        } else if (op === 0x02 && data[1] === 0) {
            this.state = "init";
        } else if (op === 0x02 && data[1] === 1) {
            this.answer(0x02);
        } else if (op === 0x08) {
            this.every = data[1]! | (data[2]! << 8);
        } else if (op === 0x03) {
            this.state = "image";
        } else if (op === 0x04) {
            this.answer(0x04);
        }
    }

    async packet(data: Uint8Array): Promise<void> {
        this.packets.push(data.slice());
        assert.ok(data.length <= PACKET_BYTES);
        if (this.state === "sizes") {
            const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
            assert.deepEqual([v.getUint32(0, true), v.getUint32(4, true)], [0, 0]);
            this.size = v.getUint32(8, true);
            this.state = "idle";
            this.answer(0x01);
        } else if (this.state === "init") {
            this.init.push(...data);
        } else if (this.state === "image") {
            if (this.owed) {
                this.overran = true;
            }
            this.image.push(...data);
            this.since++;
            if (this.image.length >= this.size) {
                this.state = "ready";
                this.answer(0x03);
            } else if (this.every > 0 && this.since === this.every) {
                this.since = 0;
                if (!this.script.noReceipts) {
                    this.owed = true;
                    const n = this.image.length;
                    queueMicrotask(() => {
                        this.owed = false;
                        this.onNotify(Uint8Array.of(0x11, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24));
                    });
                }
            }
        }
    }

    async close(): Promise<void> {
        this.closed = true;
    }
}

const pkg: Package = { init: imageOf(14), image: imageOf(1000) };

test("the image goes to the bootloader as tools/ble_dfu.py sends it, a receipt every ten packets", async () => {
    const b = new Bootloader();
    const seen: DfuProgress[] = [];
    await sendPackage(b, pkg, { timings: quick, onProgress: (p) => seen.push(p) });
    assert.deepEqual(b.controls, [[0x01, 0x04], [0x02, 0x00], [0x02, 0x01], [0x08, EVERY, 0], [0x03], [0x04], [0x05]]);
    // The sizes, little-endian: no SoftDevice, no bootloader, and the application.
    assert.deepEqual([...b.packets[0]!], [0, 0, 0, 0, 0, 0, 0, 0, 0xe8, 0x03, 0, 0]);
    assert.deepEqual(b.init, [...pkg.init]);
    assert.deepEqual(b.image, [...pkg.image]);
    assert.equal(b.overran, false, "nothing was sent while a receipt was owed");
    // The sizes and the init packet are each one packet; the image is fifty.
    assert.equal(b.packets.length, 1 + 1 + 50);
    assert.equal(b.closed, true);
    assert.deepEqual(
        [...new Set(seen.map((p) => p.stage))],
        ["erasing", "init", "sending", "checking", "starting", "done"],
    );
    const sending = seen.filter((p) => p.stage === "sending").map((p) => p.sent);
    assert.deepEqual(sending, [0, 200, 400, 600, 800]);
    assert.ok(seen.every((p) => p.size === 1000));
});

test("a step the bootloader refuses stops it, and the bootloader is told to start over", async () => {
    for (const [op, status, said] of [
        [0x01, 4, /the start: the firmware is larger than it takes/],
        [0x02, 6, /the init packet: the operation failed/],
        [0x03, 6, /the firmware: the operation failed/],
        [0x04, 5, /the check: the firmware arrived damaged/],
    ] as const) {
        const b = new Bootloader({ refuse: [op, status] });
        await assert.rejects(
            sendPackage(b, pkg, { timings: quick }),
            (e: unknown) => e instanceof DfuFailed && e.status === status && said.test(e.message),
        );
        assert.deepEqual(b.controls.at(-1), [0x06], `RESET after step ${op}`);
        assert.equal(b.controls.some((c) => c[0] === 0x05), false, "never started");
        assert.equal(b.closed, true);
    }
});

test("a receipt that never comes is not sent past: the transfer stops when it is late", async () => {
    const b = new Bootloader({ noReceipts: true });
    await assert.rejects(
        sendPackage(b, pkg, { timings: quick }),
        (e: unknown) => e instanceof DfuFailed && e.status === 0 && /receipt/.test(e.message),
    );
    // Ten packets of the image, and not one more.
    assert.equal(b.image.length, EVERY * PACKET_BYTES);
    assert.deepEqual(b.controls.at(-1), [0x06]);
});

test("an erase that never ends is given up on in time, and the bootloader told to start over", async () => {
    const b = new Bootloader({ silent: 0x01 });
    const started = Date.now();
    await assert.rejects(sendPackage(b, pkg, { timings: quick }), (e: unknown) => e instanceof DfuFailed && e.status === 0);
    assert.ok(Date.now() - started >= quick.erase - 5);
    assert.deepEqual(b.controls, [[0x01, 0x04], [0x06]]);
});

test("a link that goes ends the transfer at once", async () => {
    const b = new Bootloader({ silent: 0x01 });
    const going = sendPackage(b, pkg, { timings: { ...quick, erase: 60_000 } });
    setTimeout(() => b.onClose("out of reach"), 10);
    await assert.rejects(going, /out of reach/);
});

test("the link going as the bootloader starts the image is success", async () => {
    const b = new Bootloader();
    b.control = ((original) => async (data: Uint8Array) => {
        if (data[0] === 0x05) {
            throw new Error("GATT Server is disconnected");
        }
        return original(data);
    })(b.control.bind(b));
    await sendPackage(b, pkg, { timings: quick });
    assert.equal(b.image.length, 1000);
});

test("an image that is not whole words is not sent", async () => {
    const b = new Bootloader();
    await assert.rejects(sendPackage(b, { init: pkg.init, image: imageOf(1001) }, { timings: quick }), /whole words/);
    assert.deepEqual(b.controls, []);
});

/** A zip of `files`, each deflated or stored, as Python's zipfile writes one. */
function zipOf(files: [string, Uint8Array, boolean][]): Uint8Array {
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const [name, data, deflate] of files) {
        const n = new TextEncoder().encode(name);
        const body = deflate ? new Uint8Array(deflateRawSync(data)) : data;
        const local = new Uint8Array(30 + n.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(8, deflate ? 8 : 0, true);
        lv.setUint32(18, body.length, true);
        lv.setUint32(22, data.length, true);
        lv.setUint16(26, n.length, true);
        local.set(n, 30);
        const entry = new Uint8Array(46 + n.length);
        const cv = new DataView(entry.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(10, deflate ? 8 : 0, true);
        cv.setUint32(20, body.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, n.length, true);
        cv.setUint32(42, offset, true);
        entry.set(n, 46);
        parts.push(local, body);
        central.push(entry);
        offset += local.length + body.length;
    }
    const size = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, size, true);
    ev.setUint32(16, offset, true);
    const all = [...parts, ...central, end];
    const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
    let at = 0;
    for (const p of all) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

const manifestJson = (bin: string, dat: string) =>
    new TextEncoder().encode(
        JSON.stringify({
            manifest: {
                application: {
                    bin_file: bin,
                    dat_file: dat,
                    init_packet_data: { application_version: 0xffffffff, device_type: 0x52, softdevice_req: [0xfffe] },
                },
                dfu_version: 0.5,
            },
        }),
    );

test("a package is read from its zip: the manifest's application, deflated or stored", async () => {
    for (const deflate of [true, false]) {
        const zip = zipOf([
            ["zephyr.bin", pkg.image, deflate],
            ["zephyr.dat", pkg.init, deflate],
            ["manifest.json", manifestJson("zephyr.bin", "zephyr.dat"), deflate],
        ]);
        const read = await readPackage(zip);
        assert.deepEqual([...read.image], [...pkg.image]);
        assert.deepEqual([...read.init], [...pkg.init]);
    }
});

test("what is not a package is refused", async () => {
    await assert.rejects(readPackage(new TextEncoder().encode("<html>Not Found</html>")), /not a zip/);
    await assert.rejects(readPackage(zipOf([["zephyr.bin", pkg.image, true]])), /manifest/);
    await assert.rejects(
        readPackage(zipOf([["manifest.json", new TextEncoder().encode('{"manifest":{"softdevice":{}}}'), true]])),
        /no application/,
    );
    await assert.rejects(
        readPackage(zipOf([["manifest.json", manifestJson("zephyr.bin", "zephyr.dat"), true]])),
        /no zephyr.dat/,
    );
});
