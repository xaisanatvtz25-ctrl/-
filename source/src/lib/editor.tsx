import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from './api';
import { checkToken } from './github';
import { makeEditorDoc, openEditKey, readEditorDoc, writeEditorDoc } from './keys';
import { useSession } from './session';
import { LOCAL, activeVault, getLocal, onLocalChange, setLocal } from './vault';
import { VaultError, openMaster } from './vaultCore';
import { AccountModal, UnlockModal } from '../components/EditAccess';
import type { UnlockReason } from '../components/EditAccess';

/**
 * Editing. Everyone logged in can look; adding and changing data needs the edit password as well. It opens the
 * GitHub key kept (encrypted) in the repository, so it works on any device. Everything saved carries the name of
 * the person logged in.
 */

const KEEP_MS = 30 * 24 * 3600 * 1000;
const TOKEN_RE = /^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/;

interface SavedKey {
    /** the person who unlocked (another person logging in on this device does not inherit it) */
    u: string;
    token: string;
    exp: number;
}

function readSaved(userId: string): SavedKey | null {
    try {
        const v = JSON.parse(getLocal(LOCAL.editKey) || 'null') as SavedKey | null;
        return v && v.u === userId && typeof v.token === 'string' && v.token && Number(v.exp) > Date.now() ? v : null;
    } catch {
        return null;
    }
}

interface EditorValue {
    /** editing is unlocked */
    canEdit: boolean;
    /** the saving key while unlocked, '' when locked */
    token: string;
    /** the person logged in (saved with every change) */
    name: string;
    /** run `then` now if editing is open, otherwise after unlocking */
    requireLogin: (then?: () => void) => void;
    openAccount: () => void;
    /** lock editing again (stays logged in) */
    logout: () => void;
    /** the saving key stopped working (removed on GitHub): lock and ask again */
    keyRejected: () => void;
}

const EditorContext = createContext<EditorValue | null>(null);

export function EditorProvider({ children }: { children: ReactNode }) {
    const session = useSession();
    const [saved, setSaved] = useState<SavedKey | null>(() => readSaved(session.userId));
    const [request, setRequest] = useState<{ then?: () => void; reason?: UnlockReason } | null>(null);
    const [accountOpen, setAccountOpen] = useState(false);

    const token = saved && saved.exp > Date.now() ? saved.token : '';
    const canEdit = Boolean(token);

    const save = useCallback(
        (t: string | null) => {
            const v = t ? { u: session.userId, token: t, exp: Date.now() + KEEP_MS } : null;
            setLocal(LOCAL.editKey, v ? JSON.stringify(v) : null);
            setSaved(v);
        },
        [session.userId],
    );

    // unlocked or locked in another tab of this browser
    useEffect(() => onLocalChange(LOCAL.editKey, () => setSaved(readSaved(session.userId))), [session.userId]);

    const logout = useCallback(() => {
        save(null);
        setAccountOpen(false);
    }, [save]);

    const unlock = useCallback(
        async (password: string): Promise<'ok' | 'connect'> => {
            const doc = await readEditorDoc();
            if (!doc || !doc.edit) {
                return 'connect'; // first time: saving is not connected yet
            }
            const t = await openEditKey(doc, password);
            try {
                await checkToken(t);
            } catch (e) {
                if (e instanceof ApiError && (e.code === 'bad_token' || e.code === 'no_write')) {
                    return 'connect'; // the key was removed on GitHub: make a new one
                }
                throw e;
            }
            save(t);
            return 'ok';
        },
        [save],
    );

    /** a new GitHub key (the old one expired or was removed): needs the edit password and the company code */
    const connect = useCallback(
        async (rawToken: string, password: string, companyCode: string) => {
            const t = rawToken.replace(/\s+/g, '');
            if (!TOKEN_RE.test(t)) {
                throw new ApiError('key_invalid', 0);
            }
            try {
                await checkToken(t);
            } catch (e) {
                if (e instanceof ApiError && e.code === 'bad_token') {
                    throw new ApiError('key_invalid', 401);
                }
                throw e;
            }
            const old = await readEditorDoc(t);
            if (!old) {
                throw new VaultError('no_master');
            }
            const secret = await openMaster(old, companyCode, activeVault().kid);
            try {
                await writeEditorDoc(await makeEditorDoc(t, password, companyCode, secret.dataKey), t);
            } finally {
                secret.dataKey.fill(0);
            }
            save(t);
        },
        [save],
    );

    const requireLogin = useCallback(
        (then?: () => void) => {
            if (token) {
                then?.();
            } else {
                setRequest({ then });
            }
        },
        [token],
    );

    const keyRejected = useCallback(() => {
        save(null);
        setRequest({ reason: 'rejected' });
    }, [save]);

    const openAccount = useCallback(() => setAccountOpen(true), []);

    const value = useMemo<EditorValue>(
        () => ({ canEdit, token, name: session.name, requireLogin, openAccount, logout, keyRejected }),
        [canEdit, token, session.name, requireLogin, openAccount, logout, keyRejected],
    );

    const close = useCallback(() => setRequest(null), []);
    const done = useCallback(() => {
        const then = request?.then;
        setRequest(null);
        if (then) {
            window.setTimeout(then, 0); // let the new state reach the context first
        }
    }, [request]);

    return (
        <EditorContext.Provider value={value}>
            {children}
            <UnlockModal open={Boolean(request)} reason={request?.reason} name={session.name} onUnlock={unlock} onConnect={connect} onDone={done} onClose={close} />
            <AccountModal
                open={accountOpen}
                name={session.name}
                until={session.until}
                canEdit={canEdit}
                onUnlock={() => {
                    setAccountOpen(false);
                    setRequest({});
                }}
                onLock={logout}
                onChangePassword={() => {
                    setAccountOpen(false);
                    session.openChangePassword();
                }}
                onLogout={() => void session.logout('manual')}
                onClose={() => setAccountOpen(false)}
            />
        </EditorContext.Provider>
    );
}

export function useEditor(): EditorValue {
    const ctx = useContext(EditorContext);
    if (!ctx) {
        throw new Error('useEditor must be used inside EditorProvider');
    }
    return ctx;
}
