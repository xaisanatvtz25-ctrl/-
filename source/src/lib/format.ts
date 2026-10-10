export function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

export function fmt(n: number): string {
    return Math.round(n).toLocaleString('en-US');
}

export function toYm(year: number, month: number): string {
    return `${year}-${pad2(month)}`;
}

export function parseYm(value: string): { y: number; m: number } {
    const [y, m] = value.split('-').map(Number);
    return { y, m };
}

export function isYm(value: string | undefined | null): value is string {
    return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function todayIso(): string {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function currentYm(): string {
    return todayIso().slice(0, 7);
}

export function shiftYm(value: string, delta: number): string {
    const { y, m } = parseYm(value);
    const idx = y * 12 + (m - 1) + delta;
    return toYm(Math.floor(idx / 12), (idx % 12) + 1);
}

/** 2026-09-24 -> 24/9/26 (same style as the company report) */
export function shortDate(iso: string): string {
    if (!iso) {
        return '';
    }
    const [y, m, d] = iso.split('-');
    return `${Number(d)}/${Number(m)}/${y.slice(2)}`;
}

/** 2026-09-24 -> 24/9/2026 */
export function longDate(iso: string): string {
    if (!iso) {
        return '';
    }
    const [y, m, d] = iso.split('-');
    return `${Number(d)}/${Number(m)}/${y}`;
}

export function daysInMonth(year: number, month: number): number {
    return new Date(year, month, 0).getDate();
}

export function pctChange(current: number, previous: number): number | null {
    if (!previous) {
        return null;
    }
    return ((current - previous) / previous) * 100;
}
