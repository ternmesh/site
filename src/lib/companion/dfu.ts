// An nRF52840 node's bootloader given new firmware over Bluetooth LE: Nordic Semiconductor's legacy
// DFU, as the Adafruit nRF52 bootloader (OTAFIX) speaks it. A node whose INFO says `update` 2 is
// asked to restart into it with UPDATE_BOOTLOADER (draft/companion.md, "By the bootloader"); what
// follows is the bootloader's protocol, not the companion protocol, and this is a client of it.
//
// The image is a DFU package, the release's `tern-<board>-<region>-<version>.zip` (made by
// `adafruit-nrfutil dfu genpkg`): manifest.json, an init packet (.dat) and the application (.bin).
// The exchange, on the DFU service's control point (written with a response, answering by
// notification) and its packet characteristic (written without one):
//
//     control  START, application             01 04
//     packet   sizes: SoftDevice, bootloader, application, u32 each, little-endian
//              <- 10 01 01                     once the bootloader has erased the application
//     control  INIT 02 00, packet the init packet, control INIT 02 01
//              <- 10 02 01
//     control  a receipt every 10 packets     08 0a 00
//     control  RECEIVE                         03
//     packet   the image, 20 bytes at a time  <- 11 ..., every 10 packets
//              <- 10 03 01                     after the last
//     control  VALIDATE                        04  <- 10 04 01: its CRC is the init packet's
//     control  ACTIVATE_AND_RESET              05  the bootloader starts it
//
// Nothing else the node holds is touched: the bootloader writes only the application's flash. A
// transfer that breaks off leaves the bootloader waiting for another over Bluetooth, so trying
// again works. ternmesh/firmware's tools/ble_dfu.py is the same client, in Python.
//
// It knows nothing of how the bytes travel: a DfuLink carries them (openDfu in bluetooth.ts, or a
// test's fake bootloader).

export const DFU_SERVICE = "00001530-1212-efde-1523-785feabcd123";
export const DFU_CONTROL = "00001531-1212-efde-1523-785feabcd123";
export const DFU_PACKET = "00001532-1212-efde-1523-785feabcd123";

const START = 0x01;
const INIT = 0x02;
const RECEIVE = 0x03;
const VALIDATE = 0x04;
const ACTIVATE = 0x05;
const RESET = 0x06;
const RECEIPTS = 0x08;
const RESPONSE = 0x10;
const RECEIPT = 0x11;
const APPLICATION = 0x04;

/** What a bootloader's answer says, by its status byte. */
const STATUS: Readonly<Record<number, string>> = {
    2: "it was not expecting that step",
    3: "it does not support that",
    4: "the firmware is larger than it takes",
    5: "the firmware arrived damaged (its CRC is wrong)",
    6: "the operation failed",
};
const STEP: Readonly<Record<number, string>> = {
    [START]: "the start",
    [INIT]: "the init packet",
    [RECEIVE]: "the firmware",
    [VALIDATE]: "the check",
};

/** A packet of the image: the least every link carries. The bootloader takes whole words only. */
export const PACKET_BYTES = 20;
/** Packets between receipts: Nordic's own library holds legacy bootloaders to ten. */
export const EVERY = 10;

/** How long each step may take, in milliseconds. */
export interface DfuTimings {
    /**
     * START: the bootloader erases the application's flash first, page by page between its
     * radio's events, which takes tens of seconds. Given up on too soon, the bootloader is left
     * mid-session, and answers the next START that it was not expecting it.
     */
    erase: number;
    /** INIT and VALIDATE. */
    step: number;
    /** A receipt, after each EVERY packets: no more is sent until it comes. */
    receipt: number;
    /** The answer to RECEIVE after the last packet. */
    received: number;
    /**
     * Between packets of the image. A bootloader sent them faster than it writes them to flash
     * stops with "operation failed", as the T1000-E's did; a phone's stack sends about one each
     * connection event, which this is close to.
     */
    pace: number;
}
export const DFU_TIMINGS: DfuTimings = { erase: 240_000, step: 10_000, receipt: 10_000, received: 30_000, pace: 10 };

/** The bootloader's end of a link: its control point and its packet characteristic. */
export interface DfuLink {
    /** Writes the control point, with a response. */
    control(data: Uint8Array): Promise<void>;
    /** Writes the packet characteristic, without a response: the bootloader refuses one with. */
    packet(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
    /** Set by the client: each notification of the control point, and the link ending. */
    onNotify: (data: Uint8Array) => void;
    onClose: (why: string) => void;
}

/** What a DFU package holds for the application: the init packet, and the image. */
export interface Package {
    init: Uint8Array;
    image: Uint8Array;
}

/** The bootloader refused a step: `status` is its code (2 to 6), 0 for no answer in time. */
export class DfuFailed extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export type DfuStage = "erasing" | "init" | "sending" | "checking" | "starting" | "done";

export interface DfuProgress {
    stage: DfuStage;
    /** Bytes of the image the bootloader has, as far as this client knows, of `size`. */
    sent: number;
    size: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Notifications as they come, and a wait for the next one that is given up on after a time. */
class Inbox {
    private held: Uint8Array[] = [];
    private waiter: { resolve: (d: Uint8Array) => void; reject: (e: Error) => void } | null = null;
    private ended: string | null = null;

    push(data: Uint8Array): void {
        if (this.waiter) {
            const w = this.waiter;
            this.waiter = null;
            w.resolve(data);
        } else {
            this.held.push(data);
        }
    }

    end(why: string): void {
        this.ended = why;
        const w = this.waiter;
        this.waiter = null;
        w?.reject(new DfuFailed(0, `the link to the bootloader went: ${why}`));
    }

    next(ms: number, what: string): Promise<Uint8Array> {
        const held = this.held.shift();
        if (held) {
            return Promise.resolve(held);
        }
        if (this.ended !== null) {
            return Promise.reject(new DfuFailed(0, `the link to the bootloader went: ${this.ended}`));
        }
        return new Promise<Uint8Array>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiter = null;
                reject(new DfuFailed(0, `the bootloader did not answer ${what}`));
            }, ms);
            this.waiter = {
                resolve: (d) => {
                    clearTimeout(timer);
                    resolve(d);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
            };
        });
    }
}

/**
 * Gives the bootloader the package's image, and has it start it. `onProgress` hears each stage
 * and, while sending, each receipt. Rejects with DfuFailed if the bootloader refuses a step or
 * does not answer in time, or the link goes; the bootloader is then told to start over, so that a
 * second try finds it ready. `signal` stops it the same way.
 */
export async function sendPackage(
    link: DfuLink,
    pkg: Package,
    options: { timings?: Partial<DfuTimings>; onProgress?: (p: DfuProgress) => void; signal?: AbortSignal } = {},
): Promise<void> {
    const t = { ...DFU_TIMINGS, ...options.timings };
    const size = pkg.image.length;
    const inbox = new Inbox();
    link.onNotify = (d) => inbox.push(d);
    link.onClose = (why) => inbox.end(why);
    const report = (stage: DfuStage, sent: number) => options.onProgress?.({ stage, sent, size });
    const stopped = () => {
        if (options.signal?.aborted) {
            throw new DfuFailed(0, "stopped");
        }
    };

    /** The answer to `op`; a late receipt before it is let go of, as is anything not an answer. */
    const answer = async (op: number, ms: number) => {
        const until = Date.now() + ms;
        for (;;) {
            const a = await inbox.next(Math.max(until - Date.now(), 1), STEP[op] ?? `step ${op}`);
            if (a[0] === RESPONSE && a[1] === op) {
                if (a[2] !== 1) {
                    throw refused(op, a[2] ?? 0);
                }
                return;
            }
        }
    };

    let begun = false;
    try {
        if (size === 0 || size % 4 !== 0) {
            throw new DfuFailed(4, "the package's firmware is not whole words: it is not one a bootloader takes");
        }
        report("erasing", 0);
        begun = true;
        await link.control(Uint8Array.of(START, APPLICATION));
        const sizes = new Uint8Array(12);
        new DataView(sizes.buffer).setUint32(8, size, true);
        await link.packet(sizes);
        await answer(START, t.erase);
        stopped();

        report("init", 0);
        await link.control(Uint8Array.of(INIT, 0x00));
        for (let at = 0; at < pkg.init.length; at += PACKET_BYTES) {
            await link.packet(pkg.init.subarray(at, at + PACKET_BYTES));
        }
        await link.control(Uint8Array.of(INIT, 0x01));
        await answer(INIT, t.step);
        await link.control(Uint8Array.of(RECEIPTS, EVERY, 0));
        await link.control(Uint8Array.of(RECEIVE));

        report("sending", 0);
        let packets = 0;
        for (let at = 0; at < size; at += PACKET_BYTES) {
            stopped();
            await link.packet(pkg.image.subarray(at, at + PACKET_BYTES));
            if (t.pace > 0) {
                await sleep(t.pace);
            }
            packets++;
            const sent = Math.min(at + PACKET_BYTES, size);
            if (packets % EVERY === 0 && sent < size) {
                // The receipt is the flow control: no more goes until it comes.
                for (;;) {
                    const a = await inbox.next(t.receipt, "with a receipt");
                    if (a[0] === RECEIPT) {
                        break;
                    }
                    if (a[0] === RESPONSE && a[2] !== 1) {
                        throw refused(a[1] ?? RECEIVE, a[2] ?? 0);
                    }
                }
                report("sending", sent);
            }
        }
        await answer(RECEIVE, t.received);
        report("checking", size);
        await link.control(Uint8Array.of(VALIDATE));
        await answer(VALIDATE, t.step);
        report("starting", size);
        begun = false;
        // It resets as it answers, and the link may go before the write is acknowledged: either
        // way it starts the firmware it has checked.
        await link.control(Uint8Array.of(ACTIVATE)).catch(() => {});
        report("done", size);
    } catch (e) {
        if (begun) {
            // Left mid-session, the bootloader refuses the next START: it is told to start over,
            // which it does waiting for another image, the application being gone.
            await link.control(Uint8Array.of(RESET)).catch(() => {});
        }
        throw e;
    } finally {
        await link.close().catch(() => {});
    }
}

function refused(op: number, status: number): DfuFailed {
    return new DfuFailed(status, `the bootloader refused ${STEP[op] ?? `step ${op}`}: ${STATUS[status] ?? `status ${status}`}`);
}

// ----- The package -----

/**
 * Reads a DFU package: its manifest's application, the init packet and the image. Throws if it is
 * not a zip, or not a package with an application. A zip's members are stored or deflated, which
 * the browser's DecompressionStream undoes; nothing else is needed.
 */
export async function readPackage(zip: Uint8Array): Promise<Package> {
    const files = unzipIndex(zip);
    const text = async (name: string) => new TextDecoder().decode(await member(zip, files, name));
    let manifest: { manifest?: { application?: { bin_file?: unknown; dat_file?: unknown } } };
    try {
        manifest = JSON.parse(await text("manifest.json"));
    } catch {
        throw new Error("the firmware package has no manifest this page can read");
    }
    const app = manifest.manifest?.application;
    if (!app || typeof app.bin_file !== "string" || typeof app.dat_file !== "string") {
        throw new Error("the firmware package has no application in it");
    }
    return { init: await member(zip, files, app.dat_file), image: await member(zip, files, app.bin_file) };
}

interface Entry {
    method: number;
    compressed: number;
    size: number;
    /** Where its local header is. */
    offset: number;
}

/** A zip's central directory: each member's name, how it is stored, and where. */
function unzipIndex(zip: Uint8Array): Map<string, Entry> {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // The end of central directory record: 22 bytes, then a comment of up to 65535.
    let end = -1;
    for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
        if (view.getUint32(at, true) === 0x06054b50) {
            end = at;
            break;
        }
    }
    if (end < 0) {
        throw new Error("the firmware package is not a zip");
    }
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const files = new Map<string, Entry>();
    for (let i = 0; i < count; i++) {
        if (at + 46 > zip.length || view.getUint32(at, true) !== 0x02014b50) {
            throw new Error("the firmware package's zip is damaged");
        }
        const nameLength = view.getUint16(at + 28, true);
        const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
        files.set(name, {
            method: view.getUint16(at + 10, true),
            compressed: view.getUint32(at + 20, true),
            size: view.getUint32(at + 24, true),
            offset: view.getUint32(at + 42, true),
        });
        at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    }
    return files;
}

async function member(zip: Uint8Array, files: Map<string, Entry>, name: string): Promise<Uint8Array> {
    const e = files.get(name);
    if (!e) {
        throw new Error(`the firmware package has no ${name}`);
    }
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    if (e.offset + 30 > zip.length || view.getUint32(e.offset, true) !== 0x04034b50) {
        throw new Error("the firmware package's zip is damaged");
    }
    const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
    const raw = zip.subarray(start, start + e.compressed);
    if (raw.length !== e.compressed) {
        throw new Error("the firmware package's zip is cut short");
    }
    let data: Uint8Array;
    if (e.method === 0) {
        data = raw.slice();
    } else if (e.method === 8) {
        const stream = new Blob([raw as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        data = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
        throw new Error(`the firmware package's ${name} is compressed in a way this page cannot read`);
    }
    if (data.length !== e.size) {
        throw new Error(`the firmware package's ${name} is not the size its zip gives`);
    }
    return data;
}
