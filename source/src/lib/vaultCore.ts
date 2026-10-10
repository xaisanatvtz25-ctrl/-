/**
 * The encryption of everything the website stores on GitHub, and the keys of the people who may open it.
 * Pure functions (Web Crypto): the same code runs in the browser and in the tools (Node), so the format is one.
 *
 *  - One random data key (AES-256-GCM) encrypts every data file: data.json, history.json, stock.json, editor.json.
 *    Without it a file on GitHub is noise: { "milako": "vault", "iv": …, "ct": … }.
 *  - access.json holds that data key once per person, locked with a key made from the person's own password
 *    (PBKDF2-SHA256, 600 000 rounds, own salt). At most MAX_USERS people; nobody else can open it.
 *  - Nothing secret is ever written in plain text: not the passwords, not the data key, not the GitHub key.
 */

export const ACCESS_FILE = 'access.json';
/** the most people who can ever log in */
export const MAX_USERS = 6;
/** PBKDF2 rounds for new keys (OWASP 2023 for PBKDF2-HMAC-SHA256) */
export const KDF_ITER = 600_000;
const ITER_MIN = 100_000;
const ITER_MAX = 5_000_000;

export class VaultError extends Error {
    code: string;

    constructor(code: string) {
        super(code);
        this.code = code;
    }
}

/* ---------- bytes ---------- */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
}

export function fromB64(text: string): Uint8Array {
    const bin = atob(String(text).replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
        out[i] = bin.charCodeAt(i);
    }
    return out;
}

export function randomBytes(n: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(n));
}

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A password as typed on any keyboard: Unicode in one form (Lao marks typed in another order are the same),
 * no spaces around it, and letter case does not matter (phones capitalise the first letter).
 */
export function normalizePassword(password: string): string {
    return String(password || '').normalize('NFKC').trim().toLowerCase();
}

function buf(bytes: Uint8Array): BufferSource {
    return bytes as BufferSource;
}

/* ---------- keys ---------- */

/** the key made from a password (AES-256-GCM, cannot be read out) */
export async function passwordKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
    if (!Number.isInteger(iterations) || iterations < ITER_MIN || iterations > ITER_MAX) {
        throw new VaultError('bad_kdf');
    }
    const base = await crypto.subtle.importKey('raw', buf(enc.encode(normalizePassword(password))), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** the data key as a key the browser can use but never hand out (non-extractable) */
export async function importDataKey(raw: Uint8Array): Promise<CryptoKey> {
    if (raw.length !== 32) {
        throw new VaultError('bad_key');
    }
    return crypto.subtle.importKey('raw', buf(raw), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** a short public fingerprint of the data key (to notice a key that changed); reveals nothing about the key */
export async function keyId(raw: Uint8Array): Promise<string> {
    const label = enc.encode('milako-kid:');
    const both = new Uint8Array(label.length + raw.length);
    both.set(label);
    both.set(raw, label.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf(both)));
    both.fill(0);
    return hex(digest.subarray(0, 8));
}

async function gcmEncrypt(key: CryptoKey, plain: Uint8Array, aad: string): Promise<{ iv: string; ct: string }> {
    const iv = randomBytes(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(enc.encode(aad)) }, key, buf(plain)));
    return { iv: toB64(iv), ct: toB64(ct) };
}

async function gcmDecrypt(key: CryptoKey, iv: string, ct: string, aad: string, failCode: string): Promise<Uint8Array> {
    try {
        return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(fromB64(iv)), additionalData: buf(enc.encode(aad)) }, key, buf(fromB64(ct))));
    } catch {
        throw new VaultError(failCode);
    }
}

/* ---------- compression (smaller files on GitHub; standard gzip) ---------- */

async function gzip(bytes: Uint8Array): Promise<Uint8Array | null> {
    if (typeof CompressionStream === 'undefined') {
        return null;
    }
    const stream = new Blob([buf(bytes)]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
    if (typeof DecompressionStream === 'undefined') {
        throw new VaultError('old_browser');
    }
    const stream = new Blob([buf(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ---------- encrypted files ---------- */

/** what an encrypted file looks like on GitHub */
export interface Envelope {
    milako: 'vault';
    v: 1;
    /**
     * far above any data format: a page of an older website that is still open sees "newer data" and refuses to
     * save over it (it asks to reload)
     */
    schema: 99;
    file: string;
    kid: string;
    z: 'gzip' | 'none';
    iv: string;
    ct: string;
}

export function isEnvelope(value: unknown): value is Envelope {
    const o = value as Partial<Envelope> | null;
    return Boolean(o && typeof o === 'object' && o.milako === 'vault' && typeof o.iv === 'string' && typeof o.ct === 'string');
}

/** text that is an encrypted file (or null) */
export function envelopeOf(text: string): Envelope | null {
    const t = (text || '').trimStart();
    if (!t.startsWith('{') || !t.includes('"vault"')) {
        return null;
    }
    try {
        const v = JSON.parse(t) as unknown;
        return isEnvelope(v) ? v : null;
    } catch {
        return null;
    }
}

const fileAad = (file: string, kid: string) => `milako-file:${file}:${kid}`;

export async function sealText(key: CryptoKey, kid: string, file: string, text: string): Promise<string> {
    const plain = enc.encode(text);
    const packed = await gzip(plain);
    const { iv, ct } = await gcmEncrypt(key, packed || plain, fileAad(file, kid));
    const env: Envelope = { milako: 'vault', v: 1, schema: 99, file, kid, z: packed ? 'gzip' : 'none', iv, ct };
    return JSON.stringify(env) + '\n';
}

/**
 * The text of a data file, opened with the data key. It must be encrypted, with this key, and be the file asked for:
 * a file in plain text (or another one put in its place) is refused, never shown or saved over.
 */
export async function openText(key: CryptoKey, kid: string, file: string, text: string): Promise<string> {
    const env = envelopeOf(text);
    if (!env) {
        throw new VaultError('not_encrypted');
    }
    if (env.kid !== kid) {
        throw new VaultError('key_changed');
    }
    if (env.file !== file) {
        throw new VaultError('wrong_file');
    }
    const plain = await gcmDecrypt(key, env.iv, env.ct, fileAad(file, kid), 'cannot_open');
    return dec.decode(env.z === 'gzip' ? await gunzip(plain) : plain);
}

/* ---------- the people who may log in (access.json, readable before logging in) ---------- */

export interface AccessUser {
    id: string;
    /** the name shown on the login screen and saved with every change */
    name: string;
    kdf: 'PBKDF2-SHA256';
    iter: number;
    salt: string;
    iv: string;
    /** the data key, locked with this person's password */
    key: string;
    /** still the starting password (to be changed at the first login) */
    initial: boolean;
    /** when the password was last set (ms) */
    at: number;
}

export interface AccessDoc {
    milako: 'access';
    v: 1;
    kid: string;
    max: number;
    users: AccessUser[];
    updatedAt: number;
}

const userAad = (id: string, kid: string) => `milako-user:${id}:${kid}`;
const ID_RE = /^u[0-9a-z]{1,12}$/;

/** access.json as it is on GitHub, checked (at most MAX_USERS people; anything odd is refused) */
export function parseAccess(text: string): AccessDoc {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new VaultError('bad_access');
    }
    const o = raw as Partial<AccessDoc> | null;
    if (!o || o.milako !== 'access' || o.v !== 1 || typeof o.kid !== 'string' || !/^[0-9a-f]{16}$/.test(o.kid) || !Array.isArray(o.users)) {
        throw new VaultError('bad_access');
    }
    const seen = new Set<string>();
    const users: AccessUser[] = [];
    for (const u of o.users) {
        const x = u as Partial<AccessUser>;
        if (
            !x ||
            typeof x.id !== 'string' ||
            !ID_RE.test(x.id) ||
            seen.has(x.id) ||
            typeof x.name !== 'string' ||
            !x.name.trim() ||
            typeof x.salt !== 'string' ||
            typeof x.iv !== 'string' ||
            typeof x.key !== 'string' ||
            !Number.isInteger(x.iter) ||
            (x.iter as number) < ITER_MIN ||
            (x.iter as number) > ITER_MAX
        ) {
            continue;
        }
        seen.add(x.id);
        users.push({
            id: x.id,
            name: x.name.replace(/\s+/g, ' ').trim().slice(0, 40),
            kdf: 'PBKDF2-SHA256',
            iter: x.iter as number,
            salt: x.salt,
            iv: x.iv,
            key: x.key,
            initial: x.initial === true,
            at: Number(x.at) > 0 ? Number(x.at) : 0,
        });
        if (users.length >= MAX_USERS) {
            break; // never more people than that, whatever the file says
        }
    }
    if (!users.length) {
        throw new VaultError('bad_access');
    }
    return { milako: 'access', v: 1, kid: o.kid, max: MAX_USERS, users, updatedAt: Number(o.updatedAt) || 0 };
}

export function serializeAccess(doc: AccessDoc): string {
    const users = doc.users.slice(0, MAX_USERS).map((u) => ' ' + JSON.stringify(u));
    return (
        '{\n' +
        ' "milako": "access",\n "v": 1,\n' +
        ` "kid": ${JSON.stringify(doc.kid)},\n` +
        ` "max": ${MAX_USERS},\n` +
        ` "users": [\n${users.join(',\n')}\n ],\n` +
        ` "updatedAt": ${Math.round(doc.updatedAt) || 0}\n` +
        '}\n'
    );
}

/** The data key locked with a person's password (a new salt each time). */
export async function lockForUser(id: string, kid: string, password: string, rawKey: Uint8Array, iterations = KDF_ITER): Promise<Pick<AccessUser, 'kdf' | 'iter' | 'salt' | 'iv' | 'key'>> {
    const salt = randomBytes(16);
    const k = await passwordKey(password, salt, iterations);
    const { iv, ct } = await gcmEncrypt(k, rawKey, userAad(id, kid));
    return { kdf: 'PBKDF2-SHA256', iter: iterations, salt: toB64(salt), iv, key: ct };
}

/** The data key, opened with the password of this person (VaultError 'wrong_password' otherwise). */
export async function openForUser(user: AccessUser, kid: string, password: string): Promise<Uint8Array> {
    const k = await passwordKey(password, fromB64(user.salt), user.iter);
    const raw = await gcmDecrypt(k, user.iv, user.key, userAad(user.id, kid), 'wrong_password');
    if (raw.length !== 32 || (await keyId(raw)) !== kid) {
        raw.fill(0);
        throw new VaultError('wrong_password');
    }
    return raw;
}

/* ---------- the GitHub key for saving (inside editor.json, which is itself encrypted) ---------- */

/** a secret locked with a password (format of the first website, kept: PBKDF2-SHA256 + AES-GCM) */
export interface Sealed {
    v: 1;
    kdf: 'PBKDF2-SHA256';
    iter: number;
    salt: string;
    iv: string;
    data: string;
    savedAt: number;
}

export async function sealWithPassword(secret: string, password: string, iterations = KDF_ITER): Promise<Sealed> {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const k = await passwordKey(password, salt, iterations);
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, k, buf(enc.encode(secret))));
    return { v: 1, kdf: 'PBKDF2-SHA256', iter: iterations, salt: toB64(salt), iv: toB64(iv), data: toB64(data), savedAt: Date.now() };
}

export function isSealed(raw: unknown): raw is Sealed {
    const f = raw as Partial<Sealed> | null;
    return Boolean(f && f.v === 1 && typeof f.salt === 'string' && typeof f.iv === 'string' && typeof f.data === 'string' && Number.isInteger(f.iter));
}

/** VaultError `failCode` when the password is not the right one */
export async function openWithPassword(raw: unknown, password: string, failCode = 'wrong_password'): Promise<string> {
    if (!isSealed(raw)) {
        throw new VaultError('bad_key_file');
    }
    const k = await passwordKey(password, fromB64(raw.salt), raw.iter);
    try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(fromB64(raw.iv)) }, k, buf(fromB64(raw.data)));
        return dec.decode(plain);
    } catch {
        throw new VaultError(failCode);
    }
}

/**
 * What editor.json holds (encrypted with the data key):
 *  - edit: the GitHub key, opened with the edit password (to add and change data)
 *  - master: the GitHub key and the data key, opened with the company code (to set a person's password)
 */
export interface EditorDoc {
    v: 2;
    edit: Sealed | null;
    master: Sealed | null;
    savedAt: number;
}

export function parseEditorDoc(text: string): EditorDoc {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new VaultError('bad_key_file');
    }
    if (isSealed(raw)) {
        return { v: 2, edit: raw, master: null, savedAt: raw.savedAt || 0 }; // the first website: only the edit password
    }
    const o = raw as Partial<EditorDoc> | null;
    if (!o || typeof o !== 'object') {
        throw new VaultError('bad_key_file');
    }
    return { v: 2, edit: isSealed(o.edit) ? o.edit : null, master: isSealed(o.master) ? o.master : null, savedAt: Number(o.savedAt) || 0 };
}

export function serializeEditorDoc(doc: EditorDoc): string {
    return JSON.stringify({ v: 2, edit: doc.edit, master: doc.master, savedAt: doc.savedAt }, null, 1) + '\n';
}

export interface MasterSecret {
    token: string;
    /** the data key (raw): only while a password is being set, then wiped */
    dataKey: Uint8Array;
}

export async function sealMaster(token: string, rawKey: Uint8Array, masterCode: string, iterations = KDF_ITER): Promise<Sealed> {
    return sealWithPassword(JSON.stringify({ token, dk: toB64(rawKey) }), masterCode, iterations);
}

/** VaultError 'wrong_master' when the company code is not the right one */
export async function openMaster(doc: EditorDoc, masterCode: string, kid: string): Promise<MasterSecret> {
    if (!doc.master) {
        throw new VaultError('no_master');
    }
    const text = await openWithPassword(doc.master, masterCode, 'wrong_master');
    let o: { token?: unknown; dk?: unknown };
    try {
        o = JSON.parse(text) as { token?: unknown; dk?: unknown };
    } catch {
        throw new VaultError('bad_key_file');
    }
    if (typeof o.token !== 'string' || typeof o.dk !== 'string') {
        throw new VaultError('bad_key_file');
    }
    const dataKey = fromB64(o.dk);
    if (dataKey.length !== 32 || (await keyId(dataKey)) !== kid) {
        dataKey.fill(0);
        throw new VaultError('key_changed');
    }
    return { token: o.token, dataKey };
}

/* ---------- small secrets kept on this device (encrypted with the data key) ---------- */

export async function sealLocal(key: CryptoKey, label: string, value: string): Promise<string> {
    const { iv, ct } = await gcmEncrypt(key, enc.encode(value), `milako-local:${label}`);
    return JSON.stringify({ l: 1, iv, ct });
}

export async function openLocal(key: CryptoKey, label: string, text: string | null): Promise<string | null> {
    if (!text) {
        return null;
    }
    try {
        const o = JSON.parse(text) as { l?: unknown; iv?: unknown; ct?: unknown };
        if (o.l !== 1 || typeof o.iv !== 'string' || typeof o.ct !== 'string') {
            return null;
        }
        return dec.decode(await gcmDecrypt(key, o.iv, o.ct, `milako-local:${label}`, 'cannot_open'));
    } catch {
        return null;
    }
}

/* ---------- passwords people choose ---------- */

const COMMON = new Set([
    '12345678', '123456789', '1234567890', '87654321', '11111111', '00000000', '12341234', '11223344', 'password', 'password1',
    'qwertyui', 'qwerty123', 'abcd1234', '1q2w3e4r', 'iloveyou', 'abc12345', 'aa123456', 'a1234567', 'admin123', 'welcome1',
]);

/** why a new password is not good enough (null: fine). The same rules for everyone. */
export function passwordProblem(password: string, opts: { name?: string; master?: string } = {}): 'short' | 'weak' | 'common' | 'company' | 'name' | null {
    const p = normalizePassword(password);
    if ([...p].length < 8) {
        return 'short';
    }
    if (/milako|ມິລະໂກະ|มิละโกะ/i.test(p) || (opts.master && p === normalizePassword(opts.master))) {
        return 'company'; // the company's name is the first thing anyone would try
    }
    if (opts.name && p.replace(/\s+/g, '').includes(normalizePassword(opts.name).replace(/\s+/g, ''))) {
        return 'name';
    }
    if (COMMON.has(p) || /^(.)\1+$/.test(p) || /^(0123456789|1234567890|9876543210)+/.test(p)) {
        return 'common';
    }
    const letters = /\p{L}/u.test(p);
    const others = /[^\p{L}]/u.test(p);
    if (!(letters && others) && [...p].length < 12) {
        return 'weak'; // only digits or only letters: at least 12 of them
    }
    return null;
}
