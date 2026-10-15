// What is new in Tern, newest first: each firmware and app release, and what changed on this site
// that a user would notice. /news lists them. A release's own notes are the full account; an entry
// here is what it brought, in a few lines, and links to them.
//
// Adding a release is adding an entry at the top, in the same pull request that offers it.

export interface Entry {
    /** YYYY-MM-DD, the day it came out. */
    date: string;
    what: "Firmware" | "Android" | "Apple" | "Site";
    title: string;
    body: string;
    link: string;
}

const fw = "https://github.com/ternmesh/firmware/releases/tag";
const android = "https://github.com/ternmesh/android/releases/tag";
const apple = "https://github.com/ternmesh/apple/releases/tag";

export const news: Entry[] = [
    {
        date: "2026-10-15",
        what: "Site",
        title: "Every board on the flash page",
        body: "The flash page offers all sixteen boards the firmware is built for, not only the Heltec V3: an ESP32 board is written over USB, and an nRF52840 board gets its .uf2 to copy on. The phone apps can update every ESP32 board over Bluetooth. The boards not yet checked on hardware say so.",
        link: "/flash",
    },
    {
        date: "2026-10-14",
        what: "Firmware",
        title: "0.5.0-alpha.1",
        body: "A board keeps to an airtime budget and tells the phone when a message waits for it, a leaf carried somewhere else finds the relays there, a board with a GPS knows where it is, and a phone can turn a board off.",
        link: `${fw}/v0.5.0-alpha.1`,
    },
    {
        date: "2026-10-11",
        what: "Firmware",
        title: "0.4.0-alpha.1",
        body: "Five more regions: Chile, Malaysia, Thailand, Russia and Kazakhstan. Routing announces are signed, a board shows who is about through presence cards, a group can be joined from a code, and there are images for thirteen more boards.",
        link: `${fw}/v0.4.0-alpha.1`,
    },
    {
        date: "2026-10-11",
        what: "Android",
        title: "Android 0.2.0",
        body: "Groups handed on and joined by a join code, as a link or a QR code. Who is about, from the presence cards the node has heard, and the node's own card. Every region the firmware has.",
        link: `${android}/v0.2.0`,
    },
    {
        date: "2026-10-11",
        what: "Apple",
        title: "iPhone, iPad and Mac 0.2.0",
        body: "Join codes, shown and joined from. Who is about, from Contacts, and the node's presence card on the Node screen. Every region the firmware has, and ternmesh.org links that open the app.",
        link: `${apple}/v0.2.0`,
    },
    {
        date: "2026-10-09",
        what: "Firmware",
        title: "0.3.0-alpha.1",
        body: "A board shares its position with the contacts and groups its user chooses, a group message recorded off the air is no longer read a second time, and there are images for two more boards.",
        link: `${fw}/v0.3.0-alpha.1`,
    },
    {
        date: "2026-10-09",
        what: "Firmware",
        title: "0.2.0-alpha.1",
        body: "A board can be given new firmware over its companion link, without a cable once it runs this release, and it keeps its messages through a restart.",
        link: `${fw}/v0.2.0-alpha.1`,
    },
    {
        date: "2026-10-09",
        what: "Android",
        title: "Android 0.1.0",
        body: "The first release: pairs with a node over Bluetooth and stays connected in the background, chats with contacts and groups with notifications, adds contacts by QR code, shares positions on a map, and updates the node's firmware.",
        link: `${android}/v0.1.0`,
    },
    {
        date: "2026-10-09",
        what: "Apple",
        title: "iPhone, iPad and Mac 0.1.0",
        body: "The first release, on TestFlight: the same node, chats, contacts, positions and firmware updates as on Android, on iPhone, iPad and the Mac.",
        link: `${apple}/v0.1.0`,
    },
    {
        date: "2026-10-08",
        what: "Firmware",
        title: "0.1.0-alpha.1 to alpha.4",
        body: "The first four alphas, for the Heltec V3: two boards that find each other and send encrypted messages, then routes through relays, first contact through relays too, and groups.",
        link: `${fw}/v0.1.0-alpha.4`,
    },
];
