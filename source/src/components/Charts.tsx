import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fmt } from '../lib/format';
import { CountUp } from './CountUp';

export const CHART_COLORS = ['#1B76B8', '#3BA3DB', '#86CDF1', '#F2A93B', '#E4572E', '#2BA37A', '#9AA8BD'];

function useWidth<T extends HTMLElement>(fallback: number) {
    const ref = useRef<T>(null);
    const [width, setWidth] = useState(fallback);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) {
            return;
        }
        setWidth(el.clientWidth || fallback);
        if (typeof ResizeObserver === 'undefined') {
            return;
        }
        const ro = new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect.width;
            if (w) {
                setWidth(w);
            }
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [fallback]);
    return [ref, width] as const;
}

function useMounted(delay = 30): boolean {
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        const id = window.setTimeout(() => setMounted(true), delay);
        return () => window.clearTimeout(id);
    }, [delay]);
    return mounted;
}

type Pt = [number, number];

/** Monotone cubic interpolation: smooth, never overshoots below zero. */
function monotonePath(pts: Pt[]): string {
    const n = pts.length;
    if (n === 0) {
        return '';
    }
    if (n === 1) {
        return `M${pts[0][0]},${pts[0][1]}`;
    }
    const dx: number[] = [];
    const m: number[] = [];
    for (let i = 0; i < n - 1; i++) {
        dx.push(pts[i + 1][0] - pts[i][0]);
        m.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]));
    }
    const t: number[] = new Array(n).fill(0);
    t[0] = m[0];
    t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) {
        if (m[i - 1] * m[i] <= 0) {
            t[i] = 0;
        } else {
            t[i] = (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
        }
    }
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
        const h = dx[i] / 3;
        d += `C${(pts[i][0] + h).toFixed(1)},${(pts[i][1] + t[i] * h).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)},${(
            pts[i + 1][1] - t[i + 1] * h
        ).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
    }
    return d;
}

function niceMax(v: number): number {
    if (v <= 0) {
        return 10;
    }
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / exp;
    const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nice * exp;
}

function shortNum(n: number): string {
    if (n >= 1000) {
        const k = n / 1000;
        return `${k % 1 === 0 ? k : k.toFixed(1)}k`;
    }
    return String(Math.round(n));
}

interface TrendProps {
    values: Array<number | null>;
    labels: string[];
    fullLabels: string[];
    highlight?: number;
    current?: number;
    onSelect?: (index: number) => void;
    height?: number;
}

export function TrendChart({ values, labels, fullLabels, highlight = -1, current = -1, onSelect, height = 260 }: TrendProps) {
    const [ref, width] = useWidth<HTMLDivElement>(640);
    const [hover, setHover] = useState<number | null>(null);
    const pad = { top: 22, right: 18, bottom: 34, left: 46 };
    const innerW = Math.max(10, width - pad.left - pad.right);
    const innerH = height - pad.top - pad.bottom;
    const numeric = values.filter((v): v is number => v !== null);
    const max = niceMax(Math.max(1, ...numeric) * 1.08);
    const x = (i: number) => pad.left + (innerW * i) / Math.max(1, values.length - 1);
    const y = (v: number) => pad.top + innerH * (1 - v / max);

    const lastIndex = values.reduce<number>((acc, v, i) => (v !== null ? i : acc), -1);
    const pts: Pt[] = [];
    for (let i = 0; i <= lastIndex; i++) {
        pts.push([x(i), y(values[i] ?? 0)]);
    }
    const line = monotonePath(pts);
    const area = pts.length > 1 ? `${line}L${pts[pts.length - 1][0]},${pad.top + innerH}L${pts[0][0]},${pad.top + innerH}Z` : '';
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
    const active = hover;

    return (
        <div className="trend" ref={ref}>
            <svg width={width} height={height} role="img" aria-label="trend chart" key={`${values.join(',')}`}>
                <defs>
                    <linearGradient id="trend-area" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor="#3BA3DB" stopOpacity="0.34" />
                        <stop offset="1" stopColor="#3BA3DB" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="trend-line" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0" stopColor="#1B76B8" />
                        <stop offset="1" stopColor="#3BA3DB" />
                    </linearGradient>
                </defs>
                {ticks.map((tv, i) => (
                    <g key={i}>
                        <line
                            x1={pad.left}
                            x2={pad.left + innerW}
                            y1={y(tv)}
                            y2={y(tv)}
                            className={i === 0 ? 'grid-base' : 'grid-line'}
                        />
                        <text x={pad.left - 10} y={y(tv) + 4} textAnchor="end" className="axis-label">
                            {shortNum(tv)}
                        </text>
                    </g>
                ))}
                {labels.map((label, i) => (
                    <text
                        key={label + i}
                        x={x(i)}
                        y={height - 10}
                        textAnchor="middle"
                        className={`axis-label${i === current ? ' is-current' : ''}${values[i] === null ? ' is-future' : ''}`}
                    >
                        {label}
                    </text>
                ))}
                {active !== null && values[active] !== null && (
                    <line className="crosshair" x1={x(active)} x2={x(active)} y1={pad.top} y2={pad.top + innerH} />
                )}
                {area && <path d={area} fill="url(#trend-area)" className="chart-area" />}
                {line && (
                    <path
                        d={line}
                        pathLength={1}
                        fill="none"
                        stroke="url(#trend-line)"
                        strokeWidth={3}
                        strokeLinecap="round"
                        className="chart-line"
                    />
                )}
                {values.map((v, i) =>
                    v === null ? null : (
                        <circle
                            key={i}
                            cx={x(i)}
                            cy={y(v)}
                            r={active === i ? 7 : i === highlight ? 6 : 4.5}
                            className={`chart-dot${i === highlight ? ' is-best' : ''}${active === i ? ' is-active' : ''}`}
                            style={{ animationDelay: `${600 + i * 70}ms` }}
                        />
                    ),
                )}
                {values.map((v, i) => (
                    <rect
                        key={`hit-${i}`}
                        x={x(i) - innerW / 22}
                        y={pad.top}
                        width={innerW / 11}
                        height={innerH + pad.bottom}
                        fill="transparent"
                        className={v === null ? '' : 'hit'}
                        onMouseEnter={() => setHover(v === null ? null : i)}
                        onMouseLeave={() => setHover(null)}
                        onClick={() => v !== null && onSelect && onSelect(i)}
                    />
                ))}
            </svg>
            {active !== null && values[active] !== null && (
                <div
                    className="chart-tip"
                    style={{
                        left: Math.min(Math.max(x(active), 70), width - 70),
                        top: Math.max(0, y(values[active] as number) - 64),
                    }}
                >
                    <div className="chart-tip-label">{fullLabels[active]}</div>
                    <div className="chart-tip-value num">{fmt(values[active] as number)}</div>
                </div>
            )}
        </div>
    );
}

export interface DonutSegment {
    label: string;
    value: number;
    color: string;
}

interface DonutProps {
    segments: DonutSegment[];
    total: number;
    centerLabel: string;
    size?: number;
}

export function Donut({ segments, total, centerLabel, size = 196 }: DonutProps) {
    const mounted = useMounted(60);
    const r = 15.915; // circumference = 100
    let acc = 0;
    const gap = segments.length > 1 ? 0.8 : 0;
    return (
        <div className="donut" style={{ width: size, height: size }}>
            <svg viewBox="0 0 42 42" width={size} height={size} aria-hidden="true">
                <circle cx="21" cy="21" r={r} fill="none" className="donut-track" strokeWidth="5.2" />
                {segments.map((s, i) => {
                    const len = total > 0 ? (s.value / total) * 100 : 0;
                    const offset = acc;
                    acc += len;
                    const visible = Math.max(0, len - gap);
                    return (
                        <circle
                            key={s.label + i}
                            cx="21"
                            cy="21"
                            r={r}
                            fill="none"
                            stroke={s.color}
                            strokeWidth="5.2"
                            strokeDasharray={mounted ? `${visible} ${100 - visible}` : `0 100`}
                            strokeDashoffset={25 - offset}
                            strokeLinecap="butt"
                            style={{ transition: `stroke-dasharray 900ms var(--ease-out) ${i * 90}ms` }}
                        />
                    );
                })}
            </svg>
            <div className="donut-center">
                <CountUp value={total} className="donut-total" />
                <span className="donut-label">{centerLabel}</span>
            </div>
        </div>
    );
}

interface SparkProps {
    values: number[];
    width?: number;
    height?: number;
    color?: string;
}

export function Sparkline({ values, width = 132, height = 36, color = '#3BA3DB' }: SparkProps) {
    const id = useMemo(() => `sp-${Math.random().toString(36).slice(2, 8)}`, []);
    const max = Math.max(1, ...values);
    const step = width / Math.max(1, values.length - 1);
    const pts: Pt[] = values.map((v, i) => [i * step, height - 3 - (v / max) * (height - 8)]);
    const line = monotonePath(pts);
    const area = `${line}L${width},${height}L0,${height}Z`;
    return (
        <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            <defs>
                <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor={color} stopOpacity="0.28" />
                    <stop offset="1" stopColor={color} stopOpacity="0" />
                </linearGradient>
            </defs>
            <path d={area} fill={`url(#${id})`} className="spark-area" />
            <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" pathLength={1} className="spark-line" />
        </svg>
    );
}
