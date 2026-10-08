// A node that is not there: enough of one, in the page, to show what the client does to someone
// with no board plugged in. Everything it says is made up. It speaks the protocol in whole
// frames, as a Bluetooth link would carry them, so the client in front of it is the real one.

import type { Transport } from "./client.ts";
import { STATE, decode, encode } from "./protocol.ts";
import type { Fields } from "./protocol.ts";

const SELF = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const ROBIN = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
const SAM = "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025";

interface Held {
    id: number;
    contact: string;
    time: number;
    flags: number;
    state: number;
    reason: number;
    text: string;
}

export function openDemo(): Transport {
    const contacts = new Map<string, { name: string; session: number }>([
        [ROBIN, { name: "Robin", session: 1 }],
        [SAM, { name: "Sam (the hut)", session: 0 }],
    ]);
    const now = () => Math.floor(Date.now() / 1000);
    const messages: Held[] = [
        { id: 1, contact: ROBIN, time: now() - 5400, flags: 1, state: STATE.received, reason: 0, text: "Are you up on the ridge yet?" },
        { id: 2, contact: ROBIN, time: now() - 5300, flags: 0, state: STATE.delivered, reason: 0, text: "Half an hour out. Signal is good from the col." },
        { id: 3, contact: ROBIN, time: now() - 600, flags: 0, state: STATE.received, reason: 0, text: "Kettle is on." },
    ];
    let greeted = false;
    let count = 0;
    let closed = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const transport: Transport = {
        framed: true,
        write: async (data) => {
            // Answered a moment later, as a node on a link would be.
            later(30, () => heard(data));
        },
        close: async () => {
            closed = true;
            timers.forEach(clearTimeout);
        },
        onData: () => {},
        onClose: () => {},
    };

    function later(ms: number, what: () => void): void {
        const t = setTimeout(() => {
            timers.delete(t);
            if (!closed) {
                what();
            }
        }, ms);
        timers.add(t);
    }
    function answer(type: string, seq: number, fields: Fields = {}): void {
        transport.onData(encode(type, seq, fields));
    }
    function news(type: string, fields: Fields): void {
        if (greeted) {
            transport.onData(encode(type, count, fields));
            count = (count + 1) & 0xff;
        }
    }
    const record = (m: Held): Fields => ({
        id: m.id,
        contact: m.contact,
        time: m.time,
        flags: m.flags,
        state: m.state,
        reason: m.reason,
        wait: 0,
        text: m.text,
    });
    function add(contact: string, state: number, reason: number, text: string): Held {
        const m = { id: messages.length + 1, contact, time: now(), flags: 0, state, reason, text };
        messages.push(m);
        news("MESSAGE", record(m));
        return m;
    }
    function move(m: Held, state: number, reason = 0): void {
        m.state = state;
        m.reason = reason;
        news("STATE", { id: m.id, state, reason, wait: 0 });
    }

    function heard(data: Uint8Array): void {
        const f = decode(data);
        if (!f) {
            return;
        }
        const x = f.fields;
        if (f.type !== "HELLO" && !greeted) {
            answer("ERROR", f.seq, { code: 6 });
            return;
        }
        switch (f.type) {
            case "HELLO":
                greeted = true;
                count = 0;
                answer("INFO", f.seq, { version: 0, firmware: "a demo, not a node" });
                break;
            case "SYNC":
                news("SELF", { address: SELF, role: 1, region: "US915", power: 2, time: now() });
                for (const [address, c] of contacts) {
                    news("CONTACT", { address, session: c.session, name: c.name });
                }
                for (const m of messages) {
                    if (m.id > Number(x.after)) {
                        news("MESSAGE", record(m));
                    }
                }
                news("NEIGHBOUR", { routing_id: 0x1d2e3f40, role: 1, snr_quarter_db: 38, heard: 12 });
                news("NEIGHBOUR", { routing_id: 0x7b10c2a9, role: 0, snr_quarter_db: -26, heard: 95 });
                news("AIRTIME", { period: 0, allowed: 0, used: 812, wait: 0 });
                news("POWER", { millivolts: 3987, percent: 81, flags: 1 });
                answer("SYNCED", f.seq);
                break;
            case "SEND": {
                const to = String(x.to);
                if (to === SELF) {
                    answer("ERROR", f.seq, { code: 4 });
                    break;
                }
                const known = contacts.get(to)?.session === 1;
                const m = add(to, STATE.waiting, known ? 0 : 2, String(x.text));
                answer("QUEUED", f.seq, { id: m.id });
                if (to === SAM || !known) {
                    // Nobody answers first contact here: it is given up, as a real one would be.
                    later(6000, () => move(m, STATE.notDelivered));
                    break;
                }
                later(900, () => move(m, STATE.sent));
                later(1700, () => move(m, STATE.delivered));
                later(4200, () => add(to, STATE.received, 0, `(demo) You said: ${m.text}`.slice(0, 120)));
                break;
            }
            case "READ":
                answer("OK", f.seq);
                for (const m of messages) {
                    if (m.state === STATE.received && m.flags === 0 && m.id <= Number(x.through)) {
                        m.flags = 1;
                        news("MESSAGE", record(m));
                    }
                }
                break;
            case "SAVE_CONTACT": {
                const address = String(x.address);
                if (address === SELF) {
                    answer("ERROR", f.seq, { code: 4 });
                    break;
                }
                const c = { name: String(x.name), session: contacts.get(address)?.session ?? 0 };
                contacts.set(address, c);
                answer("OK", f.seq);
                news("CONTACT", { address, session: c.session, name: c.name });
                break;
            }
            case "REMOVE_CONTACT":
                answer("OK", f.seq);
                if (contacts.delete(String(x.address))) {
                    news("CONTACT_GONE", { address: String(x.address) });
                }
                break;
            case "PING":
            case "SET_TIME":
                answer("OK", f.seq);
                break;
            default:
                answer("ERROR", f.seq, { code: 1 });
        }
    }
    return transport;
}
