// The firmware images a release carries (ternmesh/firmware, ports/esp32/release.sh and
// ports/nrf52/release.sh), and where this site keeps its copy of them: tools/firmware.ts fetches
// them at build time, since a page cannot read a GitHub release's files itself.

/** Every region the firmware has a profile for. A release has images for some of them: regionsOf. */
export const REGIONS = [
    "au915",
    "cl915",
    "eu868",
    "kz863",
    "my919",
    "nz915",
    "ru868",
    "th920",
    "us915",
] as const;
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

/**
 * How a board takes an image: `esp32` boards are written over USB serial from this site (ESP32
 * and ESP32-S3 share one flash layout, ports/esp32/partitions*.csv), and `uf2` boards, the
 * nRF52840 ones, take a `.uf2` file copied onto the drive their bootloader shows (and, from
 * 0.6.0, an update from a phone or this site by their bootloader over Bluetooth: packageName).
 */
export type Family = "esp32" | "uf2";

/** An ESP32 board's image of a region: `tern-<board>-<region>-<version>[-<part>].bin`. */
export function imageName(version: string, board: string, region: Region, part: Part): string {
    return `tern-${board}-${region}-${version}${part === "whole" ? "" : `-${part}`}.bin`;
}

/** A UF2 board's image of a region: `tern-<board>-<region>-<version>.uf2`. */
export function uf2Name(version: string, board: string, region: Region): string {
    return `tern-${board}-${region}-${version}.uf2`;
}

/**
 * A UF2 board's DFU package of a region, `tern-<board>-<region>-<version>.zip`: the same firmware
 * as its `.uf2`, as an init packet and the application, which the board's bootloader takes over
 * Bluetooth (draft/companion.md, "By the bootloader"). Releases from 0.6.0 carry one.
 */
export function packageName(version: string, board: string, region: Region): string {
    return `tern-${board}-${region}-${version}.zip`;
}

/**
 * Whether a UF2 board's release has DFU packages: it has if its checksums name one, and a region
 * without one is then an error. A release from before 0.6.0 names none.
 */
export function hasPackages(version: string, board: string, sums: Map<string, string>): boolean {
    return REGIONS.some((r) => sums.has(packageName(version, board, r)));
}

/**
 * An ESP32 board's release is `ota` if its checksums name a `boot` or `update` part; a missing one
 * is then an error.
 */
export function layoutOf(version: string, board: string, sums: Map<string, string>): Layout {
    const named = (r: Region, p: Part) => sums.has(imageName(version, board, r, p));
    return REGIONS.some((r) => named(r, "boot") || named(r, "update")) ? "ota" : "single";
}

/**
 * The regions a release has a board's images for, which its checksums name: the firmware gained
 * a region's profile before a release carried it, and a release from before then has none for it.
 */
export function regionsOf(version: string, board: string, family: Family, sums: Map<string, string>): Region[] {
    const name = (r: Region) => (family === "uf2" ? uf2Name(version, board, r) : imageName(version, board, r, "whole"));
    return REGIONS.filter((r) => sums.has(name(r)));
}

const PARTS: Record<Layout, Part[]> = { ota: ["whole", "boot", "update", "app"], single: ["whole", "app"] };

/** Every image a release of this layout has for an ESP32 board's regions, which is what the site keeps a copy of. */
export function imageNames(version: string, board: string, layout: Layout, regions: readonly Region[]): string[] {
    return regions.flatMap((r) => PARTS[layout].map((p) => imageName(version, board, r, p)));
}

export interface Write {
    name: string;
    address: number;
}

/** What flashing an ESP32 board's region `kind` writes, and where, in one go. */
export function writes(version: string, board: string, region: Region, kind: Kind, layout: Layout): Write[] {
    if (kind === "new") {
        return [{ name: imageName(version, board, region, "whole"), address: 0x0 }];
    }
    if (layout === "single") {
        return [{ name: imageName(version, board, region, "app"), address: 0x10000 }];
    }
    return [
        { name: imageName(version, board, region, "boot"), address: 0x0 },
        { name: imageName(version, board, region, "update"), address: NVS.end },
    ];
}

/** Throws if writing `length` bytes at `address` would touch NVS, which an update must keep. */
export function sparesNvs(name: string, address: number, length: number): void {
    if (address < NVS.end && address + length > NVS.start) {
        throw new Error(`${name} would overwrite the board's keys (NVS, 0x9000 to 0xf000): nothing was written`);
    }
}

/**
 * How a node takes an image: `link` over the companion link itself (UPDATE_BEGIN), as an ESP32
 * board does, or `bootloader` by its bootloader over Bluetooth, as an nRF52840 board does, which
 * has no room for a second image (UPDATE_BOOTLOADER). INFO's `update` says which, as 1 or 2.
 */
export type UpdateWay = "link" | "bootloader";

/** One image in latest.json: what the Tern phone apps read to update a node over Bluetooth. */
export interface ManifestImage {
    /** As the node reports its board in INFO, which is the name its images carry. */
    board: string;
    /** As the node reports its region: US915, EU868, AU915 and the rest of REGIONS, upper case. */
    region: string;
    /** Relative to /firmware/. */
    file: string;
    size: number;
    sha256: string;
    /**
     * `bootloader` for a DFU package; absent for an app image sent over the link, which is every
     * entry an app from before version 12 of the companion protocol knows.
     */
    update?: "bootloader";
    /**
     * The file's signature by a release key (its `.sig`), as 128 lower-case hex digits: over
     * "TERN-FIRMWARE-V1" || the 32 bytes of `sha256` (draft/companion.md, "Signed images";
     * docs/signing.md in ternmesh/firmware). Absent for a release from before releases were signed,
     * 0.6.0-alpha.1 and earlier.
     */
    signature?: string;
}

export interface Manifest {
    release: string;
    images: ManifestImage[];
}

/**
 * latest.json for a release: the app image of each `ota` ESP32 board's regions, which a node takes
 * over the link, and the DFU package of each UF2 board's regions that has them, which its
 * bootloader takes (`update` is then "bootloader"). An entry for the link has no `update`, so the
 * file a release with no packages makes is the one it made before there were any. Given the
 * release's signatures, by file, each entry carries its own; without them, as for a release from
 * before signing, none does, and the file is the one it made before there were any.
 */
export async function manifest(
    version: string,
    boards: readonly { board: string; regions: readonly Region[]; update?: UpdateWay }[],
    images: Map<string, Uint8Array>,
    signatures?: Map<string, Uint8Array>,
): Promise<Manifest> {
    const list: ManifestImage[] = [];
    for (const { board, regions, update } of [...boards].sort((a, b) => a.board.localeCompare(b.board))) {
        for (const region of [...regions].sort()) {
            const bootloader = update === "bootloader";
            const file = bootloader ? packageName(version, board, region) : imageName(version, board, region, "app");
            const data = images.get(file);
            if (!data) {
                throw new Error(`latest.json needs ${file}`);
            }
            const hex = await sha256(data);
            const image: ManifestImage = { board, region: region.toUpperCase(), file, size: data.length, sha256: hex };
            if (bootloader) {
                image.update = "bootloader";
            }
            if (signatures) {
                const sig = signatures.get(file);
                if (!sig) {
                    throw new Error(`latest.json needs ${file}.sig`);
                }
                image.signature = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
            }
            list.push(image);
        }
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
