import type { ReactNode } from 'react';
import { LogoMark } from './Logo';
import { fmt, longDate, parseYm, shortDate, todayIso, toYm } from '../lib/format';
import { groupByProduct, sumQty } from '../lib/stats';
import type { MonthMap, Product } from '../lib/types';

/*
 * A4 sheets (794 x 1123 css px) rendered off-screen and converted to PDF.
 * Layout follows the company's existing Lao production report.
 */

const COMPANY = 'ບໍລິສັດ ມິລະໂກະ';
const COMPANY_SUB = 'ການຄ້າຂາເຂົ້າ-ຂາອອກ ຈຳກັດຜູ້ດຽວ';
const SIGNERS = ['ຜູ້ຜະລິດ', 'ຄົນຄຸມສາງ', 'ຜູ້ບໍລິຫານ'];
const ROW_H = 25;
const ROW_H_SPLIT = 36;
const PAGE_BUDGET = 735;

interface SheetProps {
    title: string;
    children: ReactNode;
    page: number;
    pages: number;
    note?: string;
}

function Sheet({ title, children, page, pages, note }: SheetProps) {
    return (
        <div className="a4">
            <div className="a4-bar" />
            <header className="a4-head">
                <div className="a4-logo">
                    <LogoMark size={54} />
                </div>
                <div className="a4-titles">
                    <div className="a4-company">{COMPANY}</div>
                    <div className="a4-sub">{COMPANY_SUB}</div>
                    <div className="a4-report">{title}</div>
                </div>
            </header>
            {note && <p className="a4-note">{note}</p>}
            {children}
            <footer className="a4-foot">
                <span>ພິມວັນທີ {longDate(todayIso())}</span>
                <span>
                    ໜ້າ {page} / {pages}
                </span>
            </footer>
        </div>
    );
}

function Signatures() {
    return (
        <div className="a4-sign">
            {SIGNERS.map((s) => (
                <div key={s} className="a4-sign-col">
                    <div className="a4-sign-dots">(..................................)</div>
                    <div className="a4-sign-role">{s}</div>
                </div>
            ))}
        </div>
    );
}

interface Row {
    key: string;
    cells: ReactNode[];
    split?: boolean;
}

function paginate(rows: Row[]): Row[][] {
    const pages: Row[][] = [];
    let current: Row[] = [];
    let used = 0;
    for (const row of rows) {
        const h = row.split ? ROW_H_SPLIT : ROW_H;
        if (used + h > PAGE_BUDGET && current.length) {
            pages.push(current);
            current = [];
            used = 0;
        }
        current.push(row);
        used += h;
    }
    pages.push(current);
    return pages;
}

interface TableSpec {
    head: string[];
    widths: string[];
    align: Array<'left' | 'right' | 'center'>;
}

function Table({ spec, rows }: { spec: TableSpec; rows: Row[] }) {
    return (
        <table className="a4-table">
            <colgroup>
                {spec.widths.map((w, i) => (
                    <col key={i} style={{ width: w }} />
                ))}
            </colgroup>
            <thead>
                <tr>
                    {spec.head.map((h) => (
                        <th key={h}>{h}</th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {rows.map((r) => (
                    <tr key={r.key} className={r.split ? 'is-split' : ''}>
                        {r.cells.map((c, i) => (
                            <td key={i} style={{ textAlign: spec.align[i] }}>
                                {c}
                            </td>
                        ))}
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

interface DocPage {
    title: string;
    note?: string;
    body: ReactNode;
}

function renderDoc(pages: DocPage[]) {
    return (
        <>
            {pages.map((p, i) => (
                <Sheet key={i} title={p.title} note={p.note} page={i + 1} pages={pages.length}>
                    {p.body}
                </Sheet>
            ))}
        </>
    );
}

function TotalLine({ label, value }: { label: string; value: string }) {
    return (
        <div className="a4-total">
            {label}: <span className="num">{value}</span>
        </div>
    );
}

const MONTH_SPEC: TableSpec = {
    head: ['ລຳດັບ', 'ລາຍການຜະລິດ', 'ຈຳນວນ', 'ວັນທີຜະລິດ'],
    widths: ['9%', '46%', '17%', '28%'],
    align: ['center', 'left', 'right', 'center'],
};

function monthPages(ym: string, products: Product[], months: MonthMap, onlyProduced: boolean): DocPage[] {
    const { y, m } = parseYm(ym);
    const entries = months[ym] || [];
    const groups = new Map(groupByProduct(entries, products).map((g) => [g.productId, g]));
    const listed = products.filter((p) => groups.has(p.id) || (!onlyProduced && p.since <= ym));
    const rows: Row[] = listed.map((p, i) => {
        const g = groups.get(p.id);
        const parts = g ? g.entries.map((e) => e.qty) : [];
        const dates = g ? [...new Set(g.entries.map((e) => e.date).filter(Boolean))].map(shortDate) : [];
        const split = parts.length > 1;
        return {
            key: p.id,
            split,
            cells: [
                i + 1,
                p.name,
                g ? (
                    <div className="a4-qty">
                        <span className="num">{fmt(g.qty)}</span>
                        {split && <span className="a4-parts num">({parts.map(fmt).join(' + ')})</span>}
                    </div>
                ) : (
                    ''
                ),
                dates.join(', '),
            ],
        };
    });
    const chunks = paginate(rows);
    const title = `ລາຍງານຜົນການຜະລິດ ເດືອນ ${m} / ${y}`;
    return chunks.map((chunk, i) => ({
        title,
        body: (
            <>
                <Table spec={MONTH_SPEC} rows={chunk} />
                {i === chunks.length - 1 && (
                    <>
                        <TotalLine label={`ລວມທັງໝົດເດືອນ ${m}`} value={fmt(sumQty(entries))} />
                        <Signatures />
                    </>
                )}
            </>
        ),
    }));
}

export function MonthReport({
    ym,
    products,
    months,
    onlyProduced = false,
}: {
    ym: string;
    products: Product[];
    months: MonthMap;
    onlyProduced?: boolean;
}) {
    return renderDoc(monthPages(ym, products, months, onlyProduced));
}

const STOCK_SPEC: TableSpec = {
    head: ['ລຳດັບ', 'ລາຍການຜະລິດ', 'ຈຳນວນ', 'ວັນທີຜະລິດ', 'ເຂົ້າສາງ', 'ຜູ້ຮັບເຂົ້າສາງ'],
    widths: ['8%', '31%', '12%', '14%', '19%', '16%'],
    align: ['center', 'left', 'right', 'center', 'center', 'left'],
};

function localDay(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function stamp(ms: number): string {
    const d = new Date(ms);
    return `${shortDate(localDay(ms))} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const ISSUE_SPEC: TableSpec = {
    head: ['ລຳດັບ', 'ລາຍການຜະລິດ', 'ບັນທຶກ', 'ນັບໄດ້', 'ເຫດຜົນ', 'ຜູ້ແຈ້ງ'],
    widths: ['8%', '26%', '11%', '11%', '29%', '15%'],
    align: ['center', 'left', 'right', 'right', 'left', 'left'],
};

const ISSUE_TITLE = 'ລາຍການທີ່ບໍ່ຕົງ ✗ (ລໍຖ້າແກ້ໄຂ)';

function clip(text: string, max: number): string {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/**
 * Warehouse receiving slip: runs of one production month that were ticked as received (optionally one receiving day),
 * followed by the runs marked ✗ "does not match" that are not solved yet.
 */
export function StockReport({ ym, day, products, months }: { ym: string; day: string; products: Product[]; months: MonthMap }) {
    const { y, m } = parseYm(ym);
    const byId = new Map(products.map((p) => [p.id, p]));
    const all = months[ym] || [];
    const received = all
        .filter((e) => e.received && (!day || localDay(e.received.at) === day))
        .sort((a, b) => (a.received?.at || 0) - (b.received?.at || 0));
    const issues = all
        .filter((e) => e.issue && (!day || localDay(e.issue.at) === day))
        .sort((a, b) => (a.issue?.at || 0) - (b.issue?.at || 0));
    const pending = all.filter((e) => !e.received && !e.issue).length;
    const title = day ? `ໃບຮັບສິນຄ້າເຂົ້າສາງ ວັນທີ ${longDate(day)}` : `ໃບຮັບສິນຄ້າເຂົ້າສາງ ເດືອນ ${m} / ${y}`;
    const note =
        `ລາຍການຜະລິດເດືອນ ${m} / ${y} ທີ່ເຂົ້າສາງແລ້ວ: ${received.length} ລາຍການ` +
        (issues.length ? ` · ບໍ່ຕົງ: ${issues.length} ລາຍການ` : '') +
        (!day && pending ? ` · ຍັງລໍຖ້າເຂົ້າສາງ ${pending} ລາຍການ` : '');
    if (!received.length && !issues.length) {
        return renderDoc([{ title, note, body: <p className="a4-empty">ຍັງບໍ່ມີລາຍການເຂົ້າສາງ</p> }]);
    }
    const rows: Row[] = received.map((e, i) => ({
        key: e.id,
        cells: [
            i + 1,
            byId.get(e.productId)?.name || '—',
            <span className="num">{fmt(e.qty)}</span>,
            e.date ? shortDate(e.date) : '—',
            e.received ? stamp(e.received.at) : '',
            e.received ? e.received.by : '',
        ],
    }));
    const issueRows: Row[] = issues.map((e, i) => ({
        key: e.id,
        split: true,
        cells: [
            i + 1,
            byId.get(e.productId)?.name || '—',
            <span className="num">{fmt(e.qty)}</span>,
            e.issue && e.issue.counted !== undefined ? <span className="num">{fmt(e.issue.counted)}</span> : '—',
            <span className="a4-reason">{clip(e.issue?.reason || '', 56)}</span>,
            <span className="a4-reason">
                {e.issue?.by}
                <br />
                {e.issue ? stamp(e.issue.at) : ''}
            </span>,
        ],
    }));
    const total = received.length ? <TotalLine label="ລວມຈຳນວນເຂົ້າສາງ" value={fmt(sumQty(received))} /> : null;
    const issueTable = (chunk: Row[]) => (
        <>
            <h3 className="a4-section">{ISSUE_TITLE}</h3>
            <Table spec={ISSUE_SPEC} rows={chunk} />
        </>
    );

    // everything on one sheet when it fits
    const height = rows.length * ROW_H + issueRows.length * ROW_H_SPLIT + (rows.length && issueRows.length ? 80 : 0);
    if (height <= PAGE_BUDGET - 60) {
        return renderDoc([
            {
                title,
                note,
                body: (
                    <>
                        {rows.length > 0 && <Table spec={STOCK_SPEC} rows={rows} />}
                        {total}
                        {issueRows.length > 0 && issueTable(issueRows)}
                        <Signatures />
                    </>
                ),
            },
        ]);
    }

    const pages: DocPage[] = [];
    const chunks = rows.length ? paginate(rows) : [];
    chunks.forEach((chunk, i) => {
        pages.push({
            title,
            note: i === 0 ? note : undefined,
            body: (
                <>
                    <Table spec={STOCK_SPEC} rows={chunk} />
                    {i === chunks.length - 1 && total}
                    {i === chunks.length - 1 && !issueRows.length && <Signatures />}
                </>
            ),
        });
    });
    const issueChunks = issueRows.length ? paginate(issueRows) : [];
    issueChunks.forEach((chunk, i) => {
        pages.push({
            title,
            note: pages.length === 0 ? note : undefined,
            body: (
                <>
                    {issueTable(chunk)}
                    {i === issueChunks.length - 1 && <Signatures />}
                </>
            ),
        });
    });
    return renderDoc(pages);
}

export function YearReport({ year, products, months }: { year: number; products: Product[]; months: MonthMap }) {
    const monthKeys: string[] = [];
    for (let m = 1; m <= 12; m++) {
        const key = toYm(year, m);
        if ((months[key] || []).length) {
            monthKeys.push(key);
        }
    }
    const pages: DocPage[] = [];
    for (const key of monthKeys) {
        pages.push(...monthPages(key, products, months, false));
    }
    if (!monthKeys.length) {
        return renderDoc([{ title: `ສະຫຼຸບການຜະລິດ ປີ ${year}`, body: <p className="a4-empty">ຍັງບໍ່ມີຂໍ້ມູນການຜະລິດ</p> }]);
    }
    const firstM = parseYm(monthKeys[0]).m;
    const lastM = parseYm(monthKeys[monthKeys.length - 1]).m;
    const range = firstM === lastM ? `ເດືອນ ${firstM} / ${year}` : `ເດືອນ ${firstM}-${lastM} / ${year}`;
    const grand = monthKeys.reduce((s, k) => s + sumQty(months[k]), 0);

    // Summary by month
    const monthRows: Row[] = monthKeys.map((k, i) => ({
        key: k,
        cells: [i + 1, `ລາຍງານຜົນການຜະລິດ ເດືອນ ${parseYm(k).m} / ${year}`, <span className="num">{fmt(sumQty(months[k]))}</span>],
    }));
    pages.push({
        title: `ສະຫຼຸບຍອດລວມແຕ່ລະເດືອນ (${range})`,
        body: (
            <>
                <Table
                    spec={{ head: ['ລຳດັບ', 'ປະຈຳເດືອນ', 'ຈຳນວນລວມ'], widths: ['9%', '66%', '25%'], align: ['center', 'left', 'right'] }}
                    rows={monthRows}
                />
                <TotalLine label={`ລວມຍອດທັງໝົດ (${monthKeys.length} ເດືອນ)`} value={fmt(grand)} />
                <Signatures />
            </>
        ),
    });

    // Summary by product + frequency
    const totals = new Map<string, { qty: number; runs: number }>();
    for (const k of monthKeys) {
        for (const e of months[k]) {
            const v = totals.get(e.productId) || { qty: 0, runs: 0 };
            v.qty += e.qty;
            v.runs += 1;
            totals.set(e.productId, v);
        }
    }
    const produced = products.filter((p) => totals.has(p.id));
    const productRows: Row[] = produced.map((p, i) => ({
        key: p.id,
        cells: [i + 1, p.name, <span className="num">{fmt(totals.get(p.id)?.qty || 0)}</span>],
    }));
    const productChunks = paginate(productRows);
    productChunks.forEach((chunk, i) => {
        pages.push({
            title: `ສະຫຼຸບຍອດລວມແຕ່ລະລາຍການ (${range})`,
            body: (
                <>
                    <Table
                        spec={{ head: ['ລຳດັບ', 'ລາຍການຜະລິດ', 'ຈຳນວນລວມທັງໝົດ'], widths: ['9%', '66%', '25%'], align: ['center', 'left', 'right'] }}
                        rows={chunk}
                    />
                    {i === productChunks.length - 1 && (
                        <>
                            <TotalLine label={`ລວມຍອດທັງໝົດ (${monthKeys.length} ເດືອນ)`} value={fmt(grand)} />
                            <Signatures />
                        </>
                    )}
                </>
            ),
        });
    });

    const totalRuns = [...totals.values()].reduce((s, v) => s + v.runs, 0);
    const freqRows: Row[] = produced.map((p, i) => ({
        key: p.id,
        cells: [i + 1, p.name, `ຜະລິດ ${totals.get(p.id)?.runs || 0} ຄັ້ງ`],
    }));
    const freqChunks = paginate(freqRows);
    freqChunks.forEach((chunk, i) => {
        pages.push({
            title: `ສະຫຼຸບຄວາມຖີ່ໃນການຜະລິດ (${range})`,
            note:
                i === 0
                    ? 'ໝາຍເຫດ: ຂໍ້ມູນດ້ານລຸ່ມນີ້ສະແດງເຖິງ "ຈຳນວນຄັ້ງທີ່ຜະລິດ" ບໍ່ແມ່ນການລວມຍອດຈຳນວນສິນຄ້າ.'
                    : undefined,
            body: (
                <>
                    <Table
                        spec={{
                            head: ['ລຳດັບ', 'ລາຍການຜະລິດ', `ຈຳນວນຄັ້ງທີ່ຜະລິດ (${range.replace(` / ${year}`, '')})`],
                            widths: ['9%', '59%', '32%'],
                            align: ['center', 'left', 'left'],
                        }}
                        rows={chunk}
                    />
                    {i === freqChunks.length - 1 && (
                        <>
                            <TotalLine
                                label={`ລວມຈຳນວນຄັ້ງທີ່ຜະລິດທັງໝົດ ຕັ້ງແຕ່ເດືອນ ${firstM} ຫາ ເດືອນ ${lastM}`}
                                value={`${totalRuns} ຄັ້ງ`}
                            />
                            <Signatures />
                        </>
                    )}
                </>
            ),
        });
    });

    return renderDoc(pages);
}
