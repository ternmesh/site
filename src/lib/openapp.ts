// Opening a node's or a join code's link in the Tern app from the page the link opened in a
// phone's browser. A link tapped in a browser on the link's own site is not handed to the app:
// Android hands one on from another app or from an intent:// link, and iOS only from another app
// or another site. So on Android the page offers an intent:// link to the same link, for the app
// by its package; on iOS it can only say how. Nothing here touches the network.

import { tappable } from "./companion/share.ts";

/** The Android app's package, as public/.well-known/assetlinks.json names it. */
export const ANDROID_PACKAGE = "org.ternmesh.app";
/** The Android app itself, the newest release. */
export const ANDROID_APK = "https://github.com/ternmesh/android/releases/latest/download/tern.apk";
/** The iPhone, iPad and Mac app's beta, through Apple's TestFlight. */
export const TESTFLIGHT = "https://testflight.apple.com/join/Et3BuD5c";
/** Where a phone without the app is sent instead: the page that says how to get it. */
export const FALLBACK = "https://ternmesh.org/apps";

export type Phone = "android" | "ios" | null;

/** Which phone, if any, a browser runs on, from its user agent and its touch points: an iPad
 * asking for the desktop site says it is a Mac, and only its touch screen tells it apart. */
export function phoneOf(userAgent: string, platform = "", touchPoints = 0): Phone {
    if (/Android/i.test(userAgent)) {
        return "android";
    }
    if (/iPhone|iPad|iPod/.test(userAgent) || (platform === "MacIntel" && touchPoints > 1)) {
        return "ios";
    }
    return null;
}

/** The phone this page runs on, if any. */
export function thisPhone(): Phone {
    return phoneOf(navigator.userAgent, navigator.platform, navigator.maxTouchPoints ?? 0);
}

/**
 * An intent:// link that opens `link`, a node's or a join code's link in either case, in the
 * Android app, or the apps page where the app is not installed. Android takes the intent's data
 * as all before the last #, so a join code's own # and code are kept: they reach the app and are
 * not sent to any site.
 */
export function androidIntent(link: string): string {
    const tap = tappable(link);
    if (!tap.startsWith("https://")) {
        throw new Error("not a link");
    }
    return (
        `intent://${tap.slice("https://".length)}#Intent;scheme=https;package=${ANDROID_PACKAGE};` +
        `S.browser_fallback_url=${encodeURIComponent(FALLBACK)};end`
    );
}
