/**
 * The logged-in person on this device: the data key (kept as a key the browser can use but never hand out),
 * who it is, and the small encrypted things this device keeps (unsaved history, the stock draft, the AI key).
 */
import { VaultError, openLocal, sealLocal } from './vaultCore';

/** a login lasts this long on a device (then the password is asked again) */
export const SESSION_DAYS = 30;

export interface Vault {
    key: CryptoKey;
    kid: string;
    userId: string;
    name: string;
}

let active: Vault | null = null;

export function setActiveVault(v: Vault | null): void {
    active = v;
}

/** the data key of the person logged in (VaultError 'locked' before logging in) */
export function activeVault(): Vault {
    if (!active) {
        throw new VaultError('locked');
    }
    return active;
}

export function hasVault(): boolean {
    return Boolean(active);
}

/* ---------- the login kept on this device (IndexedDB: it can hold a key that cannot be read out) ---------- */

export interface StoredSession {
    v: 1;
    userId: string;
    name: string;
    kid: string;
    key: CryptoKey;
    loginAt: number;
    exp: number;
    /** the time of the person's password when they logged in (a newer password logs this device out) */
    ver: number;
}

const DB = 'milako-vault';
const STORE = 'kv';
const SESSION = 'session';

function openDb(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
        try {
            if (typeof indexedDB === 'undefined') {
                resolve(null);
                return;
            }
            const req = indexedDB.open(DB, 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE)) {
                    req.result.createObjectStore(STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

async function dbDo<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
    const db = await openDb();
    if (!db) {
        return null;
    }
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(STORE, mode);
            const req = fn(tx.objectStore(STORE));
            tx.oncomplete = () => {
                db.close();
                resolve((req.result as T) ?? null);
            };
            tx.onerror = () => {
                db.close();
                resolve(null);
            };
            tx.onabort = () => {
                db.close();
                resolve(null);
            };
        } catch {
            db.close();
            resolve(null);
        }
    });
}

export async function loadSession(): Promise<StoredSession | null> {
    const s = await dbDo<StoredSession>('readonly', (st) => st.get(SESSION));
    if (!s || s.v !== 1 || !(s.key instanceof CryptoKey) || typeof s.userId !== 'string' || !(s.exp > Date.now())) {
        return null;
    }
    return s;
}

/** false when this browser cannot keep it (then the login lasts until the page is closed) */
export async function saveSession(s: StoredSession): Promise<boolean> {
    const ok = await dbDo<IDBValidKey>('readwrite', (st) => st.put(s, SESSION));
    return ok !== null;
}

export async function clearSession(): Promise<void> {
    await dbDo('readwrite', (st) => st.delete(SESSION));
}

/* ---------- logging out everywhere in this browser (other tabs follow) ---------- */

const LOGOUT_KEY = 'milako.loggedOut';

export function announceLogout(): void {
    try {
        localStorage.setItem(LOGOUT_KEY, String(Date.now()));
    } catch {
        // other tabs notice at their next check
    }
}

export function onLogoutElsewhere(fn: () => void): () => void {
    const handler = (e: StorageEvent) => {
        if (e.key === LOGOUT_KEY) {
            fn();
        }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
}

/* ---------- wrong passwords: wait a little longer after each try (on this device) ---------- */

const FAIL_KEY = 'milako.loginFails';

interface Fails {
    n: number;
    until: number;
}

function readFails(): Fails {
    try {
        const v = JSON.parse(localStorage.getItem(FAIL_KEY) || 'null') as Fails | null;
        return v && Number.isFinite(v.n) ? { n: v.n, until: Number(v.until) || 0 } : { n: 0, until: 0 };
    } catch {
        return { n: 0, until: 0 };
    }
}

/** milliseconds to wait before the next try (0: may try now) */
export function loginWait(): number {
    return Math.max(0, readFails().until - Date.now());
}

export function noteLoginFail(): number {
    const f = readFails();
    const n = f.n + 1;
    // 3 tries freely, then 30 s, 1 min, 2 min … up to 15 min
    const wait = n < 4 ? 0 : Math.min(15 * 60_000, 30_000 * 2 ** (n - 4));
    try {
        localStorage.setItem(FAIL_KEY, JSON.stringify({ n, until: Date.now() + wait }));
    } catch {
        // ignore
    }
    return wait;
}

export function noteLoginOk(): void {
    try {
        localStorage.removeItem(FAIL_KEY);
    } catch {
        // ignore
    }
}

/* ---------- small things this device keeps, encrypted with the data key ---------- */

/** what is kept (name → label of the encryption) */
export const LOCAL = {
    pending: 'milako.v2.pendingHistory',
    draft: 'milako.v2.stockDraft',
    aliases: 'milako.v2.stockAliases',
    ai: 'milako.v2.ai',
    editKey: 'milako.v2.editKey',
} as const;

export type LocalName = (typeof LOCAL)[keyof typeof LOCAL];

/** kept before the website was locked, in plain text: moved into the encrypted store, then removed */
const LEGACY: Partial<Record<LocalName, string[]>> = {
    [LOCAL.pending]: ['milako.pendingHistory'],
    [LOCAL.draft]: ['milako.stockDraft'],
    [LOCAL.aliases]: ['milako.stockAliases'],
    [LOCAL.ai]: ['milako.ai', 'milako.geminiKey'],
};

/** removed for good: the old plain-text GitHub key and typed name */
const OBSOLETE = ['milako.editKey', 'milako.editorName'];

const cache = new Map<LocalName, string>();
const writing = new Map<LocalName, Promise<void>>();
const listeners = new Map<LocalName, Set<() => void>>();
let localKey: CryptoKey | null = null;
let storageHooked = false;

function lsGet(name: string): string | null {
    try {
        return localStorage.getItem(name);
    } catch {
        return null;
    }
}

function lsSet(name: string, value: string | null): void {
    try {
        if (value === null) {
            localStorage.removeItem(name);
        } else {
            localStorage.setItem(name, value);
        }
    } catch {
        // storage full or blocked: kept for this visit only
    }
}

function notify(name: LocalName): void {
    (listeners.get(name) || new Set()).forEach((fn) => fn());
}

/** Opens what this device keeps (after logging in), and encrypts what an older website left in plain text. */
export async function initLocal(key: CryptoKey): Promise<void> {
    localKey = key;
    cache.clear();
    for (const name of Object.values(LOCAL)) {
        const text = await openLocal(key, name, lsGet(name));
        if (text !== null) {
            cache.set(name, text);
        }
        for (const old of LEGACY[name] || []) {
            const plain = lsGet(old);
            if (plain !== null) {
                if (!cache.has(name) && plain.trim()) {
                    // the old Gemini key was a bare key, everything else JSON
                    const value = old === 'milako.geminiKey' ? JSON.stringify({ provider: 'gemini', key: plain.trim(), model: '', visionModel: '' }) : plain;
                    cache.set(name, value);
                    await persist(name);
                }
                lsSet(old, null);
            }
        }
    }
    OBSOLETE.forEach((k) => lsSet(k, null));
    if (!storageHooked) {
        storageHooked = true;
        // another tab of this browser changed something: read it again
        window.addEventListener('storage', (e) => {
            const name = Object.values(LOCAL).find((n) => n === e.key);
            if (!name || !localKey) {
                return;
            }
            void openLocal(localKey, name, e.newValue).then((text) => {
                if (text === null) {
                    cache.delete(name);
                } else {
                    cache.set(name, text);
                }
                notify(name);
            });
        });
    }
}

async function persist(name: LocalName): Promise<void> {
    const key = localKey;
    const value = cache.get(name);
    if (!key) {
        return;
    }
    if (value === undefined) {
        lsSet(name, null);
        return;
    }
    lsSet(name, await sealLocal(key, name, value));
}

export function getLocal(name: LocalName): string | null {
    return cache.has(name) ? (cache.get(name) as string) : null;
}

/** keeps a value (null removes it); written encrypted in the background, in order */
export function setLocal(name: LocalName, value: string | null): void {
    if (value === null) {
        cache.delete(name);
    } else {
        cache.set(name, value);
    }
    const before = writing.get(name) || Promise.resolve();
    const next = before.then(() => persist(name)).catch(() => undefined);
    writing.set(name, next);
    notify(name);
}

/** waits until everything is written (before logging out) */
export async function flushLocal(): Promise<void> {
    await Promise.all([...writing.values()]);
}

export function onLocalChange(name: LocalName, fn: () => void): () => void {
    const set = listeners.get(name) || new Set<() => void>();
    set.add(fn);
    listeners.set(name, set);
    return () => {
        set.delete(fn);
    };
}

/** forget the data key on this device (logging out): what is kept stays encrypted */
export function closeLocal(): void {
    localKey = null;
    cache.clear();
}
