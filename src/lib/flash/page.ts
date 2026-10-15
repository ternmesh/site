// The flash page: choose a board, a region and what is on the board, pick the port, and watch it
// written; or, for a UF2 board, download its image to copy onto it.

import release from "../../data/firmware.json";
import { flash } from "./flash.ts";
import type { Image, Stage } from "./flash.ts";
import { check, layoutOf, parseSums, REGIONS, sparesNvs, writes } from "./images.ts";
import type { Family, Kind, Region } from "./images.ts";

/** A board the page offers, as flash.astro writes it into the page from the release's checksums. */
export interface Offer {
    name: string;
    title: string;
    maker: string;
    chip: "ESP32" | "ESP32-S3" | "nRF52840";
    family: Family;
    /** Flashed with a release and checked on a board, or only built for. */
    checked: boolean;
    note: string;
    /** An ESP32 board whose release has the OTA layout, which a phone can update afterwards. */
    ota: boolean;
    regions: Region[];
    /** A UF2 board's file for each region, under /firmware/. */
    files: Partial<Record<Region, string>>;
}

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

/**
 * The images for a choice, every one checked against the release's checksums before any is
 * written. An update leaves NVS alone, so a board keeps its address, contacts and sessions.
 */
async function images(board: string, region: Region, kind: Kind): Promise<Image[]> {
    const sums = parseSums(new TextDecoder().decode(await fetchBytes("/firmware/SHA256SUMS")));
    const plan = writes(release.version, board, region, kind, layoutOf(release.version, board, sums));
    return Promise.all(
        plan.map(async ({ name, address }) => {
            const data = await fetchBytes(`/firmware/${name}`);
            await check(name, data, sums);
            if (kind === "update") {
                sparesNvs(name, address, data.length);
            }
            return { data, address };
        }),
    );
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
    const select = $<HTMLSelectElement>("board");
    const download = $<HTMLAnchorElement>("download");
    const offers: Offer[] = JSON.parse($("offers").textContent ?? "[]");
    const offer = () => offers.find((o) => o.name === select.value) ?? offers[0]!;
    // While a board is being written, nothing on the form may change or start another write.
    let busy = false;
    const lock = (on: boolean) => {
        busy = on;
        for (const set of form.querySelectorAll("fieldset")) {
            set.disabled = on;
        }
        go.disabled = on || !serial;
    };

    // A link from the hardware page names its board: /flash?board=rak4631.
    const asked = new URLSearchParams(location.search).get("board");
    if (asked && offers.some((o) => o.name === asked)) {
        select.value = asked;
    }

    // What the page shows follows the board: whether it is checked, its regions, and how it is flashed.
    const show = () => {
        const o = offer();
        $("checked").hidden = !o.checked;
        $("unchecked").hidden = o.checked;
        $("note").hidden = o.note === "";
        $("note").textContent = o.note;
        for (const label of form.querySelectorAll<HTMLLabelElement>("label[data-region]")) {
            const offered = o.regions.includes(label.dataset.region as Region);
            label.hidden = !offered;
            const input = label.querySelector("input")!;
            input.disabled = !offered;
            if (!offered) {
                input.checked = false;
            }
        }
        const uf2 = o.family === "uf2";
        $("serial").hidden = uf2;
        $("uf2").hidden = !uf2;
        $("ota").hidden = !o.ota;
        for (const input of form.querySelectorAll<HTMLInputElement>("input[name=kind]")) {
            input.disabled = uf2;
        }
        const region = chosen("region", REGIONS);
        const file = region ? o.files[region] : undefined;
        download.href = file ? `/firmware/${file}` : "#";
        download.setAttribute("aria-disabled", String(!file));
        download.nextElementSibling?.toggleAttribute("hidden", Boolean(file));
        go.disabled = busy || !serial;
    };
    select.addEventListener("change", show);
    form.addEventListener("change", show);
    show();

    if (!serial) {
        $("unsupported").hidden = false;
    }

    const say = (text: string, bad = false) => {
        status.textContent = text;
        status.classList.toggle("bad", bad);
    };

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const o = offer();
        const region = chosen("region", REGIONS);
        const kind = chosen<Kind>("kind", ["new", "update"]);
        if (busy || !serial || o.family !== "esp32" || o.chip === "nRF52840" || !region || !kind) {
            return;
        }
        // The browser's list of ports, which only a click may open. Closing it is not an error.
        let port: unknown;
        try {
            port = await serial.requestPort();
        } catch {
            return;
        }
        lock(true);
        $("working").hidden = false;
        $("done").hidden = true;
        $("failed").hidden = true;
        bar.removeAttribute("value");
        lines.length = 0;
        log.textContent = "";
        try {
            say("Fetching the firmware…");
            await flash(port, await images(o.name, region, kind), { chip: o.chip, title: o.title }, {
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
            say(`Done: the ${o.title} runs Tern ${release.version} for ${region.toUpperCase()}.`);
            $("done").hidden = false;
        } catch (e) {
            bar.max = 1;
            bar.value = 0;
            say(`It did not work: ${e instanceof Error ? e.message : String(e)}`, true);
            $("failed").hidden = false;
        } finally {
            lock(false);
        }
    });
}

start();
