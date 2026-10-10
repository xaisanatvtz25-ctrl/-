/**
 * editor.json: the GitHub key that lets the website save, kept encrypted twice. The file is encrypted with the
 * data key (only people logged in can even see it), and inside it the GitHub key is locked again:
 *  - with the edit password (unlocking editing), and
 *  - with the company code, together with the data key (setting a person's login password).
 */
import { KEY_FILE } from './config';
import { ApiError } from './api';
import { readFile } from './github';
import { readSecure, readSecureRaw, writeSecure } from './secureFiles';
import { VaultError, openWithPassword, parseEditorDoc, sealMaster, sealWithPassword, serializeEditorDoc } from './vaultCore';
import type { EditorDoc } from './vaultCore';

const KEEP_ERRORS = ['key_changed', 'cannot_open', 'wrong_file', 'not_encrypted', 'locked'];

/** editor.json, opened (null: saving was never connected) */
export async function readEditorDoc(token?: string): Promise<EditorDoc | null> {
    let text: string | null;
    try {
        const f = await readSecure(KEY_FILE, token);
        text = f ? f.text : null;
    } catch (e) {
        if (e instanceof VaultError && KEEP_ERRORS.includes(e.code)) {
            throw e;
        }
        text = await readSecureRaw(KEY_FILE);
    }
    return text && text.trim() ? parseEditorDoc(text) : null;
}

/** the GitHub key, with the edit password (VaultError 'wrong_password') */
export async function openEditKey(doc: EditorDoc, password: string): Promise<string> {
    if (!doc.edit) {
        throw new VaultError('no_edit');
    }
    return openWithPassword(doc.edit, password, 'wrong_password');
}

/** a new editor.json for a new GitHub key (the data key comes from the company code) */
export async function makeEditorDoc(token: string, editPassword: string, masterCode: string, dataKey: Uint8Array): Promise<EditorDoc> {
    return {
        v: 2,
        edit: await sealWithPassword(token, editPassword),
        master: await sealMaster(token, dataKey, masterCode),
        savedAt: Date.now(),
    };
}

/** saves editor.json (encrypted), tried again when someone saved in between */
export async function writeEditorDoc(doc: EditorDoc, token: string): Promise<void> {
    const text = serializeEditorDoc(doc);
    for (let attempt = 0; ; attempt += 1) {
        const current = await readFile(KEY_FILE, token);
        try {
            await writeSecure(KEY_FILE, text, current ? current.sha : null, token);
            return;
        } catch (e) {
            if (e instanceof ApiError && e.code === 'conflict' && attempt < 2) {
                continue;
            }
            throw e;
        }
    }
}
