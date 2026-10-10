/**
 * Reads and saves the data files in the GitHub repository (branch "data").
 * Visitors read without a key; saving needs the key unlocked with the edit password.
 */
import { DATA_BRANCH, REPO_NAME, REPO_OWNER } from './config';
import { ApiError } from './api';

const REPO_API = `https://api.github.com/repos/${REPO_OWNER}/${encodeURIComponent(REPO_NAME)}`;
const RAW = `https://raw.githubusercontent.com/${REPO_OWNER}/${encodeURIComponent(REPO_NAME)}/${DATA_BRANCH}`;

export function utf8ToB64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
}

export function b64ToUtf8(b64: string): string {
    const bin = atob(b64.replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
}

interface CallOptions {
    method?: 'GET' | 'PUT';
    body?: string;
    token?: string;
    ms?: number;
    /** version already here: GitHub answers 304 (no download) when the file did not change */
    etag?: string;
}

async function call(url: string, opts: CallOptions = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), opts.ms ?? 20_000);
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (opts.token) {
        headers.Authorization = `Bearer ${opts.token}`;
    }
    if (opts.etag) {
        headers['If-None-Match'] = opts.etag;
    }
    if (opts.body) {
        headers['Content-Type'] = 'application/json';
    }
    try {
        return await fetch(url, {
            method: opts.method || 'GET',
            headers,
            body: opts.body,
            // revalidate every time (GitHub answers 304 when nothing changed)
            cache: opts.token ? 'no-store' : 'no-cache',
            credentials: 'omit',
            signal: controller.signal,
        });
    } catch (e) {
        if (e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError') {
            throw new ApiError('timeout', 0);
        }
        throw new ApiError('network_error', 0);
    } finally {
        window.clearTimeout(timer);
    }
}

function rateLimited(res: Response): boolean {
    return res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
}

/*
 * Visitors share GitHub's hourly limit for requests without a key (per internet connection).
 * When it is used up, remember until when, and read through the file server meanwhile.
 */
const LIMIT_KEY = 'milako.apiLimitedUntil';
let limitedUntil = 0;
try {
    limitedUntil = Number(localStorage.getItem(LIMIT_KEY)) || 0;
} catch {
    limitedUntil = 0;
}

function noteLimit(res: Response): void {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    limitedUntil = reset > Date.now() && reset < Date.now() + 2 * 3600_000 ? reset : Date.now() + 15 * 60_000;
    try {
        localStorage.setItem(LIMIT_KEY, String(limitedUntil));
    } catch {
        // ignore
    }
}

export function anonymousLimited(): boolean {
    return Date.now() < limitedUntil;
}

export interface RepoFile {
    text: string;
    sha: string;
}

/*
 * With the saving key the browser keeps no copy, so the last version of each file is kept here with its
 * ETag: an unchanged file then costs a tiny "304 not modified" answer instead of a full download
 * (and does not count against GitHub's hourly limit). The open chat asks every 20 seconds.
 */
const known = new Map<string, { etag: string; file: RepoFile }>();
let conditional = true;

function remember(name: string, res: Response, file: RepoFile): RepoFile {
    const etag = res.headers.get('etag');
    if (etag) {
        known.set(name, { etag, file });
    }
    return file;
}

/** A file from the data branch, or null when it does not exist yet. */
export async function readFile(name: string, token?: string): Promise<RepoFile | null> {
    if (!token && anonymousLimited()) {
        throw new ApiError('rate_limited', 429);
    }
    const url = `${REPO_API}/contents/${encodeURIComponent(name)}?ref=${DATA_BRANCH}`;
    const have = token && conditional ? known.get(name) : undefined;
    let res: Response;
    try {
        res = await call(url, { token, etag: have ? have.etag : undefined });
    } catch (e) {
        if (!have || !(e instanceof ApiError) || e.code !== 'network_error') {
            throw e;
        }
        conditional = false; // this network does not allow the "unchanged?" question: plain reads from now on
        res = await call(url, { token });
    }
    if (res.status === 304 && have) {
        return { ...have.file };
    }
    if (res.status === 404) {
        known.delete(name);
        return null;
    }
    if (res.status === 401) {
        throw new ApiError('bad_token', 401);
    }
    if (rateLimited(res)) {
        if (!token) {
            noteLimit(res);
        }
        throw new ApiError('rate_limited', 429);
    }
    if (!res.ok) {
        throw new ApiError(`http_${res.status}`, res.status);
    }
    const json = (await res.json()) as { content?: unknown; sha?: unknown; encoding?: unknown; size?: unknown };
    if (!json || typeof json.sha !== 'string') {
        throw new ApiError('bad_response', 0);
    }
    if (typeof json.content === 'string' && json.content && json.encoding !== 'none') {
        const file = { text: b64ToUtf8(json.content), sha: json.sha };
        return token ? remember(name, res, file) : file;
    }
    if (!Number(json.size)) {
        return { text: '', sha: json.sha };
    }
    // files over 1 MB come without content: read them as a git blob (up to 100 MB)
    const blob = await call(`${REPO_API}/git/blobs/${json.sha}`, { token });
    if (rateLimited(blob)) {
        if (!token) {
            noteLimit(blob);
        }
        throw new ApiError('rate_limited', 429);
    }
    if (!blob.ok) {
        throw new ApiError(`http_${blob.status}`, blob.status);
    }
    const b = (await blob.json()) as { content?: unknown };
    if (!b || typeof b.content !== 'string') {
        throw new ApiError('bad_response', 0);
    }
    const file = { text: b64ToUtf8(b.content), sha: json.sha };
    return token ? remember(name, res, file) : file;
}

/** Same file through GitHub's file server (used when the API limit for visitors is reached). */
export async function readRaw(name: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 20_000);
    try {
        const res = await fetch(`${RAW}/${encodeURIComponent(name)}?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit', signal: controller.signal });
        if (res.status === 404) {
            return null;
        }
        if (!res.ok) {
            throw new ApiError(`http_${res.status}`, res.status);
        }
        return await res.text();
    } catch (e) {
        if (e instanceof ApiError) {
            throw e;
        }
        throw new ApiError('network_error', 0);
    } finally {
        window.clearTimeout(timer);
    }
}

/** Saves a file as one commit. `sha` is the version that was read (null for a new file). */
export async function writeFile(name: string, text: string, sha: string | null, message: string, token: string): Promise<string> {
    const body = JSON.stringify({ message, content: utf8ToB64(text), branch: DATA_BRANCH, ...(sha ? { sha } : {}) });
    const res = await call(`${REPO_API}/contents/${encodeURIComponent(name)}`, { method: 'PUT', body, token, ms: 30_000 });
    if (res.status === 200 || res.status === 201) {
        const json = (await res.json().catch(() => null)) as { content?: { sha?: string } } | null;
        return (json && json.content && json.content.sha) || '';
    }
    if (res.status === 409 || res.status === 422) {
        throw new ApiError('conflict', 409); // someone saved in between
    }
    if (res.status === 401) {
        throw new ApiError('bad_token', 401);
    }
    if (rateLimited(res)) {
        throw new ApiError('rate_limited', 429);
    }
    if (res.status === 403 || res.status === 404) {
        throw new ApiError('no_write', 403);
    }
    throw new ApiError(`http_${res.status}`, res.status);
}

/** Checks that a key works at all (it may still lack permission to save). */
export async function checkToken(token: string): Promise<void> {
    const res = await call(REPO_API, { token });
    if (res.status === 401) {
        throw new ApiError('bad_token', 401);
    }
    if (res.status === 403 || res.status === 404) {
        throw new ApiError('no_write', 403);
    }
    if (!res.ok) {
        throw new ApiError(`http_${res.status}`, res.status);
    }
}
