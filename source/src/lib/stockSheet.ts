/**
 * The stock of the company's products (from a text the person writes or pastes for the AI assistant), and finding
 * the 25 products of the production list in it.
 *
 * Products are found ONLY by the name the company gave on its stock sheets (SHEET_NAMES), the product's own name on
 * this website, or a match the person chose earlier (aliases). Nothing else is matched automatically: a changed name
 * is asked about, and numbers that are unclear or do not add up (ຈຳນວນ − ເບີກ ≠ ຍັງເຫຼືອ) are marked to be checked.
 */
import type { Product } from './types';

/** The company's table: product of the production list (by id, in its order 1–25) = name on the stock sheet. */
export const SHEET_NAMES: Record<string, string> = {
    p01: 'ຜົງໝາກກ້ວຍ 100g',
    p02: 'ຜົງຂີ້ມິ້ນ 50g',
    p03: 'ແຈ່ວປາປົ່ນ 50g',
    p04: 'ໝາກແຂ່ນບົດ 50g',
    p05: 'ແຈ່ວບອງແກ້ວ 210g',
    p06: 'ຜົງແຈ່ວໝ່າລ່າ 180g',
    p07: 'ຜົງແຈ່ວໝ່າລ່າ 120g',
    p08: 'ຜົງແຈ່ວປິ້ງຈິນ 130g',
    p09: 'ຜົງປຸງສຸຂະພາບ 50g',
    p10: 'ແຈ່ວບອງຫລວງພະບາງ (ຊອງ)',
    p11: 'ໝາກເຜັດປົ່ນ 140g',
    p12: 'ພິກໄທ ເມັດ 180g',
    p13: 'ພິກໄທດຳບົດ 70g',
    p14: 'ຜົງແຈ່ວປິ້ງຈິນ 60g',
    p15: 'ໝາກເຜັດປົ່ນ 50g',
    p16: 'ພິກໄທດຳປະສົມ 70g',
    p17: 'ແຈ່ວໝາກແຄ່ນ 180g',
    p18: 'ແຈ່ວປິ້ງຈິນ 500g',
    p19: 'ຜົງຂີ້ມິ້ນ+ຜົງກ້ວຍ 100g',
    p20: 'ຜົງຜັກເຄວ 65g',
    p21: 'ຜົງບົດລູດ 65g',
    p22: 'ຜົງຂ່າບົດ 45g',
    p23: 'ຜົງຫອມບົ່ວ 50g',
    p24: 'ຜົງຜັກຫຽມ 50g',
    p25: 'ຊາຂີງນ້ຳເຜິ້ງ 50g',
};

export type Field = 'qty' | 'south' | 'remain';

/** one line of the sheet's table */
export interface SheetRow {
    name: string;
    unit: string;
    qty: number | null;
    south: number | null;
    remain: number | null;
    /** numbers (or the name) that could not be read for sure */
    unclear: Array<Field | 'name'>;
}

/** typed: read from a text by the website; ai: read from a text by the AI; manual: typed in the table */
export type ReadMethod = 'typed' | 'ai' | 'manual' | 'saved' | 'text';

export interface SheetRead {
    method: ReadMethod;
    /** where it came from, shown to the person (e.g. "ຂໍ້ຄວາມ 10/10 09:45") */
    fileName: string;
    /** date of the stock (YYYY-MM-DD), '' when not known */
    date: string;
    /** the date as written ('' when none was written: then it is the day the text was sent) */
    dateText: string;
    rows: SheetRow[];
}

const LAO_DIGITS = '໐໑໒໓໔໕໖໗໘໙';
const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

export function digits(s: string): string {
    return s.replace(/[໐-໙]/g, (d) => String(LAO_DIGITS.indexOf(d))).replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));
}

/* Lao marks written above/below a letter: put them in one fixed order (keyboards type them in different orders) */
const MARK_ORDER: Record<string, number> = {};
['ັ', 'ິ', 'ີ', 'ຶ', 'ື', 'ົ', 'ຸ', 'ູ', 'ຼ'].forEach((c) => (MARK_ORDER[c] = 0));
['່', '້', '໊', '໋'].forEach((c) => (MARK_ORDER[c] = 1));
MARK_ORDER['໌'] = 2;
MARK_ORDER['ໍ'] = 3;

const DROP_RE = /[\s\u200b\u200c\u200d()[\]{}.,:;'"`´‘’“”\-–—_/\\|·•*#=]/;
const UNITS = ['ກຣາມ', 'ກຣັມ', 'grams', 'gram', 'ກຣ', 'gr', 'g', 'ກ'];
const LETTER_RE = /[\u0e80-\u0effa-z\u0e00-\u0e7f]/;

/** one character of a name in its canonical form, and where it came from in the text */
export interface CChar {
    c: string;
    /** position in the original text (start, end) */
    at: number;
    end: number;
}

/**
 * A name in one canonical form, keeping track of where each character came from: spaces and punctuation, ໜ/ຫນ,
 * ໝ/ຫມ, ຫຼ/ຫລ, ຳ, the order of marks, Lao/Thai digits and letter case do not matter, and neither does a weight unit
 * after a number ("100g" = "100 ກຣາມ" = "100"). Different words stay different: this is not a guess.
 */
export function canonChars(s: string): CChar[] {
    const out: CChar[] = [];
    let i = 0;
    for (const ch of s || '') {
        const at = i;
        i += ch.length;
        for (const c of digits(ch).normalize('NFKC').toLowerCase()) {
            const c2 = c === 'ຼ' ? 'ລ' : c; // ◌ຼ written as ລ (ຫຼວງ = ຫລວງ)
            if (!DROP_RE.test(c2)) {
                out.push({ c: c2, at, end: i });
            }
        }
    }
    // marks in one fixed order
    for (let k = 0; k < out.length; ) {
        if (!(out[k].c in MARK_ORDER)) {
            k += 1;
            continue;
        }
        let e = k;
        while (e < out.length && out[e].c in MARK_ORDER) {
            e += 1;
        }
        const run = out.slice(k, e).sort((a, b) => MARK_ORDER[a.c] - MARK_ORDER[b.c]);
        out.splice(k, e - k, ...run);
        k = e;
    }
    // a weight unit right after a number is left out
    for (let k = 1; k < out.length; k += 1) {
        if (!/\d/.test(out[k - 1].c)) {
            continue;
        }
        for (const u of UNITS) {
            const piece = out.slice(k, k + u.length).map((x) => x.c).join('');
            const after = out[k + u.length];
            if (piece === u && (!after || !LETTER_RE.test(after.c))) {
                out.splice(k, u.length);
                break;
            }
        }
    }
    return out;
}

/** the canonical form of a name (see canonChars) */
export function canon(s: string): string {
    return canonChars(s)
        .map((x) => x.c)
        .join('');
}

/** A number as printed: 1,200 / 1.200 / 1 200 / Lao digits; "-" means 0; empty is null; anything else is unclear. */
export function parseNum(raw: string): number | null | 'bad' {
    const s = digits((raw || '').normalize('NFKC')).replace(/\s+/g, '');
    if (!s) {
        return null;
    }
    if (/^[-–—]+$/.test(s)) {
        return 0;
    }
    let t = s.replace(/,/g, '');
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
        t = t.replace(/\./g, ''); // 1.200 = one thousand two hundred
    }
    if (!/^\d+(\.\d+)?$/.test(t)) {
        return 'bad';
    }
    const n = Number(t);
    return Number.isFinite(n) ? n : 'bad';
}

/* ---------- dates ---------- */

const MONTHS: string[][] = [
    ['ມັງກອນ', 'ມັງກອນ', 'มกราคม', 'ม.ค'],
    ['ກຸມພາ', 'ກຸມພາ', 'กุมภาพันธ์', 'ก.พ'],
    ['ມີນາ', 'ມີນາ', 'มีนาคม', 'มี.ค'],
    ['ເມສາ', 'ເມສາ', 'เมษายน', 'เม.ย'],
    ['ພຶດສະພາ', 'ພຶດສະພາ', 'พฤษภาคม', 'พ.ค'],
    ['ມິຖຸນາ', 'ມິຖຸນາ', 'มิถุนายน', 'มิ.ย'],
    ['ກໍລະກົດ', 'ກໍລະກົດ', 'กรกฎาคม', 'ก.ค'],
    ['ສິງຫາ', 'ສິງຫາ', 'สิงหาคม', 'ส.ค'],
    ['ກັນຍາ', 'ກັນຍາ', 'กันยายน', 'ก.ย'],
    ['ຕຸລາ', 'ຕຸລາ', 'ตุลาคม', 'ต.ค'],
    ['ພະຈິກ', 'ພະຈິກ', 'พฤศจิกายน', 'พ.ย'],
    ['ທັນວາ', 'ທັນວາ', 'ธันวาคม', 'ธ.ค'],
];

function iso(y: number, m: number, d: number): string {
    if (y < 100) {
        y += 2000;
    }
    if (y > 2400) {
        y -= 543; // Buddhist year
    }
    if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) {
        return '';
    }
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCMonth() !== m - 1) {
        return '';
    }
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Every date written in a text (day first, as in Laos), in order. Two-digit years only for 2020–2040. */
export function findDates(text: string): Array<{ iso: string; text: string }> {
    const t = digits((text || '').normalize('NFKC'));
    const found: Array<{ at: number; iso: string; text: string }> = [];
    const year = (raw: string) => (raw.length === 2 ? (+raw >= 20 && +raw <= 40 ? 2000 + +raw : 0) : +raw);
    const scan = (re: RegExp, pick: (m: RegExpExecArray) => [number, number, number]) => {
        let m: RegExpExecArray | null;
        while ((m = re.exec(t))) {
            const lead = m[1] || '';
            const [y, mo, d] = pick(m);
            const value = y ? iso(y, mo, d) : '';
            if (value) {
                found.push({ at: m.index + lead.length, iso: value, text: m[0].slice(lead.length).trim() });
            }
            re.lastIndex = m.index + Math.max(1, lead.length + 1);
        }
    };
    // (no look-behind: older phones cannot read it)
    scan(/(^|[^\d])(\d{4})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})(?!\d)/g, (m) => [+m[2], +m[3], +m[4]]);
    scan(/(^|[^\d])(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{4}|\d{2})(?!\d)/g, (m) => [year(m[4]), +m[3], +m[2]]);
    scan(/(^|[^\d])(\d{1,2})\s*ເດືອນ\s*(\d{1,2})\s*ປີ\s*(\d{4}|\d{2})(?!\d)/g, (m) => [year(m[4]), +m[3], +m[2]]);
    MONTHS.forEach((names, i) => {
        for (const name of new Set(names)) {
            const re = new RegExp(`(^|[^\\d])(\\d{1,2})\\s*(?:ເດືອນ\\s*)?${name.replace(/\./g, '\\.')}\\.?\\s*(?:ປີ\\s*|พ\\.ศ\\.\\s*|ค\\.ศ\\.\\s*)?(\\d{4})(?!\\d)`, 'g');
            scan(re, (m) => [+m[3], i + 1, +m[2]]);
        }
    });
    // the same place may match two patterns: keep one per position, in reading order
    found.sort((a, b) => a.at - b.at);
    const out: Array<{ iso: string; text: string }> = [];
    let lastAt = -10;
    for (const f of found) {
        if (f.at - lastAt > 3) {
            out.push({ iso: f.iso, text: f.text });
            lastAt = f.at;
        }
    }
    return out;
}

/* ---------- finding the products ---------- */

export interface Match {
    /** product id → row index */
    rows: Map<string, number>;
    /** products of the list that are not found under a known name (the person may be asked) */
    missing: string[];
    /** rows that belong to no product (offered as choices) */
    free: number[];
}

/**
 * The names each product is known by (canonical name → product id): the company's name on its stock sheets, the
 * product's own name on this website, and the names the person chose before. A name two products share is left out.
 */
export function productKeys(products: Product[], aliases: Record<string, string>): Map<string, string> {
    const owners = new Map<string, Set<string>>();
    const add = (key: string, pid: string) => {
        if (key) {
            owners.set(key, (owners.get(key) || new Set<string>()).add(pid));
        }
    };
    for (const p of products) {
        if (SHEET_NAMES[p.id]) {
            add(canon(SHEET_NAMES[p.id]), p.id);
        }
        add(canon(p.name), p.id);
    }
    const out = new Map<string, string>();
    owners.forEach((set, key) => {
        if (set.size === 1) {
            out.set(key, [...set][0]);
        }
    });
    const ids = new Set(products.map((p) => p.id));
    for (const [k, pid] of Object.entries(aliases)) {
        if (ids.has(pid) && canon(k)) {
            out.set(canon(k), pid); // the person's own choice
        }
    }
    return out;
}

/**
 * Finds each product of the production list among the rows: by a name it is known by (productKeys), or by the
 * person's choice for this stock (picked). `ignore`: names the person said are none of the products.
 */
export function matchProducts(
    products: Product[],
    rows: SheetRow[],
    aliases: Record<string, string>,
    picked: Record<string, number | 'none'> = {},
    ignore: string[] = [],
): Match {
    const keys = productKeys(products, aliases);
    const rowsOf = new Map<string, number[]>();
    rows.forEach((r, i) => {
        const pid = keys.get(canon(r.name));
        if (pid) {
            rowsOf.set(pid, [...(rowsOf.get(pid) || []), i]);
        }
    });
    const used = new Set<number>();
    const out = new Map<string, number>();
    const missing: string[] = [];
    // the person's choices first (a row chosen for one product is not given to another)
    for (const p of products) {
        const choice = picked[p.id];
        if (typeof choice === 'number' && rows[choice] && !used.has(choice)) {
            out.set(p.id, choice);
            used.add(choice);
        }
    }
    for (const p of products) {
        if (out.has(p.id) || picked[p.id] === 'none') {
            continue;
        }
        const hit = (rowsOf.get(p.id) || []).find((i) => !used.has(i));
        if (hit !== undefined) {
            out.set(p.id, hit);
            used.add(hit);
        } else {
            missing.push(p.id);
        }
    }
    const skip = new Set(ignore.map(canon));
    const free = rows.map((_, i) => i).filter((i) => !used.has(i) && rows[i].name && !skip.has(canon(rows[i].name)) && !keys.has(canon(rows[i].name)));
    return { rows: out, missing, free };
}
