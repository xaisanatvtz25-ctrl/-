import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from './api';
import { HISTORY_FILE } from './config';
import { readFile, readRaw, writeFile } from './github';
import { readEditorDoc } from './keys';
import { normalizeHistory, serializeHistory } from './history';
import { COMMIT_MESSAGE, readSecure, writeSecure } from './secureFiles';
import {
    ACCESS_FILE,
    VaultError,
    importDataKey,
    lockForUser,
    openForUser,
    openMaster,
    parseAccess,
    serializeAccess,
} from './vaultCore';
import type { AccessDoc } from './vaultCore';
import {
    LOCAL,
    SESSION_DAYS,
    announceLogout,
    clearSession,
    closeLocal,
    flushLocal,
    initLocal,
    loadSession,
    loginWait,
    noteLoginFail,
    noteLoginOk,
    onLogoutElsewhere,
    saveSession,
    setActiveVault,
    setLocal,
} from './vault';
import type { StoredSession } from './vault';
import { ChangePasswordModal, FirstPassword, LoginScreen, SessionSplash } from '../components/Login';

/**
 * Who is using the website. Nothing can be seen before logging in: one of the people in access.json (at most 6)
 * with their own password. The login opens the data key on this device (kept 30 days, or until logging out,
 * or until the person's password is changed elsewhere). The person's name is saved with everything they do.
 */

export interface Person {
    id: string;
    name: string;
    /** still on the starting password */
    initial: boolean;
}

export type LogoutReason = 'manual' | 'changed' | 'expired' | 'removed';

interface SessionValue {
    userId: string;
    name: string;
    /** everyone who can log in (for setting someone's forgotten password) */
    people: Person[];
    /** this login lasts until (ms) */
    until: number;
    logout: (reason?: LogoutReason) => Promise<void>;
    openChangePassword: () => void;
    /** look again whether this login is still valid (password changed elsewhere, person removed, new data key) */
    recheck: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

const REASON_KEY = 'milako.logoutReason';
const CHECK_MS = 10 * 60_000;

/** access.json as it is now on GitHub (null: it does not exist) */
export async function fetchAccess(): Promise<AccessDoc | null> {
    let text: string | null;
    try {
        const f = await readFile(ACCESS_FILE);
        text = f ? f.text : null;
    } catch {
        text = await readRaw(ACCESS_FILE);
    }
    return text === null ? null : parseAccess(text);
}

function peopleOf(acc: AccessDoc | null): Person[] {
    return acc ? acc.users.map((u) => ({ id: u.id, name: u.name, initial: u.initial })) : [];
}

function newId(prefix: string): string {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** "who set whose password" in the history (the save of the password does not wait for it) */
async function logPassword(token: string, by: string, target: { id: string; name: string }): Promise<void> {
    const now = Date.now();
    for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
            const file = await readSecure(HISTORY_FILE, token);
            const doc = file && file.text.trim() ? normalizeHistory(JSON.parse(file.text)) : normalizeHistory({});
            doc.records.push({ id: newId('h'), at: now, by, act: 'password', kind: 'user', after: { id: target.id, name: target.name } });
            await writeSecure(HISTORY_FILE, serializeHistory(doc), file ? file.sha : null, token);
            return;
        } catch (e) {
            if (!(e instanceof ApiError && e.code === 'conflict')) {
                return;
            }
        }
    }
}

type Phase =
    | { at: 'boot' }
    | { at: 'login' }
    | { at: 'first'; session: StoredSession; code: string }
    | { at: 'ready'; session: StoredSession };

export function SessionProvider({ children }: { children: ReactNode }) {
    const [phase, setPhase] = useState<Phase>({ at: 'boot' });
    const [access, setAccess] = useState<AccessDoc | null>(null);
    const [accessError, setAccessError] = useState<string | null>(null);
    const [changeOpen, setChangeOpen] = useState(false);
    const [notice, setNotice] = useState<LogoutReason | null>(() => {
        try {
            const r = sessionStorage.getItem(REASON_KEY) as LogoutReason | null;
            sessionStorage.removeItem(REASON_KEY);
            return r;
        } catch {
            return null;
        }
    });
    const phaseRef = useRef(phase);
    phaseRef.current = phase;

    const loadAccess = useCallback(async (): Promise<AccessDoc | null> => {
        try {
            const acc = await fetchAccess();
            setAccess(acc);
            setAccessError(acc ? null : 'no_access');
            return acc;
        } catch (e) {
            setAccessError(e instanceof VaultError || e instanceof ApiError ? e.code : 'network_error');
            return null;
        }
    }, []);

    const logout = useCallback(async (reason: LogoutReason = 'manual') => {
        try {
            setLocal(LOCAL.editKey, null); // the editing key never stays after logging out
            await flushLocal();
        } catch {
            // ignore
        }
        await clearSession();
        closeLocal();
        setActiveVault(null);
        announceLogout();
        try {
            sessionStorage.setItem(REASON_KEY, reason);
        } catch {
            // ignore
        }
        window.location.reload(); // nothing of the data stays in this page
    }, []);

    /** opens the website for a session (a new login, or the one kept on this device) */
    const enter = useCallback(async (s: StoredSession, firstCode?: string) => {
        setActiveVault({ key: s.key, kid: s.kid, userId: s.userId, name: s.name });
        await initLocal(s.key);
        setPhase(firstCode ? { at: 'first', session: s, code: firstCode } : { at: 'ready', session: s });
    }, []);

    /** the person's password changed elsewhere, or the person was removed: this device logs out */
    const check = useCallback(async () => {
        const p = phaseRef.current;
        if (p.at !== 'ready') {
            return;
        }
        const acc = await loadAccess();
        if (!acc) {
            return; // cannot tell (offline): stays logged in
        }
        const saved = (await loadSession()) || p.session;
        const u = acc.users.find((x) => x.id === saved.userId);
        if (!u || acc.kid !== saved.kid) {
            void logout('removed');
        } else if (u.at > saved.ver) {
            void logout('changed');
        } else if (Date.now() > saved.exp) {
            void logout('expired');
        }
    }, [loadAccess, logout]);

    // the login kept on this device
    useEffect(() => {
        let alive = true;
        void (async () => {
            const s = await loadSession();
            if (!alive) {
                return;
            }
            if (s) {
                await enter(s);
                void check();
            } else {
                setPhase({ at: 'login' });
                void loadAccess();
            }
        })();
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // checked again when the person comes back to the page, and every 10 minutes
    useEffect(() => {
        if (phase.at !== 'ready') {
            return undefined;
        }
        const onVisible = () => {
            if (document.visibilityState === 'visible') {
                void check();
            }
        };
        const timer = window.setInterval(onVisible, CHECK_MS);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [phase.at, check]);

    // logged out in another tab of this browser
    useEffect(() => onLogoutElsewhere(() => window.location.reload()), []);

    const login = useCallback(
        async (userId: string, password: string): Promise<void> => {
            const wait = loginWait();
            if (wait > 0) {
                throw new VaultError(`wait:${Math.ceil(wait / 1000)}`);
            }
            const acc = (await loadAccess()) || access;
            if (!acc) {
                throw new VaultError('no_access');
            }
            const u = acc.users.find((x) => x.id === userId);
            if (!u) {
                throw new VaultError('no_access');
            }
            let raw: Uint8Array;
            try {
                raw = await openForUser(u, acc.kid, password);
            } catch (e) {
                if (e instanceof VaultError && e.code === 'wrong_password') {
                    const next = noteLoginFail();
                    if (next > 0) {
                        throw new VaultError(`wrong_wait:${Math.ceil(next / 1000)}`);
                    }
                }
                throw e;
            }
            noteLoginOk();
            const key = await importDataKey(raw);
            raw.fill(0);
            const now = Date.now();
            const s: StoredSession = { v: 1, userId: u.id, name: u.name, kid: acc.kid, key, loginAt: now, exp: now + SESSION_DAYS * 86_400_000, ver: u.at };
            await saveSession(s); // false: this browser cannot keep it; the login lasts while the page is open
            setNotice(null);
            await enter(s, u.initial ? password : undefined);
        },
        [access, enter, loadAccess],
    );

    /**
     * Sets the login password of `targetId` (oneself, or someone who forgot theirs). Needs the company code:
     * it opens the GitHub key and the data key kept for this in editor.json.
     */
    const setPassword = useCallback(
        async (targetId: string, companyCode: string, next: string): Promise<StoredSession | null> => {
            const p = phaseRef.current;
            if (p.at !== 'ready' && p.at !== 'first') {
                throw new VaultError('locked');
            }
            const me = p.session;
            const doc = await readEditorDoc();
            if (!doc) {
                throw new VaultError('no_master');
            }
            const secret = await openMaster(doc, companyCode, me.kid);
            const now = Date.now();
            let target: { id: string; name: string } | null = null;
            try {
                for (let attempt = 0; ; attempt += 1) {
                    const f = await readFile(ACCESS_FILE, secret.token);
                    if (!f) {
                        throw new VaultError('no_access');
                    }
                    const acc = parseAccess(f.text);
                    const u = acc.users.find((x) => x.id === targetId);
                    if (!u) {
                        throw new ApiError('not_found', 404);
                    }
                    Object.assign(u, await lockForUser(u.id, acc.kid, next, secret.dataKey), { initial: false, at: now });
                    acc.updatedAt = now;
                    try {
                        await writeFile(ACCESS_FILE, serializeAccess(acc), f.sha, COMMIT_MESSAGE, secret.token);
                        setAccess(acc);
                        target = { id: u.id, name: u.name };
                        break;
                    } catch (e) {
                        if (e instanceof ApiError && e.code === 'conflict' && attempt < 3) {
                            continue;
                        }
                        throw e;
                    }
                }
            } finally {
                secret.dataKey.fill(0);
            }
            if (target) {
                void logPassword(secret.token, me.name, target);
            }
            if (targetId !== me.userId) {
                return null;
            }
            // this device stays logged in with the new password; other devices of this person log out
            const updated: StoredSession = { ...me, ver: now };
            await saveSession(updated);
            setPhase((cur) => (cur.at === 'ready' ? { ...cur, session: updated } : cur));
            return updated;
        },
        [],
    );

    const session = phase.at === 'ready' || phase.at === 'first' ? phase.session : null;
    const value = useMemo<SessionValue | null>(
        () =>
            session
                ? {
                      userId: session.userId,
                      name: session.name,
                      people: peopleOf(access).length ? peopleOf(access) : [{ id: session.userId, name: session.name, initial: false }],
                      until: session.exp,
                      logout,
                      openChangePassword: () => setChangeOpen(true),
                      recheck: check,
                  }
                : null,
        [session, access, logout, check],
    );

    if (phase.at === 'boot') {
        return <SessionSplash />;
    }
    if (phase.at === 'login' || !value) {
        return (
            <LoginScreen
                people={peopleOf(access)}
                loading={!access && !accessError}
                loadError={accessError}
                notice={notice}
                onRetry={() => void loadAccess()}
                onLogin={login}
            />
        );
    }
    if (phase.at === 'first') {
        return (
            <FirstPassword
                name={phase.session.name}
                onSave={async (next) => {
                    const updated = await setPassword(phase.session.userId, phase.code, next);
                    setPhase({ at: 'ready', session: updated || phase.session });
                }}
                onSkip={() => setPhase({ at: 'ready', session: phase.session })}
                onLogout={() => void logout('manual')}
            />
        );
    }
    return (
        <SessionContext.Provider value={value}>
            {children}
            <ChangePasswordModal
                open={changeOpen}
                me={value.userId}
                people={value.people}
                onSave={async (targetId, code, next) => {
                    await setPassword(targetId, code, next);
                }}
                onClose={() => setChangeOpen(false)}
            />
        </SessionContext.Provider>
    );
}

export function useSession(): SessionValue {
    const ctx = useContext(SessionContext);
    if (!ctx) {
        throw new Error('useSession must be used inside SessionProvider (after logging in)');
    }
    return ctx;
}
