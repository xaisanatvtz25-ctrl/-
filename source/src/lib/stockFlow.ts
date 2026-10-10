/**
 * The steps from the stock (a text the person writes for the AI assistant) to the production plan, shared by the
 * assistant and the "ວັນນີ້ຄວນຜະລິດຫຍັງດີ" page (where the numbers are checked and 4 productions chosen).
 *
 * Nothing here guesses: names are found only by the company's table, the product's own name or a match the person
 * chose; numbers that are unclear or do not add up are marked for the person to check.
 */
import type { MonthMap, Product } from './types';
import { asAiError } from './ai';
import type { AiConfig, AiError } from './ai';
import { canon, matchProducts, parseNum } from './stockSheet';
import type { Field, Match, SheetRead } from './stockSheet';
import { parseStockText, readTextWithAi } from './stockText';
import { LOCAL, getLocal, setLocal } from './vault';
import { analyze, daysBetween, topSellers } from './stockAnalysis';
import type { Group, Result, StockSettings, Week, WeekRow } from './stockAnalysis';
import type { StockDraft } from './stockDraft';
import type { StockDoc } from './stockStore';

export type Slot = 'prev' | 'curr';
export type Cell = 'prev' | 'qty' | 'south' | 'left' | 'made';

/** a sheet is a stock sheet when at least this many products of the list are on it */
export const MIN_FOUND = 3;
/** productions chosen at a time */
export const PLAN_MAX = 4;

/* ---------- names matched (or skipped) by hand on this device: saved for everyone with the next analysis ---------- */

interface LocalNames {
    a: Record<string, string>;
    i: string[];
}

function readLocalNames(): LocalNames {
    try {
        const v = JSON.parse(getLocal(LOCAL.aliases) || '{}') as Partial<LocalNames> & Record<string, unknown>;
        if (v && typeof v === 'object' && ('a' in v || 'i' in v)) {
            return { a: v.a && typeof v.a === 'object' ? v.a : {}, i: Array.isArray(v.i) ? v.i.filter((x): x is string => typeof x === 'string') : [] };
        }
        return { a: (v as Record<string, string>) || {}, i: [] }; // kept by the earlier website: only the matches
    } catch {
        return { a: {}, i: [] };
    }
}

function writeLocalNames(v: LocalNames): void {
    setLocal(LOCAL.aliases, Object.keys(v.a).length || v.i.length ? JSON.stringify(v) : null);
}

export function readLocalAliases(): Record<string, string> {
    return readLocalNames().a;
}

export function writeLocalAliases(a: Record<string, string>): void {
    writeLocalNames({ ...readLocalNames(), a });
}

/** names the person said are none of the products (not asked again) */
export function readLocalIgnore(): string[] {
    return readLocalNames().i;
}

export function writeLocalIgnore(i: string[]): void {
    writeLocalNames({ ...readLocalNames(), i: [...new Set(i.map(canon).filter(Boolean))] });
}

/* ---------- reading a text ---------- */

export interface TextOutcome {
    /** the stocks found (one per date), oldest first */
    sheets: SheetRead[];
    /** read by the website, or put in rows by the AI */
    via: 'typed' | 'ai' | null;
    /** product names written twice for one date (the first kept) */
    twice: string[];
    /** the AI could not be asked (no key) although the website could not read the text */
    needKey: boolean;
    error?: AiError;
}

/**
 * The stock in a text the person sent: read by the website when it is written as lines of names and numbers;
 * otherwise (if there is an AI key and the text has numbers) put in rows by the AI. Not stock: no sheets.
 */
export async function readStockText(text: string, products: Product[], aliases: Record<string, string>, cfg: AiConfig | null, today: string): Promise<TextOutcome> {
    const read = parseStockText(text, products, aliases, today);
    const sorted = (list: SheetRead[]) => [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    /** products found with their stock written clearly (in the stock with the most) */
    const clear = (list: SheetRead[]) =>
        list.reduce((most, sh) => {
            const m = matchProducts(products, sh.rows, aliases);
            let n = 0;
            m.rows.forEach((i) => {
                if (sh.rows[i].remain !== null) n += 1;
            });
            return Math.max(most, n);
        }, 0);
    const typed: TextOutcome = { sheets: sorted(read.sheets), via: 'typed', twice: read.twice, needKey: false };
    const lines = text.split('\n').filter((l) => l.trim()).length;
    if (read.found >= MIN_FOUND) {
        // read by the website; only when most of it could not be told apart ("370 ຖົງ ຜົງກ້ວຍ") may the AI do better
        const sure = clear(read.sheets);
        if (!cfg || sure * 2 >= read.found) {
            return typed;
        }
        try {
            const ai = (await readTextWithAi(text, cfg, today)).filter((sh) => matchProducts(products, sh.rows, aliases).rows.size >= MIN_FOUND);
            return clear(ai) > sure ? { sheets: sorted(ai), via: 'ai', twice: [], needKey: false } : typed;
        } catch {
            return typed; // the numbers to check are marked on the page
        }
    }
    // another layout (written as a list): the AI may put it in rows (names as written; the same matching follows).
    // One or two lines are a question, not a stock.
    const worth = read.numbers >= MIN_FOUND && lines >= MIN_FOUND;
    if (!worth) {
        return { sheets: [], via: null, twice: [], needKey: false };
    }
    if (!cfg) {
        return { sheets: [], via: null, twice: [], needKey: read.found > 0 };
    }
    try {
        const sheets = (await readTextWithAi(text, cfg, today)).filter((sh) => matchProducts(products, sh.rows, aliases).rows.size >= MIN_FOUND);
        return { sheets: sorted(sheets), via: sheets.length ? 'ai' : null, twice: [], needKey: false };
    } catch (e) {
        return { sheets: [], via: null, twice: [], needKey: false, error: asAiError(e) };
    }
}

/* ---------- names to ask about ---------- */

export interface AskSet {
    /**
     * product: ask, for each product not found, which row it is (few products missing, e.g. a renamed one);
     * row: ask, for each unknown name, which product it is (few unknown names in a short text);
     * none: nothing unknown (products that are not written are simply not in this stock)
     */
    mode: 'product' | 'row' | 'none';
    products: string[];
    rows: number[];
}

/** what to ask about a stock, in the way that needs the fewest answers */
export function askSet(products: Product[], sheet: SheetRead | null, aliases: Record<string, string>, ignore: string[]): AskSet {
    const none: AskSet = { mode: 'none', products: [], rows: [] };
    if (!sheet || sheet.method === 'manual') {
        return none;
    }
    const m = matchProducts(products, sheet.rows, aliases, {}, ignore);
    if (!m.free.length || !m.missing.length) {
        return none;
    }
    return m.missing.length <= m.free.length ? { mode: 'product', products: m.missing, rows: [] } : { mode: 'row', products: [], rows: m.free };
}

/* ---------- the numbers of each product, with the checks ---------- */

export interface Side {
    qty: number | null;
    south: number | null;
    remain: number | null;
    unclear: Set<Field>;
    found: boolean;
    rowName: string;
}

export const NO_SIDE: Side = { qty: null, south: null, remain: null, unclear: new Set(), found: false, rowName: '' };

/** where one side's numbers come from: a sheet (with its matches), or the last saved analysis */
export interface SideSource {
    sheet: SheetRead | null;
    saved: Week | null;
    match: Match | null;
}

export function matchOf(
    products: Product[],
    sheet: SheetRead | null,
    aliases: Record<string, string>,
    picks?: Record<string, number | 'none'>,
    ignore: string[] = [],
): Match | null {
    if (!sheet || sheet.method === 'manual') {
        return null;
    }
    return matchProducts(products, sheet.rows, aliases, picks || {}, ignore);
}

export function sideOf(src: SideSource, pid: string): Side {
    if (src.saved) {
        const r = src.saved.rows.find((x) => x.p === pid);
        return r ? { qty: r.qty, south: r.south, remain: r.left, unclear: new Set(), found: true, rowName: '' } : NO_SIDE;
    }
    const sheet = src.sheet;
    if (!sheet) {
        return NO_SIDE;
    }
    if (sheet.method === 'manual') {
        return { ...NO_SIDE, found: true };
    }
    const idx = src.match ? src.match.rows.get(pid) : undefined;
    if (idx === undefined) {
        return NO_SIDE;
    }
    const row = sheet.rows[idx];
    return { qty: row.qty, south: row.south, remain: row.remain, unclear: new Set(row.unclear.filter((f): f is Field => f !== 'name')), found: true, rowName: row.name };
}

export interface Line {
    pid: string;
    prevSide: Side;
    currSide: Side;
    excluded: boolean;
    prev: number | null;
    qty: number | null;
    south: number | null;
    left: number | null;
    made: number | null;
    unclear: Cell[];
    bad: Cell[];
    mismatch: boolean;
    flagged: boolean;
}

export interface LineInput {
    products: Product[];
    prev: SideSource;
    curr: SideSource;
    prevPresent: boolean;
    currPresent: boolean;
    /** products the person said are not on the current sheet */
    notOnSheet: (pid: string) => boolean;
    /** numbers typed by the person: `${pid}:${cell}` → text */
    edits: Record<string, string>;
    /** rows the person confirmed as they are */
    okRows: Set<string>;
}

export function computeLines(input: LineInput): Line[] {
    const { products, prevPresent, currPresent, edits, okRows } = input;
    const typed = (pid: string, cell: Cell): number | null | 'bad' | undefined => {
        const r = edits[`${pid}:${cell}`];
        return r === undefined ? undefined : parseNum(r);
    };
    return products.map((p) => {
        const pid = p.id;
        const prevSide = prevPresent ? sideOf(input.prev, pid) : NO_SIDE;
        const currSide = currPresent ? sideOf(input.curr, pid) : NO_SIDE;
        const excluded = input.notOnSheet(pid) || (currPresent && !currSide.found);
        const pick = (cell: Cell, fromSheet: number | null): number | null => {
            const v = typed(pid, cell);
            return v === undefined ? fromSheet : v === 'bad' ? null : v;
        };
        const prev = pick('prev', prevSide.found ? prevSide.qty : null);
        const qty = pick('qty', currSide.qty);
        let south = pick('south', currSide.south);
        const left = pick('left', currSide.remain);
        const made = pick('made', null);
        const unclear: Cell[] = [];
        const bad = (['prev', 'qty', 'south', 'left', 'made'] as Cell[]).filter((c) => typed(pid, c) === 'bad');
        if (!excluded && currSide.found) {
            if (typed(pid, 'prev') === undefined && prevPresent && (prev === null || prevSide.unclear.has('qty'))) unclear.push('prev');
            if (typed(pid, 'qty') === undefined && currSide.unclear.has('qty')) unclear.push('qty');
            if (typed(pid, 'left') === undefined && (left === null || currSide.unclear.has('remain'))) unclear.push('left');
            if (typed(pid, 'south') === undefined && currSide.unclear.has('south')) unclear.push('south');
        }
        // an empty "sent south" cell is 0 when the numbers add up without it
        if (south === null && typed(pid, 'south') === undefined && qty !== null && left !== null && Math.abs(qty - left) < 0.01) {
            south = 0;
        }
        let mismatch = false;
        if (!excluded && qty !== null && left !== null) {
            if (south === null) {
                if (!unclear.includes('south') && typed(pid, 'south') === undefined) unclear.push('south');
            } else if (Math.abs(qty - south - left) > 0.01) {
                mismatch = true;
            }
        }
        const flagged = !excluded && currSide.found && (bad.length > 0 || ((unclear.length > 0 || mismatch) && !okRows.has(pid)));
        return { pid, prevSide, currSide, excluded, prev, qty, south, left, made, unclear, bad, mismatch, flagged };
    });
}

/** the numbers kept for the analysis (products found on the current sheet) */
export function weekRows(lines: Line[]): WeekRow[] {
    return lines
        .filter((l) => !l.excluded && l.currSide.found)
        .map((l) => ({ p: l.pid, prev: l.prev, qty: l.qty, south: l.south, left: l.left, made: l.made && l.made > 0 ? l.made : null }));
}

/* ---------- what to produce today ---------- */

export function localDay(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Production recorded on the website in (from, to]: by its production date ('made'),
 * or by the day it entered the warehouse when it was ticked ('received').
 */
export function producedBetween(months: MonthMap, from: string, to: string, by: 'made' | 'received'): Map<string, number> {
    const out = new Map<string, number>();
    if (!from || !to) {
        return out;
    }
    for (const list of Object.values(months)) {
        for (const e of list) {
            const day = by === 'received' && e.received ? localDay(e.received.at) : e.date;
            if (day && day > from && day <= to) {
                out.set(e.productId, (out.get(e.productId) || 0) + e.qty);
            }
        }
    }
    return out;
}

/** one product as it stands today (estimated from the last sheet) */
export interface TodayItem {
    productId: string;
    /** per day (average of up to 4 weeks) */
    daily: number;
    /** ຍັງເຫຼືອ on the sheet */
    leftThen: number;
    /** produced after the sheet date (recorded on the website) */
    producedSince: number;
    /** estimated stock today */
    leftNow: number;
    /** days the stock lasts from today (Infinity: nothing goes out) */
    cover: number;
    group: Group;
    /** suggested quantity to produce */
    suggest: number;
}

/**
 * The products as they stand today: the stock on the sheet, minus what goes out per day since the sheet date,
 * plus what was produced since. Most urgent first; those that need producing (suggest > 0) first of all.
 */
export function todayView(results: Result[], months: MonthMap, sheetDate: string, today: string, s: StockSettings): TodayItem[] {
    const since = Math.max(0, daysBetween(sheetDate, today));
    const made = producedBetween(months, sheetDate, today, 'made');
    const items: TodayItem[] = [];
    for (const r of results) {
        if (r.daily === null || r.left === null) {
            continue;
        }
        const producedSince = made.get(r.productId) || 0;
        const leftNow = Math.max(0, r.left + producedSince - r.daily * since);
        const cover = r.daily > 0 ? leftNow / r.daily : Infinity;
        const group: Group = cover < s.urgent ? 'urgent' : cover <= s.soon ? 'next' : 'later';
        const suggest = Math.max(0, Math.ceil(r.daily * s.target - leftNow - 1e-9));
        items.push({ productId: r.productId, daily: r.daily, leftThen: r.left, producedSince, leftNow, cover, group, suggest });
    }
    return items.sort((a, b) => Number(b.suggest > 0) - Number(a.suggest > 0) || a.cover - b.cover || b.daily - a.daily);
}

/* ---------- what the assistant reports after reading the sheets ---------- */

export interface StockSummary {
    prevDate: string;
    currDate: string;
    days: number;
    prevFrom: 'text' | 'saved' | 'none';
    foundPrev: number | null;
    foundCurr: number;
    total: number;
    /** product names to choose by hand (the name on the sheet changed) */
    asks: number;
    /** rows whose numbers must be checked */
    flagged: number;
    /** both sheets with their dates: the analysis can be made */
    ready: boolean;
    counts: { urgent: number; next: number; later: number };
    /** the fewest days left (today) */
    low: TodayItem[];
    /** the fastest going out */
    top: Array<{ productId: string; daily: number }>;
    /** the productions recommended now */
    picks: TodayItem[];
}

/** The analysis of a draft (sheets read by the assistant): the numbers, today's view and the summary. */
export function draftAnalysis(
    products: Product[],
    draft: StockDraft,
    doc: StockDoc | null,
    months: MonthMap,
    today: string,
    aliases: Record<string, string>,
): { summary: StockSummary; results: Result[]; view: TodayItem[] } {
    const savedPrev =
        draft.prev === 'saved' && doc ? [...doc.weeks].reverse().find((w) => !draft.curr.date || w.currDate < draft.curr.date) || null : null;
    const prevSheet = draft.prev && draft.prev !== 'saved' ? draft.prev : null;
    const ignore = [...(doc ? doc.ignore || [] : []), ...readLocalIgnore()];
    const prevMatch = matchOf(products, prevSheet, aliases, {}, ignore);
    const currMatch = matchOf(products, draft.curr, aliases, {}, ignore);
    const asked = (sheet: SheetRead | null) => {
        const a = askSet(products, sheet, aliases, ignore);
        return a.mode === 'product' ? a.products.length : a.rows.length;
    };
    const lines = computeLines({
        products,
        prev: { sheet: prevSheet, saved: savedPrev, match: prevMatch },
        curr: { sheet: draft.curr, saved: null, match: currMatch },
        prevPresent: Boolean(savedPrev || prevSheet),
        currPresent: true,
        notOnSheet: () => false,
        edits: {},
        okRows: new Set(),
    });
    const prevDate = savedPrev ? savedPrev.currDate : prevSheet ? prevSheet.date : '';
    const currDate = draft.curr.date;
    const days = prevDate && currDate ? daysBetween(prevDate, currDate) : 0;
    const ready = Boolean(savedPrev || prevSheet) && days > 0;
    const weekId = `w${prevDate}_${currDate}`;
    const settings = doc ? doc.settings : null;
    const results = ready && settings ? analyze(weekRows(lines), days, currDate, (doc ? doc.weeks : []).filter((w) => w.id !== weekId), settings) : [];
    const view = ready && settings ? todayView(results, months, currDate, today, settings) : [];
    const counts = { urgent: 0, next: 0, later: 0 };
    for (const r of results) {
        if (r.group === 'urgent' || r.group === 'next' || r.group === 'later') counts[r.group] += 1; // as on the page (sheet date)
    }
    const summary: StockSummary = {
        prevDate,
        currDate,
        days,
        prevFrom: savedPrev ? 'saved' : prevSheet ? 'text' : 'none',
        foundPrev: prevMatch ? prevMatch.rows.size : savedPrev ? savedPrev.rows.length : null,
        foundCurr: currMatch ? currMatch.rows.size : 0,
        total: products.length,
        asks: asked(prevSheet) + asked(draft.curr),
        flagged: lines.filter((l) => l.flagged).length,
        ready,
        counts,
        low: view.filter((v) => v.group === 'urgent' || v.group === 'next').sort((a, b) => a.cover - b.cover).slice(0, 4),
        top: topSellers(results).map((r) => ({ productId: r.productId, daily: r.daily as number })),
        picks: view.filter((v) => v.suggest > 0).slice(0, PLAN_MAX),
    };
    return { summary, results, view };
}

/** The analysis to talk about: the draft if there is one, else the last saved week. */
export function currentAnalysis(
    products: Product[],
    draft: StockDraft | null,
    doc: StockDoc | null,
    months: MonthMap,
    today: string,
    aliases: Record<string, string>,
): { summary: StockSummary | null; results: Result[]; view: TodayItem[]; from: string; to: string; days: number } | null {
    if (draft) {
        const a = draftAnalysis(products, draft, doc, months, today, aliases);
        return a.summary.ready ? { ...a, from: a.summary.prevDate, to: a.summary.currDate, days: a.summary.days } : null;
    }
    const week = doc && doc.weeks.length ? doc.weeks[doc.weeks.length - 1] : null;
    if (!doc || !week || week.days <= 0) {
        return null;
    }
    const results = analyze(week.rows, week.days, week.currDate, doc.weeks.filter((w) => w.id !== week.id), doc.settings);
    return { summary: null, results, view: todayView(results, months, week.currDate, today, doc.settings), from: week.prevDate, to: week.currDate, days: week.days };
}

/** the analysis as lines for the AI (it answers questions about it) */
export function analysisLines(products: Product[], a: { results: Result[]; view: TodayItem[]; from: string; to: string; days: number }): string[] {
    const { results, view } = a;
    const nameOf = new Map(products.map((p) => [p.id, p.name]));
    const lines: string[] = [`Stock sheets of ${a.from} and ${a.to} (${a.days} days apart).`];
    const byId = new Map(view.map((v) => [v.productId, v]));
    for (const r of results) {
        const v = byId.get(r.productId);
        const name = nameOf.get(r.productId) || r.productId;
        if (!v) {
            lines.push(`- ${name}: left on the sheet ${r.left ?? '?'}; ${r.refill ? 'stock went up (produced in between)' : 'no outflow known'}`);
            continue;
        }
        lines.push(
            `- ${name}: left on the sheet ${Math.round(v.leftThen)}, went out ${r.out ?? '?'} in the period, ${v.daily.toFixed(1)} per day` +
                `${r.weeks > 1 ? ` (average of ${r.weeks} weeks)` : ''}, produced since the sheet ${Math.round(v.producedSince)}, ` +
                `about ${Math.round(v.leftNow)} left today = ${Number.isFinite(v.cover) ? `${v.cover.toFixed(1)} days` : 'nothing goes out'}, ` +
                `group ${v.group}, suggested production ${v.suggest}`,
        );
    }
    return lines;
}
