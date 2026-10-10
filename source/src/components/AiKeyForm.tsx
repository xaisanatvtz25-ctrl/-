import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Icon } from './Icon';
import { useI18n } from '../lib/i18n';
import { PROVIDERS, asAiError, connectAi, detectProvider, getAiConfig, modelChoices, onAiChange, providerOf, setAiConfig } from '../lib/ai';
import type { AiConfig, AiError, ProviderId } from '../lib/ai';

/** The AI settings of this browser, updated when they change. */
export function useAiConfig(): AiConfig | null {
    const [cfg, setCfg] = useState<AiConfig | null>(getAiConfig);
    useEffect(() => onAiChange(() => setCfg(getAiConfig())), []);
    return cfg;
}

type Translate = ReturnType<typeof useI18n>['t'];

/** the name of a service as shown to the person */
export function aiName(t: Translate, id: ProviderId): string {
    return id === 'custom' ? t('aiCustom') : providerOf(id).name;
}

/** A short explanation of why the AI did not answer. */
export function aiProblem(t: Translate, err: AiError, name: string): string {
    switch (err.kind) {
        case 'auth':
            return t('aiErrAuth', { name, code: err.shown });
        case 'quota':
            return t('aiErrQuota', { name, code: err.shown });
        case 'network':
            return t('aiErrNetwork', { name });
        case 'timeout':
            return t('aiErrTimeout', { name });
        case 'model':
            return t('aiErrModel', { name, code: err.shown });
        case 'vision':
            return t('aiNoVision', { name });
        default:
            return t('aiErrOther', { name, code: err.shown });
    }
}

interface Props {
    /** after a key was checked and saved */
    onSaved?: (cfg: AiConfig) => void;
    autoFocus?: boolean;
    /** the key is for reading pictures: say when a service cannot */
    needVision?: boolean;
}

/** Choose an AI service, paste its key, check it; change the models; remove the key. */
export function AiKeyForm({ onSaved, autoFocus, needVision }: Props) {
    const { t } = useI18n();
    const cfg = useAiConfig();
    const [provider, setProvider] = useState<ProviderId>(cfg ? cfg.provider : 'gemini');
    const [byHand, setByHand] = useState(false);
    const [key, setKey] = useState('');
    const [baseUrl, setBaseUrl] = useState(cfg && cfg.baseUrl ? cfg.baseUrl : '');
    const [model, setModel] = useState(cfg && cfg.provider === 'custom' ? cfg.model : '');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
    const keyRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (autoFocus) {
            window.setTimeout(() => keyRef.current?.focus(), 60);
        }
    }, [autoFocus]);

    const p = providerOf(provider);
    const name = aiName(t, provider);

    const onKey = (value: string) => {
        setKey(value);
        setMsg(null);
        if (!byHand) {
            const found = detectProvider(value);
            if (found) {
                setProvider(found); // the service is known from the way the key starts
            }
        }
    };

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const k = key.trim();
        if (!k || busy) {
            return;
        }
        if (k.length < 8 || k.length > 400 || /\s/.test(k)) {
            setMsg({ tone: 'error', text: t('aiKeyInvalid') });
            return;
        }
        if (provider === 'custom' && (!/^https:\/\//i.test(baseUrl.trim()) || !model.trim())) {
            setMsg({ tone: 'error', text: t('aiCustomNeed') });
            return;
        }
        setBusy(true);
        setMsg(null);
        try {
            const res = await connectAi(provider, k, { baseUrl, model });
            if (!res.ok || !res.config) {
                setMsg({ tone: 'error', text: aiProblem(t, res.error || asAiError(new Error('?')), name) });
                return;
            }
            setAiConfig(res.config);
            setKey('');
            setMsg(
                res.warn
                    ? { tone: 'warn', text: t('aiKeySavedWarn', { why: aiProblem(t, res.warn, name) }) }
                    : { tone: 'ok', text: t('aiKeyOk', { name, model: res.config.model }) },
            );
            if (onSaved) {
                onSaved(res.config);
            }
        } catch (err) {
            setMsg({ tone: 'error', text: aiProblem(t, asAiError(err), name) });
        } finally {
            setBusy(false);
        }
    };

    const remove = () => {
        setAiConfig(null);
        setMsg({ tone: 'ok', text: t('aiKeyRemoved') });
    };

    const choices = cfg ? modelChoices(cfg) : [];
    const current = cfg ? providerOf(cfg.provider) : null;

    return (
        <form className="ai-key-form" onSubmit={submit}>
            {cfg && current && (
                <div className="ai-key-current">
                    <p className="ai-key-using">
                        <span className="ai-key-dot" aria-hidden="true" />
                        <span>
                            {t('aiUsing', { name: current.id === 'custom' ? cfg.baseUrl || aiName(t, 'custom') : current.name })}
                        </span>
                        <button type="button" className="link-btn ai-key-remove" onClick={remove} disabled={busy}>
                            <Icon name="trash" size={14} />
                            {t('aiKeyRemove')}
                        </button>
                    </p>
                    {choices.length > 0 && (
                        <div className="ai-models">
                            <label className="ai-model">
                                <span>{t('aiModelChat')}</span>
                                <span className="select-wrap">
                                    <select value={cfg.model} onChange={(e) => setAiConfig({ ...cfg, model: e.target.value })} data-ai="model-chat">
                                        {choices.map((m) => (
                                            <option key={m} value={m}>
                                                {m}
                                            </option>
                                        ))}
                                    </select>
                                    <Icon name="chevronDown" size={16} className="select-caret" />
                                </span>
                            </label>
                            <label className="ai-model">
                                <span>{t('aiModelVision')}</span>
                                <span className="select-wrap">
                                    <select
                                        value={cfg.visionModel || cfg.model}
                                        onChange={(e) => setAiConfig({ ...cfg, visionModel: e.target.value })}
                                        data-ai="model-vision"
                                    >
                                        {choices.map((m) => (
                                            <option key={m} value={m}>
                                                {m}
                                            </option>
                                        ))}
                                    </select>
                                    <Icon name="chevronDown" size={16} className="select-caret" />
                                </span>
                            </label>
                        </div>
                    )}
                    <p className="ai-key-hint">{t('aiChangeKey')}</p>
                </div>
            )}

            <label className="ai-provider">
                <span>{t('aiProvider')}</span>
                <span className="select-wrap">
                    <select
                        value={provider}
                        onChange={(e) => {
                            setProvider(e.target.value as ProviderId);
                            setByHand(true);
                            setMsg(null);
                        }}
                        data-ai="provider"
                    >
                        {PROVIDERS.map((x) => (
                            <option key={x.id} value={x.id}>
                                {x.id === 'custom' ? t('aiCustom') : x.id === 'openrouter' ? `${x.name} — ${t('aiAnyModel')}` : x.name}
                            </option>
                        ))}
                    </select>
                    <Icon name="chevronDown" size={16} className="select-caret" />
                </span>
            </label>

            {provider === 'custom' && (
                <div className="ai-custom">
                    <input
                        className="input"
                        type="url"
                        inputMode="url"
                        autoComplete="off"
                        spellCheck={false}
                        value={baseUrl}
                        placeholder="https://…/v1"
                        aria-label={t('aiCustomUrl')}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        data-ai="url"
                    />
                    <input
                        className="input"
                        autoComplete="off"
                        spellCheck={false}
                        value={model}
                        placeholder={t('aiCustomModel')}
                        aria-label={t('aiCustomModel')}
                        onChange={(e) => setModel(e.target.value)}
                        data-ai="custom-model"
                    />
                </div>
            )}

            <div className="ai-key-row">
                <input
                    ref={keyRef}
                    className="input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={key}
                    placeholder={p.keyHint ? `${t('aiKeyPlaceholder')} (${p.keyHint})` : t('aiKeyPlaceholder')}
                    aria-label={t('aiKeyPlaceholder')}
                    onChange={(e) => onKey(e.target.value)}
                    maxLength={400}
                    data-ai="key"
                />
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !key.trim()}>
                    {busy ? t('aiKeyTesting') : t('aiKeySave')}
                </button>
            </div>

            <p className="ai-key-hint">
                {p.keyUrl ? (
                    <>
                        {t('aiGetKey')}{' '}
                        <a href={p.keyUrl} target="_blank" rel="noopener noreferrer">
                            {p.keyUrl.replace(/^https:\/\//, '')}
                        </a>
                    </>
                ) : (
                    t('aiCustomHelp')
                )}
                {provider === 'openrouter' && <> · {t('aiOpenRouterNote')}</>}
                {needVision && !p.vision && (
                    <>
                        {' '}
                        · <strong>{t('aiNoVision', { name })}</strong>
                    </>
                )}
            </p>

            {msg && (
                <p className={`ai-key-msg is-${msg.tone}`} role="status">
                    {msg.text}
                </p>
            )}
            <p className="ai-key-privacy">
                <Icon name="lock" size={13} />
                {t('aiKeyPrivacy')}
            </p>
        </form>
    );
}
