import { useId, useState } from 'react';

import logoUrl from '../assets/logo.jpg';

/** Company logo, embedded in the page. Falls back to the drawn mark. */
export const LOGO_SRC = logoUrl;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
    const [x1, y1] = polar(cx, cy, r, from);
    const [x2, y2] = polar(cx, cy, r, to);
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    const sweep = to > from ? 1 : 0;
    return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${large} ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

const RING = arc(60, 60, 45, -52, -318);
const BRISTLES = [
    { d: arc(60, 60, 51, -46, 22), w: 2.2, dash: '9 4 16 5 6 3' },
    { d: arc(60, 60, 47.5, -38, 34), w: 2.6, dash: '14 5 7 4 20 6' },
    { d: arc(60, 60, 43, -30, 30), w: 2, dash: '6 5 12 4 9 6' },
    { d: arc(60, 60, 39.5, -22, 26), w: 1.6, dash: '10 6 5 5' },
];

interface MarkProps {
    size?: number;
    animated?: boolean;
    light?: boolean;
    className?: string;
}

/** Brush-ring "M" mark, drawn after the company logo. */
export function LogoMark({ size = 40, animated = false, light = false, className }: MarkProps) {
    const uid = useId().replace(/:/g, '');
    const g1 = `mk-a-${uid}`;
    const g2 = `mk-b-${uid}`;
    return (
        <svg
            className={`logo-mark${animated ? ' is-animated' : ''}${className ? ` ${className}` : ''}`}
            width={size}
            height={size}
            viewBox="0 0 120 120"
            role="img"
            aria-label="Milako"
        >
            <defs>
                <linearGradient id={g1} x1="0" y1="1" x2="1" y2="0">
                    <stop offset="0" stopColor={light ? '#BFE6FA' : '#1E86C8'} />
                    <stop offset="1" stopColor={light ? '#FFFFFF' : '#6CC6F0'} />
                </linearGradient>
                <linearGradient id={g2} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor={light ? '#FFFFFF' : '#2A93D3'} />
                    <stop offset="1" stopColor={light ? '#D6F0FC' : '#5DBDEB'} />
                </linearGradient>
            </defs>
            <path
                className="logo-ring"
                d={RING}
                pathLength={1}
                fill="none"
                stroke={`url(#${g1})`}
                strokeWidth={13}
                strokeLinecap="round"
            />
            <g className="logo-bristles" fill="none" stroke={`url(#${g1})`} strokeLinecap="round">
                {BRISTLES.map((b, i) => (
                    <path key={i} d={b.d} strokeWidth={b.w} strokeDasharray={b.dash} opacity={0.75 - i * 0.12} />
                ))}
            </g>
            <path
                className="logo-m"
                d="M41 81V41L60 63L79 41V81"
                pathLength={1}
                fill="none"
                stroke={`url(#${g2})`}
                strokeWidth={11}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

interface BrandProps {
    size?: number;
    className?: string;
}

/** Full logo image if uploaded, otherwise the drawn mark. */
export function BrandLogo({ size = 160, className }: BrandProps) {
    const [failed, setFailed] = useState(false);
    if (failed) {
        return <LogoMark size={size} animated className={className} />;
    }
    return (
        <img
            className={`brand-logo${className ? ` ${className}` : ''}`}
            src={LOGO_SRC}
            width={size}
            height={size}
            alt="ບໍລິສັດ ມິລະໂກະ"
            onError={() => setFailed(true)}
        />
    );
}
