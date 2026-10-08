// A node over Bluetooth LE, through the browser's Web Bluetooth: Chrome and Edge, on a computer
// or an Android phone (draft/companion.md, "Bluetooth LE"). Each write and each notification is
// one frame, so nothing is wrapped, and there is no console.
//
// Web Bluetooth has no way to ask for a pairing, to see one happen, or to learn the link's MTU.
// The node refuses a write until the link is paired, and that refusal is what makes the system
// ask the user for the passkey on the node's screen: so the link is opened with a write the node
// does not answer, tried until one is taken. A link whose MTU is too small is the node's to
// refuse, at the HELLO.

import type { Transport } from "./client.ts";

export const SERVICE = "7a280001-eb17-4c1c-889b-1741dd50ff40";
export const TO_NODE = "7a280002-eb17-4c1c-889b-1741dd50ff40";
export const FROM_NODE = "7a280003-eb17-4c1c-889b-1741dd50ff40";

// As much of Web Bluetooth as this uses; TypeScript's own DOM types do not have it.
export interface Characteristic extends EventTarget {
    readonly value?: DataView | null;
    writeValueWithResponse(value: Uint8Array): Promise<void>;
    startNotifications(): Promise<unknown>;
}
interface Service {
    getCharacteristic(uuid: string): Promise<Characteristic>;
}
export interface GattServer {
    readonly connected: boolean;
    connect(): Promise<GattServer>;
    disconnect(): void;
    getPrimaryService(uuid: string): Promise<Service>;
}
export interface Device extends EventTarget {
    readonly gatt?: GattServer;
}
export interface Bluetooth {
    requestDevice(options: { filters: { services: string[] }[] }): Promise<Device>;
}

/** How long each step may take, in milliseconds. */
export interface Timings {
    /** Reaching a node that is there. */
    connect: number;
    /** The user pairing: reading the passkey off the node and typing it in. */
    pair: number;
    /** Between tries of the write that waits for the pairing. */
    retry: number;
    /** Finding a node again after its link dropped: it restarts to apply a setting. */
    again: number;
}
const TIMINGS: Timings = { connect: 15000, pair: 90000, retry: 1000, again: 12000 };

function bluetooth(): Bluetooth | undefined {
    return (navigator as Navigator & { bluetooth?: Bluetooth }).bluetooth;
}

export function bluetoothSupported(): boolean {
    return typeof navigator !== "undefined" && bluetooth() !== undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `what`, or a rejection if it takes longer than `ms`. */
function within<T>(what: Promise<T>, ms: number, late: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(late)), ms);
        what.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (e: unknown) => {
                clearTimeout(timer);
                reject(e instanceof Error ? e : new Error(String(e)));
            },
        );
    });
}

/**
 * Asks the user for a node, connects and pairs. It must be called from a click: the browser
 * shows its own list of nodes in reach, and rejects if the user closes it without choosing.
 * It resolves once the node has taken a write, which a node only does from a paired client.
 */
export async function openBluetooth(
    bt: Bluetooth | undefined = bluetooth(),
    timings: Partial<Timings> = {},
): Promise<Transport> {
    if (!bt) {
        throw new Error("this browser has no Web Bluetooth");
    }
    const t = { ...TIMINGS, ...timings };
    const device = await bt.requestDevice({ filters: [{ services: [SERVICE] }] });
    const gatt = device.gatt;
    if (!gatt) {
        throw new Error("the browser will not connect to this device");
    }

    /** The present link's characteristics: the ones a connection had do not outlive it. */
    const chars: { to: Characteristic | null; from: Characteristic | null } = { to: null, from: null };
    let closing = false;
    let ended = false;
    /** Set while the link is being found again; writes wait for it. */
    let finding: Promise<boolean> | null = null;
    /** One GATT operation at a time: a browser refuses a second while one is under way. */
    let writes: Promise<void> = Promise.resolve();

    const heard = (e: Event) => {
        const value = (e.target as Characteristic).value;
        if (value) {
            // A copy: the browser may reuse the buffer for the next notification.
            transport.onData(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
        }
    };

    const deaf = () => {
        chars.from?.removeEventListener("characteristicvaluechanged", heard);
        chars.from = null;
    };

    /** The link, from nothing. */
    const link = async () => {
        chars.to = null;
        deaf();
        try {
            await within(
                (async () => {
                    await gatt.connect();
                    const service = await gatt.getPrimaryService(SERVICE);
                    const to = await service.getCharacteristic(TO_NODE);
                    const from = await service.getCharacteristic(FROM_NODE);
                    from.addEventListener("characteristicvaluechanged", heard);
                    chars.from = from;
                    await from.startNotifications();
                    chars.to = to;
                })(),
                t.connect,
                "the node did not answer over Bluetooth",
            );
        } catch (e) {
            // A connection still being made is given up, or the browser keeps trying for it.
            deaf();
            gatt.disconnect();
            throw e;
        }
    };

    const end = (why: string) => {
        if (ended) {
            return;
        }
        ended = true;
        device.removeEventListener("gattserverdisconnected", dropped);
        deaf();
        chars.to = null;
        if (gatt.connected) {
            gatt.disconnect();
        }
        if (!closing) {
            transport.onClose(why);
        }
    };

    /** The link, again, tried until `ms` have passed. */
    const find = async (ms: number): Promise<boolean> => {
        const until = Date.now() + ms;
        for (;;) {
            try {
                await link();
                return true;
            } catch {
                if (ended || closing || Date.now() + t.retry >= until) {
                    return false;
                }
                await sleep(t.retry);
            }
        }
    };

    // A node that restarts, as one does to apply a setting, comes back in a few seconds, and a
    // client that has paired needs no passkey to reach it again: the link is found again, and
    // the client's next request finds a node that wants a HELLO. Only a node that stays away is
    // the connection ending.
    function dropped(): void {
        if (ended || closing || finding || !opened) {
            return;
        }
        chars.to = null;
        finding = find(t.again).then((found) => {
            finding = null;
            if (!found) {
                end("the node went out of reach");
            }
            return found;
        });
    }

    const transport: Transport = {
        framed: true,
        write: (data) => {
            const next = writes.then(async () => {
                if (finding) {
                    await finding;
                }
                if (!chars.to) {
                    throw new Error("the Bluetooth link is down");
                }
                await chars.to.writeValueWithResponse(data);
            });
            writes = next.catch(() => {});
            return next;
        },
        close: async () => {
            closing = true;
            end("closed");
        },
        onData: () => {},
        onClose: () => {},
    };

    // Pairing. A write of one byte is shorter than a frame, which a node does not answer; an
    // unpaired link refuses it, and the system then pairs. Some systems hold the write until the
    // pairing is done and some fail it at once, and a pairing that goes wrong can drop the link,
    // so it is tried, and the link made again if need be, until it is taken.
    let opened = false;
    const until = Date.now() + t.pair;
    let why: unknown = null;
    try {
        await link();
        for (;;) {
            try {
                if (!gatt.connected || !chars.to) {
                    await link();
                }
                await within(
                    chars.to!.writeValueWithResponse(new Uint8Array([0])),
                    Math.max(until - Date.now(), 1),
                    "the pairing took too long",
                );
                break;
            } catch (e) {
                why = e;
                if (Date.now() + t.retry >= until) {
                    throw new Error(
                        `The node did not pair: ${why instanceof Error ? why.message : String(why)}. ` +
                            "Type the passkey its screen shows when the system asks.",
                    );
                }
                await sleep(t.retry);
            }
        }
    } catch (e) {
        closing = true;
        end("closed");
        throw e;
    }
    opened = true;
    device.addEventListener("gattserverdisconnected", dropped);
    if (!gatt.connected) {
        dropped();
    }
    return transport;
}
