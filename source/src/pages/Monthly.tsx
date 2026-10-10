import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { CountUp } from '../components/CountUp';
import { Donut, CHART_COLORS } from '../components/Charts';
import type { DonutSegment } from '../components/Charts';
import { Delta, YearSwitch } from '../components/Bits';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useEditor } from '../lib/editor';
import { apiErrorKey } from '../components/EditAccess';
import { MonthReport } from '../components/Report';
import { useToast } from '../components/Toast';
import type { EntryModalState } from '../components/EntryModal';
import { useI18n } from '../lib/i18n';
import { useStore } from '../lib/store';
import { daysInMonth, fmt, longDate, parseYm, pctChange, shiftYm, shortDate, toYm } from '../lib/format';
import { groupByProduct, sumQty } from '../lib/stats';
import type { ProductGroup } from '../lib/stats';
import { exportPdf, printReport } from '../lib/pdf';
import type { Entry } from '../lib/types';

interface Props {
    ym: string;
    navigate: (to: string) => void;
    openEntry: (state: EntryModalState) => void;
}

export function Monthly({ ym, navigate, openEntry }: Props) {
    const { t, monthName, weekdays } = useI18n();
    const { products, months, deleteEntry } = useStore();
    const { canEdit } = useEditor();
    const toast = useToast();
    const [showAll, setShowAll] = useState(false);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [pending, setPending] = useState<{ entry: Entry; name: string } | null>(null);
    const [pdfBusy, setPdfBusy] = useState(false);
    const pillsRef = useRef<HTMLDivElement>(null);

    const { y, m } = parseYm(ym);
    const entries = months[ym] || [];
    const prevEntries = months[shiftYm(ym, -1)] || [];
    const total = sumQty(entries);
    const prevTotal = sumQty(prevEntries);
    const delta = entries.length ? pctChange(total, prevTotal) : null;

    const groups = useMemo(() => groupByProduct(entries, products), [entries, products]);
    const rows: ProductGroup[] = useMemo(() => {
        if (!showAll) {
            return groups;
        }
        const byId = new Map(groups.map((g) => [g.productId, g]));
        const all: ProductGroup[] = products
            .filter((p) => byId.has(p.id) || p.since <= ym)
            .map((p) => byId.get(p.id) || { product: p, productId: p.id, qty: 0, entries: [] });
        const orphans = groups.filter((g) => !g.product);
        return [...all, ...orphans];
    }, [groups, products, showAll, ym]);
    const maxQty = Math.max(1, ...groups.map((g) => g.qty));

    useEffect(() => {
        setExpanded(null);
        const pill = pillsRef.current?.querySelector<HTMLElement>('.is-active');
        pill?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }, [ym]);

    const segments: DonutSegment[] = useMemo(() => {
        const sorted = [...groups].sort((a, b) => b.qty - a.qty);
        const head = sorted.slice(0, 6).map((g, i) => ({
            label: g.product?.name || '—',
            value: g.qty,
            color: CHART_COLORS[i % CHART_COLORS.length],
        }));
        const rest = sorted.slice(6).reduce((s, g) => s + g.qty, 0);
        if (rest > 0) {
            head.push({ label: t('others'), value: rest, color: CHART_COLORS[6] });
        }
        return head;
    }, [groups, t]);

    const calendar = useMemo(() => {
        const days = daysInMonth(y, m);
        const offset = new Date(y, m - 1, 1).getDay();
        const perDay = new Map<number, { qty: number; runs: number }>();
        let undated = 0;
        for (const e of entries) {
            if (e.date && e.date.startsWith(ym)) {
                const d = Number(e.date.slice(8, 10));
                const v = perDay.get(d) || { qty: 0, runs: 0 };
                v.qty += e.qty;
                v.runs += 1;
                perDay.set(d, v);
            } else {
                undated += 1;
            }
        }
        const max = Math.max(1, ...[...perDay.values()].map((v) => v.qty));
        return { days, offset, perDay, undated, max };
    }, [entries, y, m, ym]);

    const go = (target: string) => navigate(`#/month/${target}`);

    const downloadPdf = async () => {
        setPdfBusy(true);
        toast.show(t('generatingPdf'), 'info');
        const doc = <MonthReport ym={ym} products={products} months={months} />;
        try {
            await exportPdf(doc, `Milako_Report_${ym}.pdf`, `ລາຍງານຜົນການຜະລິດ ເດືອນ ${m} / ${y}`);
            toast.show(t('pdfReady'));
        } catch (e) {
            console.error(e);
            toast.show(t('pdfFailed'), 'error');
            await printReport(doc);
        } finally {
            setPdfBusy(false);
        }
    };

    const confirmDelete = async () => {
        if (!pending) {
            return;
        }
        try {
            await deleteEntry(pending.entry.id, ym);
            toast.show(t('deleted'), 'success', 'delete');
            setPending(null);
        } catch (e) {
            toast.show(t(apiErrorKey(e)), 'error');
            setPending(null);
        }
    };

    return (
        <div className="page">
            <div className="month-nav rise">
                <YearSwitch year={y} onChange={(ny) => go(toYm(ny, m))} />
                <div className="month-pills" ref={pillsRef} role="tablist" aria-label={t('pickMonth')}>
                    {Array.from({ length: 12 }, (_, i) => {
                        const mm = i + 1;
                        const key = toYm(y, mm);
                        const has = (months[key] || []).length > 0;
                        return (
                            <button
                                key={mm}
                                type="button"
                                role="tab"
                                aria-selected={mm === m}
                                className={`pill${mm === m ? ' is-active' : ''}${has ? ' has-data' : ''}`}
                                onClick={() => go(key)}
                            >
                                <span className="pill-num num">{mm}</span>
                                <span className="pill-name">{monthName(mm)}</span>
                            </button>
                        );
                    })}
                </div>
            </div>

            <section className="hero rise" style={{ animationDelay: '60ms' }} key={ym}>
                <svg className="hero-ring" viewBox="0 0 200 200" aria-hidden="true">
                    <circle cx="100" cy="100" r="78" pathLength={1} />
                    <circle cx="100" cy="100" r="62" pathLength={1} />
                </svg>
                <div className="hero-main">
                    <div className="hero-nav">
                        <button type="button" className="icon-btn icon-btn-light" onClick={() => go(shiftYm(ym, -1))} aria-label={t('prev')}>
                            <Icon name="chevronLeft" />
                        </button>
                        <p className="hero-eyebrow">{t('monthReport')}</p>
                        <button type="button" className="icon-btn icon-btn-light" onClick={() => go(shiftYm(ym, 1))} aria-label={t('next')}>
                            <Icon name="chevronRight" />
                        </button>
                    </div>
                    <h1 className="hero-title">
                        {monthName(m)} <span className="num">{y}</span>
                    </h1>
                    <div className="hero-total">
                        <CountUp value={total} className="hero-number" />
                        <Delta value={delta} />
                    </div>
                    <p className="hero-meta">
                        {t('monthTotal')} {m} · {groups.length} {t('items')} · {entries.length} {t('times')}
                        {delta !== null && (
                            <>
                                {' '}
                                · {t('vsPrev')} <span className="num">{fmt(prevTotal)}</span>
                            </>
                        )}
                    </p>
                </div>
                <div className="hero-actions">
                    <button type="button" className="btn btn-white" onClick={() => openEntry({ mode: 'add', month: ym })}>
                        <Icon name={canEdit ? 'plus' : 'lock'} size={18} />
                        {t('addProduction')}
                    </button>
                    <button type="button" className="btn btn-glass" onClick={downloadPdf} disabled={pdfBusy || entries.length === 0}>
                        <Icon name="download" size={18} />
                        {pdfBusy ? t('generatingPdf') : t('downloadPdf')}
                    </button>
                </div>
            </section>

            {entries.length === 0 ? (
                <section className="card empty rise" style={{ animationDelay: '120ms' }}>
                    <div className="empty-art" aria-hidden="true">
                        <svg viewBox="0 0 120 120">
                            <circle cx="60" cy="60" r="44" pathLength={1} />
                        </svg>
                        <Icon name="calendar" size={34} />
                    </div>
                    <h2>{t('noEntries')}</h2>
                    <p>{t('noEntriesHint')}</p>
                    <button type="button" className="btn btn-primary" onClick={() => openEntry({ mode: 'add', month: ym })}>
                        <Icon name={canEdit ? 'plus' : 'lock'} size={18} />
                        {t('addProduction')}
                    </button>
                </section>
            ) : (
                <section className="grid-2-1">
                    <article className="card card-flush rise" style={{ animationDelay: '120ms' }}>
                        <div className="card-head card-head-pad">
                            <div>
                                <h2 className="card-title">{t('tableTitle')}</h2>
                                <p className="card-sub">
                                    {t('monthReport')} {t('month')} {m} / {y}
                                </p>
                            </div>
                            <label className="switch">
                                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
                                <span className="switch-track" aria-hidden="true">
                                    <span className="switch-thumb" />
                                </span>
                                <span>{t('showAll')}</span>
                            </label>
                        </div>
                        <div className="ptable" role="table" aria-label={t('tableTitle')}>
                            <div className="ptable-head" role="row">
                                <span role="columnheader">{t('colNo')}</span>
                                <span role="columnheader">{t('colItem')}</span>
                                <span role="columnheader" className="ta-r">
                                    {t('colQty')}
                                </span>
                                <span role="columnheader" className="ta-c">
                                    {t('colDate')}
                                </span>
                                <span role="columnheader" aria-hidden="true" />
                            </div>
                            {rows.map((g, i) => {
                                const isOpen = expanded === g.productId;
                                const dates = [...new Set(g.entries.map((e) => e.date).filter(Boolean))].map(shortDate);
                                const name = g.product?.name || '—';
                                const empty = g.entries.length === 0;
                                return (
                                    <div
                                        key={g.productId}
                                        className={`prow-wrap${isOpen ? ' is-open' : ''}${empty ? ' is-empty' : ''}`}
                                        style={{ animationDelay: `${160 + i * 28}ms` }}
                                    >
                                        <div
                                            className="prow"
                                            role="row"
                                            tabIndex={empty ? -1 : 0}
                                            aria-expanded={empty ? undefined : isOpen}
                                            onClick={() => !empty && setExpanded(isOpen ? null : g.productId)}
                                            onKeyDown={(e) => {
                                                if (!empty && (e.key === 'Enter' || e.key === ' ')) {
                                                    e.preventDefault();
                                                    setExpanded(isOpen ? null : g.productId);
                                                }
                                            }}
                                        >
                                            <span role="cell" className="prow-no num">
                                                {i + 1}
                                            </span>
                                            <span role="cell" className="prow-name">
                                                <span className="prow-title">{name}</span>
                                                {!empty && (
                                                    <span className="prow-bar" aria-hidden="true">
                                                        <span style={{ transform: `scaleX(${g.qty / maxQty})` }} />
                                                    </span>
                                                )}
                                            </span>
                                            <span role="cell" className="prow-qty ta-r">
                                                {!empty && <span className="num">{fmt(g.qty)}</span>}
                                                {g.entries.length > 1 && (
                                                    <span className="prow-parts num">({g.entries.map((e) => fmt(e.qty)).join(' + ')})</span>
                                                )}
                                            </span>
                                            <span role="cell" className="prow-dates ta-c">
                                                {dates.length ? dates.join(', ') : empty ? '' : <span className="muted">—</span>}
                                            </span>
                                            <span role="cell" className="prow-act">
                                                {empty ? (
                                                    canEdit && <button
                                                        type="button"
                                                        className="icon-btn icon-btn-sm"
                                                        aria-label={`${t('addProduction')}: ${name}`}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            openEntry({ mode: 'add', month: ym, productId: g.productId });
                                                        }}
                                                    >
                                                        <Icon name="plus" size={16} />
                                                    </button>
                                                ) : (
                                                    <Icon name="chevronDown" size={18} className="prow-caret" />
                                                )}
                                            </span>
                                        </div>
                                        {!empty && (
                                            <div className="prow-detail" aria-hidden={!isOpen}>
                                                <div className="prow-detail-inner">
                                                    <ul className="runs">
                                                        {g.entries.map((e, k) => (
                                                            <li key={e.id} className="run">
                                                                <span className="run-idx num">#{k + 1}</span>
                                                                <span className="run-date">
                                                                    <Icon name="calendar" size={14} />
                                                                    {e.date ? longDate(e.date) : <span className="muted">{t('noDate')}</span>}
                                                                </span>
                                                                <span className="run-qty num">{fmt(e.qty)}</span>
                                                                {e.note && <span className="run-note">{e.note}</span>}
                                                                {e.received && (
                                                                    <span className="run-in" title={`${e.received.by}`}>
                                                                        <Icon name="check" size={12} stroke={3} />
                                                                        {t('stockBadge')}
                                                                    </span>
                                                                )}
                                                                {e.issue && (
                                                                    <a
                                                                        className="run-in run-issue"
                                                                        href={`#/chat/run/${encodeURIComponent(e.id)}`}
                                                                        title={e.issue.reason}
                                                                        tabIndex={isOpen ? 0 : -1}
                                                                    >
                                                                        <Icon name="x" size={12} stroke={3} />
                                                                        {t('issueKpi')}
                                                                        {e.issue.counted !== undefined ? ` · ${t('hCounted', { n: fmt(e.issue.counted) })}` : ''}
                                                                    </a>
                                                                )}
                                                                {(e.by || e.editedBy) && (
                                                                    <span className="run-by">
                                                                        <Icon name="user" size={12} />
                                                                        {e.by ? t('recordedBy', { name: e.by }) : ''}
                                                                        {e.editedBy && e.editedBy !== e.by ? `${e.by ? ' · ' : ''}${t('editedBy', { name: e.editedBy })}` : ''}
                                                                    </span>
                                                                )}
                                                                {canEdit && <span className="run-actions">
                                                                    <button
                                                                        type="button"
                                                                        className="icon-btn icon-btn-sm"
                                                                        tabIndex={isOpen ? 0 : -1}
                                                                        aria-label={`${t('edit')} ${name} ${fmt(e.qty)}`}
                                                                        onClick={() => openEntry({ mode: 'edit', month: ym, entry: e })}
                                                                    >
                                                                        <Icon name="pencil" size={15} />
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        className="icon-btn icon-btn-sm icon-btn-danger"
                                                                        tabIndex={isOpen ? 0 : -1}
                                                                        aria-label={`${t('delete')} ${name} ${fmt(e.qty)}`}
                                                                        onClick={() => setPending({ entry: e, name })}
                                                                    >
                                                                        <Icon name="trash" size={15} />
                                                                    </button>
                                                                </span>}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                    {canEdit && (
                                                        <button
                                                            type="button"
                                                            className="link-btn"
                                                            tabIndex={isOpen ? 0 : -1}
                                                            onClick={() => openEntry({ mode: 'add', month: ym, productId: g.productId })}
                                                        >
                                                            <Icon name="plus" size={16} />
                                                            {t('addProduction')}
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                            <div className="ptable-total">
                                <span>
                                    {t('monthTotal')} {m}
                                </span>
                                <CountUp value={total} className="ptable-total-num" />
                            </div>
                        </div>
                    </article>

                    <div className="stack">
                        <article className="card rise" style={{ animationDelay: '180ms' }}>
                            <div className="card-head">
                                <h2 className="card-title">{t('share')}</h2>
                            </div>
                            <div className="donut-wrap">
                                <Donut segments={segments} total={total} centerLabel={t('total')} />
                                <ul className="legend">
                                    {segments.map((s) => (
                                        <li key={s.label}>
                                            <span className="legend-dot" style={{ background: s.color }} />
                                            <span className="legend-name">{s.label}</span>
                                            <span className="legend-pct num">{total ? ((s.value / total) * 100).toFixed(1) : '0'}%</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        </article>

                        <article className="card rise" style={{ animationDelay: '240ms' }}>
                            <div className="card-head">
                                <h2 className="card-title">{t('calendar')}</h2>
                            </div>
                            <div className="cal">
                                {weekdays.map((w) => (
                                    <span key={w} className="cal-wd">
                                        {w}
                                    </span>
                                ))}
                                {Array.from({ length: calendar.offset }, (_, i) => (
                                    <span key={`o${i}`} />
                                ))}
                                {Array.from({ length: calendar.days }, (_, i) => {
                                    const day = i + 1;
                                    const v = calendar.perDay.get(day);
                                    const level = v ? Math.min(4, Math.ceil((v.qty / calendar.max) * 4)) : 0;
                                    return (
                                        <span
                                            key={day}
                                            className={`cal-day lv-${level}`}
                                            title={v ? `${day}/${m}: ${fmt(v.qty)} (${v.runs} ${t('times')})` : undefined}
                                            style={{ animationDelay: `${260 + i * 12}ms` }}
                                        >
                                            <span className="num">{day}</span>
                                        </span>
                                    );
                                })}
                            </div>
                            {calendar.undated > 0 && (
                                <p className="cal-note">
                                    <Icon name="clock" size={14} />
                                    {t('noDate')}: {calendar.undated} {t('times')}
                                </p>
                            )}
                        </article>
                    </div>
                </section>
            )}

            <ConfirmDialog
                open={Boolean(pending)}
                message={
                    pending
                        ? t('confirmEntry', { name: pending.name, qty: fmt(pending.entry.qty) }) + (pending.entry.received ? t('confirmEntryReceived') : '')
                        : ''
                }
                onConfirm={confirmDelete}
                onClose={() => setPending(null)}
            />
        </div>
    );
}
