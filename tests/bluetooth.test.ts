// The Bluetooth link against a browser played by the test: what is asked of Web Bluetooth, the
// pairing, and a node that goes and comes back.
import assert from "node:assert/strict";
import { test } from "node:test";

import { FROM_NODE, SERVICE, TO_NODE, openBluetooth } from "../src/lib/companion/bluetooth.ts";
import type { Bluetooth } from "../src/lib/companion/bluetooth.ts";

const FAST = { connect: 200, pair: 400, retry: 5, again: 100 };
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

class Char extends EventTarget {
    value: DataView | null = null;
    wrote: Uint8Array[] = [];
    notifying = false;
    /** What a write does: by default, it is taken. */
    onWrite: (value: Uint8Array) => Promise<void> = () => Promise.resolve();
    async writeValueWithResponse(value: Uint8Array): Promise<void> {
        await this.onWrite(value);
        this.wrote.push(value);
    }
    startNotifications(): Promise<unknown> {
        this.notifying = true;
        return Promise.resolve(this);
    }
    notify(bytes: number[]): void {
        this.value = new DataView(new Uint8Array([0xee, ...bytes, 0xee]).buffer, 1, bytes.length);
        this.dispatchEvent(new Event("characteristicvaluechanged"));
    }
}

/** A node as the browser shows it: each connection has characteristics of its own. */
class Node extends EventTarget {
    asked: unknown = null;
    connects = 0;
    there = true;
    /** Writes refused before one is taken, as an unpaired link refuses them. */
    refusals = 0;
    to = new Char();
    from = new Char();
    connected = false;
    readonly gatt = {
        node: this as Node,
        get connected(): boolean {
            return this.node.connected;
        },
        async connect() {
            const n = this.node;
            if (!n.there) {
                throw new Error("out of range");
            }
            n.connects++;
            n.connected = true;
            n.to = new Char();
            n.from = new Char();
            n.to.onWrite = () => {
                if (n.refusals > 0) {
                    n.refusals--;
                    return Promise.reject(new Error("authentication failed"));
                }
                return Promise.resolve();
            };
            return this;
        },
        disconnect() {
            this.node.connected = false;
        },
        async getPrimaryService(uuid: string) {
            assert.equal(uuid, SERVICE);
            const n = this.node;
            return {
                async getCharacteristic(c: string) {
                    assert.ok(c === TO_NODE || c === FROM_NODE);
                    return c === TO_NODE ? n.to : n.from;
                },
            };
        },
    };
    /** The link drops, as when the node restarts. */
    drop(): void {
        this.connected = false;
        this.dispatchEvent(new Event("gattserverdisconnected"));
    }
    browser(): Bluetooth {
        return {
            requestDevice: async (options) => {
                this.asked = options;
                return this;
            },
        };
    }
}

test("a node is asked for by the service, and frames go whole each way", async () => {
    const node = new Node();
    const t = await openBluetooth(node.browser(), FAST);
    assert.deepEqual(node.asked, { filters: [{ services: [SERVICE] }] });
    assert.equal(t.framed, true);
    assert.ok(node.from.notifying);
    // The write that waited for the pairing: shorter than a frame, so the node does not answer.
    assert.deepEqual(node.to.wrote, [new Uint8Array([0])]);

    await t.write(new Uint8Array([1, 2, 3]));
    assert.deepEqual(node.to.wrote[1], new Uint8Array([1, 2, 3]));

    const got: Uint8Array[] = [];
    t.onData = (d) => got.push(d);
    node.from.notify([0x40, 1, 9]);
    assert.deepEqual(got, [new Uint8Array([0x40, 1, 9])]);
    assert.equal(got[0]!.buffer.byteLength, 3, "a copy of the frame alone");
    await t.close();
});

test("a link that is not paired yet is tried until it is", async () => {
    const node = new Node();
    node.refusals = 3;
    const t = await openBluetooth(node.browser(), FAST);
    assert.equal(node.refusals, 0);
    assert.equal(node.to.wrote.length, 1);
    await t.close();
});

test("a pairing that drops the link is begun again", async () => {
    const node = new Node();
    const browser = node.browser();
    const connect = node.gatt.connect.bind(node.gatt);
    let first = true;
    node.gatt.connect = async () => {
        const g = await connect();
        if (first) {
            first = false;
            node.to.onWrite = () => {
                node.connected = false;
                return Promise.reject(new Error("GATT Server is disconnected"));
            };
        }
        return g;
    };
    const t = await openBluetooth(browser, FAST);
    assert.equal(node.connects, 2);
    assert.equal(node.to.wrote.length, 1);
    await t.close();
});

test("a node that never pairs is given up, and let go", async () => {
    const node = new Node();
    node.refusals = 1e9;
    await assert.rejects(openBluetooth(node.browser(), FAST), /did not pair: authentication failed/);
    assert.equal(node.connected, false);
});

test("a browser with no Web Bluetooth says so", async () => {
    await assert.rejects(openBluetooth(undefined), /no Web Bluetooth/);
});

test("one write at a time", async () => {
    const node = new Node();
    const t = await openBluetooth(node.browser(), FAST);
    let under = 0;
    let most = 0;
    node.to.onWrite = async () => {
        most = Math.max(most, ++under);
        await tick(5);
        under--;
    };
    await Promise.all([1, 2, 3].map((n) => t.write(new Uint8Array([n]))));
    assert.equal(most, 1);
    assert.deepEqual(node.to.wrote.slice(1), [1, 2, 3].map((n) => new Uint8Array([n])));
    await t.close();
});

test("a failed write does not hold up the next", async () => {
    const node = new Node();
    const t = await openBluetooth(node.browser(), FAST);
    node.refusals = 1;
    await assert.rejects(t.write(new Uint8Array([1])));
    await t.write(new Uint8Array([2]));
    assert.deepEqual(node.to.wrote[1], new Uint8Array([2]));
    await t.close();
});

test("a node that restarts is found again, and a write waits for it", async () => {
    const node = new Node();
    const t = await openBluetooth(node.browser(), FAST);
    let closed = "";
    t.onClose = (why) => (closed = why);
    const got: Uint8Array[] = [];
    t.onData = (d) => got.push(d);
    const old = node.from;

    node.there = false;
    node.drop();
    const w = t.write(new Uint8Array([7, 7]));
    await tick(20);
    node.there = true;
    await w;
    assert.equal(node.connects, 2);
    assert.deepEqual(node.to.wrote, [new Uint8Array([7, 7])]);
    assert.ok(node.from.notifying);

    old.notify([1, 1]);
    node.from.notify([0x80, 0]);
    assert.deepEqual(got, [new Uint8Array([0x80, 0])], "only the present link is heard");
    assert.equal(closed, "");
    await t.close();
});

test("a node that stays away ends the connection", async () => {
    const node = new Node();
    const t = await openBluetooth(node.browser(), FAST);
    let closed = "";
    t.onClose = (why) => (closed = why);
    node.there = false;
    node.drop();
    await assert.rejects(t.write(new Uint8Array([1])), /link is down/);
    assert.equal(closed, "the node went out of reach");
});

test("closing lets the node go, and is not the link ending", async () => {
    const node = new Node();
    const t = await openBluetooth(node.browser(), FAST);
    let closed = "";
    t.onClose = (why) => (closed = why);
    await t.close();
    assert.equal(node.connected, false);
    node.drop();
    await tick(20);
    assert.equal(node.connects, 1);
    assert.equal(closed, "");
});

test("closing while a node is looked for stops the looking", async () => {
    const node = new Node();
    const t = await openBluetooth(node.browser(), FAST);
    node.there = false;
    node.drop();
    await tick(8);
    await t.close();
    node.there = true;
    await tick(30);
    assert.equal(node.connects, 1);
    assert.equal(node.connected, false);
});

test("a link made as the connection closes is not kept", async () => {
    const node = new Node();
    const t = await openBluetooth(node.browser(), FAST);
    const connect = node.gatt.connect.bind(node.gatt);
    node.gatt.connect = async () => {
        await tick(10);
        return connect();
    };
    node.drop();
    await tick(2);
    await t.close();
    await tick(30);
    assert.equal(node.connects, 2);
    assert.equal(node.connected, false);
    const got: Uint8Array[] = [];
    t.onData = (d) => got.push(d);
    node.from.notify([1, 1]);
    assert.deepEqual(got, [], "and nothing is heard from it");
});
