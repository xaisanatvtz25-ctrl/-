/**
 * The stock the AI assistant has just read from a text, waiting on the "ວັນນີ້ຄວນຜະລິດຫຍັງດີ" page to be checked
 * and turned into a production plan. Kept on this device only (encrypted, it survives a reload) until the plan is sent.
 */
import type { SheetRead } from './stockSheet';
import { LOCAL, getLocal, onLocalChange, setLocal } from './vault';

export interface StockDraft {
    id: string;
    at: number;
    /** the earlier stock; 'saved' = the current stock of the last saved analysis; null = not given yet */
    prev: SheetRead | 'saved' | null;
    /** the newer stock */
    curr: SheetRead;
    /** read from a text by the website, by the AI, or typed in the table */
    source: 'text' | 'ai' | 'manual';
}

const METHODS = ['typed', 'ai', 'manual', 'saved', 'text'];

function validSheet(s: unknown): s is SheetRead {
    if (!s || typeof s !== 'object') {
        return false;
    }
    const o = s as Record<string, unknown>;
    return METHODS.includes(String(o.method)) && Array.isArray(o.rows) && typeof o.date === 'string';
}

function clean(raw: unknown): StockDraft | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== 'string' || !validSheet(o.curr)) {
        return null;
    }
    const prev = o.prev === 'saved' ? 'saved' : validSheet(o.prev) ? o.prev : null;
    const source = o.source === 'manual' ? 'manual' : o.source === 'ai' ? 'ai' : 'text';
    return { id: o.id, at: Number(o.at) || 0, prev, curr: o.curr, source };
}

export function getDraft(): StockDraft | null {
    try {
        const raw = getLocal(LOCAL.draft);
        return raw ? clean(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

export function setDraft(draft: StockDraft | null): void {
    setLocal(LOCAL.draft, draft ? JSON.stringify(draft) : null);
}

export function newDraftId(): string {
    return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** called when the draft changes (in this page or another tab) */
export function onDraftChange(fn: () => void): () => void {
    return onLocalChange(LOCAL.draft, fn);
}
