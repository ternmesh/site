// The boards the firmware is built for, as ternmesh/firmware's docs/boards.md lists them: that
// table is the source, and this follows it. `name` is the board's name in the firmware, which its
// images and INFO carry; whether the pinned release has an image for it the hardware page reads
// from the release itself (src/lib/boards.ts).

import type { Family } from "../lib/flash/images.ts";

export interface Board {
    name: string;
    title: string;
    maker: "Heltec" | "LilyGo" | "RAKwireless" | "Seeed";
    chip: "ESP32-S3" | "ESP32" | "nRF52840";
    radio: "SX1262" | "SX1276";
    /** Runs: flashed with a release and checked on a board. Built: CI builds it, nobody has run it yet. */
    status: "runs" | "built";
    /** What a buyer should know: a missing screen, button or GPS. */
    note?: string;
    /** The maker's page for it, where it is sold or where its sellers are listed; none once it is no longer made. */
    buy?: string;
}

export const makers: Record<Board["maker"], string> = {
    Heltec: "https://heltec.org",
    LilyGo: "https://lilygo.cc",
    RAKwireless: "https://www.rakwireless.com",
    Seeed: "https://www.seeedstudio.com",
};

export const boards: Board[] = [
    {
        name: "heltec-v3",
        title: "Heltec WiFi LoRa 32 V3",
        maker: "Heltec",
        chip: "ESP32-S3",
        radio: "SX1262",
        status: "runs",
        buy: "https://heltec.org/project/wifi-lora-32-v3/",
    },
    {
        name: "heltec-v4",
        title: "Heltec WiFi LoRa 32 V4 (V4.2, V4.3)",
        maker: "Heltec",
        chip: "ESP32-S3",
        radio: "SX1262",
        status: "built",
        note: "A 28 dBm amplifier: mind what your region allows into the antenna.",
        buy: "https://heltec.org/project/wifi-lora-32-v4/",
    },
    {
        name: "heltec-wsl-v3",
        title: "Heltec Wireless Stick Lite V3",
        maker: "Heltec",
        chip: "ESP32-S3",
        radio: "SX1262",
        status: "built",
        note: "No screen.",
        buy: "https://heltec.org/project/wireless-stick-lite-v2/",
    },
    {
        name: "heltec-tracker",
        title: "Heltec Wireless Tracker (V1.0, V1.1)",
        maker: "Heltec",
        chip: "ESP32-S3",
        radio: "SX1262",
        status: "built",
        note: "Its colour screen is not driven yet.",
        buy: "https://heltec.org/project/wireless-tracker/",
    },
    {
        name: "heltec-vme290",
        title: "Heltec Vision Master E290",
        maker: "Heltec",
        chip: "ESP32-S3",
        radio: "SX1262",
        status: "built",
        note: "E-paper.",
        buy: "https://heltec.org/project/vision-master-e290/",
    },
    {
        name: "heltec-vme213",
        title: "Heltec Vision Master E213",
        maker: "Heltec",
        chip: "ESP32-S3",
        radio: "SX1262",
        status: "built",
        note: "Its e-paper is not driven yet.",
        buy: "https://heltec.org/project/vision-master-e213/",
    },
    {
        name: "heltec-paper",
        title: "Heltec Wireless Paper",
        maker: "Heltec",
        chip: "ESP32-S3",
        radio: "SX1262",
        status: "built",
        note: "Its e-paper is not driven yet.",
        buy: "https://heltec.org/project/wireless-paper/",
    },
    { name: "heltec-v2", title: "Heltec WiFi LoRa 32 V2", maker: "Heltec", chip: "ESP32", radio: "SX1276", status: "built" },
    { name: "heltec-v21", title: "Heltec WiFi LoRa 32 V2.1", maker: "Heltec", chip: "ESP32", radio: "SX1276", status: "built" },
    {
        name: "lilygo-tbeam",
        title: "LilyGo T-Beam V1.0, V1.1 (868/915 MHz)",
        maker: "LilyGo",
        chip: "ESP32",
        radio: "SX1276",
        status: "built",
        note: "Its GPS gives the node its position.",
        buy: "https://lilygo.cc/products/t-beam",
    },
    {
        name: "lilygo-tbeam12",
        title: "LilyGo T-Beam V1.2 (868/915 MHz)",
        maker: "LilyGo",
        chip: "ESP32",
        radio: "SX1276",
        status: "built",
        note: "Its GPS gives the node its position.",
        buy: "https://lilygo.cc/products/t-beam",
    },
    {
        name: "lilygo-t3-v161",
        title: "LilyGo LoRa32 T3 V1.6.1 (868/915 MHz)",
        maker: "LilyGo",
        chip: "ESP32",
        radio: "SX1276",
        status: "built",
        note: "No user button: it turns off only when its battery runs down.",
        buy: "https://lilygo.cc/products/lora3",
    },
    {
        name: "lilygo-t3s3",
        title: "LilyGo T3-S3 V1.2, V1.3 with an SX1276 (868/915 MHz)",
        maker: "LilyGo",
        chip: "ESP32-S3",
        radio: "SX1276",
        status: "built",
        note: "Not the SX1262 version, which waits on a detail LilyGo has not published.",
        buy: "https://lilygo.cc/products/t3s3-v1-0",
    },
    {
        name: "heltec-t114",
        title: "Heltec Mesh Node T114 V2",
        maker: "Heltec",
        chip: "nRF52840",
        radio: "SX1262",
        status: "built",
        buy: "https://heltec.org/project/mesh-node-t114/",
    },
    {
        name: "rak4631",
        title: "RAKwireless RAK4631 (on a RAK19007 or RAK19003)",
        maker: "RAKwireless",
        chip: "nRF52840",
        radio: "SX1262",
        status: "built",
        note: "No user button.",
        buy: "https://store.rakwireless.com/products/wisblock-meshtastic-starter-kit",
    },
    {
        name: "wio-tracker-l1",
        title: "Seeed Wio Tracker L1, L1 Lite",
        maker: "Seeed",
        chip: "nRF52840",
        radio: "SX1262",
        status: "built",
        buy: "https://www.seeedstudio.com/Wio-Tracker-L1-p-6453.html",
    },
];

/**
 * How a board takes an image: the flash page writes an ESP32's over USB, and a UF2 board's is
 * copied onto its drive.
 */
export function familyOf(board: Board): Family {
    return board.chip === "nRF52840" ? "uf2" : "esp32";
}
