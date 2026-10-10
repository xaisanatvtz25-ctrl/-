/**
 * stock.json on the "data" branch (encrypted): the weekly stock analyses (history), the settings of the analysis,
 * the names the person matched to a product themselves, and the names they said to skip (remembered).
 */
import { ApiError } from './api';
import { readSecure, readSecureText, writeSecure } from './secureFiles';
import { SCHEMA, cleanPerson, isValidDate, jsonLines } from './source';
import { canon } from './stockSheet';
import { cleanSettings } from './stockAnalysis';
import type { StockSettings, Week, WeekRow } from './stockAnalysis';

export const STOCK_FILE = 'stock.json';
const WEEKS_MAX = 156;

export interface StockDoc {
    version: 1;
    schema: number;
    settings: StockSettings;
    /** canonical sheet name → product id (only matches the person chose) */
    aliases: Record<string, string>;
    /** canonical names the person said are none of the products (not asked again) */
    ignore: string[];
    /** oldest first */
    weeks: Week[];
}

function num(v: unknown): number | null {
    if (v === null || v === undefined || v === '') {
        return null;
    }
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n < 1e9 ? n : null;
}

function cleanRow(raw: unknown): WeekRow | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const o = raw as Record<string, unknown>;
    const p = typeof o.p === 'string' ? o.p : '';
    if (!p) {
        return null;
    }
    return { p, prev: num(o.prev), qty: num(o.qty), south: num(o.south), left: num(o.left), made: num(o.made) };
}

export function normalizeStock(raw: unknown): StockDoc {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const aliases: Record<string, string> = {};
    if (r.aliases && typeof r.aliases === 'object') {
        for (const [k, v] of Object.entries(r.aliases as Record<string, unknown>)) {
            const key = canon(k);
            if (key && typeof v === 'string' && v) {
                aliases[key] = v;
            }
        }
    }
    const ignore = [...new Set((Array.isArray(r.ignore) ? r.ignore : []).map((x) => (typeof x === 'string' ? canon(x) : '')).filter(Boolean))].slice(0, 500);
    const seen = new Set<string>();
    const weeks: Week[] = [];
    for (const w of Array.isArray(r.weeks) ? r.weeks : []) {
        if (!w || typeof w !== 'object') {
            continue;
        }
        const o = w as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id : '';
        if (!id || seen.has(id) || !isValidDate(o.prevDate) || !isValidDate(o.currDate)) {
            continue;
        }
        seen.add(id);
        const rows = (Array.isArray(o.rows) ? o.rows : []).map(cleanRow).filter((x): x is WeekRow => Boolean(x));
        const files = o.files && typeof o.files === 'object' ? (o.files as Record<string, unknown>) : {};
        weeks.push({
            id,
            savedAt: Number(o.savedAt) || 0,
            by: cleanPerson(o.by) || '—',
            prevDate: o.prevDate as string,
            currDate: o.currDate as string,
            days: Math.max(0, Math.round(Number(o.days)) || 0),
            rows,
            files: { prev: typeof files.prev === 'string' ? files.prev.slice(0, 120) : undefined, curr: typeof files.curr === 'string' ? files.curr.slice(0, 120) : undefined },
        });
    }
    weeks.sort((a, b) => (a.currDate < b.currDate ? -1 : a.currDate > b.currDate ? 1 : a.savedAt - b.savedAt));
    return {
        version: 1,
        schema: Math.max(1, Math.round(Number(r.schema)) || 1),
        settings: cleanSettings(r.settings),
        aliases,
        ignore,
        weeks: weeks.slice(-WEEKS_MAX),
    };
}

export function serializeStock(doc: StockDoc): string {
    return (
        '{\n' +
        ' "version": 1,\n' +
        ` "schema": ${SCHEMA},\n` +
        ` "settings": ${JSON.stringify(doc.settings)},\n` +
        ` "aliases": ${JSON.stringify(doc.aliases, null, 1).replace(/\n/g, '\n ')},\n` +
        ` "ignore": ${JSON.stringify(doc.ignore || [])},\n` +
        ' "weeks": ' + jsonLines(doc.weeks, ' ') + '\n' +
        '}\n'
    );
}

/** The analyses saved so far (everyone logged in can read them). */
export async function loadStock(token?: string): Promise<StockDoc> {
    const text = await readSecureText(STOCK_FILE, token);
    const doc = normalizeStock(text && text.trim() ? JSON.parse(text) : {});
    cache = { doc, at: Date.now() };
    return doc;
}

let cache: { doc: StockDoc; at: number } | null = null;

/** The analyses, read again when older than `maxAge` (the assistant and the page share them). */
export async function getStock(token?: string, maxAge = 60_000): Promise<StockDoc> {
    if (cache && Date.now() - cache.at < maxAge) {
        return cache.doc;
    }
    return loadStock(token);
}

/** the analyses known right now (null before the first read) */
export function cachedStock(): StockDoc | null {
    return cache ? cache.doc : null;
}

/** Applies `change` to the newest stock.json and saves it (tried again if someone saved in between). */
export async function saveStock(token: string, change: (doc: StockDoc) => void): Promise<StockDoc> {
    for (let attempt = 0; ; attempt += 1) {
        const file = await readSecure(STOCK_FILE, token);
        let doc: StockDoc;
        try {
            doc = normalizeStock(file && file.text.trim() ? JSON.parse(file.text) : {});
        } catch {
            throw new ApiError('bad_data', 500);
        }
        if (doc.schema > SCHEMA) {
            window.dispatchEvent(new Event('milako:outdated'));
            throw new ApiError('outdated', 409);
        }
        change(doc);
        try {
            await writeSecure(STOCK_FILE, serializeStock(doc), file ? file.sha : null, token);
            cache = { doc, at: Date.now() };
            return doc;
        } catch (e) {
            if (e instanceof ApiError && e.code === 'conflict' && attempt < 4) {
                continue;
            }
            throw e;
        }
    }
}
