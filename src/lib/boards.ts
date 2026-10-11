// Which boards a firmware release has images for, read from its SHA256SUMS: the hardware page
// says which boards can be flashed from a release, and stays right when the site pins another.

import { REGIONS } from "./flash/images.ts";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The boards a release's checksums name an image for. An image is `tern-<board>-<region>-<version>`
 * then `.bin`, `.uf2` or `-<part>.bin`; a board's name may itself have hyphens (`heltec-wsl-v3`).
 */
export function boardsOf(version: string, sums: Map<string, string>): Set<string> {
    const pattern = new RegExp(`^tern-(.+)-(?:${REGIONS.join("|")})-${escape(version)}(?:\\.bin|\\.uf2|-[a-z]+\\.bin)$`);
    const boards = new Set<string>();
    for (const name of sums.keys()) {
        const m = pattern.exec(name);
        if (m) {
            boards.add(m[1]);
        }
    }
    return boards;
}
