// The far end of a client's link, played by a test: what the client wrote, and a way to say
// things back. Shared by the suites that drive a Client.
import assert from "node:assert/strict";

import type { Transport } from "../src/lib/companion/client.ts";
import { decode, encode, hex, unhex, wrap } from "../src/lib/companion/protocol.ts";
import type { Fields } from "../src/lib/companion/protocol.ts";

export class Wire implements Transport {
    readonly framed: boolean;
    wrote: Uint8Array[] = [];
    onData: (data: Uint8Array) => void = () => {};
    onClose: (why: string) => void = () => {};
    closedByClient = false;
    private arrived: (() => void) | null = null;

    constructor(framed: boolean) {
        this.framed = framed;
    }
    write(data: Uint8Array): Promise<void> {
        this.wrote.push(data);
        this.arrived?.();
        return Promise.resolve();
    }
    close(): Promise<void> {
        this.closedByClient = true;
        return Promise.resolve();
    }
    /** The next frame the client writes, as the frame alone. */
    async next(): Promise<Uint8Array> {
        while (this.wrote.length === 0) {
            await new Promise<void>((r) => (this.arrived = r));
        }
        const w = this.wrote.shift()!;
        return this.framed ? w : w.subarray(4, w.length - 2);
    }
    say(type: string, seq: number, fields: Fields = {}): void {
        const f = encode(type, seq, fields);
        this.onData(this.framed ? f : wrap(f));
    }
    raw(frame: Uint8Array): void {
        this.onData(this.framed ? frame : wrap(frame));
    }
}

/** One frame of a connection in the specification's vectors. */
export type Step = { from: string; type: string; seq: number; frame: string };

/**
 * Plays a node's side of one of the specification's connections to this client, from `at` until
 * the next of the client's frames that is not yet written, and checks each of the client's against
 * it. This client sets the node's clock before it syncs, which the connection leaves out: that is
 * answered here, and the node's answers take the seq of the request this client sent.
 */
export function playing(wire: Wire, steps: Step[]) {
    let at = 0;
    const seqs = new Map<number, number>();
    const play = () => {
        while (at < steps.length && steps[at]!.from === "node") {
            const frame = unhex(steps[at++]!.frame)!;
            if (frame[0]! >= 0x40 && frame[0]! < 0x80) {
                frame[1] = seqs.get(frame[1]!)!;
            }
            wire.raw(frame);
        }
    };
    const expect = async () => {
        const step = steps[at++]!;
        assert.equal(step.from, "client");
        let got = await wire.next();
        if (step.type !== "SET_TIME" && decode(got)!.type === "SET_TIME") {
            wire.say("OK", got[1]!);
            got = await wire.next();
        }
        const want = unhex(step.frame)!;
        assert.equal(hex(got.subarray(2)), hex(want.subarray(2)), step.type);
        assert.equal(got[0], want[0], step.type);
        seqs.set(want[1]!, got[1]!);
        play();
    };
    return { expect, play, done: () => at === steps.length };
}
