/**
 * Locking the website's data, outside the browser (Node 20+), with the very code the website uses.
 * Build:  esbuild tools/vault-cli.ts --bundle --platform=node --format=esm --outfile=tools/vault-cli.mjs
 *
 *   init   Encrypts plain data files and creates the logins.
 *            --in DIR       data.json, history.json, stock.json (those present) in plain text
 *            --out DIR      where the encrypted files and access.json are written
 *            --names a,b,c  the people who may log in (at most 6), in this order
 *          Passwords come from the environment, never from the command line or a file:
 *            MILAKO_MASTER  the company code (everyone's first password; needed to set a password)
 *            MILAKO_EDIT    the edit password (unlocks adding and changing data)
 *            and the GitHub key: MILAKO_TOKEN, or --old-editor FILE + MILAKO_OLD_EDIT (the key kept by the
 *            first website, opened with its edit password)
 *          --dek-out FILE   (tests only) also writes the data key
 *          MILAKO_PERSONAL  (tests only) {"name": "password"}: people who already set their own password
 *   open   --dek FILE --name data.json   encrypted file on stdin → plain text on stdout (tests)
 *   seal   --dek FILE --name data.json   plain text on stdin → encrypted file on stdout (tests)
 *   check  --dir DIR  with MILAKO_TRY_USER (name) and MILAKO_TRY_PASS: logs in like the website and opens every file
 *          MILAKO_TRY_EDIT  also checks that the edit password opens the GitHub key (never printed)
 *          --compare DIR    and that every opened file is exactly the plain file in DIR
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    ACCESS_FILE,
    KDF_ITER,
    MAX_USERS,
    fromB64,
    importDataKey,
    keyId,
    lockForUser,
    openForUser,
    openMaster,
    openText,
    openWithPassword,
    parseAccess,
    parseEditorDoc,
    randomBytes,
    sealMaster,
    sealText,
    sealWithPassword,
    serializeAccess,
    serializeEditorDoc,
    toB64,
} from '../src/lib/vaultCore';
import type { AccessDoc, EditorDoc } from '../src/lib/vaultCore';

const DATA_FILES = ['data.json', 'history.json', 'stock.json'];

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
}

function need(value: string | undefined, what: string): string {
    if (!value) {
        console.error(`missing: ${what}`);
        process.exit(2);
    }
    return value;
}

async function stdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) {
        chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function dekFrom(file: string): Promise<{ key: CryptoKey; kid: string }> {
    const raw = fromB64(readFileSync(file, 'utf8').trim());
    return { key: await importDataKey(raw), kid: await keyId(raw) };
}

async function init(): Promise<void> {
    const inDir = need(arg('in'), '--in');
    const outDir = need(arg('out'), '--out');
    const names = need(arg('names'), '--names')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
    if (!names.length || names.length > MAX_USERS || new Set(names).size !== names.length) {
        console.error(`--names: 1 to ${MAX_USERS} different names`);
        process.exit(2);
    }
    const master = need(process.env.MILAKO_MASTER, 'MILAKO_MASTER');
    const edit = need(process.env.MILAKO_EDIT, 'MILAKO_EDIT');
    const iter = Number(arg('iter') || KDF_ITER);
    let token = process.env.MILAKO_TOKEN || '';
    const oldEditor = arg('old-editor');
    if (!token && oldEditor) {
        const old = parseEditorDoc(readFileSync(oldEditor, 'utf8'));
        if (!old.edit) {
            console.error('old editor file has no key');
            process.exit(2);
        }
        token = await openWithPassword(old.edit, need(process.env.MILAKO_OLD_EDIT, 'MILAKO_OLD_EDIT'));
    }
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(token)) {
        console.error('no GitHub key (MILAKO_TOKEN or --old-editor)');
        process.exit(2);
    }
    const raw = randomBytes(32);
    const kid = await keyId(raw);
    const key = await importDataKey(raw);
    mkdirSync(outDir, { recursive: true });
    const now = Date.now();
    const access: AccessDoc = { milako: 'access', v: 1, kid, max: MAX_USERS, users: [], updatedAt: now };
    // (tests only) people who already set their own password: MILAKO_PERSONAL = {"name": "password"}
    const personal = JSON.parse(process.env.MILAKO_PERSONAL || '{}') as Record<string, string>;
    for (let i = 0; i < names.length; i += 1) {
        const id = `u${i + 1}`;
        const own = personal[names[i]];
        access.users.push({ id, name: names[i], ...(await lockForUser(id, kid, own || master, raw, iter)), initial: !own, at: now });
    }
    writeFileSync(join(outDir, ACCESS_FILE), serializeAccess(access));
    for (const f of DATA_FILES) {
        const p = join(inDir, f);
        if (existsSync(p)) {
            writeFileSync(join(outDir, f), await sealText(key, kid, f, readFileSync(p, 'utf8')));
        }
    }
    const doc: EditorDoc = {
        v: 2,
        edit: await sealWithPassword(token, edit, iter),
        master: await sealMaster(token, raw, master, iter),
        savedAt: now,
    };
    writeFileSync(join(outDir, 'editor.json'), await sealText(key, kid, 'editor.json', serializeEditorDoc(doc)));
    const dekOut = arg('dek-out');
    if (dekOut) {
        writeFileSync(dekOut, toB64(raw) + '\n');
    }
    raw.fill(0);
    console.log(JSON.stringify({ ok: true, kid, users: names.length, files: DATA_FILES.filter((f) => existsSync(join(inDir, f))) }));
}

async function check(): Promise<void> {
    const dir = need(arg('dir'), '--dir');
    const who = need(process.env.MILAKO_TRY_USER, 'MILAKO_TRY_USER');
    const pass = need(process.env.MILAKO_TRY_PASS, 'MILAKO_TRY_PASS');
    const access = parseAccess(readFileSync(join(dir, ACCESS_FILE), 'utf8'));
    const u = access.users.find((x) => x.name === who);
    if (!u) {
        console.error('no such person');
        process.exit(1);
    }
    const raw = await openForUser(u, access.kid, pass);
    const key = await importDataKey(raw);
    const out: Record<string, unknown> = { kid: access.kid, people: access.users.map((x) => x.name) };
    for (const f of [...DATA_FILES, 'editor.json']) {
        const p = join(dir, f);
        if (!existsSync(p)) {
            continue;
        }
        const text = await openText(key, access.kid, f, readFileSync(p, 'utf8'));
        const json = JSON.parse(text) as Record<string, unknown>;
        const cmp = arg('compare');
        if (cmp && f !== 'editor.json' && existsSync(join(cmp, f))) {
            out[`${f} same as plain`] = readFileSync(join(cmp, f), 'utf8') === text;
        }
        if (f === 'data.json') {
            out[f] = { products: (json.products as unknown[]).length, months: Object.keys(json.months as object).length };
        } else if (f === 'history.json') {
            out[f] = { records: (json.records as unknown[]).length };
        } else if (f === 'editor.json') {
            const doc = parseEditorDoc(text);
            const m = await openMaster(doc, pass, access.kid).catch(() => null); // only when the password is the company code
            let editOpens: boolean | null = null;
            let sameToken: boolean | null = null;
            if (process.env.MILAKO_TRY_EDIT && doc.edit) {
                const t = await openWithPassword(doc.edit, process.env.MILAKO_TRY_EDIT).catch(() => '');
                editOpens = /^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(t);
                sameToken = m ? m.token === t : null;
            }
            out[f] = { edit: Boolean(doc.edit), master: Boolean(doc.master), masterOpens: Boolean(m), editOpens, sameToken };
            m?.dataKey.fill(0);
        } else {
            out[f] = { ok: true };
        }
    }
    raw.fill(0);
    console.log(JSON.stringify(out));
}

async function main(): Promise<void> {
    const cmd = process.argv[2];
    if (cmd === 'init') {
        await init();
    } else if (cmd === 'open') {
        const { key, kid } = await dekFrom(need(arg('dek'), '--dek'));
        process.stdout.write(await openText(key, kid, need(arg('name'), '--name'), await stdin()));
    } else if (cmd === 'seal') {
        const { key, kid } = await dekFrom(need(arg('dek'), '--dek'));
        process.stdout.write(await sealText(key, kid, need(arg('name'), '--name'), await stdin()));
    } else if (cmd === 'check') {
        await check();
    } else {
        console.error('usage: vault-cli init|open|seal|check …');
        process.exit(2);
    }
}

main().catch((e) => {
    console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    process.exit(1);
});
