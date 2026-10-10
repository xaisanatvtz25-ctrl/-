import { Icon } from './Icon';
import { useI18n } from '../lib/i18n';
import { fmt, longDate } from '../lib/format';
import type { PlanItem, Product } from '../lib/types';

function addDays(iso: string, n: number): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

interface Props {
    items: PlanItem[];
    products: Product[];
    today: string;
    canEdit: boolean;
    /** open the production form for this item (saving it marks the item produced) */
    onRecord: (item: PlanItem) => void;
    /** mark produced / not produced without a production run */
    onToggle?: (item: PlanItem, done: boolean) => void;
    busy?: string | null;
}

/** The production plan sent from the weekly stock analysis: what to make, in order, with the day. */
export function PlanList({ items, products, today, canEdit, onRecord, onToggle, busy }: Props) {
    const { t } = useI18n();
    const nameOf = new Map(products.map((p) => [p.id, p.name]));
    const tomorrow = addDays(today, 1);

    const dayLabel = (d: string) => (!d ? '' : d === today ? t('today') : d === tomorrow ? t('planTomorrow') : longDate(d));

    return (
        <ol className="plan-list">
            {items.map((it) => {
                const late = !it.done && it.date && it.date < today;
                const now = !it.done && it.date === today;
                return (
                    <li key={it.id} className={`plan-item${it.done ? ' is-done' : ''}${late ? ' is-late' : ''}${now ? ' is-today' : ''}`}>
                        <span className="plan-order num">{it.done ? <Icon name="check" size={15} stroke={3} /> : it.order}</span>
                        <div className="plan-body">
                            <p className="plan-name">{nameOf.get(it.productId) || '—'}</p>
                            <p className="plan-meta">
                                <span className="plan-day">
                                    <Icon name="calendar" size={13} />
                                    {dayLabel(it.date)}
                                </span>
                                {late && <span className="badge plan-late">{t('planLate')}</span>}
                                {it.done && <span className="plan-done-by">{t('planDoneBy', { by: it.done.by })}</span>}
                            </p>
                        </div>
                        <div className="plan-side">
                            <span className="plan-qty num">{fmt(it.qty)}</span>
                            {canEdit && !it.done && (
                                <button
                                    type="button"
                                    className="btn btn-success btn-sm plan-record"
                                    onClick={() => onRecord(it)}
                                    disabled={busy === it.id}
                                    aria-label={`${t('planRecord')}: ${nameOf.get(it.productId) || ''}`}
                                >
                                    <Icon name="check" size={15} stroke={2.6} />
                                    <span className="plan-record-text">{t('planRecord')}</span>
                                </button>
                            )}
                            {canEdit && it.done && onToggle && !it.done.entry && (
                                <button type="button" className="link-btn plan-undo" onClick={() => onToggle(it, false)} disabled={busy === it.id}>
                                    {t('planUndo')}
                                </button>
                            )}
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}
