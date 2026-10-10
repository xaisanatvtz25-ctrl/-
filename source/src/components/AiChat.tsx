import { Fragment, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Icon } from './Icon';
import { LogoMark } from './Logo';
import { useI18n } from '../lib/i18n';
import { useStore } from '../lib/store';
import { useToast } from './Toast';
import { errorCode } from '../lib/api';
import { apiErrorKey } from './EditAccess';
import { buildSystemPrompt, detectLang, fallbackAnswer } from '../lib/answers';
import { asAiError, askAi, getAiConfig, providerOf } from '../lib/ai';
import { AiKeyForm, aiName, aiProblem, useAiConfig } from './AiKeyForm';
import { fmt, longDate, todayIso } from '../lib/format';
import { onAiRequest } from '../lib/aiEvents';
import { useEditor } from '../lib/editor';
import { cachedStock, getStock } from '../lib/stockStore';
import type { StockDoc } from '../lib/stockStore';
import { getDraft, newDraftId, setDraft } from '../lib/stockDraft';
import type { StockDraft } from '../lib/stockDraft';
import { MIN_FOUND, analysisLines, currentAnalysis, draftAnalysis, readLocalAliases, readStockText } from '../lib/stockFlow';
import type { StockSummary } from '../lib/stockFlow';
import type { SheetRead } from '../lib/stockSheet';
import { parseStockText, stockTemplate } from '../lib/stockText';
import type { AiAction } from '../lib/types';
import '../styles/chat-extra.css';

interface ChatMessage {
    id: number;
    role: 'user' | 'assistant';
    content: string;
    action?: AiAction | null;
    actionState?: 'pending' | 'busy' | 'done' | 'cancelled';
    error?: boolean;
    errorCode?: string;
    fallback?: boolean;
    fallbackReason?: string;
    /** why the AI did not answer (shown under the answer from the data) */
    fallbackText?: string;
    /** the person wrote their stock (shown as written, line by line) */
    typed?: boolean;
    /** still working: the text says what is happening */
    progress?: boolean;
    /** the analysis of the stock that was written */
    stock?: StockSummary;
    /** reading this text needs an AI key */
    needKey?: boolean;
}

/** longest text in the box (two stocks of 25 products fit easily) */
const INPUT_MAX = 6000;

/** phones and tablets: Enter makes a new line (the stock is written line by line); the button sends */
const touchKeyboard = () => typeof window !== 'undefined' && Boolean(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

let msgSeq = 0;
const nextId = () => {
    msgSeq += 1;
    return msgSeq;
};

/** Tiny, safe markdown: **bold**, bullet and numbered lists, paragraphs. */
function renderInline(text: string): ReactNode[] {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') && p.length > 4 ? <strong key={i}>{p.slice(2, -2)}</strong> : <Fragment key={i}>{p}</Fragment>,
    );
}

function RichText({ text }: { text: string }) {
    const lines = text.replace(/\r/g, '').split('\n');
    const blocks: ReactNode[] = [];
    let list: { ordered: boolean; items: string[] } | null = null;
    const flush = () => {
        if (list) {
            const items = list.items.map((it, i) => <li key={i}>{renderInline(it)}</li>);
            blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
            list = null;
        }
    };
    for (const raw of lines) {
        const line = raw.trimEnd();
        const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
        const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (bullet || numbered) {
            const ordered = Boolean(numbered && !bullet);
            if (!list || list.ordered !== ordered) {
                flush();
                list = { ordered, items: [] };
            }
            list.items.push((bullet ? bullet[1] : numbered ? numbered[1] : '').replace(/^#+\s*/, ''));
            continue;
        }
        flush();
        if (line.trim()) {
            blocks.push(<p key={blocks.length}>{renderInline(line.replace(/^#+\s*/, ''))}</p>);
        }
    }
    flush();
    return <div className="rich">{blocks}</div>;
}

interface Props {
    open: boolean;
    onClose: () => void;
}

export function AiChat({ open, onClose }: Props) {
    const { t, lang, suggestions } = useI18n();
    const { addEntry, addProduct, products, months, plan } = useStore();
    const { token } = useEditor();
    const toast = useToast();
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const aiCfg = useAiConfig();
    const [keyOpen, setKeyOpen] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    // the box grows with what is written (up to about half the screen)
    useEffect(() => {
        const el = inputRef.current;
        if (el) {
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.45))}px`;
        }
    }, [input, open]);

    useEffect(() => {
        if (open) {
            window.setTimeout(() => inputRef.current?.focus(), 260);
        }
    }, [open]);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !document.querySelector('.modal-root')) {
                onClose();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    useEffect(() => {
        const el = listRef.current;
        if (el) {
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        }
    }, [messages, busy]);

    const ask = async (history: ChatMessage[]) => {
        setBusy(true);
        try {
            const payload = history
                .filter((m) => !m.error && !m.progress && m.content)
                .map((m) => ({ role: m.role, content: m.content }))
                .slice(-12);
            while (payload.length && payload[0].role !== 'user') {
                payload.shift();
            }
            const question = payload.length ? payload[payload.length - 1].content : '';
            const cfg = getAiConfig();
            let reply = '';
            let fallback = false;
            let reason = '';
            let why = '';
            if (cfg) {
                try {
                    let stockLines: string[] = [];
                    try {
                        const doc = await getStock(token || undefined);
                        const a = currentAnalysis(products, getDraft(), doc, months, todayIso(), { ...doc.aliases, ...readLocalAliases() });
                        stockLines = a ? analysisLines(products, a) : [];
                    } catch {
                        stockLines = [];
                    }
                    reply = await askAi(cfg, buildSystemPrompt(products, months, plan, stockLines), payload);
                } catch (err) {
                    const e = asAiError(err);
                    fallback = true;
                    reason = e.kind;
                    why = aiProblem(t, e, aiName(t, cfg.provider));
                }
            } else {
                fallback = true;
                reason = 'no_key';
                await new Promise((r) => window.setTimeout(r, 380));
            }
            if (fallback) {
                let picks: Array<{ name: string; qty: number; cover: number }> = [];
                try {
                    const doc = cachedStock() || (await getStock(token || undefined));
                    const a = currentAnalysis(products, getDraft(), doc, months, todayIso(), { ...doc.aliases, ...readLocalAliases() });
                    picks = a ? a.view.filter((v) => v.suggest > 0).slice(0, 4).map((v) => ({ name: nameOfId(v.productId), qty: v.suggest, cover: v.cover })) : [];
                } catch {
                    picks = [];
                }
                reply = fallbackAnswer(question, detectLang(question, lang), products, months, plan, picks);
            }
            setMessages((prev) => [
                ...prev,
                { id: nextId(), role: 'assistant', content: reply || '…', action: null, fallback, fallbackReason: reason, fallbackText: why },
            ]);
        } catch (e) {
            setMessages((prev) => [
                ...prev,
                { id: nextId(), role: 'assistant', content: t('aiError'), error: true, errorCode: errorCode(e).slice(0, 48) },
            ]);
        } finally {
            setBusy(false);
        }
    };

    const send = async (text: string) => {
        const content = text.trim();
        if (!content || busy) {
            return;
        }
        if (maybeStock(content)) {
            await analyzeText(content);
            return;
        }
        const history = [...messages, { id: nextId(), role: 'user' as const, content }];
        setMessages(history);
        setInput('');
        await ask(history);
    };

    /** a text that may be the stock (names with numbers, line by line) */
    const maybeStock = (content: string): boolean => {
        const doc = cachedStock();
        const quick = parseStockText(content, products, { ...(doc ? doc.aliases : {}), ...readLocalAliases() }, todayIso());
        const lines = content.split('\n').filter((l) => l.trim()).length;
        return quick.found >= MIN_FOUND || (quick.numbers >= MIN_FOUND && lines >= MIN_FOUND);
    };

    /* ---------- the stock written in the chat ---------- */

    const analyzeText = async (text: string) => {
        const progressId = nextId();
        const userMsg: ChatMessage = { id: nextId(), role: 'user', content: text, typed: true };
        setMessages((prev) => [...prev, userMsg, { id: progressId, role: 'assistant', content: t('aiReadingStock'), progress: true }]);
        setInput('');
        setBusy(true);
        const update = (content: string) => setMessages((prev) => prev.map((m) => (m.id === progressId ? { ...m, content } : m)));
        const finish = (msg: Partial<ChatMessage>) =>
            setMessages((prev) => prev.map((m) => (m.id === progressId ? { id: progressId, role: 'assistant', content: '', ...msg, progress: false } : m)));
        let answered = false;
        try {
            const cfg = getAiConfig();
            const today = todayIso();
            let doc: StockDoc | null = null;
            try {
                doc = await getStock(token || undefined);
            } catch {
                doc = cachedStock();
            }
            const aliases = { ...(doc ? doc.aliases : {}), ...readLocalAliases() };
            const read = await readStockText(text, products, aliases, cfg, today);
            if (!read.sheets.length) {
                if (read.needKey) {
                    finish({ content: t('aiStockNeedKey'), needKey: true });
                    answered = true;
                    return;
                }
                if (read.error) {
                    finish({ content: `${t('aiStockNotRead')} (${aiProblem(t, read.error, cfg ? aiName(t, cfg.provider) : 'AI')})` });
                    answered = true;
                    return;
                }
                // not a stock after all: answered as a question
                setMessages((prev) => prev.filter((m) => m.id !== progressId));
                return;
            }
            const stamp = new Date();
            const label = `${t('aiStockLabel')} ${String(stamp.getDate()).padStart(2, '0')}/${String(stamp.getMonth() + 1).padStart(2, '0')} ${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`;
            const sheets: SheetRead[] = read.sheets.map((sh) => ({ ...sh, fileName: label }));
            // which stock is the earlier one: by the dates written (an undated one is today's)
            let prev: SheetRead | 'saved' | null = null;
            let curr = sheets[sheets.length - 1];
            if (sheets.length >= 2) {
                prev = sheets[sheets.length - 2];
            } else {
                const waiting = getDraft();
                if (waiting && waiting.prev === null && waiting.curr.date && curr.date && waiting.curr.date !== curr.date) {
                    // the other stock was sent a moment ago
                    [prev, curr] = waiting.curr.date < curr.date ? [waiting.curr, curr] : [curr, waiting.curr];
                } else if (doc && doc.weeks.some((w) => !curr.date || w.currDate < curr.date)) {
                    prev = 'saved';
                }
            }
            const draft: StockDraft = { id: newDraftId(), at: Date.now(), prev, curr, source: read.via === 'ai' ? 'ai' : 'text' };
            setDraft(draft);
            const { summary, results, view } = draftAnalysis(products, draft, doc, months, today, aliases);
            let narrative = '';
            if (cfg && summary.ready) {
                update(t('aiAnalyzing'));
                try {
                    const language = detectLang(text, lang) === 'th' ? 'Thai' : detectLang(text, lang) === 'en' ? 'English' : 'Lao';
                    const facts = analysisLines(products, { results, view, from: summary.prevDate, to: summary.currDate, days: summary.days });
                    const names = new Map(products.map((p) => [p.id, p.name]));
                    facts.push(
                        'Recommended now (in this order): ' +
                            summary.picks.map((v, i) => `${i + 1}. ${names.get(v.productId)} ${v.suggest}`).join('; '),
                    );
                    narrative = await askAi(
                        cfg,
                        [
                            'You are the production assistant of Milako, a Lao producer of chili pastes, seasoning powders and pepper.',
                            `Write in ${language}. Product names exactly as given.`,
                            'From the stock analysis below (already computed: never change or invent numbers), write a short analysis for the production team:',
                            '1) which products are running low (fewest days of stock left from today),',
                            '2) which sell best and go out fastest,',
                            '3) the 4 productions recommended now, in order, with their quantities,',
                            'then one sentence of practical advice. Use short bullet lists, at most 130 words, no table.',
                        ].join('\n'),
                        [{ role: 'user', content: facts.join('\n') }],
                        { maxTokens: 900, temperature: 0.2, timeout: 60_000 },
                    );
                } catch {
                    narrative = ''; // the card below has the numbers
                }
            }
            const headline = summary.ready
                ? t('aiStockHeadline', { from: longDate(summary.prevDate), to: longDate(summary.currDate), days: summary.days })
                : summary.prevFrom === 'none'
                  ? t('aiStockNeedPrev')
                  : t('aiStockDates');
            const notes = [
                ...(read.twice.length ? [t('aiStockTwice', { names: read.twice.join(', ') })] : []),
                ...(read.via === 'ai' ? [t('aiStockByAi')] : []),
                ...(!curr.dateText ? [t('aiStockNoDate', { date: longDate(curr.date) })] : []),
            ];
            finish({ content: [narrative || headline, ...notes].join('\n'), stock: summary });
            answered = true;
        } catch (e) {
            finish({ content: t('aiError'), error: true, errorCode: errorCode(e).slice(0, 48) });
            answered = true;
        } finally {
            setBusy(false);
            if (!answered) {
                // not a stock: the assistant answers the text as a question
                void ask([...messages, { ...userMsg, typed: false }]);
            }
        }
    };

    /** the form with every product, put in the box to be filled in */
    const fillTemplate = () => {
        const text = stockTemplate(products, todayIso(), lang === 'th' ? 'th' : 'lo');
        setInput(text);
        window.setTimeout(() => {
            const el = inputRef.current;
            if (el) {
                el.focus();
                const firstLineEnd = text.indexOf('\n', text.indexOf('\n') + 1);
                const at = firstLineEnd > 0 ? firstLineEnd : text.length;
                el.setSelectionRange(at, at);
                el.scrollTop = 0; // the date and the first products in view, the cursor after the first name
            }
        }, 80);
    };

    // the page "ວັນນີ້ຄວນຜະລິດຫຍັງດີ" opens the assistant with the form
    const templateRef = useRef(fillTemplate);
    templateRef.current = fillTemplate;
    useEffect(
        () =>
            onAiRequest((req) => {
                if (req.template) {
                    templateRef.current();
                }
            }),
        [],
    );
    const openStockPage = () => {
        onClose();
        window.location.hash = '#/weekly';
    };

    const retry = (id: number) => {
        if (busy) {
            return;
        }
        const history = messages.filter((m) => m.id !== id);
        setMessages(history);
        void ask(history);
    };

    const onSubmit = (e: FormEvent) => {
        e.preventDefault();
        void send(input);
    };

    const setActionState = (id: number, state: ChatMessage['actionState']) => {
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, actionState: state } : m)));
    };

    const confirmAction = async (msg: ChatMessage) => {
        const a = msg.action;
        if (!a) {
            return;
        }
        setActionState(msg.id, 'busy');
        try {
            if (a.type === 'add_production' && a.productId && a.qty) {
                await addEntry({
                    productId: a.productId,
                    qty: a.qty,
                    date: a.date || '',
                    month: a.month || (a.date || '').slice(0, 7),
                    note: a.note || '',
                });
            } else if (a.type === 'add_product' && a.name) {
                await addProduct(a.name);
            }
            setActionState(msg.id, 'done');
            toast.show(t('saved'));
        } catch (e) {
            setActionState(msg.id, 'pending');
            toast.show(errorCode(e) === 'duplicate_name' ? t('duplicate') : t(apiErrorKey(e)), 'error');
        }
    };

    const openKeyPanel = () => setKeyOpen((v) => !v);

    const showSuggestions = messages.length === 0;
    const nameOfId = (id: string) => products.find((p) => p.id === id)?.name || id;
    const rate = (n: number) => (n >= 10 ? fmt(n) : n.toLocaleString('en-US', { maximumFractionDigits: 1 }));
    const working = messages.some((m) => m.progress);

    const stockList = (title: string, rows: Array<[string, string]>, tone = '') => (
        <div className={`ai-stock-list ${tone}`}>
            <h4>{title}</h4>
            <ol>
                {rows.map(([name, value], i) => (
                    <li key={i}>
                        <span className="ai-stock-name">{name}</span>
                        <span className="ai-stock-value num">{value}</span>
                    </li>
                ))}
            </ol>
        </div>
    );

    const stockCard = (s: StockSummary) => (
        <div className="ai-stock">
            <div className="ai-stock-dates">
                <Icon name="file" size={15} />
                <span className="num">
                    {s.prevDate ? longDate(s.prevDate) : '?'} → {s.currDate ? longDate(s.currDate) : '?'}
                </span>
                {s.days > 0 && <span className="ai-stock-days">{t('wkDaysBetween', { n: s.days })}</span>}
            </div>
            <p className="ai-stock-found">
                {t('aiStockFound', { n: s.foundCurr, total: s.total })}
                {s.prevFrom === 'saved' ? ` · ${t('aiStockPrevSaved')}` : ''}
            </p>
            {s.asks + s.flagged > 0 && (
                <p className="ai-stock-warn">
                    <Icon name="alert" size={15} />
                    {t('aiStockCheck', { n: s.asks + s.flagged })}
                </p>
            )}
            {s.ready && (
                <>
                    <div className="ai-stock-kpis">
                        <span className="is-urgent">
                            {t('wkGroup_urgent')} <b className="num">{s.counts.urgent}</b>
                        </span>
                        <span className="is-next">
                            {t('wkGroup_next')} <b className="num">{s.counts.next}</b>
                        </span>
                        <span className="is-later">
                            {t('wkGroup_later')} <b className="num">{s.counts.later}</b>
                        </span>
                    </div>
                    {s.low.length > 0 && stockList(t('wkLowTitle'), s.low.map((v) => [nameOfId(v.productId), t('wkDaysN', { n: rate(v.cover) })]), 'is-low')}
                    {s.top.length > 0 && stockList(t('wkTop5'), s.top.map((v) => [nameOfId(v.productId), t('wkPerDayN', { n: rate(v.daily) })]), 'is-top')}
                    {s.picks.length > 0 && stockList(t('aiStockPicks', { n: s.picks.length }), s.picks.map((v) => [nameOfId(v.productId), fmt(v.suggest)]), 'is-picks')}
                </>
            )}
            <button type="button" className="btn btn-primary btn-sm ai-stock-open" onClick={openStockPage}>
                {s.asks + s.flagged > 0 ? t('aiStockOpenCheck') : t('aiStockOpen')}
                <Icon name="arrowRight" size={16} />
            </button>
        </div>
    );

    return (
        <>
            <div className={`ai-scrim${open ? ' is-open' : ''}`} onClick={onClose} aria-hidden="true" />
            <aside className={`ai-panel${open ? ' is-open' : ''}`} aria-label={t('aiTitle')} aria-hidden={!open} inert={!open ? true : undefined}>
                <header className="ai-head">
                    <div className="ai-avatar">
                        <Icon name="sparkles" size={20} />
                    </div>
                    <div className="ai-head-text">
                        <h2>
                            {t('aiTitle')}
                            {aiCfg && <span className="ai-engine">{providerOf(aiCfg.provider).short}</span>}
                        </h2>
                        <p>{t('aiSub')}</p>
                    </div>
                    <button
                        type="button"
                        className={`icon-btn${keyOpen ? ' is-active' : ''}`}
                        onClick={openKeyPanel}
                        aria-label={t('aiKeyTitle')}
                        title={t('aiKeyTitle')}
                        aria-expanded={keyOpen}
                    >
                        <Icon name="key" size={18} />
                    </button>
                    {messages.length > 0 && (
                        <button type="button" className="icon-btn" onClick={() => setMessages([])} aria-label={t('aiClear')} title={t('aiClear')}>
                            <Icon name="refresh" size={18} />
                        </button>
                    )}
                    <button type="button" className="icon-btn" onClick={onClose} aria-label={t('close')}>
                        <Icon name="x" />
                    </button>
                </header>

                {keyOpen && (
                    <div className="ai-key-panel">
                        <div className="ai-key-title">
                            <Icon name="key" size={16} />
                            {t('aiKeyTitle')}
                        </div>
                        <p className="ai-key-hint">{t('aiKeyHintAny')}</p>
                        <AiKeyForm autoFocus onSaved={() => window.setTimeout(() => setKeyOpen(false), 2200)} />
                    </div>
                )}

                <div className="ai-list" ref={listRef}>
                    {!aiCfg && !keyOpen && (
                        <div className="ai-key-notice">
                            <Icon name="key" size={18} />
                            <p>{t('aiKeyMissing')}</p>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={openKeyPanel}>
                                {t('aiKeySetup')}
                            </button>
                        </div>
                    )}
                    <div className="msg msg-assistant msg-welcome">
                        <div className="msg-avatar">
                            <LogoMark size={28} />
                        </div>
                        <div className="bubble">
                            <p>{t('aiWelcome')}</p>
                        </div>
                    </div>
                    {showSuggestions && (
                        <div className="ai-suggest">
                            <button type="button" className="chip chip-stock" onClick={fillTemplate}>
                                <Icon name="clipboard" size={15} />
                                {t('aiStockChip')}
                            </button>
                            {suggestions.map((s, i) => (
                                <button key={s} type="button" className="chip" style={{ animationDelay: `${120 + i * 70}ms` }} onClick={() => void send(s)}>
                                    {s}
                                </button>
                            ))}
                        </div>
                    )}
                    {messages.map((m) => (
                        <div key={m.id} className={`msg msg-${m.role}${m.error ? ' msg-error' : ''}${m.progress ? ' msg-progress' : ''}${m.stock ? ' msg-stock' : ''}`}>
                            {m.role === 'assistant' && (
                                <div className="msg-avatar">
                                    <LogoMark size={28} />
                                </div>
                            )}
                            <div className="bubble">
                                {m.progress ? (
                                    <p className="ai-progress">
                                        <span className="spinner spinner-dark" aria-hidden="true" />
                                        {m.content}
                                    </p>
                                ) : m.role === 'assistant' ? (
                                    <RichText text={m.content} />
                                ) : (
                                    <p className={m.typed ? 'msg-typed' : undefined}>{m.content}</p>
                                )}
                                {m.stock && stockCard(m.stock)}
                                {m.needKey && !aiCfg && (
                                    <button type="button" className="btn btn-ghost btn-sm ai-need-key" onClick={() => setKeyOpen(true)}>
                                        <Icon name="key" size={15} />
                                        {t('aiKeySetup')}
                                    </button>
                                )}
                                {m.fallback && (
                                    <p className="fallback-note">
                                        {m.fallbackReason === 'no_key' ? t('aiFallbackNoKey') : `${m.fallbackText || t('aiFallbackNote')} — ${t('aiFallbackFromData')}`}
                                        {(m.fallbackReason === 'auth' || m.fallbackReason === 'model' || m.fallbackReason === 'quota') && (
                                            <button type="button" className="link-btn fallback-fix" onClick={() => setKeyOpen(true)}>
                                                {t('aiCheckKey')}
                                            </button>
                                        )}
                                    </p>
                                )}
                                {m.error && (
                                    <div className="err-row">
                                        {m.errorCode && <span className="err-code">{m.errorCode}</span>}
                                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => retry(m.id)} disabled={busy}>
                                            <Icon name="refresh" size={14} />
                                            {t('retry')}
                                        </button>
                                    </div>
                                )}
                                {m.action && (
                                    <div className={`action-card is-${m.actionState}`}>
                                        {m.action.type === 'add_production' ? (
                                            <dl>
                                                <div>
                                                    <dt>{t('product')}</dt>
                                                    <dd>{m.action.productName}</dd>
                                                </div>
                                                <div>
                                                    <dt>{t('quantity')}</dt>
                                                    <dd className="num">{fmt(m.action.qty || 0)}</dd>
                                                </div>
                                                <div>
                                                    <dt>{t('date')}</dt>
                                                    <dd>{longDate(m.action.date || '')}</dd>
                                                </div>
                                                {m.action.note && (
                                                    <div>
                                                        <dt>{t('note')}</dt>
                                                        <dd>{m.action.note}</dd>
                                                    </div>
                                                )}
                                            </dl>
                                        ) : (
                                            <dl>
                                                <div>
                                                    <dt>{t('productName')}</dt>
                                                    <dd>{m.action.name}</dd>
                                                </div>
                                            </dl>
                                        )}
                                        {m.actionState === 'done' && <div className="action-status ok">{t('aiDone')}</div>}
                                        {m.actionState === 'cancelled' && <div className="action-status">{t('aiCancelled')}</div>}
                                        {(m.actionState === 'pending' || m.actionState === 'busy') && (
                                            <div className="action-btns">
                                                <button type="button" className="btn btn-ghost btn-sm" disabled={m.actionState === 'busy'} onClick={() => setActionState(m.id, 'cancelled')}>
                                                    {t('cancel')}
                                                </button>
                                                <button type="button" className="btn btn-primary btn-sm" disabled={m.actionState === 'busy'} onClick={() => void confirmAction(m)}>
                                                    <Icon name="check" size={16} />
                                                    {m.actionState === 'busy'
                                                        ? t('saving')
                                                        : m.action.type === 'add_product'
                                                          ? t('aiConfirmProductBtn')
                                                          : t('aiConfirm')}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                    {busy && !working && (
                        <div className="msg msg-assistant">
                            <div className="msg-avatar">
                                <LogoMark size={28} />
                            </div>
                            <div className="bubble bubble-typing" aria-label={t('aiThinking')}>
                                <span />
                                <span />
                                <span />
                            </div>
                        </div>
                    )}
                </div>

                <form className="ai-input" onSubmit={onSubmit}>
                    <button type="button" className="ai-template" onClick={fillTemplate} disabled={busy} aria-label={t('aiStockChip')} title={t('aiStockChip')}>
                        <Icon name="clipboard" size={19} />
                    </button>
                    <textarea
                        ref={inputRef}
                        rows={1}
                        value={input}
                        placeholder={t('aiPlaceholder')}
                        aria-label={t('aiPlaceholder')}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !touchKeyboard()) {
                                e.preventDefault();
                                void send(input);
                            }
                        }}
                        maxLength={INPUT_MAX}
                    />
                    <button type="submit" className="send-btn" disabled={busy || !input.trim()} aria-label={t('aiSend')}>
                        <Icon name="send" size={18} />
                    </button>
                </form>
            </aside>
        </>
    );
}
