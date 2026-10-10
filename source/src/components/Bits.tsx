import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { useI18n } from '../lib/i18n';

export function PageHeader({ eyebrow, title, sub, actions }: { eyebrow?: string; title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
    return (
        <header className="page-head">
            <div className="page-head-text">
                {eyebrow && <p className="eyebrow">{eyebrow}</p>}
                <h1 className="page-title">{title}</h1>
                {sub && <p className="page-sub">{sub}</p>}
            </div>
            {actions && <div className="page-actions">{actions}</div>}
        </header>
    );
}

export function YearSwitch({ year, onChange }: { year: number; onChange: (y: number) => void }) {
    const { t } = useI18n();
    return (
        <div className="year-switch" role="group" aria-label={t('year')}>
            <button type="button" className="icon-btn" onClick={() => onChange(year - 1)} aria-label={t('prev')}>
                <Icon name="chevronLeft" size={18} />
            </button>
            <span className="year-value num" aria-live="polite">
                {year}
            </span>
            <button type="button" className="icon-btn" onClick={() => onChange(year + 1)} aria-label={t('next')}>
                <Icon name="chevronRight" size={18} />
            </button>
        </div>
    );
}

export function Delta({ value }: { value: number | null }) {
    const { t } = useI18n();
    if (value === null || !Number.isFinite(value)) {
        return null;
    }
    const up = value >= 0;
    return (
        <span className={`delta ${up ? 'is-up' : 'is-down'}`} title={t('vsPrev')}>
            <Icon name={up ? 'trendUp' : 'trendDown'} size={14} stroke={2.4} />
            <span className="num">
                {up ? '+' : ''}
                {value.toFixed(1)}%
            </span>
        </span>
    );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
    return (
        <div className="skeleton-wrap" aria-hidden="true">
            {Array.from({ length: rows }, (_, i) => (
                <div key={i} className="skeleton" style={{ animationDelay: `${i * 120}ms` }} />
            ))}
        </div>
    );
}
