/**
 * Reading and saving the data files on GitHub, encrypted with the data key of the person logged in.
 * Commit messages say nothing about the data (the GitHub history is public): every save is just "Update".
 */
import { readFile, readRaw, writeFile } from './github';
import type { RepoFile } from './github';
import { activeVault } from './vault';
import { openText, sealText } from './vaultCore';

export const COMMIT_MESSAGE = 'Update';

async function open(name: string, text: string): Promise<string> {
    const v = activeVault();
    return openText(v.key, v.kid, name, text);
}

/** a data file from GitHub, opened (null when it does not exist yet) */
export async function readSecure(name: string, token?: string): Promise<RepoFile | null> {
    const f = await readFile(name, token);
    if (!f) {
        return null;
    }
    return { text: f.text.trim() ? await open(name, f.text) : '', sha: f.sha };
}

/** the same file through GitHub's file server (when the API cannot be used) */
export async function readSecureRaw(name: string): Promise<string | null> {
    const text = await readRaw(name);
    return text === null ? null : text.trim() ? open(name, text) : '';
}

/** the file through the API, else through the file server; null when it does not exist */
export async function readSecureText(name: string, token?: string): Promise<string | null> {
    try {
        const f = await readSecure(name, token);
        return f ? f.text : null;
    } catch (e) {
        if (e && typeof e === 'object' && 'code' in e && ['key_changed', 'cannot_open', 'wrong_file', 'not_encrypted', 'locked'].includes(String((e as { code: string }).code))) {
            throw e;
        }
        return readSecureRaw(name);
    }
}

/** saves a data file encrypted, as one commit */
export async function writeSecure(name: string, text: string, sha: string | null, token: string): Promise<string> {
    const v = activeVault();
    return writeFile(name, await sealText(v.key, v.kid, name, text), sha, COMMIT_MESSAGE, token);
}

/** opens a copy of a data file that was published with the website */
export async function openSnapshot(name: string, text: string): Promise<string> {
    return open(name, text);
}
