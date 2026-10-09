// QR codes, written from ISO/IEC 18004, for the links this site and its app show: an address's
// (draft/sharing.md in ternmesh/spec) and a group's join code (draft/groups.md). Versions 1 to 5 at
// error correction level L, each one block of codewords, which is all those links need: an
// address's link fits version 3, and a join code version 4. A text is given as segments, each in
// the mode it is written in, so that a join code's link can be alphanumeric on either side of its
// `#`, which the alphanumeric set lacks.
//
// Nothing here touches the page: a code is its modules, true for dark, and the caller draws them.

export type Mode = "alphanumeric" | "byte";
export interface Segment {
    mode: Mode;
    text: string;
}

const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

/** Per version, from 1: data codewords and error correction codewords at level L, in one block. */
const BLOCKS: readonly [number, number][] = [
    [19, 7],
    [34, 10],
    [55, 15],
    [80, 20],
    [108, 26],
];
const VERSION_MAX = BLOCKS.length;

export function isAlphanumeric(text: string): boolean {
    return [...text].every((c) => ALPHANUMERIC.includes(c));
}

/** The segments a join code's link is best written in: the `#` alone in byte mode. A text with no
 * `#` that is all alphanumeric is one segment; anything else is one byte segment. */
export function linkSegments(link: string): Segment[] {
    const hash = link.indexOf("#");
    const before = hash < 0 ? link : link.slice(0, hash);
    const after = hash < 0 ? "" : link.slice(hash + 1);
    if (!isAlphanumeric(before) || !isAlphanumeric(after)) {
        return [{ mode: "byte", text: link }];
    }
    if (hash < 0) {
        return [{ mode: "alphanumeric", text: link }];
    }
    return [
        { mode: "alphanumeric", text: before },
        { mode: "byte", text: "#" },
        { mode: "alphanumeric", text: after },
    ].filter((s) => s.text !== "") as Segment[];
}

class Bits {
    readonly bits: number[] = [];
    put(value: number, n: number): void {
        for (let i = n - 1; i >= 0; i--) {
            this.bits.push((value >>> i) & 1);
        }
    }
}

function segmentBits(s: Segment, out: Bits): void {
    if (s.mode === "alphanumeric") {
        out.put(0b0010, 4);
        out.put(s.text.length, 9); // versions 1 to 9
        for (let i = 0; i + 1 < s.text.length; i += 2) {
            out.put(ALPHANUMERIC.indexOf(s.text[i]!) * 45 + ALPHANUMERIC.indexOf(s.text[i + 1]!), 11);
        }
        if (s.text.length % 2 === 1) {
            out.put(ALPHANUMERIC.indexOf(s.text[s.text.length - 1]!), 6);
        }
        return;
    }
    const bytes = new TextEncoder().encode(s.text);
    out.put(0b0100, 4);
    out.put(bytes.length, 8); // versions 1 to 9
    for (const b of bytes) {
        out.put(b, 8);
    }
}

// GF(256) with the polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
    let x = 1;
    for (let i = 0; i < 255; i++) {
        EXP[i] = x;
        LOG[x] = i;
        x <<= 1;
        if (x & 0x100) {
            x ^= 0x11d;
        }
    }
    for (let i = 255; i < 512; i++) {
        EXP[i] = EXP[i - 255]!;
    }
}

function mul(a: number, b: number): number {
    return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;
}

/** The Reed-Solomon codewords for data: the remainder of data·x^n by the generator of degree n. */
function correction(data: number[], n: number): number[] {
    let gen = [1];
    for (let i = 0; i < n; i++) {
        const next = new Array<number>(gen.length + 1).fill(0);
        for (let j = 0; j < gen.length; j++) {
            next[j] ^= gen[j]!;
            next[j + 1] ^= mul(gen[j]!, EXP[i]!);
        }
        gen = next;
    }
    const rem = new Array<number>(n).fill(0);
    for (const d of data) {
        const factor = d ^ rem.shift()!;
        rem.push(0);
        for (let j = 0; j < n; j++) {
            rem[j] ^= mul(gen[j + 1]!, factor);
        }
    }
    return rem;
}

type Grid = (boolean | null)[][];

function functionPatterns(version: number): { grid: Grid; reserved: boolean[][] } {
    const size = 17 + 4 * version;
    const grid: Grid = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
    const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    const set = (x: number, y: number, dark: boolean) => {
        if (x >= 0 && y >= 0 && x < size && y < size) {
            grid[y]![x] = dark;
            reserved[y]![x] = true;
        }
    };
    // Finders, with their separators.
    for (const [cx, cy] of [
        [3, 3],
        [size - 4, 3],
        [3, size - 4],
    ] as const) {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const d = Math.max(Math.abs(dx), Math.abs(dy));
                set(cx + dx, cy + dy, d !== 2 && d !== 4);
            }
        }
    }
    // Timing.
    for (let i = 8; i < size - 8; i++) {
        set(i, 6, i % 2 === 0);
        set(6, i, i % 2 === 0);
    }
    // The one alignment pattern versions 2 to 6 have.
    if (version >= 2) {
        const c = size - 7;
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            }
        }
    }
    // The format information's places, written once the mask is chosen, and the dark module.
    for (let i = 0; i < 9; i++) {
        reserved[8]![i] = reserved[i]![8] = true;
    }
    for (let i = 0; i < 8; i++) {
        reserved[8]![size - 1 - i] = reserved[size - 1 - i]![8] = true;
    }
    set(8, size - 8, true);
    return { grid, reserved };
}

const MASKS: ((x: number, y: number) => boolean)[] = [
    (x, y) => (x + y) % 2 === 0,
    (_, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Level L's format information for a mask: five bits, BCH(15,5), XORed with 0x5412. */
function formatBits(mask: number): number {
    const data = (0b01 << 3) | mask;
    let rem = data << 10;
    for (let i = 14; i >= 10; i--) {
        if ((rem >>> i) & 1) {
            rem ^= 0x537 << (i - 10);
        }
    }
    return ((data << 10) | rem) ^ 0x5412;
}

function writeFormat(m: boolean[][], mask: number): void {
    const size = m.length;
    const f = formatBits(mask);
    const bit = (i: number) => ((f >>> i) & 1) === 1;
    // Around the top-left finder: bits 0 to 7 down column 8, 8 to 14 along row 8 leftwards.
    for (let i = 0; i <= 5; i++) {
        m[i]![8] = bit(i);
    }
    m[7]![8] = bit(6);
    m[8]![8] = bit(7);
    m[8]![7] = bit(8);
    for (let i = 9; i < 15; i++) {
        m[8]![14 - i] = bit(i);
    }
    // And again beside the other two.
    for (let i = 0; i < 8; i++) {
        m[8]![size - 1 - i] = bit(i);
    }
    for (let i = 8; i < 15; i++) {
        m[size - 15 + i]![8] = bit(i);
    }
}

function penalty(m: boolean[][]): number {
    const size = m.length;
    let score = 0;
    const lines: boolean[][] = [];
    for (let i = 0; i < size; i++) {
        lines.push(m[i]!, m.map((row) => row[i]!));
    }
    for (const line of lines) {
        // Runs of five or more of one colour.
        let run = 1;
        for (let i = 1; i <= size; i++) {
            if (i < size && line[i] === line[i - 1]) {
                run++;
                continue;
            }
            if (run >= 5) {
                score += run - 2;
            }
            run = 1;
        }
        // A finder's look: 1011101 with four light modules on either side, the quiet zone
        // around the code counted as light.
        const s = "0000" + line.map((d) => (d ? "1" : "0")).join("") + "0000";
        for (let i = 0; i + 11 <= s.length; i++) {
            const run = s.slice(i, i + 11);
            if (run === "10111010000" || run === "00001011101") {
                score += 40;
            }
        }
    }
    // Blocks of two by two of one colour.
    for (let y = 0; y + 1 < size; y++) {
        for (let x = 0; x + 1 < size; x++) {
            const c = m[y]![x];
            if (m[y]![x + 1] === c && m[y + 1]![x] === c && m[y + 1]![x + 1] === c) {
                score += 3;
            }
        }
    }
    // How far the dark modules are from half.
    const dark = m.flat().filter(Boolean).length;
    score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return score;
}

/**
 * A QR code of the segments: the smallest version from `least` that holds them, at level L, with
 * the mask given or, if none is, the one the standard's penalty rules choose. Its modules, row by
 * row, true for dark, with no quiet zone. Throws if no version up to 5 holds them.
 */
export function qrEncode(segments: Segment[], options: { least?: number; mask?: number } = {}): boolean[][] {
    for (const s of segments) {
        if (s.mode === "alphanumeric" && !isAlphanumeric(s.text)) {
            throw new Error(`not alphanumeric: ${s.text}`);
        }
    }
    const bits = new Bits();
    for (const s of segments) {
        segmentBits(s, bits);
    }
    let version = Math.max(1, options.least ?? 1);
    while (version <= VERSION_MAX && bits.bits.length > BLOCKS[version - 1]![0] * 8) {
        version++;
    }
    if (version > VERSION_MAX) {
        throw new Error("too long for a QR code here");
    }
    const [dataWords, ecWords] = BLOCKS[version - 1]!;
    const capacity = dataWords * 8;
    // The terminator, up to four zeros; then to a whole byte; then the pad bytes in turn.
    bits.put(0, Math.min(4, capacity - bits.bits.length));
    bits.put(0, (8 - (bits.bits.length % 8)) % 8);
    for (let pad = 0; bits.bits.length < capacity; pad ^= 1) {
        bits.put(pad === 0 ? 0xec : 0x11, 8);
    }
    const data: number[] = [];
    for (let i = 0; i < capacity; i += 8) {
        data.push(parseInt(bits.bits.slice(i, i + 8).join(""), 2));
    }
    const words = [...data, ...correction(data, ecWords)];
    const stream = words.flatMap((w) => Array.from({ length: 8 }, (_, i) => ((w >>> (7 - i)) & 1) === 1));

    // The codewords up and down two columns at a time, from the right, around what is reserved.
    // The bits left over at the end, the remainder, are light.
    const { grid, reserved } = functionPatterns(version);
    const size = grid.length;
    const isData = reserved.map((row) => row.map((r) => !r));
    let k = 0;
    for (let right = size - 1, up = true; right > 0; right -= 2, up = !up) {
        if (right === 6) {
            right = 5; // the vertical timing pattern is never one of a pair
        }
        for (let i = 0; i < size; i++) {
            const y = up ? size - 1 - i : i;
            for (const x of [right, right - 1]) {
                if (isData[y]![x]) {
                    grid[y]![x] = k < stream.length ? stream[k]! : false;
                    k++;
                }
            }
        }
    }

    const masked = (mask: number): boolean[][] => {
        const m = grid.map((row, y) =>
            row.map((d, x) => (isData[y]![x] ? (d as boolean) !== MASKS[mask]!(x, y) : (d ?? false))),
        );
        writeFormat(m, mask);
        return m;
    };
    if (options.mask !== undefined) {
        return masked(options.mask);
    }
    let best: boolean[][] | null = null;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
        const m = masked(mask);
        const s = penalty(m);
        if (s < bestScore) {
            best = m;
            bestScore = s;
        }
    }
    return best!;
}

/** A code as an SVG path's `d`: one square a dark module, offset by a quiet zone of `quiet`. */
export function qrPath(modules: boolean[][], quiet = 4): string {
    let d = "";
    modules.forEach((row, y) =>
        row.forEach((dark, x) => {
            if (dark) {
                d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
            }
        }),
    );
    return d;
}
