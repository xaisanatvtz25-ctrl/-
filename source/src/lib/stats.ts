import type { Entry, MonthMap, Product } from './types';
import { toYm } from './format';

export function sumQty(entries: Entry[]): number {
    let total = 0;
    for (const e of entries) {
        total += e.qty;
    }
    return total;
}

export function sortEntries(entries: Entry[]): Entry[] {
    return [...entries].sort((a, b) => {
        if (a.date && b.date && a.date !== b.date) {
            return a.date < b.date ? -1 : 1;
        }
        if (a.date && !b.date) {
            return 1;
        }
        if (!a.date && b.date) {
            return -1;
        }
        return a.createdAt - b.createdAt;
    });
}

export function monthEntries(months: MonthMap, ym: string): Entry[] {
    return months[ym] || [];
}

/** 12 numbers: totals for each month of the year */
export function yearSeries(months: MonthMap, year: number): number[] {
    const out: number[] = [];
    for (let m = 1; m <= 12; m++) {
        out.push(sumQty(monthEntries(months, toYm(year, m))));
    }
    return out;
}

export interface ProductGroup {
    product: Product | null;
    productId: string;
    qty: number;
    entries: Entry[];
}

export function groupByProduct(entries: Entry[], products: Product[]): ProductGroup[] {
    const byId = new Map(products.map((p) => [p.id, p]));
    const order = new Map(products.map((p, i) => [p.id, i]));
    const groups = new Map<string, ProductGroup>();
    for (const e of entries) {
        let g = groups.get(e.productId);
        if (!g) {
            g = { product: byId.get(e.productId) || null, productId: e.productId, qty: 0, entries: [] };
            groups.set(e.productId, g);
        }
        g.qty += e.qty;
        g.entries.push(e);
    }
    return [...groups.values()]
        .map((g) => ({ ...g, entries: sortEntries(g.entries) }))
        .sort((a, b) => (order.get(a.productId) ?? 9999) - (order.get(b.productId) ?? 9999));
}

export interface ProductYearStat {
    qty: number;
    runs: number;
    last: string;
    lastMonth: string;
    perMonth: number[];
}

export function productYearStats(months: MonthMap, year: number): Map<string, ProductYearStat> {
    const stats = new Map<string, ProductYearStat>();
    for (let m = 1; m <= 12; m++) {
        const ym = toYm(year, m);
        for (const e of monthEntries(months, ym)) {
            let s = stats.get(e.productId);
            if (!s) {
                s = { qty: 0, runs: 0, last: '', lastMonth: '', perMonth: new Array(12).fill(0) };
                stats.set(e.productId, s);
            }
            s.qty += e.qty;
            s.runs += 1;
            s.perMonth[m - 1] += e.qty;
            if (ym > s.lastMonth) {
                s.lastMonth = ym;
            }
            if (e.date && e.date > s.last) {
                s.last = e.date;
            }
        }
    }
    return stats;
}

export function yearsWithData(months: MonthMap): number[] {
    const years = new Set<number>();
    for (const key of Object.keys(months)) {
        if (months[key].length) {
            years.add(Number(key.slice(0, 4)));
        }
    }
    return [...years].sort((a, b) => a - b);
}

export function latestMonthWithData(months: MonthMap): string | null {
    const keys = Object.keys(months)
        .filter((k) => months[k].length > 0)
        .sort();
    return keys.length ? keys[keys.length - 1] : null;
}

export function countEntriesForProduct(months: MonthMap, productId: string): number {
    let n = 0;
    for (const key of Object.keys(months)) {
        for (const e of months[key]) {
            if (e.productId === productId) {
                n += 1;
            }
        }
    }
    return n;
}
