/**
 * Change history (history.json on the "data" branch): who added, changed or deleted what, and when.
 * Each record keeps the item before and after the change, so a change can be undone.
 */
import type { Entry, Product } from './types';
import { SCHEMA, cleanIssue, cleanName, cleanPerson, cleanReceived, isValidDate, isYm, jsonLines } from './source';

export const HISTORY_MAX = 2000;

/**
 * flag / unflag: the warehouse marked a run ✗ "does not match" / took the mark away;
 * password: a person's login password was set (by that person, or for them with the company code)
 */
export type HistAct = 'add' | 'edit' | 'delete' | 'receive' | 'unreceive' | 'flag' | 'unflag' | 'undo' | 'password';
export type HistKind = 'entry' | 'product' | 'user';

/** the person whose password was set */
export interface UserSnap {
    id: string;
    name: string;
}

/** a production run as it was at that moment, with its month and the product name of the time */
export interface EntrySnap extends Entry {
    month: string;
    name: string;
}

export interface HistRecord {
    id: string;
    at: number;
    by: string;
    act: HistAct;
    kind: HistKind;
    before?: EntrySnap | Product | UserSnap;
    after?: EntrySnap | Product | UserSnap;
    /** for act "undo": the record that was undone */
    undoOf?: string;
    /** set on a record after it was undone */
    undoneAt?: number;
    undoneBy?: string;
}

export interface HistoryDoc {
    version: 1;
    /** format of the file (see SCHEMA in source.ts) */
    schema: number;
    records: HistRecord[];
}

/** what a save wants to log (id, time and name are added when it is written) */
export type LogDraft = Pick<HistRecord, 'act' | 'kind' | 'before' | 'after' | 'undoOf'>;

export interface HistOp {
    append?: HistRecord;
    mark?: { id: string; undoneAt: number; undoneBy: string };
}

const ACTS: HistAct[] = ['add', 'edit', 'delete', 'receive', 'unreceive', 'flag', 'unflag', 'undo', 'password'];
const KINDS: HistKind[] = ['entry', 'product', 'user'];

function num(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

export function entrySnap(e: Entry, month: string, name: string): EntrySnap {
    return { ...e, month, name };
}

/** the run itself, without the snapshot-only fields */
export function snapToEntry(s: EntrySnap): Entry {
    const e: Entry = { id: s.id, productId: s.productId, qty: s.qty, date: s.date, note: s.note, createdAt: s.createdAt };
    if (s.by) {
        e.by = s.by;
    }
    if (s.editedBy) {
        e.editedBy = s.editedBy;
        e.editedAt = s.editedAt || 0;
    }
    if (s.received) {
        e.received = { ...s.received };
    }
    if (s.issue) {
        e.issue = { ...s.issue };
    }
    return e;
}

function cleanSnap(kind: HistKind, raw: unknown): EntrySnap | Product | UserSnap | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    if (!id) {
        return undefined;
    }
    if (kind === 'user') {
        const name = cleanPerson(o.name);
        return name ? { id: id.slice(0, 20), name } : undefined;
    }
    if (kind === 'product') {
        const name = cleanName(o.name);
        if (!name) {
            return undefined;
        }
        return { id, name, sort: num(o.sort) || 1000, since: isYm(o.since) ? o.since : '2026-01', createdAt: num(o.createdAt) };
    }
    const qty = Math.round(Number(o.qty));
    const month = isYm(o.month) ? o.month : '';
    const productId = typeof o.productId === 'string' ? o.productId : '';
    if (!month || !productId || !Number.isFinite(qty) || qty <= 0) {
        return undefined;
    }
    const snap: EntrySnap = {
        id,
        productId,
        qty,
        date: isValidDate(o.date) ? o.date : '',
        note: typeof o.note === 'string' ? o.note.slice(0, 200) : '',
        createdAt: num(o.createdAt),
        month,
        name: cleanName(o.name) || productId,
    };
    const by = cleanPerson(o.by);
    if (by) {
        snap.by = by;
    }
    const editedBy = cleanPerson(o.editedBy);
    if (editedBy) {
        snap.editedBy = editedBy;
        snap.editedAt = num(o.editedAt);
    }
    const received = cleanReceived(o.received);
    if (received) {
        snap.received = received;
    }
    const issue = cleanIssue(o.issue);
    if (issue) {
        snap.issue = issue;
    }
    return snap;
}

export function normalizeHistory(raw: unknown): HistoryDoc {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const seen = new Set<string>();
    const records: HistRecord[] = [];
    (Array.isArray(r.records) ? r.records : []).forEach((item) => {
        if (!item || typeof item !== 'object') {
            return;
        }
        const o = item as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id : '';
        const act = ACTS.find((a) => a === o.act);
        const kind = KINDS.find((k) => k === o.kind);
        if (!id || seen.has(id) || !act || !kind || !num(o.at)) {
            return;
        }
        seen.add(id);
        const rec: HistRecord = { id, at: num(o.at), by: cleanPerson(o.by) || '—', act, kind };
        const before = cleanSnap(kind, o.before);
        const after = cleanSnap(kind, o.after);
        if (before) {
            rec.before = before;
        }
        if (after) {
            rec.after = after;
        }
        if (typeof o.undoOf === 'string' && o.undoOf) {
            rec.undoOf = o.undoOf;
        }
        if (num(o.undoneAt)) {
            rec.undoneAt = num(o.undoneAt);
            rec.undoneBy = cleanPerson(o.undoneBy) || '—';
        }
        records.push(rec);
    });
    records.sort((a, b) => a.at - b.at);
    return { version: 1, schema: Math.max(1, Math.round(Number(r.schema)) || 1), records: records.slice(-HISTORY_MAX) };
}

/** Applies queued changes to the history; returns true when something changed (repeating is harmless). */
export function applyOps(doc: HistoryDoc, ops: HistOp[]): boolean {
    let changed = false;
    for (const op of ops) {
        if (op.append && !doc.records.some((r) => r.id === op.append!.id)) {
            doc.records.push(op.append);
            changed = true;
        }
        if (op.mark) {
            const r = doc.records.find((x) => x.id === op.mark!.id);
            if (r && !r.undoneAt) {
                r.undoneAt = op.mark.undoneAt;
                r.undoneBy = op.mark.undoneBy;
                changed = true;
            }
        }
    }
    if (changed) {
        doc.records.sort((a, b) => a.at - b.at);
        if (doc.records.length > HISTORY_MAX) {
            doc.records = doc.records.slice(-HISTORY_MAX);
        }
    }
    return changed;
}

export function serializeHistory(doc: HistoryDoc): string {
    return '{\n "version": 1,\n "schema": ' + SCHEMA + ',\n "records": ' + jsonLines(doc.records, ' ') + '\n}\n';
}
