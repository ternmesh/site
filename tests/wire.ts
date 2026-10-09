// The far end of a client's link, played by a test: what the client wrote, and a way to say
// things back. Shared by the suites that drive a Client.
import type { Transport } from "../src/lib/companion/client.ts";
import { encode, wrap } from "../src/lib/companion/protocol.ts";
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

