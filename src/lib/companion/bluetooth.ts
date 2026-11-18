// A node over Bluetooth LE, through the browser's Web Bluetooth: Chrome and Edge, on a computer
// or an Android phone (draft/companion.md, "Bluetooth LE"). Each write and each notification is
// one frame, so nothing is wrapped, and there is no console.
//
// Web Bluetooth has no way to ask for a pairing, to see one happen, or to learn the link's MTU.
// The node refuses a write until the link is paired, and that refusal is what makes the system
// ask the user for the passkey on the node's screen: so the link is opened with a write the node
// does not answer, tried until one is taken. A link whose MTU is too small is the node's to
// refuse, at the HELLO.
//
// openDfu is the other service a node has over Bluetooth: its bootloader's, once the node has
// restarted into it to be updated (dfu.ts). It is another device to the browser, with an address
// of its own, so the user chooses it from the browser's list too.

import type { Transport } from "./client.ts";
import { DFU_CONTROL, DFU_PACKET, DFU_SERVICE } from "./dfu.ts";
import type { DfuLink } from "./dfu.ts";

export const SERVICE = "7a280001-eb17-4c1c-889b-1741dd50ff40";
export const TO_NODE = "7a280002-eb17-4c1c-889b-1741dd50ff40";
export const FROM_NODE = "7a280003-eb17-4c1c-889b-1741dd50ff40";

// As much of Web Bluetooth as this uses; TypeScript's own DOM types do not have it.
export interface Characteristic extends EventTarget {
    readonly value?: DataView | null;
    writeValueWithResponse(value: Uint8Array): Promise<void>;
    writeValueWithoutResponse(value: Uint8Array): Promise<void>;
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
    readonly name?: string;
    readonly gatt?: GattServer;
}
export interface Bluetooth {
    requestDevice(options: { filters: { services: string[] }[]; optionalServices?: string[] }): Promise<Device>;
}

/** A link to a node, and the device it is to: the page reaches the same node again with it, unasked. */
export interface BluetoothTransport extends Transport {
    readonly device: Device;
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
 * Given a `device` the user chose before, it connects to that, with no list and no click.
 */
/**
 * What to do when pairing fails (draft/companion.md, "Bluetooth LE"): a node pairs with a passkey
 * it does not show, the default 123456 or one set on it, only in the three minutes after it is
 * started by hand or its button is pressed, and a node that shows a passkey on its screen pairs
 * with that one at any time.
 */
export const PAIRING_HINT =
    "If the node shows a passkey on its screen, type that one. If it has no screen, press its button, " +
    "or turn it off and on (press RESET on a board with no button), then connect and pair within 3 minutes, " +
    "with its passkey: 123456 unless one of your own is set.";

export async function openBluetooth(
    bt: Bluetooth | undefined = bluetooth(),
    timings: Partial<Timings> = {},
    known?: Device,
): Promise<BluetoothTransport> {
    if (!bt && !known) {
        throw new Error("this browser has no Web Bluetooth");
    }
    const t = { ...TIMINGS, ...timings };
    const device = known ?? (await bt!.requestDevice({ filters: [{ services: [SERVICE] }] }));
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
            if (ended) {
                return false;
            }
            try {
                await link();
            } catch {
                if (Date.now() + t.retry >= until) {
                    return false;
                }
                await sleep(t.retry);
                continue;
            }
            if (ended) {
                // Closed while the link was being made: it is not kept.
                deaf();
                chars.to = null;
                gatt.disconnect();
                return false;
            }
            return true;
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

    const transport: BluetoothTransport = {
        device,
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
                            PAIRING_HINT,
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

/**
 * Asks the user for a node's bootloader, which advertises the DFU service once the node has
 * restarted into it, and connects to it. Like openBluetooth it must be called from a click, unless
 * given the `device` chosen before, as when a transfer is tried again. The bootloader needs no
 * pairing. One GATT operation goes at a time, as a browser requires.
 */
export async function openDfu(
    bt: Bluetooth | undefined = bluetooth(),
    timings: Partial<Timings> = {},
    known?: Device,
): Promise<DfuLink & { device: Device }> {
    if (!bt && !known) {
        throw new Error("this browser has no Web Bluetooth");
    }
    const t = { ...TIMINGS, ...timings };
    const device =
        known ?? (await bt!.requestDevice({ filters: [{ services: [DFU_SERVICE] }], optionalServices: [DFU_SERVICE] }));
    const gatt = device.gatt;
    if (!gatt) {
        throw new Error("the browser will not connect to this device");
    }
    let ended = false;
    let ops: Promise<void> = Promise.resolve();
    const one = (what: () => Promise<void>): Promise<void> => {
        const next = ops.then(() => {
            if (ended) {
                throw new Error("the link to the bootloader is down");
            }
            return what();
        });
        ops = next.catch(() => {});
        return next;
    };
    const heard = (e: Event) => {
        const value = (e.target as Characteristic).value;
        if (value) {
            link.onNotify(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
        }
    };
    const end = (why: string) => {
        if (ended) {
            return;
        }
        ended = true;
        device.removeEventListener("gattserverdisconnected", dropped);
        control?.removeEventListener("characteristicvaluechanged", heard);
        if (gatt.connected) {
            gatt.disconnect();
        }
        link.onClose(why);
    };
    const dropped = () => end("the bootloader went out of reach");

    let control: Characteristic | null = null;
    let packet: Characteristic | null = null;
    try {
        await within(
            (async () => {
                await gatt.connect();
                const service = await gatt.getPrimaryService(DFU_SERVICE);
                control = await service.getCharacteristic(DFU_CONTROL);
                packet = await service.getCharacteristic(DFU_PACKET);
                control.addEventListener("characteristicvaluechanged", heard);
                await control.startNotifications();
            })(),
            t.connect,
            "the bootloader did not answer over Bluetooth",
        );
    } catch (e) {
        (control as Characteristic | null)?.removeEventListener("characteristicvaluechanged", heard);
        gatt.disconnect();
        throw e;
    }
    device.addEventListener("gattserverdisconnected", dropped);
    const link: DfuLink & { device: Device } = {
        device,
        control: (data) => one(() => control!.writeValueWithResponse(data)),
        packet: (data) => one(() => packet!.writeValueWithoutResponse(data)),
        close: async () => end("closed"),
        onNotify: () => {},
        onClose: () => {},
    };
    return link;
}
