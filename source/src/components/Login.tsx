import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Icon } from './Icon';
import { BrandLogo, LogoMark } from './Logo';
import { LangSwitch } from './LangSwitch';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { useI18n } from '../lib/i18n';
import type { Key } from '../lib/i18n';
import { errorCode } from '../lib/api';
import { passwordProblem } from '../lib/vaultCore';
import type { LogoutReason, Person } from '../lib/session';

/* ---------- pieces ---------- */

/** what went wrong, in words (login and passwords) */
function loginErrorText(t: (k: Key, v?: Record<string, string | number>) => string, e: unknown): string {
    const code = errorCode(e);
    const wait = code.match(/^(wrong_)?wait:(\d+)$/);
    if (wait) {
        return wait[1] ? `${t('lgWrong')} — ${t('lgWait', { s: wait[2] })}` : t('lgWait', { s: wait[2] });
    }
    const map: Record<string, Key> = {
        wrong_password: 'lgWrong',
        wrong_master: 'errWrongMaster',
        no_master: 'errNoMaster',
        no_access: 'lgNoSystem',
        bad_access: 'lgNoSystem',
        key_changed: 'errKeyChanged',
        cannot_open: 'errCannotOpen',
        not_encrypted: 'errCannotOpen',
        old_browser: 'errOldBrowser',
        bad_token: 'errNoMaster',
        no_write: 'errNoMaster',
        rate_limited: 'errRate',
        conflict: 'errBusy',
    };
    return t(map[code] || (code === 'network_error' || code === 'timeout' || /^http_/.test(code) ? 'lgLoadError' : 'errorGeneric'));
}

function PasswordInput({
    id,
    value,
    onChange,
    autoComplete,
    invalid,
    autoFocus,
}: {
    id: string;
    value: string;
    onChange: (v: string) => void;
    autoComplete: string;
    invalid?: boolean;
    autoFocus?: boolean;
}) {
    const { t } = useI18n();
    const [show, setShow] = useState(false);
    return (
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
            <button type="button" className="input-toggle" onClick={() => setShow((s) => !s)} aria-label={t('showPassword')} aria-pressed={show}>
                <Icon name={show ? 'eyeOff' : 'eye'} size={18} />
            </button>
        </div>
    );
}

function ErrorLine({ text }: { text: string }) {
    return (
        <div className="login-error" role="alert" aria-live="assertive">
            {text && (
                <>
                    <Icon name="alert" size={16} />
                    {text}
                </>
            )}
        </div>
    );
}

const PROBLEM_KEY: Record<string, Key> = { short: 'pwShort', weak: 'pwWeak', common: 'pwCommon', company: 'pwCompany', name: 'pwName' };

/** the new password and its repeat, checked with the same rules for everyone (null: fine) */
function newPasswordError(t: (k: Key) => string, next: string, again: string, name: string, code?: string): string | null {
    const problem = passwordProblem(next, { name, master: code });
    if (problem) {
        return t(PROBLEM_KEY[problem]);
    }
    if (next !== again) {
        return t('pwMismatch');
    }
    return null;
}

function Backdrop() {
    return (
        <div className="login-sky" aria-hidden="true">
            <span className="blob blob-1" />
            <span className="blob blob-2" />
            <span className="blob blob-3" />
        </div>
    );
}

/* ---------- screens ---------- */

export function SessionSplash() {
    return (
        <div className="login session-splash" aria-busy="true">
            <Backdrop />
            <div className="session-splash-mark">
                <LogoMark size={64} animated />
            </div>
        </div>
    );
}

interface LoginProps {
    people: Person[];
    loading: boolean;
    loadError: string | null;
    notice: LogoutReason | null;
    onRetry: () => void;
    onLogin: (userId: string, password: string) => Promise<void>;
}

/** Before anything else: choose your name (one of the six) and type your password. */
export function LoginScreen({ people, loading, loadError, notice, onRetry, onLogin }: LoginProps) {
    const { t } = useI18n();
    const [who, setWho] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [shake, setShake] = useState(false);
    const passRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (who) {
            window.setTimeout(() => passRef.current?.querySelector('input')?.focus(), 30);
        }
    }, [who]);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (busy) {
            return;
        }
        if (!who) {
            setError(t('lgPickName'));
            return;
        }
        if (!password.trim()) {
            setError(t('enterPassword'));
            return;
        }
        setBusy(true);
        setError('');
        try {
            await onLogin(who, password);
        } catch (err) {
            setError(loginErrorText(t, err));
            setPassword('');
            setShake(true);
            window.setTimeout(() => setShake(false), 500);
            setBusy(false);
        }
    };

    const noticeText = notice === 'changed' ? t('lgChanged') : notice === 'expired' ? t('lgExpired') : notice === 'removed' ? t('lgRemoved') : notice === 'manual' ? t('lgLoggedOut') : '';

    return (
        <div className="login">
            <Backdrop />
            <div className="login-top">
                <LangSwitch />
            </div>
            <div className="login-grid">
                <div className="login-brand">
                    <div className="login-logo">
                        <BrandLogo size={220} />
                    </div>
                    <h1 className="login-company">
                        <span>{t('company')}</span>
                        <small>{t('system')}</small>
                    </h1>
                    <ul className="login-features">
                        <li>
                            <Icon name="lock" size={18} />
                            {t('lgFeat1')}
                        </li>
                        <li>
                            <Icon name="user" size={18} />
                            {t('lgFeat2')}
                        </li>
                        <li>
                            <Icon name="history" size={18} />
                            {t('lgFeat3')}
                        </li>
                    </ul>
                </div>
                <div className="login-card-wrap">
                    <form className={`login-card${shake ? ' is-shaking' : ''}`} onSubmit={submit} noValidate>
                        <div className="login-card-mark">
                            <LogoMark size={40} />
                        </div>
                        <h2 className="login-title">{t('lgTitle')}</h2>
                        <p className="login-hint">{t('lgSub')}</p>
                        {noticeText && (
                            <p className="login-notice" role="status">
                                <Icon name="alert" size={16} />
                                {noticeText}
                            </p>
                        )}
                        {loading ? (
                            <p className="login-wait">
                                <span className="spinner spinner-dark" aria-hidden="true" />
                                {t('lgLoading')}
                            </p>
                        ) : loadError ? (
                            <div className="login-load-error">
                                <ErrorLine text={loadError === 'no_access' || loadError === 'bad_access' ? t('lgNoSystem') : t('lgLoadError')} />
                                <button type="button" className="btn btn-outline" onClick={onRetry}>
                                    <Icon name="refresh" size={17} />
                                    {t('retry')}
                                </button>
                            </div>
                        ) : (
                            <>
                                <fieldset className="login-people">
                                    <legend>{t('lgWho')}</legend>
                                    <div className="login-people-grid" role="radiogroup" aria-label={t('lgWho')}>
                                        {people.map((p) => (
                                            <button
                                                key={p.id}
                                                type="button"
                                                role="radio"
                                                aria-checked={who === p.id}
                                                className={`login-person${who === p.id ? ' is-active' : ''}`}
                                                data-user={p.id}
                                                onClick={() => {
                                                    setWho(p.id);
                                                    setError('');
                                                }}
                                            >
                                                <span className="login-person-avatar" aria-hidden="true">
                                                    <Icon name="user" size={17} />
                                                </span>
                                                <span className="login-person-name">{p.name}</span>
                                                {who === p.id && <Icon name="check" size={16} className="login-person-check" />}
                                            </button>
                                        ))}
                                    </div>
                                </fieldset>
                                <div className="field" ref={passRef}>
                                    <label htmlFor="login-pass">{t('password')}</label>
                                    <PasswordInput id="login-pass" value={password} onChange={setPassword} autoComplete="current-password" invalid={Boolean(error)} />
                                </div>
                                <ErrorLine text={error} />
                                <button type="submit" className="btn btn-primary btn-block login-submit" disabled={busy}>
                                    {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="lock" size={17} />}
                                    {busy ? t('lgChecking') : t('lgEnter')}
                                </button>
                                <p className="login-forgot">{t('lgForgot')}</p>
                            </>
                        )}
                        <p className="login-secure">
                            <Icon name="lock" size={14} />
                            {t('lgSecure')}
                        </p>
                    </form>
                </div>
            </div>
        </div>
    );
}

interface FirstProps {
    name: string;
    onSave: (next: string) => Promise<void>;
    onSkip: () => void;
    onLogout: () => void;
}

/** First login with the starting password: each person sets their own (nobody else can then log in as them). */
export function FirstPassword({ name, onSave, onSkip, onLogout }: FirstProps) {
    const { t } = useI18n();
    const toast = useToast();
    const [next, setNext] = useState('');
    const [again, setAgain] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [canSkip, setCanSkip] = useState(false);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (busy) {
            return;
        }
        const problem = newPasswordError(t, next, again, name);
        if (problem) {
            setError(problem);
            return;
        }
        setBusy(true);
        setError('');
        try {
            await onSave(next);
            toast.show(t('pwSaved'), 'success', 'unlock');
        } catch (err) {
            setError(loginErrorText(t, err));
            // saving is not possible right now (not connected, offline…): the person may go on and set it later
            setCanSkip(!['wrong_password'].includes(errorCode(err)));
            setBusy(false);
        }
    };

    return (
        <div className="login">
            <Backdrop />
            <div className="login-top">
                <LangSwitch />
            </div>
            <div className="login-grid login-grid-one">
                <div className="login-card-wrap">
                    <form className="login-card first-password" onSubmit={submit} noValidate>
                        <div className="login-card-mark">
                            <Icon name="key" size={30} />
                        </div>
                        <h2 className="login-title">{t('fpTitle')}</h2>
                        <p className="login-hint">{t('fpText', { name })}</p>
                        <div className="field">
                            <label htmlFor="fp-new">{t('pwNew')}</label>
                            <PasswordInput id="fp-new" value={next} onChange={setNext} autoComplete="new-password" autoFocus />
                        </div>
                        <div className="field">
                            <label htmlFor="fp-again">{t('pwAgain')}</label>
                            <PasswordInput id="fp-again" value={again} onChange={setAgain} autoComplete="new-password" />
                        </div>
                        <p className="hint pw-rules">{t('pwRules')}</p>
                        <ErrorLine text={error} />
                        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
                            {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="check" size={17} />}
                            {busy ? t('pwSaving') : t('pwSave')}
                        </button>
                        <div className="first-password-foot">
                            {canSkip && (
                                <button type="button" className="link-btn fp-skip" onClick={onSkip}>
                                    {t('pwSkip')}
                                </button>
                            )}
                            <button type="button" className="link-btn fp-logout" onClick={onLogout}>
                                <Icon name="logout" size={15} />
                                {t('acLogout')}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}

interface ChangeProps {
    open: boolean;
    me: string;
    people: Person[];
    onSave: (targetId: string, companyCode: string, next: string) => Promise<void>;
    onClose: () => void;
}

/** In the menu: set one's own password, or a new one for someone who forgot theirs. Always with the company code. */
export function ChangePasswordModal({ open, me, people, onSave, onClose }: ChangeProps) {
    const { t } = useI18n();
    const toast = useToast();
    const [target, setTarget] = useState(me);
    const [code, setCode] = useState('');
    const [next, setNext] = useState('');
    const [again, setAgain] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (open) {
            setTarget(me);
            setCode('');
            setNext('');
            setAgain('');
            setBusy(false);
            setError('');
        }
    }, [open, me]);

    const person = people.find((p) => p.id === target);
    const forOther = target !== me;

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (busy) {
            return;
        }
        if (!code.trim()) {
            setError(t('cpNeedCode'));
            return;
        }
        const problem = newPasswordError(t, next, again, person ? person.name : '', code);
        if (problem) {
            setError(problem);
            return;
        }
        setBusy(true);
        setError('');
        try {
            await onSave(target, code, next);
            toast.show(forOther ? t('pwSavedFor', { name: person ? person.name : '' }) : t('pwSaved'), 'success', 'unlock');
            onClose();
        } catch (err) {
            setError(loginErrorText(t, err));
            setBusy(false);
        }
    };

    return (
        <Modal
            open={open}
            size="sm"
            title={t('cpTitle')}
            onClose={busy ? () => undefined : onClose}
            footer={
                <>
                    <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
                        {t('cancel')}
                    </button>
                    <button type="submit" form="cp-form" className="btn btn-primary" disabled={busy}>
                        {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="check" size={17} />}
                        {busy ? t('pwSaving') : t('pwSave')}
                    </button>
                </>
            }
        >
            <form id="cp-form" className="form change-password" onSubmit={submit} noValidate>
                <div className="field">
                    <label htmlFor="cp-who">{t('cpWho')}</label>
                    <div className="select-wrap">
                        <select id="cp-who" value={target} onChange={(e) => setTarget(e.target.value)}>
                            {people.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.id === me ? t('cpMe', { name: p.name }) : t('cpOther', { name: p.name })}
                                    {p.initial ? t('cpInitial') : ''}
                                </option>
                            ))}
                        </select>
                        <Icon name="chevronDown" size={18} className="select-caret" />
                    </div>
                    <p className={`hint${forOther ? ' cp-warn' : ''}`}>{forOther ? t('cpOtherNote', { name: person ? person.name : '' }) : t('cpSelfNote')}</p>
                </div>
                <div className="field">
                    <label htmlFor="cp-code">{t('cpCode')}</label>
                    <PasswordInput id="cp-code" value={code} onChange={setCode} autoComplete="off" autoFocus />
                    <p className="hint">{t('cpCodeHint')}</p>
                </div>
                <div className="field">
                    <label htmlFor="cp-new">{t('pwNew')}</label>
                    <PasswordInput id="cp-new" value={next} onChange={setNext} autoComplete="new-password" />
                </div>
                <div className="field">
                    <label htmlFor="cp-again">{t('pwAgain')}</label>
                    <PasswordInput id="cp-again" value={again} onChange={setAgain} autoComplete="new-password" />
                </div>
                <p className="hint pw-rules">{t('pwRules')}</p>
                <ErrorLine text={error} />
            </form>
        </Modal>
    );
}
