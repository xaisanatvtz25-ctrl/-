import { useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/Bits';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { apiErrorKey } from '../components/EditAccess';
import { IssueModal } from '../components/IssueModal';
import type { IssueTarget } from '../components/IssueModal';
import { StockReport } from '../components/Report';
import { useToast } from '../components/Toast';
import { useEditor } from '../lib/editor';
import { useI18n } from '../lib/i18n';
import { useStore } from '../lib/store';
import { WAREHOUSE_SINCE } from '../lib/config';
import { fmt, longDate, parseYm, shiftYm, shortDate } from '../lib/format';
import { exportPdf, printReport } from '../lib/pdf';
import type { Entry } from '../lib/types';

type View = 'all' | 'pending' | 'issue' | 'received';

function localDay(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function stamp(ms: number): string {
    const d = new Date(ms);
    return `${shortDate(localDay(ms))} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Months (from WAREHOUSE_SINCE on) that still have runs waiting to be received (✗ marked ones included). */
export function pendingByMonth(months: Record<string, Entry[]>): Array<{ ym: string; n: number }> {
    return Object.keys(months)
        .filter((ym) => ym >= WAREHOUSE_SINCE)
        .sort()
        .map((ym) => ({ ym, n: months[ym].filter((e) => !e.received).length }))
        .filter((x) => x.n > 0);
}

/** "140 (−10)" style difference between what was counted and what was recorded */
export function diffText(counted: number, qty: number): string {
    const d = counted - qty;
    return d === 0 ? '' : `${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}`;
}

interface Props {
    ym: string;
    navigate: (to: string) => void;
}

export function Stock({ ym, navigate }: Props) {
    const { t, monthName } = useI18n();
    const { products, months, chat, setReceived, clearIssue } = useStore();
    const { canEdit, requireLogin } = useEditor();
    const toast = useToast();
    const [view, setView] = useState<View>('all');
    const [day, setDay] = useState('');
    const [busy, setBusy] = useState<Set<string>>(new Set());
    const [untick, setUntick] = useState<Entry | null>(null);
    const [accept, setAccept] = useState<Entry | null>(null);
    const [unflag, setUnflag] = useState<Entry | null>(null);
    const [askAll, setAskAll] = useState(false);
    const [pdfBusy, setPdfBusy] = useState(false);
    const [issueFor, setIssueFor] = useState<IssueTarget | null>(null);

    const { y, m } = parseYm(ym);
    const nameOf = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);
    const entries = months[ym] || [];
    const received = entries.filter((e) => e.received);
    const issues = entries.filter((e) => e.issue);
    const pending = entries.filter((e) => !e.received && !e.issue);
    const qtyAll = entries.reduce((s, e) => s + e.qty, 0);
    const qtyIn = received.reduce((s, e) => s + e.qty, 0);
    const qtyPending = pending.reduce((s, e) => s + e.qty, 0);
    const otherPending = pendingByMonth(months).filter((x) => x.ym !== ym);
    const days = [...new Set([...received.map((e) => localDay(e.received!.at)), ...issues.map((e) => localDay(e.issue!.at))])].sort().reverse();
    const talk = useMemo(() => {
        const n = new Map<string, number>();
        for (const msg of chat) {
            if (msg.ref) {
                n.set(msg.ref.id, (n.get(msg.ref.id) || 0) + 1);
            }
        }
        return n;
    }, [chat]);

    const shown = useMemo(() => {
        const list = entries.filter((e) =>
            view === 'all' ? true : view === 'pending' ? !e.received && !e.issue : view === 'issue' ? Boolean(e.issue) : Boolean(e.received),
        );
        return [...list].sort((a, b) => {
            if (a.date !== b.date) {
                if (!a.date) return 1;
                if (!b.date) return -1;
                return a.date < b.date ? 1 : -1;
            }
            return b.createdAt - a.createdAt;
        });
    }, [entries, view]);

    const groups = useMemo(() => {
        const out: Array<{ date: string; items: Entry[] }> = [];
        for (const e of shown) {
            const last = out[out.length - 1];
            if (last && last.date === e.date) {
                last.items.push(e);
            } else {
                out.push({ date: e.date, items: [e] });
            }
        }
        return out;
    }, [shown]);

    const go = (target: string) => {
        setDay('');
        navigate(`#/stock/${target}`);
    };

    const withBusy = async (list: Entry[], work: () => Promise<void>) => {
        const ids = list.map((e) => e.id);
        setBusy((prev) => new Set([...prev, ...ids]));
        try {
            await work();
        } catch (e) {
            toast.show(t(apiErrorKey(e)), 'error');
        } finally {
            setBusy((prev) => {
                const next = new Set(prev);
                ids.forEach((id) => next.delete(id));
                return next;
            });
        }
    };

    const save = (list: Entry[], value: boolean) =>
        withBusy(list, async () => {
            await setReceived(
                list.map((e) => ({ id: e.id, month: ym })),
                value,
            );
            toast.show(value ? t('stockSaved') : t('stockUnsaved'), 'success', value ? 'check' : 'uncheck');
        });

    const toggle = (e: Entry) => {
        requireLogin(() => {
            if (e.received) {
                setUntick(e);
            } else if (e.issue) {
                setAccept(e); // it was marked ✗: confirm it is right now
            } else {
                void save([e], true);
            }
        });
    };

    const markIssue = (e: Entry) => {
        requireLogin(() => setIssueFor({ entry: e, month: ym, name: nameOf.get(e.productId) || '—' }));
    };

    const downloadPdf = async () => {
        setPdfBusy(true);
        toast.show(t('generatingPdf'), 'info');
        const doc = <StockReport ym={ym} day={day} products={products} months={months} />;
        try {
            await exportPdf(doc, `Milako_Warehouse_${day || ym}.pdf`, day ? `ໃບຮັບສິນຄ້າເຂົ້າສາງ ${day}` : `ໃບຮັບສິນຄ້າເຂົ້າສາງ ເດືອນ ${m} / ${y}`);
            toast.show(t('pdfReady'));
        } catch (err) {
            console.error(err);
            toast.show(t('pdfFailed'), 'error');
            await printReport(doc);
        } finally {
            setPdfBusy(false);
        }
    };

    const views: Array<{ key: View; label: string }> = [
        { key: 'all', label: `${t('hAll')} · ${entries.length}` },
        { key: 'pending', label: `${t('stockPending')} · ${pending.length}` },
        { key: 'issue', label: `✗ ${t('issueKpi')} · ${issues.length}` },
        { key: 'received', label: `${t('stockReceived')} · ${received.length}` },
    ];
    const canPdf = received.length + issues.length > 0;

    return (
        <div className="page">
            <PageHeader
                eyebrow={t('company')}
                title={t('stockTitle')}
                sub={t('stockSub')}
                actions={
                    <div className="stock-head-actions">
                        <a href="#/chat" className="btn btn-outline stock-chat-link">
                            <Icon name="chat" size={18} />
                            {t('navChat')}
                        </a>
                        <div className="year-switch stock-month" role="group" aria-label={t('pickMonth')}>
                            <button type="button" className="icon-btn" onClick={() => go(shiftYm(ym, -1))} aria-label={t('prev')}>
                                <Icon name="chevronLeft" size={18} />
                            </button>
                            <span className="year-value">
                                {monthName(m)} <span className="num">{y}</span>
                            </span>
                            <button type="button" className="icon-btn" onClick={() => go(shiftYm(ym, 1))} aria-label={t('next')}>
                                <Icon name="chevronRight" size={18} />
                            </button>
                        </div>
                    </div>
                }
            />

            <section className="stock-kpis rise">
                <article className="kpi kpi-sky">
                    <div className="kpi-top">
                        <span className="kpi-icon">
                            <Icon name="check" size={18} />
                        </span>
                        <span className="kpi-label">{t('stockReceived')}</span>
                    </div>
                    <div className="kpi-value num">
                        {received.length} <small>/ {entries.length}</small>
                    </div>
                    <div className="kpi-foot">{t('stockRunsWord')}</div>
                </article>
                <article className="kpi kpi-navy">
                    <div className="kpi-top">
                        <span className="kpi-icon">
                            <Icon name="warehouse" size={18} />
                        </span>
                        <span className="kpi-label">{t('stockQty')}</span>
                    </div>
                    <div className="kpi-value num">{fmt(qtyIn)}</div>
                    <div className="kpi-foot">{t('stockOf', { total: fmt(qtyAll) })}</div>
                </article>
                <article className={`kpi ${pending.length ? 'kpi-turmeric' : 'kpi-sky'}`}>
                    <div className="kpi-top">
                        <span className="kpi-icon">
                            <Icon name="clock" size={18} />
                        </span>
                        <span className="kpi-label">{t('stockPending')}</span>
                    </div>
                    <div className="kpi-value num">{pending.length}</div>
                    <div className="kpi-foot">{pending.length ? fmt(qtyPending) : t('stockAllIn')}</div>
                </article>
                <article className={`kpi ${issues.length ? 'kpi-chili' : 'kpi-sky'} kpi-issue`}>
                    <div className="kpi-top">
                        <span className="kpi-icon">
                            <Icon name="x" size={18} stroke={2.6} />
                        </span>
                        <span className="kpi-label">{t('issueKpi')}</span>
                    </div>
                    <div className="kpi-value num">{issues.length}</div>
                    <div className="kpi-foot">{issues.length ? t('issueKpiFoot') : t('issueKpiNone')}</div>
                </article>
            </section>

            {otherPending.length > 0 && (
                <div className="stock-other rise">
                    <Icon name="alert" size={16} />
                    <span>{t('stockOtherMonths')}</span>
                    {otherPending.map((x) => (
                        <button key={x.ym} type="button" className="chip" onClick={() => go(x.ym)}>
                            {monthName(parseYm(x.ym).m)} {parseYm(x.ym).y} · {x.n}
                        </button>
                    ))}
                </div>
            )}

            <section className="card stock-card rise">
                <div className="stock-tools">
                    <div className="chips" role="group" aria-label={t('stockTitle')}>
                        {views.map((v) => (
                            <button
                                key={v.key}
                                type="button"
                                className={`chip${view === v.key ? ' is-active' : ''}${v.key === 'issue' && issues.length ? ' chip-danger' : ''}`}
                                aria-pressed={view === v.key}
                                onClick={() => setView(v.key)}
                            >
                                {v.label}
                            </button>
                        ))}
                    </div>
                    {canEdit && pending.length > 0 && (view === 'all' || view === 'pending') && (
                        <button type="button" className="btn btn-success btn-sm" onClick={() => setAskAll(true)}>
                            <Icon name="check" size={16} />
                            {t('stockReceiveAll', { n: pending.length })}
                        </button>
                    )}
                </div>

                {entries.length === 0 ? (
                    <div className="empty-mini">{t('stockEmpty')}</div>
                ) : shown.length === 0 ? (
                    <div className="empty-mini">{t('stockNone')}</div>
                ) : (
                    <div className="stock-groups">
                        {groups.map((g) => (
                            <section key={g.date || 'none'} className="stock-group">
                                <h2 className="stock-date">
                                    <Icon name="calendar" size={14} />
                                    {g.date ? longDate(g.date) : t('noDate')}
                                </h2>
                                <ul className="stock-list">
                                    {g.items.map((e) => {
                                        const isBusy = busy.has(e.id);
                                        const changedAfter = Boolean(e.received && e.editedAt && e.editedAt > e.received.at);
                                        const fixedAfter = Boolean(e.issue && e.editedAt && e.editedAt > e.issue.at);
                                        const name = nameOf.get(e.productId) || '—';
                                        const said = talk.get(e.id) || 0;
                                        return (
                                            <li
                                                key={e.id}
                                                className={`stock-item${e.received ? ' is-in' : ''}${e.issue ? ' is-issue' : ''}${isBusy ? ' is-busy' : ''}`}
                                            >
                                                <button
                                                    type="button"
                                                    role="checkbox"
                                                    aria-checked={Boolean(e.received)}
                                                    aria-label={`${e.received ? t('stockUnmark') : t('stockMark')}: ${name} ${fmt(e.qty)}`}
                                                    className="stock-check"
                                                    disabled={isBusy}
                                                    onClick={() => toggle(e)}
                                                >
                                                    {isBusy ? (
                                                        <span className="spinner spinner-dark" aria-hidden="true" />
                                                    ) : e.received ? (
                                                        <Icon name="check" size={20} stroke={3} />
                                                    ) : e.issue ? (
                                                        <Icon name="x" size={20} stroke={3} />
                                                    ) : null}
                                                </button>
                                                <div className="stock-body">
                                                    <p className="stock-name">{name}</p>
                                                    <p className="stock-meta">
                                                        {e.by ? t('recordedBy', { name: e.by }) : t('stockNoRecorder')}
                                                        {e.note ? ` · ${e.note}` : ''}
                                                    </p>
                                                    {e.received ? (
                                                        <p className="stock-in">
                                                            <Icon name="warehouse" size={13} />
                                                            {t('stockReceivedBy', { time: stamp(e.received.at), by: e.received.by })}
                                                        </p>
                                                    ) : e.issue ? (
                                                        <div className="stock-issue">
                                                            <p className="stock-issue-head">
                                                                <strong>{t('issueState')}</strong>
                                                                {e.issue.counted !== undefined && (
                                                                    <span className="num">
                                                                        {t('issueCountLine', { qty: fmt(e.qty), counted: fmt(e.issue.counted) })}
                                                                        {diffText(e.issue.counted, e.qty) ? ` (${diffText(e.issue.counted, e.qty)})` : ''}
                                                                    </span>
                                                                )}
                                                            </p>
                                                            {e.issue.reason && <p className="stock-issue-reason">“{e.issue.reason}”</p>}
                                                            <p className="stock-issue-by">{t('issueBy', { by: e.issue.by, time: stamp(e.issue.at) })}</p>
                                                            <div className="stock-issue-actions">
                                                                <a href={`#/chat/run/${encodeURIComponent(e.id)}`} className="btn btn-outline btn-sm stock-talk">
                                                                    <Icon name="chat" size={15} />
                                                                    {t('issueChat')}
                                                                    {said > 0 && <span className="stock-talk-n num">{said}</span>}
                                                                </a>
                                                                {canEdit && (
                                                                    <button type="button" className="btn btn-ghost btn-sm stock-unflag" onClick={() => setUnflag(e)} disabled={isBusy}>
                                                                        {t('issueCancel')}
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        <p className="stock-wait">{t('stockPending')}</p>
                                                    )}
                                                    {changedAfter && <span className="badge badge-gold stock-warn">{t('stockEditedAfter')}</span>}
                                                    {fixedAfter && e.editedBy && (
                                                        <span className="badge badge-sky stock-fixed">{t('sysFixed', { by: e.editedBy, name: '' }).trim()}</span>
                                                    )}
                                                </div>
                                                <div className="stock-side">
                                                    <span className="stock-qty num">{fmt(e.qty)}</span>
                                                    {!e.received && !e.issue && (
                                                        <button
                                                            type="button"
                                                            className="stock-flag"
                                                            onClick={() => markIssue(e)}
                                                            disabled={isBusy}
                                                            aria-label={`${t('issueMarkAria')}: ${name} ${fmt(e.qty)}`}
                                                        >
                                                            <Icon name="x" size={14} stroke={2.8} />
                                                            {t('issueBtn')}
                                                        </button>
                                                    )}
                                                </div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </section>
                        ))}
                    </div>
                )}

                <div className="stock-pdf">
                    <div className="select-wrap">
                        <select value={day} onChange={(ev) => setDay(ev.target.value)} aria-label={t('stockPdfDay')} disabled={!days.length}>
                            <option value="">
                                {t('stockPdfDay')}: {t('stockWholeMonth')}
                            </option>
                            {days.map((d) => (
                                <option key={d} value={d}>
                                    {t('stockPdfDay')}: {longDate(d)}
                                </option>
                            ))}
                        </select>
                        <Icon name="chevronDown" size={18} className="select-caret" />
                    </div>
                    <button type="button" className="btn btn-primary" onClick={downloadPdf} disabled={pdfBusy || !canPdf}>
                        <Icon name="download" size={18} />
                        {pdfBusy ? t('generatingPdf') : t('stockPdf')}
                    </button>
                    {!canPdf && entries.length > 0 && <p className="hint stock-pdf-hint">{t('stockPdfHint')}</p>}
                </div>
            </section>

            <IssueModal target={issueFor} onClose={() => setIssueFor(null)} />
            <ConfirmDialog
                open={Boolean(untick)}
                message={untick ? t('stockConfirmUnmark', { name: nameOf.get(untick.productId) || '—', qty: fmt(untick.qty) }) : ''}
                confirmLabel={t('stockUnmark')}
                icon="x"
                onConfirm={async () => {
                    const e = untick;
                    setUntick(null);
                    if (e) {
                        await save([e], false);
                    }
                }}
                onClose={() => setUntick(null)}
            />
            <ConfirmDialog
                open={Boolean(accept)}
                message={accept ? t('issueConfirmReceive', { name: nameOf.get(accept.productId) || '—' }) : ''}
                confirmLabel={t('issueAccept')}
                icon="check"
                danger={false}
                onConfirm={async () => {
                    const e = accept;
                    setAccept(null);
                    if (e) {
                        await save([e], true);
                    }
                }}
                onClose={() => setAccept(null)}
            />
            <ConfirmDialog
                open={Boolean(unflag)}
                message={unflag ? t('issueConfirmCancel', { name: nameOf.get(unflag.productId) || '—' }) : ''}
                confirmLabel={t('issueCancel')}
                icon="x"
                onConfirm={async () => {
                    const e = unflag;
                    setUnflag(null);
                    if (e) {
                        await withBusy([e], async () => {
                            await clearIssue({ id: e.id, month: ym });
                            toast.show(t('issueCancelled'), 'success', 'uncheck');
                        });
                    }
                }}
                onClose={() => setUnflag(null)}
            />
            <ConfirmDialog
                open={askAll}
                message={
                    t('stockConfirmAll', { n: pending.length, qty: fmt(qtyPending) }) + (issues.length ? t('stockConfirmAllSkip', { n: issues.length }) : '')
                }
                confirmLabel={t('stockMark')}
                icon="check"
                danger={false}
                onConfirm={async () => {
                    setAskAll(false);
                    await save(pending, true);
                }}
                onClose={() => setAskAll(false)}
            />
        </div>
    );
}
