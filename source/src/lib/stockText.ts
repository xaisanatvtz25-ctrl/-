/**
 * Reading the stock from a text the person writes or pastes for the AI assistant, e.g.
 *
 *     ສະຕັອກວັນທີ 10/10/2026
 *     ຜົງກ້ວຍ 370
 *     ຂີ້ໝິ້ນ: ເຫຼືອ 100
 *     ຜົງໝາກກ້ວຍ 100g   520  150  370        (ຈຳນວນ, ເບີກໄປພາກໃຕ້, ຍັງເຫຼືອ — the order of the sheet)
 *
 * One number is the stock there is (ຍັງເຫຼືອ). Three are ຈຳນວນ / ເບີກ / ເຫຼືອ. Words say which is which (ເຫຼືອ, ເບີກ,
 * ຈຳນວນ). Two numbers without words are not guessed: they are marked to be checked. A date line starts a stock
 * (the earlier and the newer stock can be sent in one text); without a date it is the stock of the day it is sent.
 *
 * Names are found only as the company or this website writes them (or as the person matched them before); anything
 * else becomes a row whose name is asked about. When the website cannot read a text (sentences, other layouts) the AI
 * may put it in rows, copying the names as written: the same matching then applies.
 */
import type { Product } from './types';
import { askAiJson, providerOf } from './ai';
import type { AiConfig } from './ai';
import { canon, canonChars, digits, findDates, matchProducts, parseNum, productKeys } from './stockSheet';
import type { Field, SheetRead, SheetRow } from './stockSheet';

/* ---------- words ---------- */

type Col = 'qty' | 'south' | 'remain';

/** words that say which number it is (any of them, written in Lao or Thai) */
const LABELS: Array<[Col, string[]]> = [
    ['remain', ['ຍັງເຫຼືອ', 'ຄົງເຫຼືອ', 'ເຫຼືອ', 'ຄົງຄັງ', 'ສະຕັອກ', 'ສະຕ໊ອກ', 'ยังเหลือ', 'คงเหลือ', 'เหลือ', 'สต็อก', 'remain', 'left', 'stock']],
    ['south', ['ເບີກໄປພາກໃຕ້', 'ສົ່ງພາກໃຕ້', 'ໄປພາກໃຕ້', 'ພາກໃຕ້', 'ເບີກ', 'เบิก', 'ภาคใต้', 'south']],
    ['qty', ['ຈຳນວນ', 'ທັງໝົດ', 'ມີ', 'จำนวน', 'ทั้งหมด', 'มี', 'qty']],
];

/** units after a number (left out) */
const UNIT_WORDS = ['ຖົງ', 'ກ່ອງ', 'ແກ້ວ', 'ຊອງ', 'ກະປ໋ອງ', 'ກະປອງ', 'ຫໍ່', 'ອັນ', 'ແພັກ', 'ຕຸກ', 'ຂວດ', 'ໂຫຼ', 'ລັງ', 'ຫົວ', 'ຊິ້ນ', 'ถุง', 'กล่อง', 'ซอง', 'ขวด', 'ชิ้น', 'แพ็ค', 'pcs', 'pc', 'box', 'bag'];

const LABEL_KEYS: Array<[Col, string]> = LABELS.flatMap(([col, words]) => words.map((w): [Col, string] => [col, canon(w)])).sort((a, b) => b[1].length - a[1].length);
const UNIT_KEYS = UNIT_WORDS.map(canon).sort((a, b) => b.length - a.length);
/** small words between a name and its numbers (left out): ມີ is a label */
const FILLER_KEYS = ['ແມ່ນ', 'ມີຢູ່', 'ຍັງມີ', 'ຢູ່', 'ຄື', 'คือ', 'อยู่', 'ประมาณ', 'ປະມານ'].map(canon).sort((a, b) => b.length - a.length);

const LETTER_RE = /[\u0e80-\u0eff\u0e00-\u0e7fa-z]/i;

/* ---------- numbers after a name ---------- */

interface Values {
    nums: number[];
    labeled: Partial<Record<Col, number>>;
    /** a number that could not be read (e.g. "12o") */
    bad: boolean;
    /** where the values stop: the rest is another item (or a note) */
    stop: number;
}

/**
 * The numbers (and the words that say which they are) at the start of `text`, until another word starts.
 * Returns where they stop.
 */
function readValues(text: string): Values {
    const t = digits(text.normalize('NFKC'));
    const out: Values = { nums: [], labeled: {}, bad: false, stop: t.length };
    let pending: Col | null = null;
    let i = 0;
    const startsWithKey = (keys: string[]): number => {
        // canonical comparison of what comes next (Lao has no spaces between words)
        const rest = canonChars(t.slice(i, i + 40));
        const s = rest.map((x) => x.c).join('');
        for (const k of keys) {
            if (k && s.startsWith(k)) {
                const last = rest[k.length - 1];
                return last ? last.end : 0;
            }
        }
        return 0;
    };
    while (i < t.length) {
        const ch = t[i];
        if (/\s/.test(ch) || /[:=;,|()[\]/*•·+]/.test(ch)) {
            i += 1;
            continue;
        }
        const num = /^\d[\d,]*(?:\.\d+)?/.exec(t.slice(i));
        if (num) {
            let raw = num[0].replace(/,+$/, '');
            // "520,150,370" without spaces: three numbers, not 520 million
            if (/,/.test(raw) && (parseNum(raw) as number) > 999_999) {
                const parts = raw.split(',').filter(Boolean);
                parts.forEach((p) => push(Number(p)));
                i += num[0].length;
                continue;
            }
            const n = parseNum(raw);
            i += num[0].length;
            // "12o" or "1O0": a number with letters stuck to it is not read
            if (i < t.length && /[a-z]/i.test(t[i]) && !startsWithUnitAt(i)) {
                out.bad = true;
                while (i < t.length && /[0-9a-z]/i.test(t[i])) i += 1;
                continue;
            }
            if (n === 'bad' || n === null) {
                out.bad = true;
            } else {
                push(n);
            }
            continue;
        }
        if (/[-–—]/.test(ch)) {
            // a dash where a number goes: 0 (an empty column of the sheet, "520 - 370"); "520-150" written
            // without spaces is a sum, not a column: nothing is read for it
            const between = /\d/.test(t[i - 1] || '') && /\d/.test(t[i + 1] || '');
            if (between) {
                out.bad = true;
            } else {
                push(0);
            }
            i += 1;
            continue;
        }
        if (LETTER_RE.test(ch) || /[\u0e80-\u0eff]/.test(ch)) {
            let n = startsWithKey(LABEL_KEYS.map((x) => x[1]));
            if (n) {
                const s = canon(t.slice(i, i + n));
                const found = LABEL_KEYS.find((x) => s.startsWith(x[1]));
                pending = found ? found[0] : null;
                i += n;
                continue;
            }
            n = startsWithKey(UNIT_KEYS) || startsWithKey(FILLER_KEYS);
            if (n) {
                i += n;
                continue;
            }
            out.stop = i; // another word: the values of this item end here
            break;
        }
        i += 1; // any other sign
    }
    return out;

    function push(n: number) {
        if (pending && out.labeled[pending] === undefined) {
            out.labeled[pending] = n;
            pending = null;
        } else {
            out.nums.push(n);
        }
    }

    function startsWithUnitAt(at: number): boolean {
        const s = canon(t.slice(at, at + 12));
        return UNIT_KEYS.some((k) => s.startsWith(k)) || /^(g|kg|gr|ml|l)\b/i.test(t.slice(at, at + 3));
    }
}

/** the numbers of one row, from what was written (never guessed: what cannot be told is marked unclear) */
function toRow(name: string, v: Values, cols: Col[] | null): SheetRow {
    const row: SheetRow = { name, unit: '', qty: null, south: null, remain: null, unclear: [] };
    const set: Partial<Record<Col, number>> = { ...v.labeled };
    const nums = [...v.nums];
    const labeledCount = Object.keys(v.labeled).length;
    if (nums.length) {
        if (labeledCount) {
            const open = (['qty', 'south', 'remain'] as Col[]).filter((c) => set[c] === undefined);
            if (nums.length === open.length) {
                open.forEach((c, k) => (set[c] = nums[k]));
            } else if (nums.length === 1 && set.remain !== undefined && set.qty === undefined && set.south === undefined) {
                set.qty = nums[0]; // "ຜົງກ້ວຍ 520 ເຫຼືອ 370": the count, then what is left
            } else {
                open.forEach((c) => row.unclear.push(c === 'remain' ? 'remain' : c));
            }
        } else if (cols && nums.length === cols.length) {
            cols.forEach((c, k) => (set[c] = nums[k]));
        } else if (nums.length === 1) {
            set.remain = nums[0];
        } else if (nums.length === 3) {
            [set.qty, set.south, set.remain] = nums;
        } else {
            row.unclear.push('qty', 'remain'); // two numbers (or more than three) without words: not guessed
        }
    }
    // one number of stock: what there is now (nothing sent south)
    if (set.remain !== undefined && set.qty === undefined && set.south === undefined) {
        set.qty = set.remain;
    } else if (set.qty !== undefined && set.remain === undefined && set.south === undefined && !row.unclear.length) {
        set.remain = set.qty;
    }
    // what the numbers given say about the third one
    if (set.qty !== undefined && set.south !== undefined && set.remain === undefined && set.qty - set.south >= 0) {
        set.remain = set.qty - set.south;
    } else if (set.remain !== undefined && set.south !== undefined && set.qty === undefined) {
        set.qty = set.remain + set.south;
    } else if (set.qty !== undefined && set.remain !== undefined && set.south === undefined && set.qty >= set.remain) {
        set.south = set.qty - set.remain;
    }
    row.qty = set.qty ?? null;
    row.south = set.south ?? null;
    row.remain = set.remain ?? null;
    if (v.bad) {
        (['qty', 'south', 'remain'] as Field[]).forEach((f) => {
            if (row[f] === null && !row.unclear.includes(f)) row.unclear.push(f);
        });
        if (!row.unclear.length) row.unclear.push('remain');
    }
    row.unclear = [...new Set(row.unclear)];
    return row;
}

/* ---------- lines ---------- */

/** the numbers' order written in a header line (ລາຍການ ຈຳນວນ ເບີກ ເຫຼືອ), or null */
function headerCols(line: string): Col[] | null {
    const chars = canonChars(line);
    const s = chars.map((x) => x.c).join('');
    const hits: Array<{ at: number; col: Col }> = [];
    for (let i = 0; i < s.length; ) {
        const found = LABEL_KEYS.find(([, k]) => s.startsWith(k, i));
        if (found) {
            if (!hits.some((h) => h.col === found[0])) {
                hits.push({ at: i, col: found[0] });
            }
            i += found[1].length;
        } else {
            i += 1;
        }
    }
    return hits.length ? hits.sort((a, b) => a.at - b.at).map((h) => h.col) : null;
}

const MONTHS_SHORT: string[][] = [
    ['ມັງກອນ', 'มกราคม', 'ม.ค'],
    ['ກຸມພາ', 'กุมภาพันธ์', 'ก.พ'],
    ['ມີນາ', 'มีนาคม', 'มี.ค'],
    ['ເມສາ', 'เมษายน', 'เม.ย'],
    ['ພຶດສະພາ', 'พฤษภาคม', 'พ.ค'],
    ['ມິຖຸນາ', 'มิถุนายน', 'มิ.ย'],
    ['ກໍລະກົດ', 'กรกฎาคม', 'ก.ค'],
    ['ສິງຫາ', 'สิงหาคม', 'ส.ค'],
    ['ກັນຍາ', 'กันยายน', 'ก.ย'],
    ['ຕຸລາ', 'ตุลาคม', 'ต.ค'],
    ['ພະຈິກ', 'พฤศจิกายน', 'พ.ย'],
    ['ທັນວາ', 'ธันวาคม', 'ธ.ค'],
];

function isoOf(y: number, m: number, d: number): string {
    const date = new Date(Date.UTC(y, m - 1, d));
    return m >= 1 && m <= 12 && d >= 1 && date.getUTCMonth() === m - 1 ? date.toISOString().slice(0, 10) : '';
}

/** a date of a header line: with its year, or day and month only (this year; last year when that is still to come) */
function lineDate(line: string, today: string): { iso: string; text: string } | null {
    const full = findDates(line);
    if (full.length) {
        return full[0];
    }
    const t = digits(line.normalize('NFKC'));
    let m = /(^|[^\d])(\d{1,2})\s*[/.\-]\s*(\d{1,2})(?![\d/.\-])/.exec(t);
    let d = 0;
    let mo = 0;
    if (m) {
        d = +m[2];
        mo = +m[3];
    } else {
        for (let i = 0; i < MONTHS_SHORT.length && !d; i += 1) {
            for (const name of MONTHS_SHORT[i]) {
                const re = new RegExp(`(^|[^\\d])(\\d{1,2})\\s*(?:ເດືອນ\\s*)?${name.replace(/\./g, '\\.')}`);
                const hit = re.exec(t);
                if (hit) {
                    m = hit;
                    d = +hit[2];
                    mo = i + 1;
                    break;
                }
            }
        }
    }
    if (!m || !d) {
        return null;
    }
    const year = Number(today.slice(0, 4));
    let iso = isoOf(year, mo, d);
    if (iso && iso > today) {
        iso = isoOf(year - 1, mo, d);
    }
    return iso ? { iso, text: m[0].slice(m[1].length).trim() } : null;
}

/** "1.", "2)", "- ", "• " in front of a line (not "370 ຖົງ …": that is a number of bags) */
function stripLead(line: string): string {
    const m = /^\s*(?:[-*•·]\s+|\(?\d{1,3}\s*[.)\]:]\s*|(\d{1,3})\s+(?=[^\d\s]))/.exec(line);
    if (!m) {
        return line;
    }
    const rest = line.slice(m[0].length);
    if (m[1] !== undefined) {
        const next = canon(rest.slice(0, 14));
        if (UNIT_KEYS.some((k) => next.startsWith(k))) {
            return line;
        }
    }
    return rest;
}

/** two names joined into one ("ຜົງກ້ວຍ+ຂີ້ໝິ້ນ", "A & B", "A/B"): a name next to such a sign is not a name on its own */
const JOIN_AFTER_RE = /^\s*[+&/]\s*[\u0e80-\u0eff\u0e00-\u0e7fa-z]/i;
const JOIN_BEFORE_RE = /[\u0e80-\u0eff\u0e00-\u0e7fa-z]\s*[+&/]\s*$/i;

/** text before a name ends with a number of it ("370 ຖົງ ", "370 ແມ່ນ "), not with other words ("ເດືອນ 9 ຜະລິດ ") */
function numberRightBefore(lead: string): boolean {
    const t = digits(lead);
    const m = /\d[\d,.]*(?!.*\d)/.exec(t);
    if (!m) {
        return false;
    }
    const gap = t.slice(m.index + m[0].length);
    return readValues(gap).stop >= gap.length;
}

interface Found {
    start: number;
    end: number;
    pid: string;
}

/** where the known names are in a line (longest name first; a name must stand on its own) */
function findNames(line: string, keys: Map<string, string>, lengths: number[]): Found[] {
    const chars = canonChars(line);
    const s = chars.map((x) => x.c).join('');
    const out: Found[] = [];
    for (let k = 0; k < chars.length; ) {
        const startRaw = chars[k].at;
        const before = startRaw > 0 ? line[startRaw - 1] : ' ';
        // the name starts a word: at the start, after a space, a number or a sign (not inside another word,
        // and not the second half of two joined names)
        const atStart = startRaw === 0 || (!LETTER_RE.test(before) && !JOIN_BEFORE_RE.test(line.slice(Math.max(0, startRaw - 6), startRaw)));
        let hit: Found | null = null;
        if (atStart) {
            for (const len of lengths) {
                if (k + len > chars.length) {
                    continue;
                }
                const piece = s.slice(k, k + len);
                const pid = keys.get(piece);
                if (!pid) {
                    continue;
                }
                let end = chars[k + len - 1].end;
                // a weight after the name ("… 180 g") belongs to it
                if (/\d$/.test(piece)) {
                    const unit = /^\s*(?:ກຣາມ|ກຣັມ|grams?|gr|g|ກ(?![\u0e80-\u0eff]))(?![a-z\u0e80-\u0eff])/i.exec(line.slice(end));
                    if (unit) {
                        end += unit[0].length;
                    }
                }
                const after = line.slice(end);
                // it must end there too: not followed by more of a word (or more digits after a size)
                if ((/\d$/.test(piece) && /^\d/.test(after)) || JOIN_AFTER_RE.test(after)) {
                    continue;
                }
                if (/^[\u0e80-\u0eff\u0e00-\u0e7fa-z]/i.test(after)) {
                    const v = readValues(after);
                    if (v.stop === 0 && !(v.nums.length || Object.keys(v.labeled).length)) {
                        continue; // "ຊາຂີງມະນາວ": another product that starts the same way
                    }
                }
                hit = { start: startRaw, end, pid };
                break;
            }
        }
        if (hit) {
            out.push(hit);
            while (k < chars.length && chars[k].at < hit.end) {
                k += 1;
            }
        } else {
            k += 1;
        }
    }
    return out;
}

/* ---------- the whole text ---------- */

export interface TextRead {
    /** one per date written (in the order of the text) */
    sheets: SheetRead[];
    /** products found, in the sheet with the most */
    found: number;
    /** numbers in the text */
    numbers: number;
    /** product names written twice for the same date (the first is kept) */
    twice: string[];
}

interface Section {
    date: string;
    dateText: string;
    rows: SheetRow[];
    cols: Col[] | null;
    /** product id → its row */
    pids: Map<string, number>;
}

export function parseStockText(text: string, products: Product[], aliases: Record<string, string>, today: string): TextRead {
    const keys = productKeys(products, aliases);
    const lengths = [...new Set([...keys.keys()].map((k) => k.length))].sort((a, b) => b - a);
    const nameOf = new Map(products.map((p) => [p.id, p.name]));
    const sections: Section[] = [{ date: '', dateText: '', rows: [], cols: null, pids: new Map() }];
    const twice: string[] = [];
    let numbers = 0;
    const lines = (text || '').replace(/\r\n?/g, '\n').split('\n');
    for (const rawLine of lines) {
        let line = stripLead(rawLine).replace(/\t/g, '  ');
        if (!line.trim()) {
            continue;
        }
        numbers += (digits(line).match(/\d+(?:[.,]\d+)*/g) || []).length;
        let names = findNames(line, keys, lengths);
        if (!names.length) {
            // (the line as written: "9 ຕຸລາ 2026" starts with a number that is not a list number)
            const date = lineDate(rawLine.replace(/\t/g, '  '), today) || lineDate(line, today);
            if (date) {
                const cur = sections[sections.length - 1];
                if (cur.rows.length || cur.date) {
                    sections.push({ date: date.iso, dateText: date.text, rows: [], cols: cur.cols, pids: new Map() });
                } else {
                    cur.date = date.iso;
                    cur.dateText = date.text;
                }
                const cols = headerCols(rawLine.replace(date.text, ' '));
                if (cols) {
                    sections[sections.length - 1].cols = cols;
                }
                continue;
            }
            const cols = headerCols(line);
            if (cols && !/\d/.test(digits(line))) {
                sections[sections.length - 1].cols = cols; // ລາຍການ | ຈຳນວນ | ເບີກ | ເຫຼືອ
                continue;
            }
        } else {
            // a date written on a line with products is not a number of them
            for (const d of findDates(line)) {
                line = line.replace(d.text, (m) => ' '.repeat(m.length));
            }
            names = findNames(line, keys, lengths);
        }
        const sec = sections[sections.length - 1];
        const addRow = (row: SheetRow, pid: string | null) => {
            if (row.qty === null && row.south === null && row.remain === null && !row.unclear.length) {
                return; // a name without numbers (e.g. a line of the form left empty)
            }
            if (pid) {
                const k = sec.pids.get(pid);
                if (k !== undefined) {
                    const kept = sec.rows[k];
                    if (kept.qty === null && kept.south === null && kept.remain === null && (row.qty !== null || row.remain !== null)) {
                        sec.rows[k] = row; // a line that could not be read, then the product written clearly
                    } else {
                        twice.push(nameOf.get(pid) || row.name);
                    }
                    return;
                }
                sec.pids.set(pid, sec.rows.length);
            }
            sec.rows.push(row);
        };
        /** text that is not a known name: a row whose name is asked about (when it has numbers) */
        const other = (piece: string) => {
            const t = piece.trim();
            let firstNum = digits(t).search(/\d/);
            if (firstNum <= 0) {
                return;
            }
            // a weight right after the name is part of it ("ຜົງແຈ່ວປີ້ງຈີນ 180g 95": the name with its size, then 95)
            const size = /^\d+(?:[.,]\d+)?\s*(?:ກຣາມ|ກຣັມ|grams?|gr|g|ກ(?![\u0e80-\u0eff]))(?![a-z\u0e80-\u0eff])/i.exec(digits(t.slice(firstNum)));
            const nameEnd = size ? firstNum + size[0].length : firstNum;
            const name = t.slice(0, nameEnd).replace(/[:=\-–—|]+\s*$/, '').trim();
            if (!name || !/[\u0e80-\u0eff\u0e00-\u0e7fa-z]/i.test(name)) {
                return;
            }
            if (size) {
                firstNum = nameEnd;
            }
            const v = readValues(t.slice(firstNum));
            if (size && !v.nums.length && !Object.keys(v.labeled).length && !v.bad) {
                return; // only a name with its size, no stock written
            }
            addRow(toRow(name, v, sec.cols), null);
            const rest = t.slice(firstNum).slice(v.stop);
            if (rest.trim() && v.stop > 0) {
                other(rest);
            }
        };
        // numbers written right before the names ("370 ຖົງ ຜົງກ້ວຍ"): which number belongs to which name cannot be told
        const numberFirst = names.length > 0 && numberRightBefore(line.slice(0, names[0].start));
        let pos = 0;
        names.forEach((n, i) => {
            other(line.slice(pos, n.start));
            const limit = i + 1 < names.length ? names[i + 1].start : line.length;
            const after = line.slice(n.end, limit);
            const v = readValues(after);
            const row = toRow(line.slice(n.start, n.end).trim(), v, sec.cols);
            if (numberFirst) {
                row.qty = row.south = row.remain = null;
                row.unclear = ['qty', 'south', 'remain']; // not guessed: marked to be checked
            }
            addRow(row, n.pid);
            pos = n.end + Math.min(v.stop, after.length);
        });
        other(line.slice(pos));
    }
    // one stock per date (an undated one is the stock of today)
    const byDate = new Map<string, SheetRead>();
    for (const sec of sections) {
        if (!sec.rows.length) {
            continue;
        }
        const date = sec.date || today;
        const same = byDate.get(date);
        if (same) {
            const have = new Set(matchProducts(products, same.rows, aliases).rows.keys());
            for (const r of sec.rows) {
                const pid = productKeys(products, aliases).get(canon(r.name));
                if (pid && have.has(pid)) {
                    twice.push(nameOf.get(pid) || r.name);
                    continue;
                }
                same.rows.push(r);
            }
        } else {
            byDate.set(date, { method: 'typed', fileName: '', date, dateText: sec.dateText, rows: [...sec.rows] });
        }
    }
    const sheets = [...byDate.values()];
    const found = sheets.reduce((m, sh) => Math.max(m, matchProducts(products, sh.rows, aliases).rows.size), 0);
    return { sheets, found, numbers, twice: [...new Set(twice)] };
}

/* ---------- when the website cannot read it: the AI puts it in rows ---------- */

const AI_SCHEMA = {
    type: 'OBJECT',
    properties: {
        sheets: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    date: { type: 'STRING', nullable: true, description: 'Date of this stock as YYYY-MM-DD (written day/month/year), null if none is written.' },
                    dateText: { type: 'STRING', description: 'The date exactly as written, or empty.' },
                    rows: {
                        type: 'ARRAY',
                        items: {
                            type: 'OBJECT',
                            properties: {
                                name: { type: 'STRING', description: 'The product name exactly as written (Lao script, sizes like 100g).' },
                                qty: { type: 'NUMBER', nullable: true, description: 'ຈຳນວນ (count before sending south)' },
                                south: { type: 'NUMBER', nullable: true, description: 'ເບີກໄປພາກໃຕ້ (sent to the south)' },
                                remain: { type: 'NUMBER', nullable: true, description: 'ຍັງເຫຼືອ (left, the stock there is)' },
                                unclear: { type: 'ARRAY', items: { type: 'STRING', enum: ['name', 'qty', 'south', 'remain'] } },
                            },
                            required: ['name', 'qty', 'south', 'remain', 'unclear'],
                        },
                    },
                },
                required: ['rows', 'dateText'],
            },
        },
    },
    required: ['sheets'],
};

const AI_PROMPT = [
    'The text below was written by a person at a Lao company: the stock of their products (it may hold two stocks, an earlier and a newer one, each with its date).',
    'Put it in rows. For each product: the name exactly as written (never translate, correct or complete a name), and its numbers:',
    'ຈຳນວນ (quantity), ເບີກໄປພາກໃຕ້ (sent to the south), ຍັງເຫຼືອ (remaining / left / the stock there is).',
    'When only one number is given for a product, it is ຍັງເຫຼືອ (remain); leave the others null.',
    'IMPORTANT: never guess or invent. A number you cannot tell for sure is null and its column goes in "unclear". Skip lines that are not products.',
    'One entry in "sheets" per date written (in the order of the text).',
].join('\n');

const AI_SHAPE = [
    'Answer with JSON only (no other text), in this shape:',
    '{"sheets": [{"date": "YYYY-MM-DD or null", "dateText": "the date as written", "rows": [{"name": "…", "qty": null, "south": null, "remain": 0, "unclear": []}]}]}',
].join('\n');

/** The stock in a text, put in rows by the AI (names copied as written; unclear numbers left empty and marked). */
export async function readTextWithAi(text: string, cfg: AiConfig, today: string): Promise<SheetRead[]> {
    const wire = providerOf(cfg.provider).wire;
    const prompt = `${AI_PROMPT}\n${wire === 'gemini' ? '' : `\n${AI_SHAPE}\n`}\nTEXT:\n${text.slice(0, 8000)}`;
    const json = (await askAiJson(cfg, prompt, AI_SCHEMA)) as { sheets?: unknown };
    const out: SheetRead[] = [];
    for (const raw of Array.isArray(json.sheets) ? json.sheets : []) {
        const sh = (raw || {}) as { date?: unknown; dateText?: unknown; rows?: unknown };
        const rows: SheetRow[] = [];
        for (const r of Array.isArray(sh.rows) ? sh.rows : []) {
            const o = (r || {}) as Record<string, unknown>;
            const unclear = (Array.isArray(o.unclear) ? o.unclear : []).filter((u): u is Field | 'name' => ['name', 'qty', 'south', 'remain'].includes(String(u)));
            const row: SheetRow = { name: String(o.name || '').trim().slice(0, 80), unit: '', qty: null, south: null, remain: null, unclear: [...new Set(unclear)] };
            (['qty', 'south', 'remain'] as Field[]).forEach((f) => {
                const v = o[f];
                if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
                    row[f] = v;
                } else if (typeof v === 'string' && v.trim()) {
                    const n = parseNum(v);
                    if (n === 'bad') row.unclear.push(f);
                    else row[f] = n;
                }
            });
            // one number: the stock there is (as when the website reads it)
            if (row.remain !== null && row.qty === null && row.south === null && !row.unclear.includes('qty')) {
                row.qty = row.remain;
            }
            if (row.name && (row.qty !== null || row.remain !== null || row.unclear.length)) {
                rows.push(row);
            }
        }
        if (!rows.length) {
            continue;
        }
        const dateText = typeof sh.dateText === 'string' ? sh.dateText.slice(0, 60) : '';
        // the date as written wins over the AI's reading of it
        const written = dateText ? findDates(dateText)[0] || lineDate(dateText, today) : null;
        const date = written ? written.iso : typeof sh.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sh.date) ? sh.date : '';
        out.push({ method: 'ai', fileName: '', date: date || today, dateText: date ? dateText : '', rows });
    }
    return out;
}

/** the form put in the assistant's box: every product, to be filled in */
export function stockTemplate(products: Product[], today: string, lang: 'lo' | 'th'): string {
    const [y, m, d] = today.split('-');
    const head = lang === 'th' ? `สต็อกวันที่ ${d}/${m}/${y}` : `ສະຕັອກວັນທີ ${d}/${m}/${y}`;
    return [head, ...products.map((p, i) => `${i + 1}. ${p.name}: `)].join('\n');
}
