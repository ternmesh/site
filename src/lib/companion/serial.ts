// A node on a USB serial port, through the browser's Web Serial: Chrome and Edge on a desktop.
// The port carries the node's console as well as frames, at 115200 baud (draft/companion.md,
// "Byte streams").

import type { Transport } from "./client.ts";

// As much of Web Serial as this uses; TypeScript's own DOM types do not have it yet.
interface SerialPort {
    readable: ReadableStream<Uint8Array> | null;
    writable: WritableStream<Uint8Array> | null;
    open(options: { baudRate: number }): Promise<void>;
    close(): Promise<void>;
}
interface Serial extends EventTarget {
    requestPort(): Promise<SerialPort>;
}

function serial(): Serial | undefined {
    return (navigator as Navigator & { serial?: Serial }).serial;
}

export function serialSupported(): boolean {
    return typeof navigator !== "undefined" && serial() !== undefined;
}

/**
 * Asks the user for a port and opens it. It must be called from a click: the browser shows its
 * own list of ports, and rejects if the user closes it without choosing.
 */
export async function openSerial(): Promise<Transport> {
    const s = serial();
    if (!s) {
        throw new Error("this browser has no Web Serial");
    }
    const port = await s.requestPort();
    await port.open({ baudRate: 115200 });
    if (!port.readable || !port.writable) {
        await port.close().catch(() => {});
        throw new Error("the port opened, but cannot be read and written");
    }
    const reader = port.readable.getReader();
    const writer = port.writable.getWriter();
    let closing = false;

    // A port will not close while either of its streams is locked, and closing a writer does not
    // unlock it: both locks are let go first, the reader's by the loop below once its read ends.
    const shut = async () => {
        await writer.close().catch(() => {});
        writer.releaseLock();
        await port.close().catch(() => {});
    };
    let reading: Promise<void> = Promise.resolve();

    const transport: Transport = {
        framed: false,
        write: (data) => writer.write(data),
        close: async () => {
            closing = true;
            await reader.cancel().catch(() => {});
            await reading;
            await shut();
        },
        onData: () => {},
        onClose: () => {},
    };

    reading = (async () => {
        let why = "the port closed";
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                if (value) {
                    transport.onData(value);
                }
            }
        } catch (e) {
            // Unplugging the board ends the read with an error.
            why = e instanceof Error ? e.message : String(e);
        }
        reader.releaseLock();
        if (!closing) {
            await shut();
            transport.onClose(why);
        }
    })();
    return transport;
}
