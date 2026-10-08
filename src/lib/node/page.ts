// The page a node's QR code opens (draft/sharing.md in ternmesh/spec): the link is the URL itself,
// /A/ or /a/ and the address in base32, which the site serves with this one page (public/_redirects).
// Everything is read here, in the browser; nothing is fetched.

import { LINK, addressText, readAddress, shortCode } from "../companion/share.ts";

function $<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) {
        throw new Error(`no #${id}`);
    }
    return el as T;
}

/** The address in this page's URL, or null. Only the path counts: /A/ or /a/ and the base32. */
export function addressInPath(path: string): string | null {
    const m = /^\/a\/([^/]+)\/?$/i.exec(path);
    return m ? readAddress(LINK + m[1]) : null;
}

async function show(): Promise<void> {
    const address = addressInPath(location.pathname);
    if (!address) {
        $("missing").hidden = false;
        return;
    }
    const text = addressText(address);
    $("address").textContent = text.replace(/(.{8})(?!$)/g, "$1 ");
    $("code").textContent = await shortCode(address);
    $<HTMLAnchorElement>("add").href = `/app?add=${address}`;
    $("found").hidden = false;

    $("copy").addEventListener("click", () => {
        navigator.clipboard.writeText(text).then(
            () => ($("copied").textContent = "Copied."),
            () => ($("copied").textContent = "Your browser would not copy it: select the address and copy it yourself."),
        );
    });
}

void show();
