// The page a group's join code opens (draft/groups.md in ternmesh/spec): HTTPS://TERNMESH.ORG/G#
// and the code in base32. The site serves /G with this one page (public/_redirects), and the code
// is after the #, which a browser sends to no site: it is read here, in the browser, and sent
// nowhere. Joining is for a node: this page hands the code on to the app, after its # again.

import { JOIN_LINK, readJoinCode } from "../companion/share.ts";

function $<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) {
        throw new Error(`no #${id}`);
    }
    return el as T;
}

/** The join code's link this page was opened with, as the code was written: what follows the #. */
export function linkInHash(hash: string): string {
    return JOIN_LINK + hash.replace(/^#/, "");
}

async function show(): Promise<void> {
    const link = linkInHash(location.hash);
    const code = location.hash.length > 1 ? await readJoinCode(link) : null;
    if (!code) {
        $("missing").hidden = false;
        return;
    }
    $("name").textContent = code.name === "" ? "A Tern group" : code.name;
    $("unnamed").hidden = code.name !== "";
    $<HTMLAnchorElement>("join").href = `/app#join=${encodeURIComponent(link)}`;
    $("found").hidden = false;

    $("copy").addEventListener("click", () => {
        navigator.clipboard.writeText(link).then(
            () => ($("copied").textContent = "Copied."),
            () => ($("copied").textContent = "Your browser would not copy it: copy the address bar instead."),
        );
    });
}

void show();
// Another code put in the address bar changes only what follows the #, which loads nothing: the
// page reads it afresh.
window.addEventListener("hashchange", () => location.reload());
