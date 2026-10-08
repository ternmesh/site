// MD5 (RFC 1321), as lowercase hex. Not for security: it is what an ESP32's bootloader offers to
// say whether what it wrote is what it was sent, and the browser's own crypto does not have it.

const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(data: Uint8Array): string {
    // The message, a 1 bit, zeros to 56 mod 64, then its length in bits, little-endian.
    const padded = new Uint8Array(((data.length + 8) >>> 6) * 64 + 64);
    padded.set(data);
    padded[data.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, (data.length << 3) >>> 0, true);
    view.setUint32(padded.length - 4, Math.floor(data.length / 2 ** 29), true);

    const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    const m = new Uint32Array(16);
    for (let at = 0; at < padded.length; at += 64) {
        for (let i = 0; i < 16; i++) {
            m[i] = view.getUint32(at + 4 * i, true);
        }
        let [a, b, c, d] = h as [number, number, number, number];
        for (let i = 0; i < 64; i++) {
            const round = i >> 4;
            let f: number, g: number;
            if (round === 0) {
                f = (b & c) | (~b & d);
                g = i;
            } else if (round === 1) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) % 16;
            } else if (round === 2) {
                f = b ^ c ^ d;
                g = (3 * i + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                g = (7 * i) % 16;
            }
            const x = (a + f + K[i]! + m[g]!) >>> 0;
            const s = S[round * 4 + (i % 4)]!;
            a = d;
            d = c;
            c = b;
            b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
        }
        h[0] = (h[0]! + a) >>> 0;
        h[1] = (h[1]! + b) >>> 0;
        h[2] = (h[2]! + c) >>> 0;
        h[3] = (h[3]! + d) >>> 0;
    }
    const out = new DataView(new ArrayBuffer(16));
    h.forEach((word, i) => out.setUint32(4 * i, word, true));
    return Array.from(new Uint8Array(out.buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
