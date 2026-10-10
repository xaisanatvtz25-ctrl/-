import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { PageHeader } from '../components/Bits';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { apiErrorKey } from '../components/EditAccess';
import { useToast } from '../components/Toast';
import type { EntryModalState } from '../components/EntryModal';
import { diffText } from './Stock';
import { useEditor } from '../lib/editor';
import { useI18n } from '../lib/i18n';
import type { Key } from '../lib/i18n';
import { useStore } from '../lib/store';
import { CHAT_TEXT_MAX } from '../lib/source';
import { findRun, latestAt, latestFlags, openIssues, samePerson } from '../lib/chat';
import type { FoundRun } from '../lib/chat';
import { fmt, longDate, shortDate } from '../lib/format';
import { play } from '../lib/sound';
import type { ChatMsg, ChatRef } from '../lib/types';

type T = (key: Key, vars?: Record<string, string | number>) => string;

const PAGE = 60;
const POLL_MS = 20_000;

function localDay(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function clock(ms: number): string {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** the newest message sits just above the box for typing */
function toBottom(smooth: boolean): void {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

/** one line saying what a message is (for replies, alerts and pop-up notes) */
export function previewOf(m: ChatMsg, t: T): string {
    const name = m.ref ? m.ref.name : '';
    if (m.kind === 'flag') return t('sysFlag', { name, text: m.text });
    if (m.kind === 'fixed') {
        return m.from !== undefined && m.to !== undefined
            ? t('sysFixedQty', { by: m.by, name, from: fmt(m.from), to: fmt(m.to) })
            : t('sysFixed', { by: m.by, name });
    }
    if (m.kind === 'ok') return t('sysOk', { by: m.by, name });
    if (m.kind === 'unflag') return t('sysUnflag', { by: m.by, name });
    if (m.kind === 'deleted') return t('sysDeleted', { by: m.by, name });
    return m.text;
}

const SYS_ICON: Record<string, IconName> = { fixed: 'pencil', ok: 'check', unflag: 'undo', deleted: 'trash' };

interface Props {
    /** show only the runs still marked ✗ */
    open: boolean;
    /** jump to the newest message about this run */
    run: string | null;
    navigate: (to: string) => void;
    openEntry: (s: EntryModalState) => void;
    /** this device had read everything up to here when the page opened */
    seen: number;
    markSeen: (at: number) => void;
}

type Pending = { kind: 'accept' | 'cancel'; run: FoundRun; name: string } | { kind: 'delete'; msg: ChatMsg };

/** Production ↔ warehouse chat: ✗ marks from the warehouse, answers and corrections from production. */
export function Chat({ open, run, navigate, openEntry, seen, markSeen }: Props) {
    const { t } = useI18n();
    const { products, months, chat, refresh, sendMessage, deleteMessage, setReceived, clearIssue, updateEntry } = useStore();
    const { canEdit, requireLogin, name: me, token } = useEditor();
    const toast = useToast();
    const [text, setText] = useState('');
    const [about, setAbout] = useState<ChatRef | null>(null);
    const [replyTo, setReplyTo] = useState<ChatMsg | null>(null);
    const [sending, setSending] = useState(false);
    const [limit, setLimit] = useState(PAGE);
    const [pending, setPending] = useState<Pending | null>(null);
    const [busyRun, setBusyRun] = useState<string | null>(null);
    const [flash, setFlash] = useState<string | null>(null);
    const firstSeen = useRef(seen);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const scrolledRef = useRef(false);
    const countRef = useRef(0);
    const shownTargetRef = useRef<string | null>(null);

    const nameOf = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);
    const issues = useMemo(() => openIssues(months), [months]);
    const openSet = useMemo(() => new Set(issues.map((x) => x.entry.id)), [issues]);
    const lastFlag = useMemo(() => latestFlags(chat), [chat]);
    const byId = useMemo(() => new Map(chat.map((m) => [m.id, m])), [chat]);
    const filtered = useMemo(() => (open ? chat.filter((m) => m.ref && openSet.has(m.ref.id)) : chat), [chat, open, openSet]);

    // the message to jump to: the newest ✗ mark about that run (or the newest message about it)
    const target = useMemo(() => {
        if (!run) {
            return null;
        }
        const flagId = lastFlag.get(run);
        if (flagId) {
            return flagId;
        }
        const about = filtered.filter((m) => m.ref && m.ref.id === run);
        return about.length ? about[about.length - 1].id : null;
    }, [run, lastFlag, filtered]);

    useEffect(() => {
        if (!target) {
            return;
        }
        const index = filtered.findIndex((m) => m.id === target);
        if (index >= 0 && index < filtered.length - limit) {
            setLimit(filtered.length - index + 5);
        }
    }, [target, filtered, limit]);

    const visible = filtered.slice(-limit);
    const firstNew = visible.find((m) => m.at > firstSeen.current && !samePerson(m.by, me));

    // keep reading: newer messages every 20 s while the page is open (with the saving key: no GitHub limit)
    useEffect(() => {
        void refresh(true);
        if (!token) {
            return;
        }
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') {
                void refresh(true);
            }
        }, POLL_MS);
        return () => window.clearInterval(timer);
    }, [refresh, token]);

    // everything shown here counts as read on this device
    useEffect(() => {
        const mark = () => {
            if (document.visibilityState === 'visible' && chat.length) {
                markSeen(latestAt(chat));
            }
        };
        mark();
        document.addEventListener('visibilitychange', mark);
        return () => document.removeEventListener('visibilitychange', mark);
    }, [chat, markSeen]);

    const flashOn = (id: string) => {
        setFlash(id);
        window.setTimeout(() => setFlash((cur) => (cur === id ? null : cur)), 2400);
    };

    // first view: the run asked for, the first new message, or the newest message
    useLayoutEffect(() => {
        if (scrolledRef.current || !visible.length) {
            return;
        }
        scrolledRef.current = true;
        countRef.current = filtered.length;
        const goal = target && document.getElementById(`m-${target}`);
        if (goal) {
            shownTargetRef.current = target;
            goal.scrollIntoView({ block: 'center' });
            flashOn(target!);
            return;
        }
        const fresh = firstNew && document.getElementById('chat-new');
        if (fresh) {
            fresh.scrollIntoView({ block: 'start' });
        } else {
            toBottom(false);
        }
    });

    // new messages while reading at the bottom: follow them
    useEffect(() => {
        if (!scrolledRef.current) {
            return;
        }
        if (filtered.length > countRef.current) {
            const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 320;
            const mine = samePerson(filtered[filtered.length - 1].by, me);
            if (nearBottom || mine) {
                window.setTimeout(() => toBottom(true), 30);
            }
        }
        countRef.current = filtered.length;
    }, [filtered, me]);

    // another run asked for while the page is open (e.g. from the alert strip): scroll there
    useEffect(() => {
        if (!target || !scrolledRef.current || shownTargetRef.current === target) {
            return;
        }
        const el = document.getElementById(`m-${target}`);
        if (el) {
            shownTargetRef.current = target;
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            flashOn(target);
        }
    });

    const jumpTo = (id: string, tries = 0) => {
        const el = document.getElementById(`m-${id}`);
        if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            flashOn(id);
        } else if (tries < 1 && byId.has(id)) {
            setLimit(chat.length);
            window.setTimeout(() => jumpTo(id, tries + 1), 60);
        }
    };

    const focusInput = () => window.setTimeout(() => inputRef.current?.focus(), 30);

    const startReply = (m: ChatMsg) => {
        requireLogin(() => {
            setReplyTo(m.kind && m.kind !== 'flag' ? null : m);
            setAbout(m.ref || null);
            focusInput();
        });
    };

    const send = async (ev?: FormEvent) => {
        ev?.preventDefault();
        const value = text.trim();
        if (!value || sending) {
            return;
        }
        if (!canEdit) {
            requireLogin();
            return;
        }
        setSending(true);
        try {
            await sendMessage(value, about, replyTo ? replyTo.id : null);
            play('send');
            setText('');
            setAbout(null);
            setReplyTo(null);
            window.setTimeout(() => toBottom(true), 60);
        } catch (e) {
            toast.show(t(apiErrorKey(e)), 'error');
        } finally {
            setSending(false);
        }
    };

    const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        const touch = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
        if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
        }
    };

    const runWork = async (id: string, work: () => Promise<void>) => {
        setBusyRun(id);
        try {
            await work();
        } catch (e) {
            toast.show(t(apiErrorKey(e)), 'error');
        } finally {
            setBusyRun(null);
        }
    };

    const fixTo = (found: FoundRun, qty: number) =>
        requireLogin(() =>
            void runWork(found.entry.id, async () => {
                const e = found.entry;
                await updateEntry(e.id, found.month, { productId: e.productId, qty, date: e.date, month: found.month, note: e.note });
                toast.show(t('issueFixed', { n: fmt(qty) }));
            }),
        );

    const confirmPending = async () => {
        const p = pending;
        setPending(null);
        if (!p) {
            return;
        }
        if (p.kind === 'delete') {
            try {
                await deleteMessage(p.msg.id);
                toast.show(t('chatDeleted'), 'success', 'delete');
            } catch (e) {
                toast.show(t(apiErrorKey(e)), 'error');
            }
            return;
        }
        await runWork(p.run.entry.id, async () => {
            if (p.kind === 'accept') {
                await setReceived([{ id: p.run.entry.id, month: p.run.month }], true);
                toast.show(t('stockSaved'), 'success', 'check');
            } else {
                await clearIssue({ id: p.run.entry.id, month: p.run.month });
                toast.show(t('issueCancelled'), 'success', 'uncheck');
            }
        });
    };

    /** the run a message is about, as it is now */
    const runCard = (ref: ChatRef): ReactNode => {
        const found = findRun(months, ref.id, ref.month);
        const e = found ? found.entry : null;
        const name = e ? nameOf.get(e.productId) || ref.name : ref.name;
        const state = !e ? 'gone' : e.received ? 'in' : e.issue ? 'issue' : 'wait';
        const label = !e ? t('issueGoneState') : e.received ? t('issueReceivedState') : e.issue ? t('issueState') : t('stockPending');
        return (
            <a className={`crun is-${state}`} href={`#/stock/${found ? found.month : ref.month}`}>
                <Icon name="box" size={14} />
                <span className="crun-name">{name}</span>
                <span className="crun-meta num">
                    {(e ? e.date : ref.date) ? shortDate((e ? e.date : ref.date) as string) : ''} · {fmt(e ? e.qty : ref.qty)}
                </span>
                <span className="crun-state">{label}</span>
            </a>
        );
    };

    const flagCard = (m: ChatMsg) => {
        const ref = m.ref!;
        const found = findRun(months, ref.id, ref.month);
        const e = found ? found.entry : null;
        const isOpen = Boolean(e && e.issue && lastFlag.get(ref.id) === m.id);
        const state = !e ? 'gone' : isOpen ? 'open' : e.received ? 'in' : 'closed';
        const stateLabel =
            state === 'open' ? t('issueOpenState') : state === 'in' ? t('issueReceivedState') : state === 'gone' ? t('issueGoneState') : t('issueClosedState');
        const qty = e ? e.qty : ref.qty;
        const name = e ? nameOf.get(e.productId) || ref.name : ref.name;
        const date = e ? e.date : ref.date;
        const counted = m.counted;
        const fixable = isOpen && counted !== undefined && counted > 0 && counted !== qty;
        const busy = busyRun === ref.id;
        return (
            <article className={`cflag is-${state}`}>
                <header className="cflag-head">
                    <span className="cflag-icon" aria-hidden="true">
                        <Icon name="x" size={18} stroke={2.8} />
                    </span>
                    <div className="cflag-titles">
                        <p className="cflag-title">
                            {t('issueKpi')} · {name}
                        </p>
                        <p className="cflag-sub">
                            {date ? longDate(date) : ref.month} · {t('issueBy', { by: m.by, time: clock(m.at) })}
                        </p>
                    </div>
                    <span className={`cflag-state is-${state}`}>{stateLabel}</span>
                </header>
                <p className="cflag-count num">
                    {counted !== undefined
                        ? `${t('issueCountLine', { qty: fmt(qty), counted: fmt(counted) })}${diffText(counted, qty) ? ` (${diffText(counted, qty)})` : ''}`
                        : t('issueRecorded', { qty: fmt(qty) })}
                </p>
                {m.text && <p className="cflag-reason">“{m.text}”</p>}
                {isOpen && found && (
                    <div className="cflag-actions">
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => startReply(m)} disabled={busy}>
                            <Icon name="reply" size={15} />
                            {t('chatReply')}
                        </button>
                        {fixable && (
                            <button type="button" className="btn btn-outline btn-sm cflag-fix" onClick={() => fixTo(found, counted!)} disabled={busy}>
                                <Icon name="pencil" size={15} />
                                {t('issueFixTo', { n: fmt(counted!) })}
                            </button>
                        )}
                        <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => openEntry({ mode: 'edit', month: found.month, entry: found.entry })}
                            disabled={busy}
                        >
                            {t('issueEdit')}
                        </button>
                        <button
                            type="button"
                            className="btn btn-success btn-sm cflag-accept"
                            onClick={() => requireLogin(() => setPending({ kind: 'accept', run: found, name }))}
                            disabled={busy}
                        >
                            {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="check" size={15} stroke={2.6} />}
                            {t('issueAccept')}
                        </button>
                        <button
                            type="button"
                            className="btn btn-ghost btn-sm cflag-cancel"
                            onClick={() => requireLogin(() => setPending({ kind: 'cancel', run: found, name }))}
                            disabled={busy}
                        >
                            {t('issueCancel')}
                        </button>
                    </div>
                )}
            </article>
        );
    };

    // messages with day separators and the "new messages" line
    const rows: ReactNode[] = [];
    let lastDay = '';
    const today = localDay(Date.now());
    const yesterday = localDay(Date.now() - 86_400_000);
    for (const m of visible) {
        const day = localDay(m.at);
        if (day !== lastDay) {
            lastDay = day;
            rows.push(
                <li key={`d-${day}`} className="chat-day" aria-hidden="true">
                    <span>{day === today ? t('today') : day === yesterday ? t('yesterday') : longDate(day)}</span>
                </li>,
            );
        }
        if (firstNew && m.id === firstNew.id) {
            rows.push(
                <li key="new" id="chat-new" className="chat-new">
                    <span>{t('chatNew')}</span>
                </li>,
            );
        }
        const mine = samePerson(m.by, me);
        const cls = `${flash === m.id ? ' is-flash' : ''}`;
        if (m.kind === 'flag' && m.ref) {
            rows.push(
                <li key={m.id} id={`m-${m.id}`} className={`cmsg cmsg-flag${mine ? ' is-mine' : ''}${cls}`}>
                    {flagCard(m)}
                </li>,
            );
        } else if (m.kind) {
            rows.push(
                <li key={m.id} id={`m-${m.id}`} className={`csys is-${m.kind}${cls}`}>
                    <span>
                        <Icon name={SYS_ICON[m.kind] || 'clock'} size={13} />
                        {previewOf(m, t)} · {clock(m.at)}
                    </span>
                </li>,
            );
        } else {
            const quote = m.replyTo ? byId.get(m.replyTo) : undefined;
            rows.push(
                <li key={m.id} id={`m-${m.id}`} className={`cmsg${mine ? ' is-mine' : ''}${cls}`}>
                    <div className="cmsg-bubble">
                        {!mine && <p className="cmsg-who">{m.by}</p>}
                        {m.replyTo && (
                            <button type="button" className="cmsg-quote" onClick={() => quote && jumpTo(quote.id)} disabled={!quote}>
                                <Icon name="reply" size={13} />
                                {quote ? (
                                    <span>
                                        <b>{samePerson(quote.by, me) ? t('chatYou') : quote.by}</b> {previewOf(quote, t)}
                                    </span>
                                ) : (
                                    <span>{t('chatGone')}</span>
                                )}
                            </button>
                        )}
                        {m.ref && runCard(m.ref)}
                        <p className="cmsg-text">{m.text}</p>
                    </div>
                    <div className="cmsg-tools">
                        <span className="cmsg-time num">{clock(m.at)}</span>
                        {!mine && (
                            <button type="button" className="link-btn" onClick={() => startReply(m)}>
                                {t('chatReply')}
                            </button>
                        )}
                        {mine && canEdit && (
                            <button type="button" className="link-btn cmsg-del" onClick={() => setPending({ kind: 'delete', msg: m })}>
                                {t('delete')}
                            </button>
                        )}
                    </div>
                </li>,
            );
        }
    }

    const left = CHAT_TEXT_MAX - text.length;

    return (
        <div className="page chat-page">
            <PageHeader eyebrow={t('company')} title={t('chatTitle')} sub={t('chatSub')} />

            <div className="chat-filter rise">
                <div className="chips" role="group" aria-label={t('chatTitle')}>
                    <a href="#/chat" className={`chip${!open ? ' is-active' : ''}`} aria-current={!open ? 'page' : undefined}>
                        {t('hAll')} · {chat.length}
                    </a>
                    <a
                        href="#/chat/open"
                        className={`chip${open ? ' is-active' : ''}${issues.length ? ' chip-danger' : ''}`}
                        aria-current={open ? 'page' : undefined}
                    >
                        ✗ {t('chatOpenOnly', { n: issues.length })}
                    </a>
                </div>
                <button type="button" className="chip chat-to-stock" onClick={() => navigate('#/stock')}>
                    <Icon name="warehouse" size={15} />
                    {t('chatGoWarehouse')}
                </button>
            </div>

            <section className="card chat-card rise">
                {filtered.length > visible.length && (
                    <button type="button" className="btn btn-ghost btn-sm chat-older" onClick={() => setLimit((n) => n + PAGE)}>
                        {t('chatOlder')}
                    </button>
                )}
                {filtered.length === 0 ? (
                    <div className="chat-empty">
                        <span className="chat-empty-icon" aria-hidden="true">
                            <Icon name={open ? 'check' : 'chat'} size={26} />
                        </span>
                        <p className="chat-empty-title">{open ? t('chatNoOpen') : t('chatEmpty')}</p>
                        {!open && <p className="hint">{t('chatEmptyHint')}</p>}
                    </div>
                ) : (
                    <ol className="chat-list" aria-live="polite">
                        {rows}
                    </ol>
                )}

                <form className="chat-compose" onSubmit={send}>
                    {(replyTo || about) && (
                        <div className="chat-compose-ref">
                            <Icon name="reply" size={15} />
                            <span>
                                {replyTo ? t('chatReplying', { by: samePerson(replyTo.by, me) ? t('chatYou') : replyTo.by }) : t('chatAbout')}
                                {about ? (
                                    <b>
                                        {' '}
                                        · {about.name} · {fmt(about.qty)}
                                    </b>
                                ) : null}
                            </span>
                            <button
                                type="button"
                                className="icon-btn icon-btn-sm"
                                onClick={() => {
                                    setReplyTo(null);
                                    setAbout(null);
                                }}
                                aria-label={t('chatCancelReply')}
                            >
                                <Icon name="x" size={16} />
                            </button>
                        </div>
                    )}
                    {canEdit ? (
                        <div className="chat-compose-row">
                            <textarea
                                ref={inputRef}
                                id="chat-input"
                                className="chat-input"
                                rows={1}
                                maxLength={CHAT_TEXT_MAX}
                                value={text}
                                placeholder={t('chatPlaceholder')}
                                onChange={(e) => setText(e.target.value)}
                                onKeyDown={onKey}
                                aria-label={t('chatPlaceholder')}
                            />
                            <button type="submit" className="send-btn" disabled={sending || !text.trim()} aria-label={t('chatSend')}>
                                {sending ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" size={20} />}
                            </button>
                        </div>
                    ) : (
                        <button type="button" className="btn btn-primary btn-block chat-login" onClick={() => requireLogin()}>
                            <Icon name="lock" size={18} />
                            {t('chatLogin')}
                        </button>
                    )}
                    {canEdit && left < 80 && <p className="hint chat-left num">{left}</p>}
                </form>
            </section>

            <ConfirmDialog
                open={Boolean(pending)}
                message={
                    !pending
                        ? ''
                        : pending.kind === 'delete'
                          ? t('chatConfirmDelete')
                          : pending.kind === 'accept'
                            ? t('issueConfirmReceive', { name: pending.name })
                            : t('issueConfirmCancel', { name: pending.name })
                }
                confirmLabel={!pending ? '' : pending.kind === 'delete' ? t('chatDelete') : pending.kind === 'accept' ? t('issueAccept') : t('issueCancel')}
                icon={pending && pending.kind === 'accept' ? 'check' : pending && pending.kind === 'cancel' ? 'x' : 'trash'}
                danger={!pending || pending.kind !== 'accept'}
                onConfirm={confirmPending}
                onClose={() => setPending(null)}
            />
        </div>
    );
}
