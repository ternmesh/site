// Writes an image to an ESP32-S3 over Web Serial, with Espressif's own esptool-js: the board is
// reset into its ROM bootloader by the port's DTR and RTS lines, the way esptool.py does it.

import { ESPLoader, Transport } from "esptool-js";

import { md5 } from "./md5.ts";

export type Stage = "connecting" | "writing" | "checking" | "restarting";

export interface FlashOptions {
    onStage: (stage: Stage, chip?: string) => void;
    onProgress: (written: number, total: number) => void;
    onLog?: (line: string) => void;
}

/** The chip a Heltec V3 has. Another's image would not start, so nothing is written to one. */
const CHIP = "ESP32-S3";

/** 115200 is slow, about a minute for an image, but every USB-to-serial chip keeps up with it. */
const BAUD = 115200;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Resets the chip into what was just written: RTS pulls its EN pin low, and DTR, which would
 * hold it in the bootloader, is let go first. This is esptool.py's hard reset. esptool-js 0.7 has
 * one of its own that lets RTS go without ever pulling it, and the board stays in the bootloader.
 */
async function restart(transport: Transport): Promise<void> {
    await transport.setDTR(false);
    await transport.setRTS(true);
    await sleep(100);
    await transport.setRTS(false);
}

/**
 * Writes `image` at `address`, checks the board holds what was sent, and restarts it. `port` is a
 * Web Serial port that is not open. It is closed again when this returns or throws.
 */
export async function flash(port: unknown, image: Uint8Array, address: number, options: FlashOptions): Promise<void> {
    const transport = new Transport(port as ConstructorParameters<typeof Transport>[0], false);
    const log = (line: string) => options.onLog?.(line);
    const loader = new ESPLoader({
        transport,
        baudrate: BAUD,
        terminal: { clean: () => {}, writeLine: log, write: log },
    });
    try {
        options.onStage("connecting");
        await loader.main();
        const chip = loader.chip.CHIP_NAME;
        if (chip !== CHIP) {
            throw new Error(`this is an ${chip}, not the ${CHIP} a Heltec V3 has: nothing was written`);
        }
        options.onStage("writing", chip);
        let done = false;
        await loader.writeFlash({
            fileArray: [{ data: image, address }],
            flashMode: "keep",
            flashFreq: "keep",
            flashSize: "keep",
            eraseAll: false,
            compress: true,
            reportProgress: (_file, written, total) => {
                options.onProgress(written, total);
                if (written >= total && !done) {
                    done = true;
                    options.onStage("checking", chip);
                }
            },
            calculateMD5Hash: md5,
        });
        options.onStage("restarting", chip);
        await restart(transport);
    } finally {
        await transport.disconnect().catch(() => {});
    }
}
