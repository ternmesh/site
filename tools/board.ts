// Runs the page's client against a real node on a serial port, from a terminal: the check that
// the library talks to a board and not only to the tests.
//
//     node tools/board.ts /dev/cu.usbserial-0001 [address-to-send-to [text]]
//
// macOS and Linux only: it sets the port up with stty and reads the device as a file.
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, openSync } from "node:fs";

import { Client } from "../src/lib/companion/client.ts";
import type { Transport } from "../src/lib/companion/client.ts";

const [path, to, text = "from the web client's library"] = process.argv.slice(2);
if (!path) {
    console.error("usage: node tools/board.ts <port> [address [text]]");
    process.exit(2);
}

const fd = openSync(path, "r+");
execFileSync("stty", [process.platform === "darwin" ? "-f" : "-F", path, "115200", "raw", "-echo"]);
const input = createReadStream("", { fd, autoClose: false });
const output = createWriteStream("", { fd, autoClose: false });

const port: Transport = {
    framed: false,
    write: (data) => new Promise((ok, fail) => output.write(data, (e) => (e ? fail(e) : ok()))),
    close: async () => {
        input.destroy();
        output.destroy();
    },
    onData: () => {},
    onClose: () => {},
};
input.on("data", (d) => port.onData(new Uint8Array(d as Buffer)));
input.on("error", (e) => port.onClose(String(e)));

const client = new Client(port);
const states = ["waiting", "sent", "delivered", "not delivered", "received"];
let line = "";
client.onConsole = (t) => {
    const lines = (line + t).split(/\r?\n/);
    line = lines.pop() ?? "";
    for (const l of lines) {
        console.log(`    | ${l}`);
    }
};

// Opening the port resets some boards: give it time to start, and try until it answers.
for (let tries = 0; ; tries++) {
    try {
        await client.start();
        break;
    } catch (e) {
        if (tries === 8) {
            throw e;
        }
    }
}
console.log(`node: ${client.firmware}, protocol version ${client.version}`);
console.log(`self: ${client.self?.address} ${client.self?.region} ${client.self?.power} dBm`);
for (const c of client.contacts.values()) {
    console.log(`contact: ${c.name || "(no name)"} ${c.address.slice(0, 8)} session ${c.session}`);
}
for (const n of client.neighbours.values()) {
    console.log(`neighbour: ${n.routingId.toString(16).padStart(8, "0")} SNR ${n.snrDb} dB`);
}
console.log(`messages held: ${client.messages.size}`);

if (to) {
    const id = await client.send(to, text);
    console.log(`queued as #${id}`);
    let last = -1;
    await new Promise<void>((done) => {
        const end = setTimeout(done, 40000);
        client.onChange = () => {
            const m = client.messages.get(id);
            if (m && m.state !== last) {
                last = m.state;
                console.log(`#${id}: ${states[m.state]}`);
                if (m.state >= 2) {
                    clearTimeout(end);
                    done();
                }
            }
        };
    });
}
// Not closed, and not left politely: a read of a terminal device that is under way does not end
// when asked, and holds the process open.
process.kill(process.pid, "SIGKILL");
