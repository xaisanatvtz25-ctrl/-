import { useMemo } from 'react';
import { Icon } from './Icon';
import { PlanList } from './PlanList';
import { useI18n } from '../lib/i18n';
import { useStore } from '../lib/store';
import { useEditor } from '../lib/editor';
import { fmt, longDate, todayIso } from '../lib/format';
import { suggestToday } from '../lib/suggest';
import type { Suggestion } from '../lib/suggest';
import type { EntryModalState } from './EntryModal';

/** at most this many plan items on the overview (the rest is on the weekly analysis page) */
const PLAN_SHOWN = 6;

/** "What should we produce today?": the plan sent from the weekly stock analysis, then hints from past production. */
export function TodayCard({ openEntry }: { openEntry: (state: EntryModalState) => void }) {
    const { t } = useI18n();
    const { products, months, plan } = useStore();
    const { canEdit } = useEditor();
    const today = todayIso();
    const list = useMemo(() => suggestToday(products, months, today), [products, months, today]);

    // the plan: what is not made yet first (in its order), and what was made today
    const planShown = useMemo(() => {
        const open = plan.filter((p) => !p.done);
        const doneToday = plan.filter((p) => p.done && p.date === today);
        return [...open, ...doneToday].sort((a, b) => a.order - b.order).slice(0, PLAN_SHOWN);
    }, [plan, today]);
    const planDone = plan.filter((p) => p.done).length;

    const why = (s: Suggestion) => {
        if (s.reason === 'overdue') {
            return t('sugOverdue', { days: s.daysSince ?? 0, every: s.every });
        }
        if (s.reason === 'notThisMonth') {
            return t('sugNotThisMonth', { avg: fmt(s.monthAvg) });
        }
        return t('sugBehind', { done: fmt(s.monthDone), avg: fmt(s.monthAvg) });
    };

    return (
        <article className="card today-card rise" style={{ animationDelay: '200ms' }}>
            <div className="card-head">
                <div>
                    <h2 className="card-title today-title">
                        <span className="today-icon" aria-hidden="true">
                            <Icon name="bulb" size={18} />
                        </span>
                        {t('sugTitle')}
                    </h2>
                    <p className="card-sub">
                        {longDate(today)} · {plan.length ? t('planTitle') : t('sugSub')}
                    </p>
                </div>
            </div>

            {plan.length > 0 && (
                <div className="today-plan">
                    <div className="today-plan-head">
                        <strong>
                            <Icon name="analysis" size={16} />
                            {t('planTitle')}
                        </strong>
                        <span className="today-plan-progress">
                            {planDone === plan.length ? t('planAllDone') : t('planProgress', { done: planDone, total: plan.length })}
                        </span>
                    </div>
                    {planShown.length > 0 && (
                        <PlanList
                            items={planShown}
                            products={products}
                            today={today}
                            canEdit={canEdit}
                            onRecord={(it) => openEntry({ mode: 'add', month: today.slice(0, 7), productId: it.productId, qty: it.qty, date: today })}
                        />
                    )}
                    <a className="link-btn today-plan-all" href="#/weekly">
                        {t('planAll')}
                        <Icon name="chevronRight" size={15} />
                    </a>
                </div>
            )}

            {plan.length === 0 && (
                <a className="today-go" href="#/weekly">
                    <Icon name="sparkles" size={16} />
                    <span>{t('todayGoChoose')}</span>
                    <Icon name="chevronRight" size={15} />
                </a>
            )}

            {list.length === 0 ? (
                <div className="empty-mini">{t('sugNone')}</div>
            ) : (
                <ol className="sug-list">
                    {list.map((s, i) => (
                        <li key={s.productId} className="sug-item" style={{ animationDelay: `${260 + i * 50}ms` }}>
                            <span className="sug-rank num">{i + 1}</span>
                            <div className="sug-body">
                                <p className="sug-name">{s.name}</p>
                                <p className="sug-reason">{why(s)}</p>
                            </div>
                            <div className="sug-side">
                                <span className="sug-qty">
                                    <small>{t('sugAbout')}</small>
                                    <span className="num">{fmt(s.qty)}</span>
                                </span>
                                {canEdit && (
                                    <button
                                        type="button"
                                        className="icon-btn sug-add"
                                        aria-label={`${t('addProduction')}: ${s.name}`}
                                        title={t('addProduction')}
                                        onClick={() => openEntry({ mode: 'add', month: today.slice(0, 7), productId: s.productId, qty: s.qty, date: today })}
                                    >
                                        <Icon name="plus" size={17} />
                                    </button>
                                )}
                            </div>
                        </li>
                    ))}
                </ol>
            )}
            <p className="sug-note">{t('sugNote')}</p>
        </article>
    );
}
