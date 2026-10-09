// Which firmware a node could be given over its link: the release ternmesh.org offers, read from
// /firmware/latest.json (tools/firmware.ts writes it), the image in it for the node's board and
// region, and whether that release is later than the node's, by Semantic Versioning's order.

import type { Manifest, ManifestImage } from "../flash/images.ts";

/**
 * SemVer 2.0.0's order: negative if `a` comes before `b`, positive after, 0 for the same. A
 * version that does not read as one comes before every one that does.
 */
export function compareVersions(a: string, b: string): number {
    const pa = parse(a);
    const pb = parse(b);
    if (!pa || !pb) {
        return (pa ? 1 : 0) - (pb ? 1 : 0);
    }
    for (let i = 0; i < 3; i++) {
        if (pa.core[i] !== pb.core[i]) {
            return pa.core[i]! < pb.core[i]! ? -1 : 1;
        }
    }
    // A prerelease comes before the release it leads to.
    if (pa.pre.length === 0 || pb.pre.length === 0) {
        return (pa.pre.length === 0 ? 1 : 0) - (pb.pre.length === 0 ? 1 : 0);
    }
    for (let i = 0; i < Math.min(pa.pre.length, pb.pre.length); i++) {
        const x = pa.pre[i]!;
        const y = pb.pre[i]!;
        const nx = /^\d+$/.test(x);
        const ny = /^\d+$/.test(y);
        if (nx && ny && BigInt(x) !== BigInt(y)) {
            return BigInt(x) < BigInt(y) ? -1 : 1;
        }
        if (nx !== ny) {
            return nx ? -1 : 1; // numbers come before words
        }
        if (!nx && x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return Math.sign(pa.pre.length - pb.pre.length);
}

function parse(v: string): { core: bigint[]; pre: string[] } | null {
    const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
    if (!m) {
        return null;
    }
    return { core: [BigInt(m[1]!), BigInt(m[2]!), BigInt(m[3]!)], pre: m[4] ? m[4].split(".") : [] };
}

/** The manifest's image for a board and region, as the node reports them, or null if there is none. */
export function imageFor(manifest: Manifest, board: string, region: string): ManifestImage | null {
    if (board === "" || region === "") {
        return null;
    }
    return (
        manifest.images.find((i) => i.board === board && i.region.toUpperCase() === region.toUpperCase()) ?? null
    );
}

/** Reads latest.json, or throws if it is not one. */
export function readManifest(json: unknown): Manifest {
    const m = json as Partial<Manifest> | null;
    if (!m || typeof m.release !== "string" || !Array.isArray(m.images)) {
        throw new Error("the firmware list is not one this page can read");
    }
    const images = m.images.filter(
        (i): i is ManifestImage =>
            typeof i?.board === "string" &&
            typeof i.region === "string" &&
            typeof i.file === "string" &&
            /^[\w.-]+$/.test(i.file) &&
            Number.isInteger(i.size) &&
            i.size > 0 &&
            typeof i.sha256 === "string" &&
            /^[0-9a-f]{64}$/.test(i.sha256),
    );
    return { release: m.release, images };
}

/**
 * What the site offers a node: the release and its image, or null if there is nothing newer for
 * its board and region. A site with no latest.json has nothing a phone or a page may send.
 */
export async function offerFor(
    board: string,
    region: string,
    release: string,
    fetcher: typeof fetch = fetch,
): Promise<{ release: string; image: ManifestImage } | null> {
    const res = await fetcher("/firmware/latest.json", { cache: "no-store" });
    if (res.status === 404) {
        return null;
    }
    if (!res.ok) {
        throw new Error(`the firmware list did not load (${res.status})`);
    }
    const manifest = readManifest(await res.json());
    const image = imageFor(manifest, board, region);
    if (!image || compareVersions(manifest.release, release) <= 0) {
        return null;
    }
    return { release: manifest.release, image };
}

/** Fetches an image and checks it is the one the manifest names, or throws. */
export async function fetchImage(image: ManifestImage, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
    const res = await fetcher(`/firmware/${image.file}`);
    if (!res.ok) {
        throw new Error(`the firmware did not download (${res.status})`);
    }
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length !== image.size) {
        throw new Error("the firmware downloaded is not the size the list gives");
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    const got = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    if (got !== image.sha256) {
        throw new Error("the firmware downloaded is not the one the list names: it was not sent");
    }
    return data;
}
