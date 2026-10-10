import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { useToast } from './Toast';
import { useI18n } from '../lib/i18n';
import type { Key } from '../lib/i18n';
import { errorCode } from '../lib/api';
import { TOKEN_URL } from '../lib/config';
import { longDate } from '../lib/format';

/** i18n key for an error from saving, loading or unlocking */
export function apiErrorKey(e: unknown): Key {
    const code = errorCode(e);
    if (code === 'wrong_password') return 'wrongPassword';
    if (code === 'wrong_master') return 'errWrongMaster';
    if (code === 'no_master') return 'errNoMaster';
    if (code === 'key_changed') return 'errKeyChanged';
    if (code === 'cannot_open' || code === 'wrong_file' || code === 'not_encrypted') return 'errCannotOpen';
    if (code === 'old_browser') return 'errOldBrowser';
    if (code === 'locked') return 'lgChanged';
    if (code === 'unauthorized') return 'sessionExpired';
    if (code === 'bad_token') return 'authExpired';
    if (code === 'key_invalid') return 'keyInvalid';
    if (code === 'no_write') return 'keyNoWrite';
    if (code === 'rate_limited') return 'errRate';
    if (code === 'conflict') return 'errBusy';
    if (code === 'network_error' || code === 'timeout' || code === 'bad_response' || /^http_/.test(code)) return 'errNetwork';
    if (code === 'not_found' || code === 'product_not_found') return 'errChanged';
    if (code === 'qty_invalid') return 'qtyInvalid';
    if (code === 'duplicate_name') return 'duplicate';
    if (code === 'name_required') return 'nameRequired';
    if (code === 'already_undone' || code === 'nothing_to_undo') return 'errUndone';
    if (code === 'bad_data') return 'errBadData';
    if (code === 'reason_required') return 'issueReasonRequired';
    if (code === 'text_required') return 'chatTextRequired';
    if (code === 'not_yours') return 'chatNotYours';
    if (code === 'outdated') return 'errOutdated';
    if (code === 'date_invalid' || code === 'month_required') return 'errorGeneric';
    return 'errorGeneric';
}

export type UnlockReason = 'expired' | 'rejected';

interface UnlockProps {
    open: boolean;
    reason?: UnlockReason;
    /** the person logged in (everything is saved with this name) */
    name: string;
    /** 'ok' when unlocked, 'connect' when saving has not been connected to GitHub yet */
    onUnlock: (password: string) => Promise<'ok' | 'connect'>;
    onConnect: (token: string, password: string, companyCode: string) => Promise<void>;
    onDone: () => void;
    onClose: () => void;
}

function PassField({ id, label, value, onChange, show, onShow, autoComplete, hint, invalid, autoFocus }: {
    id: string;
    label: string;
    value: string;
    onChange: (v: string) => void;
    show: boolean;
    onShow: () => void;
    autoComplete: string;
    hint?: string;
    invalid?: boolean;
    autoFocus?: boolean;
}) {
    const { t } = useI18n();
    return (
        <div className="field">
            <label htmlFor={id}>{label}</label>
            <div className="input-icon">
                <Icon name="lock" size={18} />
                <input
                    id={id}
                    className="input"
                    type={show ? 'text' : 'password'}
                    autoComplete={autoComplete}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    aria-invalid={invalid || undefined}
                    data-autofocus={autoFocus || undefined}
                    maxLength={128}
                />
                <button type="button" className="input-toggle" onClick={onShow} aria-label={t('showPassword')} aria-pressed={show}>
                    <Icon name={show ? 'eyeOff' : 'eye'} size={18} />
                </button>
            </div>
            {hint && <p className="hint">{hint}</p>}
        </div>
    );
}

/** Type the edit password to unlock editing. When the GitHub key must be replaced, it is connected here too. */
export function UnlockModal({ open, reason, name, onUnlock, onConnect, onDone, onClose }: UnlockProps) {
    const { t } = useI18n();
    const toast = useToast();
    const [step, setStep] = useState<'password' | 'connect'>('password');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [show, setShow] = useState(false);
    const [token, setToken] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (open) {
            setStep('password');
            setPassword('');
            setCode('');
            setShow(false);
            setToken('');
            setBusy(false);
            setError('');
        }
    }, [open]);

    const unlock = async (e: FormEvent) => {
        e.preventDefault();
        if (!password.trim()) {
            setError(t('enterPassword'));
            return;
        }
        setBusy(true);
        setError('');
        try {
            const res = await onUnlock(password);
            if (res === 'connect') {
                setStep('connect');
                setShow(true);
                setBusy(false);
                return;
            }
            toast.show(t('loggedIn'), 'success', 'unlock');
            onDone();
        } catch (err) {
            setError(t(apiErrorKey(err)));
            setBusy(false);
        }
    };

    const paste = async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                setToken(text.trim());
                setError('');
            }
        } catch {
            setError(t('pasteManual'));
        }
    };

    const connect = async (e: FormEvent) => {
        e.preventDefault();
        if (!token.trim()) {
            setError(t('keyMissing'));
            return;
        }
        if (!password.trim()) {
            setError(t('enterPassword'));
            return;
        }
        if (!code.trim()) {
            setError(t('cpNeedCode'));
            return;
        }
        setBusy(true);
        setError('');
        try {
            await onConnect(token, password, code);
            toast.show(t('connectedToast'), 'success', 'unlock');
            onDone();
        } catch (err) {
            setError(t(apiErrorKey(err)));
            setBusy(false);
        }
    };

    const errorBox = (
        <div className="login-error" role="alert" aria-live="assertive">
            {error && (
                <>
                    <Icon name="alert" size={16} />
                    {error}
                </>
            )}
        </div>
    );

    if (step === 'connect') {
        return (
            <Modal
                open={open}
                size="sm"
                title={t('connectTitle')}
                onClose={busy ? () => undefined : onClose}
                footer={
                    <>
                        <button type="button" className="btn btn-ghost" onClick={() => setStep('password')} disabled={busy}>
                            {t('backStep')}
                        </button>
                        <button type="submit" form="connect-form" className="btn btn-primary" disabled={busy}>
                            {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="check" size={17} />}
                            {busy ? t('connecting') : t('connect')}
                        </button>
                    </>
                }
            >
                <form id="connect-form" className="form connect" onSubmit={connect} noValidate>
                    <p className="hint connect-intro">{t('connectIntro')}</p>
                    <ol className="connect-steps">
                        <li>
                            <span>{t('connectStep1')}</span>
                            <a className="btn btn-primary connect-open" href={TOKEN_URL} target="_blank" rel="noopener noreferrer">
                                <Icon name="key" size={17} />
                                {t('openGitHub')}
                            </a>
                        </li>
                        <li>{t('connectStep2')}</li>
                        <li>{t('connectStep3')}</li>
                        <li>{t('connectStep4')}</li>
                    </ol>
                    <div className="field">
                        <label htmlFor="connect-token">{t('keyLabel')}</label>
                        <div className="paste-row">
                            <input
                                id="connect-token"
                                className="input"
                                type="text"
                                inputMode="text"
                                autoComplete="off"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                                placeholder="github_pat_..."
                                value={token}
                                onChange={(e) => setToken(e.target.value)}
                                aria-invalid={Boolean(error)}
                            />
                            <button type="button" className="btn btn-outline" onClick={() => void paste()} disabled={busy}>
                                {t('pasteBtn')}
                            </button>
                        </div>
                    </div>
                    <PassField id="connect-pass" label={t('editPassword')} value={password} onChange={setPassword} show={show} onShow={() => setShow((s) => !s)} autoComplete="new-password" hint={t('connectPwHint')} />
                    <PassField id="connect-code" label={t('cpCode')} value={code} onChange={setCode} show={show} onShow={() => setShow((s) => !s)} autoComplete="off" hint={t('connectCodeHint')} />
                    {errorBox}
                </form>
            </Modal>
        );
    }

    return (
        <Modal
            open={open}
            size="sm"
            title={t('editLogin')}
            subtitle={reason === 'rejected' ? t('authExpired') : reason === 'expired' ? t('sessionExpired') : undefined}
            onClose={busy ? () => undefined : onClose}
            footer={
                <>
                    <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
                        {t('cancel')}
                    </button>
                    <button type="submit" form="unlock-form" className="btn btn-primary" disabled={busy}>
                        {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="lock" size={17} />}
                        {busy ? t('unlocking') : t('unlock')}
                    </button>
                </>
            }
        >
            <form id="unlock-form" className="form" onSubmit={unlock} noValidate>
                <p className="hint edit-login-hint">{t('unlockHint')}</p>
                <p className="unlock-as">
                    <Icon name="user" size={16} />
                    <span>{t('unlockAs', { name })}</span>
                </p>
                <PassField
                    id="unlock-pass"
                    label={t('editPassword')}
                    value={password}
                    onChange={setPassword}
                    show={show}
                    onShow={() => setShow((s) => !s)}
                    autoComplete="current-password"
                    invalid={Boolean(error)}
                    autoFocus
                />
                {errorBox}
                <button
                    type="button"
                    className="edit-setup-link"
                    onClick={() => {
                        setError('');
                        setStep('connect');
                        setShow(true);
                    }}
                >
                    <Icon name="key" size={14} />
                    {t('reconnect')}
                </button>
            </form>
        </Modal>
    );
}

interface AccountProps {
    open: boolean;
    /** the person logged in */
    name: string;
    /** the login on this device lasts until (ms) */
    until: number;
    canEdit: boolean;
    onUnlock: () => void;
    onLock: () => void;
    onChangePassword: () => void;
    onLogout: () => void;
    onClose: () => void;
}

/** The person logged in: editing on or off, change the password, log out. */
export function AccountModal({ open, name, until, canEdit, onUnlock, onLock, onChangePassword, onLogout, onClose }: AccountProps) {
    const { t } = useI18n();
    const toast = useToast();
    const day = new Date(until);
    const untilIso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;

    return (
        <Modal open={open} size="sm" title={t('acTitle')} onClose={onClose}>
            <div className="account-card">
                <span className="account-avatar">
                    <Icon name="user" size={22} />
                </span>
                <div>
                    <strong className="account-name">{name}</strong>
                    <p className="hint">{t('acLoggedIn', { date: longDate(untilIso) })}</p>
                </div>
            </div>
            <div className={`account-edit${canEdit ? ' is-on' : ''}`}>
                <span className="account-edit-icon" aria-hidden="true">
                    <Icon name={canEdit ? 'pencil' : 'lock'} size={18} />
                </span>
                <span className="account-edit-text">{canEdit ? t('acEditOn') : t('acEditOff')}</span>
                {canEdit ? (
                    <button
                        type="button"
                        className="btn btn-outline btn-sm account-lock"
                        onClick={() => {
                            onLock();
                            toast.show(t('loggedOut'), 'info', 'lock');
                        }}
                    >
                        {t('acLock')}
                    </button>
                ) : (
                    <button type="button" className="btn btn-primary btn-sm account-unlock" onClick={onUnlock}>
                        {t('acUnlock')}
                    </button>
                )}
            </div>
            <div className="account-actions">
                <button type="button" className="btn btn-outline account-change" onClick={onChangePassword}>
                    <Icon name="key" size={17} />
                    {t('acChange')}
                </button>
                <button type="button" className="btn btn-ghost account-logout" onClick={onLogout}>
                    <Icon name="logout" size={17} />
                    {t('acLogout')}
                </button>
            </div>
            <p className="hint account-note">{t('acNote', { name })}</p>
        </Modal>
    );
}
