/**
 * Weekly stock analysis: how much of each product went out between two stock sheets,
 * how many days the stock left will last, how urgent it is, and how much to produce.
 *
 *   outflow        = previous ຈຳນວນ (+ produced in between, if typed) − ຍັງເຫຼືອ now
 *   per day        = outflow ÷ days between the two sheets (the average of the last 4 weeks when there are more)
 *   days left      = ຍັງເຫຼືອ ÷ per day
 *   to produce     = per day × target days − ຍັງເຫຼືອ
 * If the stock went up and nothing produced was typed, the outflow is unknown ("produced in between").
 */

export interface StockSettings {
    /** less than this many days left: urgent */
    urgent: number;
    /** up to this many days: next round; more: not needed yet */
    soon: number;
    /** produce enough for this many days */
    target: number;
    /** productions per working day (to date the plan) */
    perDay: number;
}

export const DEFAULT_SETTINGS: StockSettings = { urgent: 14, soon: 35, target: 30, perDay: 4 };

export function cleanSettings(raw: unknown): StockSettings {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const num = (v: unknown, def: number, min: number, max: number) => {
        const n = Math.round(Number(v));
        return Number.isFinite(n) && n >= min && n <= max ? n : def;
    };
    const urgent = num(o.urgent, DEFAULT_SETTINGS.urgent, 1, 365);
    const soon = Math.max(urgent, num(o.soon, DEFAULT_SETTINGS.soon, 1, 730));
    return { urgent, soon, target: num(o.target, DEFAULT_SETTINGS.target, 1, 365), perDay: num(o.perDay, DEFAULT_SETTINGS.perDay, 1, 20) };
}

/** the numbers used for one product in one week */
export interface WeekRow {
    /** product id */
    p: string;
    /** ຈຳນວນ on the previous sheet */
    prev: number | null;
    /** ຈຳນວນ on this sheet */
    qty: number | null;
    /** ເບີກໄປພາກໃຕ້ on this sheet */
    south: number | null;
    /** ຍັງເຫຼືອ on this sheet */
    left: number | null;
    /** produced between the two sheets (typed by the person, optional) */
    made: number | null;
}

export interface Week {
    id: string;
    savedAt: number;
    by: string;
    prevDate: string;
    currDate: string;
    days: number;
    rows: WeekRow[];
    files?: { prev?: string; curr?: string };
}

export type Group = 'urgent' | 'next' | 'later' | 'refill' | 'nodata';

export interface Result {
    productId: string;
    left: number | null;
    south: number | null;
    /** outflow in this period (null: unknown) */
    out: number | null;
    /** the stock went up: produced in between */
    refill: boolean;
    /** per day in this period */
    dailyNow: number | null;
    /** per day used: average of up to 4 weeks */
    daily: number | null;
    /** weeks in that average */
    weeks: number;
    /** days the stock left will last (Infinity: nothing goes out) */
    cover: number | null;
    group: Group;
    /** suggested quantity to produce */
    suggest: number;
}

const GROUP_RANK: Record<Group, number> = { urgent: 0, next: 1, later: 2, refill: 3, nodata: 4 };

export function outflow(r: WeekRow): { out: number | null; refill: boolean } {
    if (r.prev === null || r.left === null) {
        return { out: null, refill: false };
    }
    if (!r.made && r.left > r.prev) {
        return { out: null, refill: true };
    }
    return { out: Math.max(0, r.prev + (r.made || 0) - r.left), refill: false };
}

export function daysBetween(from: string, to: string): number {
    const a = Date.parse(`${from}T00:00:00Z`);
    const b = Date.parse(`${to}T00:00:00Z`);
    return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : 0;
}

/** The analysis of this week's rows; earlier saved weeks give the 4-week average. Sorted: most urgent first. */
export function analyze(rows: WeekRow[], days: number, currDate: string, history: Week[], s: StockSettings): Result[] {
    const earlier = history
        .filter((w) => w.currDate < currDate && w.days > 0)
        .sort((a, b) => (a.currDate < b.currDate ? 1 : -1))
        .slice(0, 3);
    const out = rows.map((r): Result => {
        const now = outflow(r);
        const dailyNow = now.out !== null && days > 0 ? now.out / days : null;
        let total = 0;
        let totalDays = 0;
        let weeks = 0;
        if (now.out !== null && days > 0) {
            total += now.out;
            totalDays += days;
            weeks += 1;
        }
        for (const w of earlier) {
            const wr = w.rows.find((x) => x.p === r.p);
            const o = wr ? outflow(wr).out : null;
            if (o !== null) {
                total += o;
                totalDays += w.days;
                weeks += 1;
            }
        }
        const daily = totalDays > 0 ? total / totalDays : null;
        let cover: number | null = null;
        let group: Group;
        if (r.left === null) {
            group = 'nodata';
        } else if (daily === null) {
            group = now.refill ? 'refill' : 'nodata';
        } else {
            cover = daily > 0 ? r.left / daily : Infinity;
            group = cover < s.urgent ? 'urgent' : cover <= s.soon ? 'next' : 'later';
        }
        const suggest = daily !== null && r.left !== null ? Math.max(0, Math.ceil(daily * s.target - r.left)) : 0;
        return { productId: r.p, left: r.left, south: r.south, out: now.out, refill: now.refill, dailyNow, daily, weeks, cover, group, suggest };
    });
    return out.sort((a, b) => GROUP_RANK[a.group] - GROUP_RANK[b.group] || (a.cover ?? Infinity) - (b.cover ?? Infinity) || (b.daily ?? 0) - (a.daily ?? 0));
}

/** the 5 products that went out fastest (per day) */
export function topSellers(results: Result[], n = 5): Result[] {
    return results
        .filter((r) => r.daily !== null && r.daily > 0)
        .sort((a, b) => (b.daily as number) - (a.daily as number))
        .slice(0, n);
}

/* ---------- dates for the plan (production runs Monday–Friday) ---------- */

function addDays(iso: string, n: number): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

export function isWorkday(iso: string): boolean {
    const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
    return day >= 1 && day <= 5;
}

export function nextWorkday(iso: string, includeSelf = false): string {
    let d = includeSelf ? iso : addDays(iso, 1);
    for (let i = 0; i < 7 && !isWorkday(d); i += 1) {
        d = addDays(d, 1);
    }
    return d;
}

/** first day of the plan: today (or the next working day), never before the sheet */
export function planStart(currDate: string, today: string): string {
    const fromToday = nextWorkday(today, true);
    const fromSheet = currDate ? nextWorkday(currDate, true) : fromToday;
    return fromSheet > fromToday ? fromSheet : fromToday;
}

/** a date for each item in order: `perDay` items per working day */
export function schedule(count: number, start: string, perDay: number): string[] {
    const out: string[] = [];
    let day = nextWorkday(start, true);
    let used = 0;
    for (let i = 0; i < count; i += 1) {
        if (used >= Math.max(1, perDay)) {
            day = nextWorkday(day);
            used = 0;
        }
        out.push(day);
        used += 1;
    }
    return out;
}
