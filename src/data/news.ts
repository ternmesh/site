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
        date: "2026-11-20",
        what: "Firmware",
        title: "0.7.0-alpha.2",
        body: "Fixes a freeze that left an nRF52840 board such as the T1000-E advertising over Bluetooth but never answering, and adds a watchdog on every board. Leaves can sleep between polls of a relay that keeps their messages, a relay's owners can manage it over the mesh, and a chat deleted in an app is erased from the node and every client. Speaks companion version 17.",
        link: `${fw}/v0.7.0-alpha.2`,
    },
    {
        date: "2026-11-20",
        what: "Android",
        title: "0.5.0",
        body: "Shows and sets a node's sleep, deletes a chat from the node and every client of it, and manages a relay you own over the mesh. Speaks companion version 17.",
        link: `${android}/v0.5.0`,
    },
    {
        date: "2026-11-20",
        what: "Apple",
        title: "0.6.0",
        body: "Shows and sets a node's sleep, deletes a chat from the node and every client of it, and manages a relay you own over the mesh. Speaks companion version 17.",
        link: `${apple}/v0.6.0`,
    },
    {
        date: "2026-11-20",
        what: "Site",
        title: "The web app speaks companion version 17",
        body: "/app shows and sets a node's sleep, deletes a chat from the node and every client, and manages a relay you own over the mesh: its settings, its owners, its Bluetooth lock and a restart.",
        link: "/app",
    },
    {
        date: "2026-11-18",
        what: "Android",
        title: "0.4.1",
        body: "The list of nodes to connect to stays in the order they were found instead of jumping by signal strength, and a connection no longer drops for discovering its services twice.",
        link: `${android}/v0.4.1`,
    },
    {
        date: "2026-11-18",
        what: "Apple",
        title: "0.5.1",
        body: "The list of nodes to connect to stays in the order they were found instead of jumping by signal strength.",
        link: `${apple}/v0.5.1`,
    },
    {
        date: "2026-11-18",
        what: "Firmware",
        title: "0.7.0-alpha.1",
        body: "A security and privacy release. Announces no longer carry a node's address, updates are signed and checked, a board without a screen pairs only just after it is turned on or its button is pressed, and a client can erase a board. Acknowledgements, sessions, first contact and groups are hardened. It does not talk to 0.6: update every board you use.",
        link: `${fw}/v0.7.0-alpha.1`,
    },
    {
        date: "2026-11-18",
        what: "Android",
        title: "0.4.0",
        body: "Checks every firmware image's signature before sending it, works with nodes' new blinded routing ids, explains the pairing window when pairing fails, and can erase a node. Speaks companion version 14.",
        link: `${android}/v0.4.0`,
    },
    {
        date: "2026-11-18",
        what: "Apple",
        title: "0.5.0",
        body: "Checks every firmware image's signature before sending it, works with nodes' new blinded routing ids, explains the pairing window when pairing fails, and can erase a node. Speaks companion version 14.",
        link: `${apple}/v0.5.0`,
    },
    {
        date: "2026-11-17",
        what: "Firmware",
        title: "0.6.0-alpha.1",
        body: "A phone can update a Heltec T114 or a Seeed T1000-E over Bluetooth, through the board's bootloader, and the board keeps everything it saved. The T1000-E needs the OTAFIX bootloader installed once. The screen has five pages and a menu, and the T114 a colour layout of its own.",
        link: `${fw}/v0.6.0-alpha.1`,
    },
    {
        date: "2026-11-17",
        what: "Android",
        title: "0.3.0",
        body: "Updates an nRF52840 node over Bluetooth through its bootloader, as firmware 0.6.0-alpha.1 offers, in about five to eight minutes. Speaks companion version 12.",
        link: `${android}/v0.3.0`,
    },
    {
        date: "2026-11-17",
        what: "Apple",
        title: "0.4.0",
        body: "Updates an nRF52840 node over Bluetooth through its bootloader, as firmware 0.6.0-alpha.1 offers. Speaks companion version 12.",
        link: `${apple}/v0.4.0`,
    },
    {
        date: "2026-11-17",
        what: "Site",
        title: "Update an nRF52840 node from the browser",
        body: "/app can update a Heltec T114 or a Seeed T1000-E over Web Bluetooth, through its bootloader, and latest.json lists each nRF52840 board's DFU package for the phone apps.",
        link: "/app",
    },
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
