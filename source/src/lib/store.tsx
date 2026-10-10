import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from './api';
import { DATA_FILE, HISTORY_FILE, REFRESH_MS } from './config';
import { readSecure, readSecureText, writeSecure } from './secureFiles';
import { LOCAL, getLocal, setLocal } from './vault';
import {
    CHAT_TEXT_MAX,
    QTY_MAX,
    REASON_MAX,
    SCHEMA,
    cleanCount,
    cleanName,
    cleanText,
    isValidDate,
    isYm,
    loadLive,
    loadSnapshot,
    normName,
    normalizeDoc,
    serializeDoc,
} from './source';
import type { DataDoc, Dataset, DataSource } from './source';
import { applyOps, entrySnap, normalizeHistory, serializeHistory, snapToEntry } from './history';
import type { EntrySnap, HistOp, HistRecord, HistoryDoc, LogDraft } from './history';
import { useEditor } from './editor';
import { useSession } from './session';
import { announceOutdated } from './update';
import type { ChatMsg, ChatRef, Entry, EntryInput, MonthMap, PlanItem, Product } from './types';

/** a production run, found by id (the month is where to look first) */
export interface RunRef {
    id: string;
    month: string;
}

interface StoreValue {
    products: Product[];
    months: MonthMap;
    /** production ↔ warehouse chat, oldest first */
    chat: ChatMsg[];
    loaded: boolean;
    loadError: string | null;
    source: DataSource | null;
    updatedAt: number;
    /** goes up after every save (the history page reloads) */
    historyVersion: number;
    refresh: (silent?: boolean) => Promise<void>;
    addEntry: (input: EntryInput) => Promise<{ month: string; entry: Entry }>;
    updateEntry: (id: string, fromMonth: string, input: EntryInput) => Promise<{ month: string; entry: Entry }>;
    deleteEntry: (id: string, month: string) => Promise<void>;
    addProduct: (name: string, since?: string) => Promise<Product>;
    renameProduct: (id: string, name: string) => Promise<Product>;
    deleteProduct: (id: string) => Promise<void>;
    loadHistory: () => Promise<HistoryDoc>;
    undo: (recordId: string) => Promise<void>;
    /** tick (or untick) production runs as received into the warehouse; returns how many changed */
    setReceived: (items: RunRef[], received: boolean) => Promise<number>;
    /** warehouse: mark a run ✗ "does not match", with the reason (and the quantity counted) */
    flagIssue: (item: RunRef, counted: number | undefined, reason: string) => Promise<void>;
    /** take the ✗ mark away (the run waits for the warehouse again) */
    clearIssue: (item: RunRef) => Promise<void>;
    /** write in the production ↔ warehouse chat, optionally about one run and/or answering a message */
    sendMessage: (text: string, ref?: ChatRef | null, replyTo?: string | null) => Promise<ChatMsg>;
    /** delete one's own message */
    deleteMessage: (id: string) => Promise<void>;
    /** production plan from the weekly stock analysis */
    plan: PlanItem[];
    /** replaces the plan with these products, in this order ("ສົ່ງໄປລາຍການຜະລິດ") */
    sendPlan: (week: string, items: Array<{ productId: string; qty: number; date: string }>) => Promise<void>;
    /** marks a plan item produced (or not) without recording a production run */
    setPlanDone: (id: string, done: boolean) => Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

const MAX_QTY = QTY_MAX;

function newId(prefix: string): string {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** this month in Vientiane time (YYYY-MM) */
function thisMonth(): string {
    return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
}

function checkEntry(doc: DataDoc, input: EntryInput) {
    const product = doc.products.find((p) => p.id === input.productId);
    if (!product) {
        throw new ApiError('product_not_found', 404);
    }
    const qty = Math.round(Number(input.qty));
    if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY) {
        throw new ApiError('qty_invalid', 400);
    }
    const date = (input.date || '').trim();
    if (date && !isValidDate(date)) {
        throw new ApiError('date_invalid', 400);
    }
    const month = date ? date.slice(0, 7) : input.month;
    if (!isYm(month)) {
        throw new ApiError('month_required', 400);
    }
    return { product, qty, date, month, note: (input.note || '').trim().slice(0, 200) };
}

function findEntry(doc: DataDoc, id: string, hint: string): { month: string; index: number } | null {
    const months = [hint, ...Object.keys(doc.months).filter((m) => m !== hint)];
    for (const month of months) {
        const index = (doc.months[month] || []).findIndex((e) => e.id === id);
        if (index >= 0) {
            return { month, index };
        }
    }
    return null;
}

function removeEntry(doc: DataDoc, month: string, index: number): Entry {
    const list = [...(doc.months[month] || [])];
    const [old] = list.splice(index, 1);
    if (list.length) {
        doc.months[month] = list;
    } else {
        delete doc.months[month];
    }
    return old;
}

function productName(doc: DataDoc, id: string): string {
    return doc.products.find((p) => p.id === id)?.name || id;
}

function runsOf(doc: DataDoc, productId: string): number {
    return Object.values(doc.months).reduce((n, list) => n + list.filter((e) => e.productId === productId).length, 0);
}

/** what a chat message shows about a run */
function refOf(e: Entry, month: string, name: string): ChatRef {
    return { id: e.id, month, name, qty: e.qty, date: e.date };
}

/** a message added by the site when something happens to a run */
function sysMessage(doc: DataDoc, msg: Omit<ChatMsg, 'id' | 'text'> & { text?: string }): void {
    doc.chat.push({ id: newId('m'), text: '', ...msg });
}

/** Reverses one history record on the current data (for "undo"). */
function inverse(doc: DataDoc, r: HistRecord, who: string, now: number): Pick<LogDraft, 'kind' | 'before' | 'after'> {
    if (r.kind === 'entry') {
        const a = r.after as EntrySnap | undefined;
        const b = r.before as EntrySnap | undefined;
        if (r.act === 'add' && a) {
            const at = findEntry(doc, a.id, a.month);
            if (!at) {
                throw new ApiError('nothing_to_undo', 409);
            }
            const cur = removeEntry(doc, at.month, at.index);
            return { kind: 'entry', before: entrySnap(cur, at.month, productName(doc, cur.productId)) };
        }
        if (r.act === 'receive' || r.act === 'unreceive') {
            const s = (a || b) as EntrySnap | undefined;
            const at = s ? findEntry(doc, s.id, s.month) : null;
            if (!s || !at) {
                throw new ApiError('nothing_to_undo', 409);
            }
            const list = doc.months[at.month];
            const cur = list[at.index];
            if (r.act === 'receive' ? !cur.received : Boolean(cur.received)) {
                throw new ApiError('nothing_to_undo', 409);
            }
            const next: Entry = { ...cur };
            if (r.act === 'receive') {
                delete next.received;
                if (b && b.issue) {
                    next.issue = { ...b.issue }; // it was marked ✗ before the tick
                }
            } else if (b && b.received) {
                next.received = { ...b.received };
                delete next.issue;
            } else {
                throw new ApiError('nothing_to_undo', 409);
            }
            list[at.index] = next;
            const name = productName(doc, cur.productId);
            return { kind: 'entry', before: entrySnap(cur, at.month, name), after: entrySnap(next, at.month, name) };
        }
        if (r.act === 'flag' || r.act === 'unflag') {
            const s = (a || b) as EntrySnap | undefined;
            const at = s ? findEntry(doc, s.id, s.month) : null;
            if (!s || !at) {
                throw new ApiError('nothing_to_undo', 409);
            }
            const list = doc.months[at.month];
            const cur = list[at.index];
            const next: Entry = { ...cur };
            const name = productName(doc, cur.productId);
            if (r.act === 'flag') {
                // only while the ✗ mark is still there
                if (!cur.issue) {
                    throw new ApiError('nothing_to_undo', 409);
                }
                delete next.issue;
                if (b && b.received) {
                    next.received = { ...b.received };
                }
                sysMessage(doc, { at: now, by: who, kind: 'unflag', ref: refOf(next, at.month, name) });
            } else {
                // put the mark back, only if nothing happened to the run since
                if (cur.issue || cur.received || !b || !b.issue) {
                    throw new ApiError('nothing_to_undo', 409);
                }
                next.issue = { ...b.issue };
                const counted = b.issue.counted;
                sysMessage(doc, {
                    at: now,
                    by: who,
                    kind: 'flag',
                    text: b.issue.reason,
                    ref: refOf(next, at.month, name),
                    ...(counted !== undefined ? { counted } : {}),
                });
            }
            list[at.index] = next;
            return { kind: 'entry', before: entrySnap(cur, at.month, name), after: entrySnap(next, at.month, name) };
        }
        if ((r.act === 'edit' || r.act === 'delete') && b) {
            if (!doc.products.some((p) => p.id === b.productId)) {
                throw new ApiError('product_not_found', 404);
            }
            let before: EntrySnap | undefined;
            let restored: Entry;
            const at = findEntry(doc, b.id, (a || b).month);
            if (at) {
                if (r.act === 'delete') {
                    throw new ApiError('nothing_to_undo', 409);
                }
                const cur = removeEntry(doc, at.month, at.index);
                before = entrySnap(cur, at.month, productName(doc, cur.productId));
                // what was typed comes back; the warehouse marks it has now stay
                restored = { ...cur, productId: b.productId, qty: b.qty, date: b.date, note: b.note, editedBy: who, editedAt: now };
                if (cur.issue && cur.qty !== restored.qty) {
                    sysMessage(doc, {
                        at: now,
                        by: who,
                        kind: 'fixed',
                        ref: refOf(restored, b.month, productName(doc, b.productId)),
                        from: cur.qty,
                        to: restored.qty,
                    });
                }
            } else {
                restored = { ...snapToEntry(b), editedBy: who, editedAt: now };
            }
            doc.months[b.month] = [...(doc.months[b.month] || []), restored];
            return { kind: 'entry', before, after: entrySnap(restored, b.month, productName(doc, b.productId)) };
        }
    } else {
        const a = r.after as Product | undefined;
        const b = r.before as Product | undefined;
        if (r.act === 'add' && a) {
            const index = doc.products.findIndex((p) => p.id === a.id);
            if (index < 0) {
                throw new ApiError('nothing_to_undo', 409);
            }
            const runs = runsOf(doc, a.id);
            if (runs > 0) {
                throw new ApiError(`has_entries:${runs}`, 409);
            }
            const [cur] = doc.products.splice(index, 1);
            return { kind: 'product', before: { ...cur } };
        }
        if (r.act === 'edit' && b) {
            const p = doc.products.find((x) => x.id === b.id);
            if (!p) {
                throw new ApiError('not_found', 404);
            }
            if (doc.products.some((x) => x.id !== b.id && normName(x.name) === normName(b.name))) {
                throw new ApiError('duplicate_name', 409);
            }
            const before = { ...p };
            p.name = b.name;
            return { kind: 'product', before, after: { ...p } };
        }
        if (r.act === 'delete' && b) {
            if (doc.products.some((x) => x.id === b.id)) {
                throw new ApiError('nothing_to_undo', 409);
            }
            if (doc.products.some((x) => normName(x.name) === normName(b.name))) {
                throw new ApiError('duplicate_name', 409);
            }
            doc.products.push({ ...b });
            return { kind: 'product', after: { ...b } };
        }
    }
    throw new ApiError('nothing_to_undo', 409);
}

interface Change<R> {
    result: R;
    log?: LogDraft | LogDraft[];
    /** history record this change undoes */
    mark?: string;
    /** nothing to save (already in that state) */
    noop?: boolean;
}

/* History records wait here (kept on this device, encrypted) until they are written to GitHub. */
function readPending(): HistOp[] {
    try {
        const v = JSON.parse(getLocal(LOCAL.pending) || '[]') as unknown;
        return Array.isArray(v) ? (v as HistOp[]) : [];
    } catch {
        return [];
    }
}

function writePending(ops: HistOp[]): void {
    setLocal(LOCAL.pending, ops.length ? JSON.stringify(ops) : null);
}

function opKey(op: HistOp): string {
    return op.append ? `a:${op.append.id}` : op.mark ? `m:${op.mark.id}` : '';
}

/** Reads the data from GitHub; saves each change as one commit on the "data" branch, plus a history record. */
export function StoreProvider({ children }: { children: ReactNode }) {
    const editor = useEditor();
    const session = useSession();
    const sessionRef = useRef(session);
    sessionRef.current = session;
    const [products, setProducts] = useState<Product[]>([]);
    const [months, setMonths] = useState<MonthMap>({});
    const [chat, setChat] = useState<ChatMsg[]>([]);
    const [plan, setPlan] = useState<PlanItem[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [source, setSource] = useState<DataSource | null>(null);
    const [updatedAt, setUpdatedAt] = useState(0);
    const [historyVersion, setHistoryVersion] = useState(0);

    const busyRef = useRef(0);
    const liveOkRef = useRef(false);
    const loadedRef = useRef(false);
    // every save bumps this; a read that started before a save is thrown away
    const writeSeqRef = useRef(0);
    const lastWriteRef = useRef(0);
    const stateRef = useRef({ products, months, chat, plan });
    stateRef.current = { products, months, chat, plan };
    const editorRef = useRef(editor);
    editorRef.current = editor;

    const apply = useCallback((data: Dataset) => {
        loadedRef.current = true;
        setProducts(data.products);
        setMonths(data.months);
        setChat(data.chat);
        setPlan(data.plan);
        setSource(data.source);
        setUpdatedAt(data.updatedAt);
        setLoaded(true);
        setLoadError(null);
    }, []);

    const showSnapshot = useCallback(async () => {
        try {
            const snap = await loadSnapshot();
            if (!liveOkRef.current && snap.products.length) {
                apply(snap);
            }
        } catch {
            // no published copy
        }
    }, [apply]);

    const refresh = useCallback(
        async (silent = false) => {
            if (silent && (busyRef.current > 0 || Date.now() - lastWriteRef.current < 15_000)) {
                return;
            }
            // the current data from GitHub; the copy published with the site only if GitHub is slow or unreachable
            const slow = !silent && !liveOkRef.current ? window.setTimeout(() => void showSnapshot(), 1500) : 0;
            const seq = writeSeqRef.current;
            try {
                const live = await loadLive(editorRef.current.token || undefined);
                if (seq !== writeSeqRef.current || busyRef.current > 0) {
                    return; // a save happened meanwhile and already brought newer data
                }
                liveOkRef.current = true;
                apply(live);
            } catch (e) {
                if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'key_changed') {
                    void sessionRef.current.recheck(); // the data key was changed: this login is no longer valid
                }
                if (!silent && !liveOkRef.current) {
                    await showSnapshot();
                    if (!loadedRef.current) {
                        setLoadError(e instanceof Error ? e.message : 'load_failed');
                    }
                }
            } finally {
                window.clearTimeout(slow);
            }
        },
        [apply, showSnapshot],
    );

    useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') {
                void refresh(true);
            }
        }, REFRESH_MS);
        const onFocus = () => void refresh(true);
        window.addEventListener('focus', onFocus);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('focus', onFocus);
        };
    }, [refresh]);

    /* ---------- history ---------- */

    const flushingRef = useRef<Promise<void> | null>(null);

    /** Writes waiting history records to GitHub (also after a reload or a lost connection). */
    const flush = useCallback((): Promise<void> => {
        if (flushingRef.current) {
            return flushingRef.current;
        }
        const run = async () => {
            for (let round = 0; round < 3; round += 1) {
                const token = editorRef.current.token;
                const ops = readPending();
                if (!token || !ops.length) {
                    return;
                }
                for (let attempt = 0; attempt < 5; attempt += 1) {
                    const file = await readSecure(HISTORY_FILE, token);
                    const doc = file && file.text.trim() ? normalizeHistory(JSON.parse(file.text)) : normalizeHistory({});
                    if (doc.schema > SCHEMA) {
                        announceOutdated(); // written by a newer website: keep the records here until this page is reloaded
                        return;
                    }
                    let ok = true;
                    if (applyOps(doc, ops)) {
                        try {
                            await writeSecure(HISTORY_FILE, serializeHistory(doc), file ? file.sha : null, token);
                        } catch (e) {
                            if (e instanceof ApiError && e.code === 'conflict') {
                                ok = false;
                            } else {
                                throw e;
                            }
                        }
                    }
                    if (ok) {
                        const done = new Set(ops.map(opKey));
                        writePending(readPending().filter((op) => !done.has(opKey(op))));
                        setHistoryVersion((v) => v + 1);
                        break;
                    }
                }
            }
        };
        const p = run()
            .catch(() => undefined) // stays queued; tried again with the next save or visit
            .finally(() => {
                flushingRef.current = null;
            });
        flushingRef.current = p;
        return p;
    }, []);

    useEffect(() => {
        if (editor.token && readPending().length) {
            void flush();
        }
    }, [editor.token, flush]);

    const loadHistory = useCallback(async (): Promise<HistoryDoc> => {
        const token = editorRef.current.token || undefined;
        const text = await readSecureText(HISTORY_FILE, token);
        const doc = text && text.trim() ? normalizeHistory(JSON.parse(text)) : normalizeHistory({});
        applyOps(doc, readPending()); // this device's newest changes, even before they reach GitHub
        return doc;
    }, []);

    /* ---------- saving ---------- */

    /** Applies `change` to the newest data and saves it (retries if someone saved in between). */
    const commit = useCallback(
        async <R,>(change: (doc: DataDoc, who: string, now: number) => Change<R>): Promise<R> => {
            const ed = editorRef.current;
            if (!ed.token || !ed.name) {
                ed.requireLogin(); // asks for the password, or just the name
                throw new ApiError('unauthorized', 401);
            }
            const who = ed.name;
            busyRef.current += 1;
            try {
                for (let attempt = 0; ; attempt += 1) {
                    const file = await readSecure(DATA_FILE, ed.token);
                    let doc: DataDoc;
                    try {
                        doc = file
                            ? normalizeDoc(JSON.parse(file.text))
                            : normalizeDoc({
                                  products: stateRef.current.products,
                                  months: stateRef.current.months,
                                  chat: stateRef.current.chat,
                                  plan: stateRef.current.plan,
                              });
                    } catch {
                        throw new ApiError('bad_data', 500);
                    }
                    if (doc.schema > SCHEMA) {
                        // saved by a newer website: this old page would drop what it does not know
                        announceOutdated();
                        throw new ApiError('outdated', 409);
                    }
                    const now = Date.now();
                    const out = change(doc, who, now);
                    if (out.noop) {
                        return out.result;
                    }
                    const next = normalizeDoc({ ...doc, updatedAt: now });
                    try {
                        await writeSecure(DATA_FILE, serializeDoc(next), file ? file.sha : null, ed.token);
                    } catch (e) {
                        if (e instanceof ApiError && e.code === 'conflict' && attempt < 4) {
                            continue;
                        }
                        throw e;
                    }
                    writeSeqRef.current += 1;
                    lastWriteRef.current = Date.now();
                    liveOkRef.current = true;
                    apply({ products: next.products, months: next.months, chat: next.chat, plan: next.plan, source: 'live', updatedAt: Date.now() });
                    const logs = out.log ? (Array.isArray(out.log) ? out.log : [out.log]) : [];
                    if (logs.length) {
                        const ops: HistOp[] = logs.map((log) => ({ append: { id: newId('h'), at: now, by: who, ...log } }));
                        if (out.mark) {
                            ops.push({ mark: { id: out.mark, undoneAt: now, undoneBy: who } });
                        }
                        writePending([...readPending(), ...ops]);
                        setHistoryVersion((v) => v + 1);
                        void flush();
                    }
                    return out.result;
                }
            } catch (e) {
                if (e instanceof ApiError && (e.code === 'bad_token' || e.code === 'no_write')) {
                    ed.keyRejected();
                }
                if (e instanceof ApiError && (e.code === 'not_found' || e.code === 'product_not_found' || e.code === 'nothing_to_undo')) {
                    void refresh();
                }
                throw e;
            } finally {
                busyRef.current -= 1;
            }
        },
        [apply, refresh, flush],
    );

    const addEntry = useCallback(
        (input: EntryInput) =>
            commit((doc, who, now) => {
                const v = checkEntry(doc, input);
                const entry: Entry = { id: newId('e'), productId: v.product.id, qty: v.qty, date: v.date, note: v.note, createdAt: now, by: who };
                doc.months[v.month] = [...(doc.months[v.month] || []), entry];
                // the plan from the stock analysis: the first open item for this product is now produced
                const planned = doc.plan.find((x) => x.productId === entry.productId && !x.done);
                if (planned) {
                    planned.done = { at: now, by: who, entry: entry.id };
                }
                return {
                    result: { month: v.month, entry },
                    log: { act: 'add', kind: 'entry', after: entrySnap(entry, v.month, v.product.name) },
                };
            }),
        [commit],
    );

    const updateEntry = useCallback(
        (id: string, fromMonth: string, input: EntryInput) =>
            commit((doc, who, now) => {
                const at = findEntry(doc, id, fromMonth);
                if (!at) {
                    throw new ApiError('not_found', 404);
                }
                const v = checkEntry(doc, input);
                const old = removeEntry(doc, at.month, at.index);
                const entry: Entry = { ...old, productId: v.product.id, qty: v.qty, date: v.date, note: v.note, editedBy: who, editedAt: now };
                doc.months[v.month] = [...(doc.months[v.month] || []), entry];
                if (old.issue && (old.qty !== entry.qty || old.productId !== entry.productId || old.date !== entry.date || at.month !== v.month)) {
                    // the warehouse marked it ✗: tell them in the chat that it was corrected
                    sysMessage(doc, {
                        at: now,
                        by: who,
                        kind: 'fixed',
                        ref: refOf(entry, v.month, v.product.name),
                        ...(old.qty !== entry.qty ? { from: old.qty, to: entry.qty } : {}),
                    });
                }
                return {
                    result: { month: v.month, entry },
                    log: {
                        act: 'edit',
                        kind: 'entry',
                        before: entrySnap(old, at.month, productName(doc, old.productId)),
                        after: entrySnap(entry, v.month, v.product.name),
                    },
                };
            }),
        [commit],
    );

    const deleteEntry = useCallback(
        async (id: string, month: string) => {
            await commit((doc, who, now) => {
                const at = findEntry(doc, id, month);
                if (!at) {
                    throw new ApiError('not_found', 404);
                }
                const cur = removeEntry(doc, at.month, at.index);
                const name = productName(doc, cur.productId);
                if (cur.issue) {
                    sysMessage(doc, { at: now, by: who, kind: 'deleted', ref: refOf(cur, at.month, name) });
                }
                // the run counted for a plan item: that item is open again
                for (const x of doc.plan) {
                    if (x.done && x.done.entry === cur.id) {
                        delete x.done;
                    }
                }
                return { result: undefined, log: { act: 'delete', kind: 'entry', before: entrySnap(cur, at.month, name) } };
            });
        },
        [commit],
    );

    const addProduct = useCallback(
        (name: string, since?: string) =>
            commit((doc, _who, now) => {
                const clean = cleanName(name);
                if (!clean) {
                    throw new ApiError('name_required', 400);
                }
                if (doc.products.some((p) => normName(p.name) === normName(clean))) {
                    throw new ApiError('duplicate_name', 409);
                }
                const sort = doc.products.reduce((m, p) => Math.max(m, p.sort < 1000 ? p.sort : 0), 0) + 1;
                const product: Product = { id: newId('p'), name: clean, sort, since: isYm(since) ? since : thisMonth(), createdAt: now };
                doc.products.push(product);
                return { result: product, log: { act: 'add', kind: 'product', after: { ...product } } };
            }),
        [commit],
    );

    const renameProduct = useCallback(
        (id: string, name: string) =>
            commit((doc) => {
                const clean = cleanName(name);
                if (!clean) {
                    throw new ApiError('name_required', 400);
                }
                const product = doc.products.find((p) => p.id === id);
                if (!product) {
                    throw new ApiError('not_found', 404);
                }
                if (doc.products.some((p) => p.id !== id && normName(p.name) === normName(clean))) {
                    throw new ApiError('duplicate_name', 409);
                }
                const before = { ...product };
                product.name = clean;
                return { result: { ...product }, log: { act: 'edit', kind: 'product', before, after: { ...product } } };
            }),
        [commit],
    );

    const deleteProduct = useCallback(
        async (id: string) => {
            await commit((doc) => {
                const index = doc.products.findIndex((p) => p.id === id);
                if (index < 0) {
                    throw new ApiError('not_found', 404);
                }
                const runs = runsOf(doc, id);
                if (runs > 0) {
                    throw new ApiError(`has_entries:${runs}`, 409);
                }
                const [old] = doc.products.splice(index, 1);
                return { result: undefined, log: { act: 'delete', kind: 'product', before: { ...old } } };
            });
        },
        [commit],
    );

    const setReceived = useCallback(
        (items: RunRef[], received: boolean) => {
            return commit((doc, who, now) => {
                const logs: LogDraft[] = [];
                for (const item of items) {
                    const at = findEntry(doc, item.id, item.month);
                    if (!at) {
                        continue;
                    }
                    const list = doc.months[at.month];
                    const cur = list[at.index];
                    if (Boolean(cur.received) === received) {
                        continue; // someone already did it
                    }
                    const next: Entry = { ...cur };
                    const name = productName(doc, cur.productId);
                    if (received) {
                        next.received = { by: who, at: now };
                        if (cur.issue) {
                            // it was marked ✗: checked again and accepted
                            delete next.issue;
                            sysMessage(doc, { at: now, by: who, kind: 'ok', ref: refOf(next, at.month, name) });
                        }
                    } else {
                        delete next.received;
                    }
                    list[at.index] = next;
                    logs.push({ act: received ? 'receive' : 'unreceive', kind: 'entry', before: entrySnap(cur, at.month, name), after: entrySnap(next, at.month, name) });
                }
                return { result: logs.length, log: logs, noop: logs.length === 0 };
            });
        },
        [commit],
    );

    const flagIssue = useCallback(
        async (item: RunRef, counted: number | undefined, reason: string) => {
            await commit((doc, who, now) => {
                const why = cleanText(reason, REASON_MAX);
                if (!why) {
                    throw new ApiError('reason_required', 400);
                }
                const count = cleanCount(counted);
                const at = findEntry(doc, item.id, item.month);
                if (!at) {
                    throw new ApiError('not_found', 404);
                }
                const list = doc.months[at.month];
                const cur = list[at.index];
                const next: Entry = { ...cur, issue: { by: who, at: now, reason: why, ...(count !== undefined ? { counted: count } : {}) } };
                delete next.received;
                list[at.index] = next;
                const name = productName(doc, cur.productId);
                sysMessage(doc, {
                    at: now,
                    by: who,
                    kind: 'flag',
                    text: why,
                    ref: refOf(next, at.month, name),
                    ...(count !== undefined ? { counted: count } : {}),
                });
                return { result: undefined, log: { act: 'flag', kind: 'entry', before: entrySnap(cur, at.month, name), after: entrySnap(next, at.month, name) } };
            });
        },
        [commit],
    );

    const clearIssue = useCallback(
        async (item: RunRef) => {
            await commit((doc, who, now) => {
                const at = findEntry(doc, item.id, item.month);
                if (!at) {
                    throw new ApiError('not_found', 404);
                }
                const list = doc.months[at.month];
                const cur = list[at.index];
                if (!cur.issue) {
                    return { result: undefined, noop: true }; // someone already did it
                }
                const next: Entry = { ...cur };
                delete next.issue;
                list[at.index] = next;
                const name = productName(doc, cur.productId);
                sysMessage(doc, { at: now, by: who, kind: 'unflag', ref: refOf(next, at.month, name) });
                return { result: undefined, log: { act: 'unflag', kind: 'entry', before: entrySnap(cur, at.month, name), after: entrySnap(next, at.month, name) } };
            });
        },
        [commit],
    );

    const sendMessage = useCallback(
        (text: string, ref?: ChatRef | null, replyTo?: string | null) =>
            commit((doc, who, now) => {
                const clean = cleanText(text, CHAT_TEXT_MAX);
                if (!clean) {
                    throw new ApiError('text_required', 400);
                }
                const msg: ChatMsg = { id: newId('m'), at: now, by: who, text: clean };
                if (ref) {
                    // the run as it is now (or as it was, if it was deleted meanwhile)
                    const at = findEntry(doc, ref.id, ref.month);
                    msg.ref = at ? refOf(doc.months[at.month][at.index], at.month, productName(doc, doc.months[at.month][at.index].productId)) : { ...ref };
                }
                if (replyTo && doc.chat.some((m) => m.id === replyTo)) {
                    msg.replyTo = replyTo;
                }
                doc.chat.push(msg);
                return { result: msg };
            }),
        [commit],
    );

    const sendPlan = useCallback(
        async (week: string, items: Array<{ productId: string; qty: number; date: string }>) => {
            await commit((doc, who, now) => {
                const list: PlanItem[] = [];
                items.forEach((it, i) => {
                    if (!doc.products.some((p) => p.id === it.productId)) {
                        throw new ApiError('product_not_found', 404);
                    }
                    const qty = Math.round(Number(it.qty));
                    if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY) {
                        throw new ApiError('qty_invalid', 400);
                    }
                    list.push({ id: newId('k'), productId: it.productId, qty, date: isValidDate(it.date) ? it.date : '', order: i + 1, week, by: who, at: now });
                });
                doc.plan = list;
                return { result: undefined };
            });
        },
        [commit],
    );

    const setPlanDone = useCallback(
        async (id: string, done: boolean) => {
            await commit((doc, who, now) => {
                const item = doc.plan.find((x) => x.id === id);
                if (!item) {
                    throw new ApiError('not_found', 404);
                }
                if (Boolean(item.done) === done) {
                    return { result: undefined, noop: true };
                }
                if (done) {
                    item.done = { at: now, by: who };
                } else {
                    delete item.done;
                }
                return { result: undefined };
            });
        },
        [commit],
    );

    const deleteMessage = useCallback(
        async (id: string) => {
            await commit((doc, who) => {
                const index = doc.chat.findIndex((m) => m.id === id);
                if (index < 0) {
                    return { result: undefined, noop: true };
                }
                const msg = doc.chat[index];
                if (msg.kind || msg.by !== who) {
                    throw new ApiError('not_yours', 403);
                }
                doc.chat.splice(index, 1);
                return { result: undefined };
            });
        },
        [commit],
    );

    const undo = useCallback(
        async (recordId: string) => {
            const hist = await loadHistory();
            const r = hist.records.find((x) => x.id === recordId);
            if (!r) {
                throw new ApiError('not_found', 404);
            }
            if (r.undoneAt || r.act === 'undo' || r.act === 'password') {
                throw new ApiError('already_undone', 409);
            }
            await commit((doc, who, now) => ({
                result: undefined,
                log: { ...inverse(doc, r, who, now), act: 'undo', undoOf: r.id },
                mark: r.id,
            }));
        },
        [commit, loadHistory],
    );

    const value = useMemo<StoreValue>(
        () => ({
            products,
            months,
            chat,
            loaded,
            loadError,
            source,
            updatedAt,
            historyVersion,
            refresh,
            addEntry,
            updateEntry,
            deleteEntry,
            addProduct,
            renameProduct,
            deleteProduct,
            loadHistory,
            undo,
            setReceived,
            flagIssue,
            clearIssue,
            sendMessage,
            deleteMessage,
            plan,
            sendPlan,
            setPlanDone,
        }),
        [
            products,
            months,
            chat,
            loaded,
            loadError,
            source,
            updatedAt,
            historyVersion,
            refresh,
            addEntry,
            updateEntry,
            deleteEntry,
            addProduct,
            renameProduct,
            deleteProduct,
            loadHistory,
            undo,
            setReceived,
            flagIssue,
            clearIssue,
            sendMessage,
            deleteMessage,
            plan,
            sendPlan,
            setPlanDone,
        ],
    );

    return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
    const ctx = useContext(StoreContext);
    if (!ctx) {
        throw new Error('useStore must be used inside StoreProvider');
    }
    return ctx;
}
