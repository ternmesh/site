// The firmware images a release carries (ternmesh/firmware, ports/heltec-v3/release.sh), and
// where this site keeps its copy of them: tools/firmware.ts fetches them at build time, since a
// page cannot read a GitHub release's files itself.

export const REGIONS = ["us915", "eu868"] as const;
export type Region = (typeof REGIONS)[number];

/** `new` writes the whole flash; `update` the application alone, and the board keeps its keys. */
export type Kind = "new" | "update";

export const ADDRESS: Record<Kind, number> = { new: 0x0, update: 0x10000 };

export function imageName(version: string, region: Region, kind: Kind): string {
    return `tern-heltec-v3-${region}-${version}${kind === "update" ? "-app" : ""}.bin`;
}

export function imageNames(version: string): string[] {
    return REGIONS.flatMap((r) => [imageName(version, r, "new"), imageName(version, r, "update")]);
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
