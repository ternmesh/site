// The flash page: choose a region and what is on the board, pick the port, and watch it written.

import release from "../../data/firmware.json";
import { flash } from "./flash.ts";
import type { Stage } from "./flash.ts";
import { ADDRESS, check, imageName, parseSums, REGIONS } from "./images.ts";
import type { Kind, Region } from "./images.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Serial {
    requestPort(): Promise<unknown>;
}
const serial = (navigator as Navigator & { serial?: Serial }).serial;

const STAGES: Record<Stage, string> = {
    connecting: "Restarting the board into its bootloader…",
    writing: "Writing. Leave the cable alone: this takes about a minute.",
    checking: "Checking the board holds what was sent…",
    restarting: "Restarting the board…",
};

async function fetchBytes(path: string): Promise<Uint8Array> {
    const answer = await fetch(path);
    if (!answer.ok) {
        throw new Error(`${path}: ${answer.status} ${answer.statusText}`);
    }
    return new Uint8Array(await answer.arrayBuffer());
}

/** The image for a choice, checked against the release's checksums. */
async function image(region: Region, kind: Kind): Promise<Uint8Array> {
    const name = imageName(release.version, region, kind);
    const [data, sums] = await Promise.all([fetchBytes(`/firmware/${name}`), fetchBytes("/firmware/SHA256SUMS")]);
    await check(name, data, parseSums(new TextDecoder().decode(sums)));
    return data;
}

function chosen<T extends string>(name: string, among: readonly T[]): T | undefined {
    const value = new FormData($<HTMLFormElement>("flash")).get(name);
    return among.find((x) => x === value);
}

function start(): void {
    const form = $<HTMLFormElement>("flash");
    const go = $<HTMLButtonElement>("go");
    const status = $("status");
    const bar = $<HTMLProgressElement>("bar");
    const log = $("log");
    const lines: string[] = [];

    if (!serial) {
        $("unsupported").hidden = false;
        go.disabled = true;
        return;
    }

    const say = (text: string, bad = false) => {
        status.textContent = text;
        status.classList.toggle("bad", bad);
    };

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const region = chosen("region", REGIONS);
        const kind = chosen<Kind>("kind", ["new", "update"]);
        if (!region || !kind) {
            return;
        }
        // The browser's list of ports, which only a click may open. Closing it is not an error.
        let port: unknown;
        try {
            port = await serial.requestPort();
        } catch {
            return;
        }
        go.disabled = true;
        $("working").hidden = false;
        $("done").hidden = true;
        $("failed").hidden = true;
        bar.removeAttribute("value");
        lines.length = 0;
        log.textContent = "";
        try {
            say("Fetching the image…");
            const data = await image(region, kind);
            await flash(port, data, ADDRESS[kind], {
                onStage: (stage) => {
                    say(STAGES[stage]);
                    if (stage !== "writing") {
                        bar.removeAttribute("value");
                    }
                },
                onProgress: (written, total) => {
                    bar.max = total;
                    bar.value = written;
                },
                onLog: (line) => {
                    lines.push(line);
                    log.textContent = lines.join("\n");
                },
            });
            bar.max = 1;
            bar.value = 1;
            say(`Done: the board runs Tern ${release.version} for ${region.toUpperCase()}.`);
            $("done").hidden = false;
        } catch (e) {
            bar.max = 1;
            bar.value = 0;
            say(`It did not work: ${e instanceof Error ? e.message : String(e)}`, true);
            $("failed").hidden = false;
        } finally {
            go.disabled = false;
        }
    });
}

start();
