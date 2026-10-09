// The firmware images a release carries (ternmesh/firmware, ports/heltec-v3/release.sh), and
// where this site keeps its copy of them: tools/firmware.ts fetches them at build time, since a
// page cannot read a GitHub release's files itself.

export const REGIONS = ["us915", "eu868"] as const;
export type Region = (typeof REGIONS)[number];

/** `new` writes the whole flash; `update` everything but NVS, and the board keeps its keys. */
export type Kind = "new" | "update";

/**
 * The files a release has for a region: `whole` is the flash from 0x0, NVS blank; `boot` the
 * bootloader and partition table, stopping where NVS starts; `update` the flash from otadata on,
 * otadata blank; `app` the application alone, which is what a phone sends over Bluetooth.
 */
export type Part = "whole" | "boot" | "update" | "app";

/**
 * How a release lays out the flash. `ota` is two app slots after otadata, which a phone can
 * update; `single` is ESP-IDF's one app at 0x10000, every release up to 0.1.0-alpha.4. A
 * `single` release has no `boot` or `update` part, and its update writes `app` at 0x10000.
 * `single` can go once the site pins no release from before the OTA layout.
 */
export type Layout = "ota" | "single";

/** Where NVS is, in both layouts: the node's identity, contacts, sessions and bonds. */
export const NVS = { start: 0x9000, end: 0xf000 } as const;

export function imageName(version: string, region: Region, part: Part): string {
    return `tern-heltec-v3-${region}-${version}${part === "whole" ? "" : `-${part}`}.bin`;
}

/** A release is `ota` if its checksums name a `boot` or `update` part; a missing one is then an error. */
export function layoutOf(version: string, sums: Map<string, string>): Layout {
    const named = (r: Region, p: Part) => sums.has(imageName(version, r, p));
    return REGIONS.some((r) => named(r, "boot") || named(r, "update")) ? "ota" : "single";
}

const PARTS: Record<Layout, Part[]> = { ota: ["whole", "boot", "update", "app"], single: ["whole", "app"] };

/** Every image a release of this layout has, which is what the site keeps a copy of. */
export function imageNames(version: string, layout: Layout): string[] {
    return REGIONS.flatMap((r) => PARTS[layout].map((p) => imageName(version, r, p)));
}

export interface Write {
    name: string;
    address: number;
}

/** What flashing a region's `kind` writes, and where, in one go. */
export function writes(version: string, region: Region, kind: Kind, layout: Layout): Write[] {
    if (kind === "new") {
        return [{ name: imageName(version, region, "whole"), address: 0x0 }];
    }
    if (layout === "single") {
        return [{ name: imageName(version, region, "app"), address: 0x10000 }];
    }
    return [
        { name: imageName(version, region, "boot"), address: 0x0 },
        { name: imageName(version, region, "update"), address: NVS.end },
    ];
}

/** Throws if writing `length` bytes at `address` would touch NVS, which an update must keep. */
export function sparesNvs(name: string, address: number, length: number): void {
    if (address < NVS.end && address + length > NVS.start) {
        throw new Error(`${name} would overwrite the board's keys (NVS, 0x9000 to 0xf000): nothing was written`);
    }
}

/** One app image in latest.json: what the Tern phone apps read to update a node over Bluetooth. */
export interface ManifestImage {
    board: "heltec-v3";
    /** As the node reports its region: US915, EU868. */
    region: string;
    /** Relative to /firmware/. */
    file: string;
    size: number;
    sha256: string;
}

export interface Manifest {
    release: string;
    images: ManifestImage[];
}

/** latest.json for an `ota` release, from the app images themselves. */
export async function manifest(version: string, images: Map<string, Uint8Array>): Promise<Manifest> {
    const list: ManifestImage[] = [];
    for (const region of [...REGIONS].sort()) {
        const file = imageName(version, region, "app");
        const data = images.get(file);
        if (!data) {
            throw new Error(`latest.json needs ${file}`);
        }
        const hex = await sha256(data);
        list.push({ board: "heltec-v3", region: region.toUpperCase(), file, size: data.length, sha256: hex });
    }
    return { release: version, images: list };
}

/** SHA256SUMS as sha256sum writes it: a name to its 64 hex digits. Lines it cannot read are an error. */
export function parseSums(text: string): Map<string, string> {
    const sums = new Map<string, string>();
    for (const line of text.split("\n")) {
        if (line.trim() === "") {
            continue;
        }
        const m = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line.trim());
        if (!m) {
            throw new Error(`SHA256SUMS has a line that is not a checksum: ${line}`);
        }
        sums.set(m[2]!, m[1]!);
    }
    return sums;
}

export async function sha256(data: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Throws unless the image is the one the checksums name. */
export async function check(name: string, data: Uint8Array, sums: Map<string, string>): Promise<void> {
    const want = sums.get(name);
    if (!want) {
        throw new Error(`SHA256SUMS does not name ${name}`);
    }
    const got = await sha256(data);
    if (got !== want) {
        throw new Error(`${name} is not the release's: its SHA-256 is ${got}, not ${want}`);
    }
}
