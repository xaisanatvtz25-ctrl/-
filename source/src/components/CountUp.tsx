import { useEffect, useRef, useState } from 'react';
import { fmt } from '../lib/format';

function prefersReducedMotion(): boolean {
    try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

const easeOutExpo = (x: number) => (x === 1 ? 1 : 1 - Math.pow(2, -10 * x));

interface Props {
    value: number;
    duration?: number;
    className?: string;
    format?: (n: number) => string;
}

/** Animated number that counts from its previous value to the new one. */
export function CountUp({ value, duration = 1100, className, format = fmt }: Props) {
    const [display, setDisplay] = useState(0);
    const fromRef = useRef(0);
    const frameRef = useRef(0);

    useEffect(() => {
        const from = fromRef.current;
        const to = value;
        if (prefersReducedMotion() || from === to) {
            fromRef.current = to;
            setDisplay(to);
            return;
        }
        const start = performance.now();
        const tick = (now: number) => {
            const p = Math.min(1, (now - start) / duration);
            const v = from + (to - from) * easeOutExpo(p);
            setDisplay(v);
            if (p < 1) {
                frameRef.current = requestAnimationFrame(tick);
            } else {
                fromRef.current = to;
            }
        };
        frameRef.current = requestAnimationFrame(tick);
        return () => {
            cancelAnimationFrame(frameRef.current);
            fromRef.current = to;
        };
    }, [value, duration]);

    return (
        <span className={`num ${className || ''}`} aria-label={format(value)}>
            <span aria-hidden="true">{format(display)}</span>
        </span>
    );
}
