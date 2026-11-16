// Which firmware release the site should offer, of those ternmesh/firmware has published: the
// latest by Semantic Versioning's order, if it is later than the one offered now. A release on an
// older line published after a newer one (a fix to 0.4 after 0.5) is not offered over it.

import { compareVersions } from "../companion/release.ts";

const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** The version to offer instead of `current`, from the releases' tags (`v0.5.0-alpha.2`), or null. */
export function newerRelease(current: string, tags: readonly string[]): string | null {
    let latest: string | null = null;
    for (const tag of tags) {
        const version = TAG.exec(tag.trim())?.[1];
        if (version && (latest === null || compareVersions(version, latest) > 0)) {
            latest = version;
        }
    }
    return latest !== null && compareVersions(latest, current) > 0 ? latest : null;
}
