/**
 * The data file (data.json on the repository's "data" branch) and how it is read.
 * It is encrypted: only the people who can log in can open it. An encrypted copy is also published with the site
 * as a fallback.
 */
import type { ChatKind, ChatMsg, ChatRef, Entry, Issue, MonthMap, PlanItem, Product, Received } from './types';
import { DATA_FILE } from './config';
import { openSnapshot, readSecure, readSecureRaw } from './secureFiles';

export type DataSource = 'live' | 'snapshot';

export interface Dataset {
    products: Product[];
    months: MonthMap;
    chat: ChatMsg[];
    plan: PlanItem[];
    source: DataSource;
    /** when the data was read (live) or published (snapshot), epoch ms */
    updatedAt: number;
}

/**
 * Format of the data files. Raise it when a change adds data that an older website would drop when it saves;
 * an older page then refuses to save and asks to reload instead.
 * 2: ✗ marks (issue) on runs and the chat.
 * 3: the production plan sent from the weekly stock analysis (plan), stock.json.
 * 4: encrypted files, logins (access.json), password records in the history, names skipped on stock texts.
 */
export const SCHEMA = 4;

/** What is stored in data.json. */
export interface DataDoc {
    version: 1;
    /** format of the file (see SCHEMA) */
    schema: number;
    updatedAt: number;
    products: Product[];
    months: MonthMap;
    /** production ↔ warehouse chat, oldest first */
    chat: ChatMsg[];
    /** production plan from the weekly stock analysis, in order */
    plan: PlanItem[];
}

/** longest chat message, longest reason for a ✗ mark, messages kept */
export const CHAT_TEXT_MAX = 500;
export const REASON_MAX = 300;
export const CHAT_MAX = 1000;
export const QTY_MAX = 10_000_000;

const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isYm(v: unknown): v is string {
    return typeof v === 'string' && YM_RE.test(v);
}

export function isValidDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) {
        return false;
    }
    const d = new Date(value + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function cleanName(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

export function normName(value: string): string {
    return value.replace(/\s+/g, '').toLowerCase();
}

/** A person's name as typed (recorder of a change). */
export function cleanPerson(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
}

/** "received into the warehouse" mark: who and when */
export function cleanReceived(value: unknown): Received | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const o = value as Record<string, unknown>;
    const by = cleanPerson(o.by);
    const at = Number(o.at);
    return by && Number.isFinite(at) && at > 0 ? { by, at } : undefined;
}

function positive(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Text typed by a person: line breaks kept (at most one empty line), control characters removed. */
export function cleanText(value: unknown, max: number): string {
    if (typeof value !== 'string') {
        return '';
    }
    return value
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, max)
        .trim();
}

/** a counted quantity: 0 is allowed (nothing arrived); missing stays undefined */
export function cleanCount(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= 0 && n <= QTY_MAX ? n : undefined;
}

/** ✗ "does not match" mark */
export function cleanIssue(value: unknown): Issue | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const o = value as Record<string, unknown>;
    const by = cleanPerson(o.by);
    const at = Number(o.at);
    if (!by || !Number.isFinite(at) || at <= 0) {
        return undefined;
    }
    const issue: Issue = { by, at, reason: cleanText(o.reason, REASON_MAX) };
    const counted = cleanCount(o.counted);
    if (counted !== undefined) {
        issue.counted = counted;
    }
    return issue;
}

const CHAT_KINDS: ChatKind[] = ['flag', 'fixed', 'ok', 'unflag', 'deleted'];

function cleanRef(value: unknown): ChatRef | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const o = value as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    if (!id || !isYm(o.month)) {
        return undefined;
    }
    const qty = Math.round(Number(o.qty));
    return {
        id,
        month: o.month,
        name: cleanName(o.name) || '—',
        qty: Number.isFinite(qty) && qty > 0 ? qty : 0,
        date: isValidDate(o.date) ? o.date : '',
    };
}

/** The production plan, cleaned, in its order. */
export function normalizePlan(raw: unknown): PlanItem[] {
    const out: PlanItem[] = [];
    const seen = new Set<string>();
    (Array.isArray(raw) ? raw : []).forEach((item, i) => {
        if (!item || typeof item !== 'object') {
            return;
        }
        const o = item as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id.trim() : '';
        const productId = typeof o.productId === 'string' ? o.productId.trim() : '';
        const qty = Math.round(Number(o.qty));
        if (!id || seen.has(id) || !productId || !Number.isFinite(qty) || qty <= 0 || qty > QTY_MAX) {
            return;
        }
        seen.add(id);
        const plan: PlanItem = {
            id,
            productId,
            qty,
            date: isValidDate(o.date) ? o.date : '',
            order: positive(o.order) || i + 1,
            week: typeof o.week === 'string' ? o.week.slice(0, 40) : '',
            by: cleanPerson(o.by) || '—',
            at: positive(o.at),
        };
        if (o.done && typeof o.done === 'object') {
            const d = o.done as Record<string, unknown>;
            const at = positive(d.at);
            if (at) {
                plan.done = { at, by: cleanPerson(d.by) || '—', ...(typeof d.entry === 'string' && d.entry ? { entry: d.entry.slice(0, 40) } : {}) };
            }
        }
        out.push(plan);
    });
    return out.sort((a, b) => a.order - b.order).slice(0, 200);
}

/** The chat messages, cleaned, oldest first, at most CHAT_MAX. */
export function normalizeChat(raw: unknown): ChatMsg[] {
    const out: ChatMsg[] = [];
    const seen = new Set<string>();
    (Array.isArray(raw) ? raw : []).forEach((item) => {
        if (!item || typeof item !== 'object') {
            return;
        }
        const o = item as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id.trim() : '';
        const at = positive(o.at);
        const kind = CHAT_KINDS.find((k) => k === o.kind);
        const text = cleanText(o.text, CHAT_TEXT_MAX);
        if (!id || seen.has(id) || !at || (!kind && !text)) {
            return;
        }
        seen.add(id);
        const msg: ChatMsg = { id, at, by: cleanPerson(o.by) || '—', text };
        if (kind) {
            msg.kind = kind;
        }
        const ref = cleanRef(o.ref);
        if (ref) {
            msg.ref = ref;
        }
        const counted = cleanCount(o.counted);
        if (counted !== undefined) {
            msg.counted = counted;
        }
        const from = cleanCount(o.from);
        const to = cleanCount(o.to);
        if (from !== undefined && to !== undefined) {
            msg.from = from;
            msg.to = to;
        }
        if (typeof o.replyTo === 'string' && o.replyTo) {
            msg.replyTo = o.replyTo.slice(0, 40);
        }
        out.push(msg);
    });
    // oldest first (stable for messages written in the same millisecond)
    return out
        .map((m, i) => ({ m, i }))
        .sort((a, b) => a.m.at - b.m.at || a.i - b.i)
        .map((x) => x.m)
        .slice(-CHAT_MAX);
}

/** Cleans whatever is in the file into the shape the site uses (bad items are skipped). */
export function normalizeDoc(raw: unknown): DataDoc {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const products: Product[] = [];
    const seenProducts = new Set<string>();
    (Array.isArray(r.products) ? r.products : []).forEach((item, i) => {
        if (!item || typeof item !== 'object') {
            return;
        }
        const o = item as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id.trim() : '';
        const name = cleanName(o.name);
        if (!id || !name || seenProducts.has(id)) {
            return;
        }
        seenProducts.add(id);
        products.push({
            id,
            name,
            sort: positive(o.sort) || 1000 + i,
            since: isYm(o.since) ? o.since : '2026-01',
            createdAt: positive(o.createdAt),
        });
    });
    products.sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);

    const months: MonthMap = {};
    const seenEntries = new Set<string>();
    const src = r.months && typeof r.months === 'object' && !Array.isArray(r.months) ? (r.months as Record<string, unknown>) : {};
    Object.keys(src)
        .sort()
        .forEach((ym) => {
            const list = src[ym];
            if (!isYm(ym) || !Array.isArray(list)) {
                return;
            }
            list.forEach((item, i) => {
                if (!item || typeof item !== 'object') {
                    return;
                }
                const o = item as Record<string, unknown>;
                const productId = typeof o.productId === 'string' ? o.productId.trim() : '';
                const qty = Math.round(Number(o.qty));
                if (!productId || !Number.isFinite(qty) || qty <= 0) {
                    return;
                }
                let id = typeof o.id === 'string' ? o.id.trim() : '';
                if (!id || seenEntries.has(id)) {
                    id = `${id || 'e'}-${ym}-${i}`;
                }
                seenEntries.add(id);
                const entry: Entry = {
                    id,
                    productId,
                    qty,
                    date: isValidDate(o.date) ? o.date : '',
                    note: typeof o.note === 'string' ? o.note.slice(0, 200) : '',
                    createdAt: positive(o.createdAt),
                };
                const by = cleanPerson(o.by);
                if (by) {
                    entry.by = by;
                }
                const editedBy = cleanPerson(o.editedBy);
                if (editedBy) {
                    entry.editedBy = editedBy;
                    entry.editedAt = positive(o.editedAt);
                }
                const received = cleanReceived(o.received);
                const issue = cleanIssue(o.issue);
                // a run is either received (✓) or not matching (✗): the newer mark wins
                if (received && (!issue || received.at >= issue.at)) {
                    entry.received = received;
                } else if (issue) {
                    entry.issue = issue;
                }
                (months[ym] = months[ym] || []).push(entry);
            });
        });
    return {
        version: 1,
        schema: Math.max(1, Math.round(Number(r.schema)) || 1),
        updatedAt: positive(r.updatedAt) || positive(r.exportedAt),
        products,
        months,
        chat: normalizeChat(r.chat),
        plan: normalizePlan(r.plan),
    };
}

/** A JSON array with one item per line (small file, and each change is one line in the GitHub history). */
export function jsonLines(items: unknown[], indent: string): string {
    if (!items.length) {
        return '[]';
    }
    return '[\n' + items.map((x) => indent + ' ' + JSON.stringify(x)).join(',\n') + '\n' + indent + ']';
}

export function serializeDoc(doc: DataDoc): string {
    const months = Object.keys(doc.months)
        .sort()
        .filter((ym) => doc.months[ym].length)
        .map((ym) => '  ' + JSON.stringify(ym) + ': ' + jsonLines(doc.months[ym], '  '));
    const chat = doc.chat && doc.chat.length ? ',\n "chat": ' + jsonLines(doc.chat, ' ') : '';
    const plan = doc.plan && doc.plan.length ? ',\n "plan": ' + jsonLines(doc.plan, ' ') : '';
    return (
        '{\n' +
        ' "version": 1,\n' +
        ` "schema": ${SCHEMA},\n` +
        ` "updatedAt": ${Math.round(doc.updatedAt) || 0},\n` +
        ' "products": ' + jsonLines(doc.products, ' ') + ',\n' +
        ' "months": ' + (months.length ? '{\n' + months.join(',\n') + '\n }' : '{}') +
        chat +
        plan + '\n' +
        '}\n'
    );
}

async function fetchLiveText(token?: string): Promise<string | null> {
    try {
        const f = await readSecure(DATA_FILE, token);
        return f ? f.text : null;
    } catch (e) {
        if (e && typeof e === 'object' && 'code' in e && ['key_changed', 'cannot_open', 'wrong_file', 'not_encrypted', 'locked'].includes(String((e as { code: string }).code))) {
            throw e;
        }
        if (token) {
            try {
                const f = await readSecure(DATA_FILE);
                return f ? f.text : null;
            } catch {
                // fall through to the file server
            }
        }
        return readSecureRaw(DATA_FILE);
    }
}

/** The current data from GitHub (with the saving key, when unlocked, for the freshest copy). */
export async function loadLive(token?: string): Promise<Dataset> {
    const text = await fetchLiveText(token);
    if (!text) {
        throw new Error('no_data');
    }
    const doc = normalizeDoc(JSON.parse(text));
    if (!doc.products.length) {
        throw new Error('empty_products');
    }
    return { products: doc.products, months: doc.months, chat: doc.chat, plan: doc.plan, source: 'live', updatedAt: Date.now() };
}

/** The copy published with the site, shown first (fast) and if GitHub cannot be reached. */
export async function loadSnapshot(): Promise<Dataset> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15_000);
    try {
        const res = await fetch(`./data.json?_=${Date.now()}`, { cache: 'no-store', credentials: 'omit', signal: controller.signal });
        if (!res.ok) {
            throw new Error(`http_${res.status}`);
        }
        const doc = normalizeDoc(JSON.parse(await openSnapshot(DATA_FILE, await res.text())));
        return { products: doc.products, months: doc.months, chat: doc.chat, plan: doc.plan, source: 'snapshot', updatedAt: doc.updatedAt };
    } finally {
        window.clearTimeout(timer);
    }
}
