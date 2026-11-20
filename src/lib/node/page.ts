// The page a node's QR code opens (draft/sharing.md in ternmesh/spec): the link is the URL itself,
// /A/ or /a/ and the address in base32, which the site serves with this one page (public/_redirects).
// Everything is read here, in the browser; nothing is fetched.

import { LINK, addressTapLink, addressText, readAddress, shortCode } from "../companion/share.ts";
import { androidIntent, thisPhone } from "../openapp.ts";

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

    // In a phone's browser, a way into the app: the link was opened here, not there.
    const link = addressTapLink(address);
    const phone = thisPhone();
    if (phone === "android") {
        $<HTMLAnchorElement>("open-app").href = androidIntent(link);
        $("app-android").hidden = false;
    } else if (phone === "ios") {
        $("app-link").textContent = link;
        $("copy-link").addEventListener("click", () => {
            navigator.clipboard.writeText(link).then(
                () => ($("link-copied").textContent = "Copied. Paste it in the Tern app."),
                () => ($("link-copied").textContent = "Your browser would not copy it: select the link and copy it yourself."),
            );
        });
        $("app-ios").hidden = false;
    }
}

void show();
