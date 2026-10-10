/**
 * The GitHub key for saving is kept in the repository encrypted with the edit password
 * (PBKDF2-SHA256 + AES-GCM in the browser). Only someone who types the password can use it.
 */
import { ApiError } from './api';

const ITERATIONS = 310_000;

export interface SealedKey {
    v: 1;
    kdf: 'PBKDF2-SHA256';
    iter: number;
    salt: string;
    iv: string;
    data: string;
    savedAt: number;
}

function toB64(bytes: Uint8Array): string {
    let bin = '';
    bytes.forEach((b) => {
        bin += String.fromCharCode(b);
    });
    return btoa(bin);
}

function fromB64(text: string): Uint8Array {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
    }
    return out;
}

/** Spaces and capital letters (phone keyboards) do not matter. */
export function normalizePassword(password: string): string {
    return password.trim().toLowerCase();
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(normalizePassword(password)), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

export async function seal(secret: string, password: string): Promise<SealedKey> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, ITERATIONS);
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(secret)));
    return { v: 1, kdf: 'PBKDF2-SHA256', iter: ITERATIONS, salt: toB64(salt), iv: toB64(iv), data: toB64(data), savedAt: Date.now() };
}

export async function unseal(raw: unknown, password: string): Promise<string> {
    const f = raw as Partial<SealedKey> | null;
    if (!f || f.v !== 1 || typeof f.salt !== 'string' || typeof f.iv !== 'string' || typeof f.data !== 'string') {
        throw new ApiError('bad_key_file', 0);
    }
    const iter = Number(f.iter);
    if (!Number.isInteger(iter) || iter < 10_000 || iter > 5_000_000) {
        throw new ApiError('bad_key_file', 0);
    }
    const key = await deriveKey(password, fromB64(f.salt), iter);
    try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(f.iv) as BufferSource }, key, fromB64(f.data) as BufferSource);
        return new TextDecoder().decode(plain);
    } catch {
        throw new ApiError('wrong_password', 401);
    }
}
