// The page a group's join code opens (draft/groups.md in ternmesh/spec): HTTPS://TERNMESH.ORG/G#
// and the code in base32. The site serves /G with this one page (public/_redirects), and the code
// is after the #, which a browser sends to no site: it is read here, in the browser, and sent
// nowhere. public/_headers serves the page with a policy that lets it load nothing from another
// site and connect to nothing, so nothing on it could send the code on even if it tried.
//
// The code is the group's secret, so the first thing done is to take it out of the address bar
// and the page's entry in the tab's history, where it could be bookmarked, shared with the screen,
// or found again by going back. It is kept meanwhile in the tab's own storage, which no other tab
// and no other device sees, so that reloading the page still shows the group; and it is handed to
// the app the same way, never in a link. What the browser recorded before the page ran, this page
// cannot undo: the spec says so, and so does the page.

import { JOIN_LINK, readJoinCode, tappable } from "../companion/share.ts";
import { androidIntent, thisPhone } from "../openapp.ts";

/** Where the code waits in the tab's storage: for this page, and for /app, which takes it. */
export const JOIN_KEY = "tern.join";

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

/** The tab's storage, or null where the browser refuses it. */
function tabStorage(): Storage | null {
    try {
        return window.sessionStorage;
    } catch {
        return null;
    }
}

/**
 * Takes the code out of the address, keeping it in the tab's storage, and returns its link: the
 * one in the address if there is one, else the one kept from before, else null.
 */
export function takeLink(): string | null {
    const store = tabStorage();
    if (location.hash.length > 1) {
        const link = linkInHash(location.hash);
        window.history.replaceState(null, "", location.pathname + location.search);
        try {
            store?.setItem(JOIN_KEY, link);
        } catch {
            // Storage full or refused: the page still shows the code this once.
        }
        return link;
    }
    try {
        return store?.getItem(JOIN_KEY) ?? null;
    } catch {
        return null;
    }
}

const link = takeLink();

async function show(): Promise<void> {
    const code = link ? await readJoinCode(link) : null;
    if (!link || !code) {
        $("missing").hidden = false;
        return;
    }
    $("name").textContent = code.name === "" ? "A Tern group" : code.name;
    $("unnamed").hidden = code.name !== "";
    $("found").hidden = false;

    // To the app in the same tab, which takes the code from the tab's storage and forgets it there.
    $<HTMLAnchorElement>("join").addEventListener("click", () => {
        try {
            tabStorage()?.setItem(JOIN_KEY, link);
        } catch {
            // The app then asks for the code to be pasted.
        }
    });

    // Copied as text, the link's start is lower-case, so that a tap on a phone opens the app.
    $("copy").addEventListener("click", () => {
        navigator.clipboard.writeText(tappable(link)).then(
            () => ($("copied").textContent = "Copied."),
            () => ($("copied").textContent = "Your browser would not copy it."),
        );
    });

    // In a phone's browser, a way into the app: the link was opened here, not there. On Android
    // the code goes to the app in the intent, after the path's #, and to no site.
    const phone = thisPhone();
    if (phone === "android") {
        $<HTMLAnchorElement>("open-app").href = androidIntent(link);
        $("app-android").hidden = false;
    } else if (phone === "ios") {
        $("app-ios").hidden = false;
    }
}

void show();
// Another code put in the address bar changes only what follows the #, which loads nothing: the
// page reads it afresh, and takes it out of the address bar as before.
window.addEventListener("hashchange", () => location.reload());
