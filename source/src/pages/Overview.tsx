import { useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { CountUp } from '../components/CountUp';
import { TrendChart } from '../components/Charts';
import { PageHeader, YearSwitch, Delta } from '../components/Bits';
import { YearReport } from '../components/Report';
import { TodayCard } from '../components/TodayCard';
import type { EntryModalState } from '../components/EntryModal';
import { useToast } from '../components/Toast';
import { useI18n } from '../lib/i18n';
import { useStore } from '../lib/store';
import { currentYm, fmt, parseYm, pctChange, toYm } from '../lib/format';
import { productYearStats, yearSeries } from '../lib/stats';
import { exportPdf, printReport } from '../lib/pdf';

interface Props {
    year: number;
    setYear: (y: number) => void;
    navigate: (to: string) => void;
    openEntry: (state: EntryModalState) => void;
}

export function Overview({ year, setYear, navigate, openEntry }: Props) {
    const { t, monthName } = useI18n();
    const { products, months } = useStore();
    const toast = useToast();
    const [pdfBusy, setPdfBusy] = useState(false);

    const now = parseYm(currentYm());
    const series = useMemo(() => yearSeries(months, year), [months, year]);
    const stats = useMemo(() => productYearStats(months, year), [months, year]);

    const isFuture = (m: number) => year > now.y || (year === now.y && m > now.m);
    const isCurrent = (m: number) => year === now.y && m === now.m;
    // future months and a still-empty current month are not drawn (avoids a fake drop to 0)
    const chartValues = series.map((v, i) => (isFuture(i + 1) || (isCurrent(i + 1) && v === 0) ? null : v));
    const yearTotal = series.reduce((s, v) => s + v, 0);
    const monthsWithData = series.filter((v) => v > 0).length;
    const avg = monthsWithData ? yearTotal / monthsWithData : 0;
    let runs = 0;
    stats.forEach((s) => {
        runs += s.runs;
    });
    const bestIndex = yearTotal > 0 ? series.indexOf(Math.max(...series)) : -1;
    const latestIndex = series.reduce<number>((acc, v, i) => (v > 0 ? i : acc), -1);
    const latestDelta = latestIndex > 0 ? pctChange(series[latestIndex], series[latestIndex - 1]) : null;
    const maxMonth = Math.max(1, ...series);

    const top = useMemo(() => {
        const byId = new Map(products.map((p) => [p.id, p]));
        return [...stats.entries()]
            .map(([id, s]) => ({ id, name: byId.get(id)?.name || '—', qty: s.qty, runs: s.runs }))
            .sort((a, b) => b.qty - a.qty)
            .slice(0, 8);
    }, [stats, products]);
    const topMax = top.length ? top[0].qty : 1;

    const downloadYear = async () => {
        setPdfBusy(true);
        toast.show(t('generatingPdf'), 'info');
        const doc = <YearReport year={year} products={products} months={months} />;
        try {
            await exportPdf(doc, `Milako_Report_${year}.pdf`, `ລາຍງານຜົນການຜະລິດ ປີ ${year}`);
            toast.show(t('pdfReady'));
        } catch (e) {
            console.error(e);
            toast.show(t('pdfFailed'), 'error');
            await printReport(doc);
        } finally {
            setPdfBusy(false);
        }
    };

    const kpis = [
        {
            key: 'total',
            icon: 'layers' as const,
            label: t('yearTotal'),
            value: yearTotal,
            foot: t('monthsWithData', { n: monthsWithData }),
            tone: 'sky',
        },
        {
            key: 'latest',
            icon: 'calendar' as const,
            label: latestIndex >= 0 ? `${t('latestMonth')} · ${monthName(latestIndex + 1)}` : t('latestMonth'),
            value: latestIndex >= 0 ? series[latestIndex] : 0,
            foot: <Delta value={latestDelta} />,
            tone: 'navy',
        },
        {
            key: 'avg',
            icon: 'trendUp' as const,
            label: t('avgMonth'),
            value: avg,
            foot: bestIndex >= 0 ? `${t('best')}: ${monthName(bestIndex + 1)} · ${fmt(series[bestIndex])}` : t('noData'),
            tone: 'turmeric',
        },
        {
            key: 'runs',
            icon: 'flame' as const,
            label: t('runsCount'),
            value: runs,
            foot: t('productsCount', { n: stats.size }),
            tone: 'chili',
        },
    ];

    return (
        <div className="page">
            <PageHeader
                eyebrow={t('company')}
                title={
                    <>
                        {t('overviewTitle')} <span className="title-year num">{year}</span>
                    </>
                }
                sub={t('overviewSub', { year })}
                actions={
                    <>
                        <YearSwitch year={year} onChange={setYear} />
                        <button type="button" className="btn btn-outline" onClick={downloadYear} disabled={pdfBusy || yearTotal === 0}>
                            <Icon name="download" size={18} />
                            {pdfBusy ? t('generatingPdf') : t('yearPdf')}
                        </button>
                    </>
                }
            />

            <section className="kpi-grid">
                {kpis.map((k, i) => (
                    <article key={k.key} className={`kpi kpi-${k.tone} rise`} style={{ animationDelay: `${i * 70}ms` }}>
                        <div className="kpi-top">
                            <span className="kpi-icon">
                                <Icon name={k.icon} size={18} />
                            </span>
                            <span className="kpi-label">{k.label}</span>
                        </div>
                        <CountUp value={k.value} className="kpi-value" />
                        <div className="kpi-foot">{k.foot}</div>
                    </article>
                ))}
            </section>

            <TodayCard openEntry={openEntry} />

            <section className="grid-2-1">
                <article className="card rise" style={{ animationDelay: '220ms' }}>
                    <div className="card-head">
                        <div>
                            <h2 className="card-title">{t('trendTitle')}</h2>
                            <p className="card-sub">{t('trendSub')}</p>
                        </div>
                    </div>
                    {yearTotal === 0 ? (
                        <div className="empty-mini">{t('newMonthEmpty', { year })}</div>
                    ) : (
                        <TrendChart
                            values={chartValues}
                            labels={series.map((_, i) => String(i + 1))}
                            fullLabels={series.map((_, i) => `${monthName(i + 1)} ${year}`)}
                            highlight={bestIndex}
                            current={year === now.y ? now.m - 1 : -1}
                            onSelect={(i) => navigate(`#/month/${toYm(year, i + 1)}`)}
                        />
                    )}
                </article>

                <article className="card rise" style={{ animationDelay: '290ms' }}>
                    <div className="card-head">
                        <div>
                            <h2 className="card-title">{t('topTitle')}</h2>
                            <p className="card-sub">{year}</p>
                        </div>
                        <button type="button" className="link-btn" onClick={() => navigate('#/products')}>
                            {t('seeAll')}
                            <Icon name="arrowRight" size={16} />
                        </button>
                    </div>
                    {top.length === 0 ? (
                        <div className="empty-mini">{t('noData')}</div>
                    ) : (
                        <ol className="bars">
                            {top.map((p, i) => (
                                <li key={p.id} className="bar-row" style={{ animationDelay: `${360 + i * 60}ms` }}>
                                    <div className="bar-label">
                                        <span className="bar-rank num">{i + 1}</span>
                                        <span className="bar-name">{p.name}</span>
                                        <span className="bar-value num">{fmt(p.qty)}</span>
                                    </div>
                                    <div className="bar-track">
                                        <div
                                            className={`bar-fill${i === 0 ? ' is-top' : ''}`}
                                            style={{ transform: `scaleX(${p.qty / topMax})`, animationDelay: `${420 + i * 60}ms` }}
                                        />
                                    </div>
                                </li>
                            ))}
                        </ol>
                    )}
                </article>
            </section>

            <section className="section">
                <div className="section-head">
                    <h2 className="section-title">{t('monthsTitle')}</h2>
                </div>
                <div className="month-grid">
                    {series.map((v, i) => {
                        const m = i + 1;
                        const future = isFuture(m);
                        const isNow = year === now.y && m === now.m;
                        const entries = months[toYm(year, m)] || [];
                        const productCount = new Set(entries.map((e) => e.productId)).size;
                        return (
                            <button
                                key={m}
                                type="button"
                                className={`month-tile rise${future ? ' is-future' : ''}${isNow ? ' is-now' : ''}${i === bestIndex ? ' is-best' : ''}`}
                                style={{ animationDelay: `${300 + i * 40}ms` }}
                                onClick={() => navigate(`#/month/${toYm(year, m)}`)}
                                aria-label={`${monthName(m)} ${year}: ${fmt(v)}`}
                            >
                                <span className="mt-head">
                                    <span className="mt-num num">{String(m).padStart(2, '0')}</span>
                                    {i === bestIndex && <span className="badge badge-gold">{t('best')}</span>}
                                    {isNow && i !== bestIndex && <span className="badge badge-sky">{t('thisMonth')}</span>}
                                </span>
                                <span className="mt-name">{monthName(m)}</span>
                                <span className="mt-value num">{v > 0 ? fmt(v) : future ? t('future') : '—'}</span>
                                <span className="mt-meta">
                                    {v > 0 ? `${productCount} ${t('items')} · ${entries.length} ${t('times')}` : t('noData')}
                                </span>
                                <span className="mt-meter" aria-hidden="true">
                                    <span style={{ transform: `scaleX(${v / maxMonth})` }} />
                                </span>
                            </button>
                        );
                    })}
                </div>
            </section>
        </div>
    );
}
