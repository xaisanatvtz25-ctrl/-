/**
 * "What should we produce today?" — worked out from past production only:
 * how often each product is usually made, how long ago it was last made,
 * and how this month compares with a normal month.
 */
import type { Entry, MonthMap, Product } from './types';

export type SuggestReason = 'overdue' | 'notThisMonth' | 'behind';

export interface Suggestion {
    productId: string;
    name: string;
    /** suggested quantity: the usual size of one production run */
    qty: number;
    score: number;
    reason: SuggestReason;
    /** days since it was last made (null when no date is known) */
    daysSince: number | null;
    /** usual number of days between runs */
    every: number;
    /** made this month so far */
    monthDone: number;
    /** made in a normal month (average of the last 6 months) */
    monthAvg: number;
}

function shiftYm(ym: string, delta: number): string {
    const y = Number(ym.slice(0, 4));
    const m = Number(ym.slice(5, 7));
    const idx = y * 12 + (m - 1) + delta;
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

function dayNumber(iso: string): number {
    return Math.floor(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000);
}

function median(xs: number[]): number {
    if (!xs.length) {
        return 0;
    }
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function niceQty(q: number): number {
    if (q >= 100) {
        return Math.max(10, Math.round(q / 10) * 10);
    }
    return Math.max(1, Math.round(q / 5) * 5 || Math.round(q));
}

/** Date to use for a run: its own date, or a guess inside its month when no date was written. */
function runDay(e: Entry, ym: string, today: string): string {
    if (e.date) {
        return e.date;
    }
    if (ym === today.slice(0, 7)) {
        const d = Math.max(1, Math.floor(Number(today.slice(8, 10)) / 2));
        return `${ym}-${String(d).padStart(2, '0')}`;
    }
    return `${ym}-15`;
}

/** Suggestions for `today` (YYYY-MM-DD), most urgent first. */
export function suggestToday(products: Product[], months: MonthMap, today: string, limit = 5): Suggestion[] {
    const ym = today.slice(0, 7);
    const day = Number(today.slice(8, 10));
    const daysInMonth = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
    const past6 = Array.from({ length: 6 }, (_, i) => shiftYm(ym, -(i + 1)));
    const window12 = Array.from({ length: 13 }, (_, i) => shiftYm(ym, -i));
    const todayN = dayNumber(today);
    const out: Suggestion[] = [];

    for (const p of products) {
        const active = past6.filter((k) => k >= p.since);
        if (!active.length) {
            continue; // too new to know its rhythm
        }
        let pastTotal = 0;
        let pastRuns = 0;
        let monthsMade = 0;
        for (const k of active) {
            const list = (months[k] || []).filter((e) => e.productId === p.id);
            if (list.length) {
                monthsMade += 1;
            }
            pastRuns += list.length;
            pastTotal += list.reduce((s, e) => s + e.qty, 0);
        }
        if (pastTotal === 0) {
            continue; // not made in the last 6 months: not a regular product now
        }
        const runs: Array<{ day: number; qty: number; dated: boolean }> = [];
        for (const k of window12) {
            for (const e of months[k] || []) {
                if (e.productId === p.id) {
                    runs.push({ day: dayNumber(runDay(e, k, today)), qty: e.qty, dated: Boolean(e.date) });
                }
            }
        }
        const current = (months[ym] || []).filter((e) => e.productId === p.id);
        if (current.some((e) => e.date === today)) {
            continue; // already made today
        }
        const monthDone = current.reduce((s, e) => s + e.qty, 0);
        const monthAvg = pastTotal / active.length;
        const runsPerMonth = pastRuns / active.length;
        const regular = monthsMade / active.length;

        const datedDays = [...new Set(runs.filter((r) => r.dated && r.day <= todayN).map((r) => r.day))].sort((a, b) => a - b);
        let every = 30 / Math.max(runsPerMonth, 0.25);
        if (datedDays.length >= 4) {
            const gaps = datedDays.slice(1).map((d, i) => d - datedDays[i]).filter((g) => g > 0);
            if (gaps.length >= 3) {
                every = median(gaps);
            }
        }
        every = Math.min(90, Math.max(3, Math.round(every)));

        const lastDay = Math.max(-Infinity, ...runs.filter((r) => r.day <= todayN).map((r) => r.day));
        const daysSince = Number.isFinite(lastDay) ? todayN - lastDay : null;
        const overdue = daysSince === null ? 1 : daysSince / every;
        const expected = monthAvg * (day / daysInMonth);
        const behind = monthAvg > 0 ? (Math.max(0, expected - monthDone) / monthAvg) * regular : 0;
        if (overdue < 0.85 && behind < 0.25) {
            continue;
        }
        const reason: SuggestReason = overdue >= 0.85 && daysSince !== null ? 'overdue' : monthDone === 0 ? 'notThisMonth' : 'behind';
        out.push({
            productId: p.id,
            name: p.name,
            qty: niceQty(median(runs.map((r) => r.qty))),
            score: overdue + 1.5 * behind,
            reason,
            daysSince,
            every,
            monthDone,
            monthAvg: Math.round(monthAvg),
        });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
