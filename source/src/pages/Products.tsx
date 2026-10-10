import { useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { Sparkline } from '../components/Charts';
import { PageHeader, YearSwitch } from '../components/Bits';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useEditor } from '../lib/editor';
import { apiErrorKey } from '../components/EditAccess';
import type { EntryModalState } from '../components/EntryModal';
import type { ProductModalState } from '../components/ProductModal';
import { useToast } from '../components/Toast';
import { useI18n } from '../lib/i18n';
import { useStore } from '../lib/store';
import { currentYm, fmt, longDate, parseYm, toYm } from '../lib/format';
import { countEntriesForProduct, productYearStats } from '../lib/stats';
import { errorCode } from '../lib/api';
import type { Product } from '../lib/types';

interface Props {
    year: number;
    setYear: (y: number) => void;
    openEntry: (state: EntryModalState) => void;
    openProduct: (state: ProductModalState) => void;
}

export function Products({ year, setYear, openEntry, openProduct }: Props) {
    const { t, monthName } = useI18n();
    const { products, months, deleteProduct } = useStore();
    const { canEdit } = useEditor();
    const toast = useToast();
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState<'order' | 'total'>('order');
    const [pending, setPending] = useState<Product | null>(null);

    const stats = useMemo(() => productYearStats(months, year), [months, year]);
    const now = currentYm();
    const quickMonth = parseYm(now).y === year ? now : toYm(year, 12);

    const list = useMemo(() => {
        const q = query.replace(/\s+/g, '').toLowerCase();
        const withIndex = products.map((p, i) => ({ p, no: i + 1 }));
        const filtered = q ? withIndex.filter(({ p }) => p.name.replace(/\s+/g, '').toLowerCase().includes(q)) : withIndex;
        if (sort === 'total') {
            return [...filtered].sort((a, b) => (stats.get(b.p.id)?.qty || 0) - (stats.get(a.p.id)?.qty || 0));
        }
        return filtered;
    }, [products, query, sort, stats]);

    const maxQty = Math.max(1, ...[...stats.values()].map((s) => s.qty));

    const askDelete = (p: Product) => {
        const n = countEntriesForProduct(months, p.id);
        if (n > 0) {
            toast.show(t('hasEntries', { n }), 'error');
            return;
        }
        setPending(p);
    };

    const confirmDelete = async () => {
        if (!pending) {
            return;
        }
        try {
            await deleteProduct(pending.id);
            toast.show(t('deleted'), 'success', 'delete');
            setPending(null);
        } catch (e) {
            const code = errorCode(e);
            const m = code.match(/has_entries:(\d+)/);
            toast.show(m ? t('hasEntries', { n: m[1] }) : t(apiErrorKey(e)), 'error');
            setPending(null);
        }
    };

    return (
        <div className="page">
            <PageHeader
                eyebrow={t('company')}
                title={t('productsTitle')}
                sub={t('productsSub', { year })}
                actions={
                    <>
                        <YearSwitch year={year} onChange={setYear} />
                        <button type="button" className="btn btn-primary" onClick={() => openProduct({ mode: 'add' })}>
                            <Icon name={canEdit ? 'plus' : 'lock'} size={18} />
                            {t('addProduct')}
                        </button>
                    </>
                }
            />

            <div className="toolbar rise">
                <label className="search">
                    <Icon name="search" size={18} />
                    <input type="search" value={query} placeholder={t('search')} aria-label={t('search')} onChange={(e) => setQuery(e.target.value)} />
                </label>
                <div className="seg" role="group">
                    <button type="button" className={`seg-btn${sort === 'order' ? ' is-active' : ''}`} aria-pressed={sort === 'order'} onClick={() => setSort('order')}>
                        {t('sortOrder')}
                    </button>
                    <button type="button" className={`seg-btn${sort === 'total' ? ' is-active' : ''}`} aria-pressed={sort === 'total'} onClick={() => setSort('total')}>
                        {t('sortTotal')}
                    </button>
                </div>
            </div>

            {list.length === 0 ? (
                <div className="card empty-mini">{t('noProducts')}</div>
            ) : (
                <div className="product-grid">
                    {list.map(({ p, no }, i) => {
                        const s = stats.get(p.id);
                        const last = s ? (s.last ? longDate(s.last) : `${monthName(parseYm(s.lastMonth).m)} ${year}`) : '';
                        return (
                            <article key={p.id} className="pcard rise" style={{ animationDelay: `${Math.min(i, 16) * 35}ms` }}>
                                <div className="pcard-top">
                                    <span className="pcard-no num">#{no}</span>
                                    {canEdit && <div className="pcard-actions">
                                        <button
                                            type="button"
                                            className="icon-btn icon-btn-sm"
                                            aria-label={`${t('record')}: ${p.name}`}
                                            title={t('record')}
                                            onClick={() => openEntry({ mode: 'add', month: quickMonth, productId: p.id })}
                                        >
                                            <Icon name="plus" size={16} />
                                        </button>
                                        <button
                                            type="button"
                                            className="icon-btn icon-btn-sm"
                                            aria-label={`${t('editProduct')}: ${p.name}`}
                                            title={t('editProduct')}
                                            onClick={() => openProduct({ mode: 'rename', product: p })}
                                        >
                                            <Icon name="pencil" size={15} />
                                        </button>
                                        <button
                                            type="button"
                                            className="icon-btn icon-btn-sm icon-btn-danger"
                                            aria-label={`${t('delete')}: ${p.name}`}
                                            title={t('delete')}
                                            onClick={() => askDelete(p)}
                                        >
                                            <Icon name="trash" size={15} />
                                        </button>
                                    </div>}
                                </div>
                                <h3 className="pcard-name">{p.name}</h3>
                                <div className="pcard-stats">
                                    <div>
                                        <span className="pcard-value num">{fmt(s?.qty || 0)}</span>
                                        <span className="pcard-label">
                                            {t('total')} {year}
                                        </span>
                                    </div>
                                    <Sparkline values={s ? s.perMonth : new Array(12).fill(0)} color={s ? '#2E9AD6' : '#B8C6D6'} />
                                </div>
                                <div className="pcard-meter" aria-hidden="true">
                                    <span style={{ transform: `scaleX(${(s?.qty || 0) / maxQty})` }} />
                                </div>
                                <div className="pcard-foot">
                                    <span>
                                        <Icon name="flame" size={14} /> {s?.runs || 0} {t('times')}
                                    </span>
                                    <span>
                                        <Icon name="clock" size={14} /> {s ? `${t('lastProduced')} ${last}` : t('never')}
                                    </span>
                                </div>
                            </article>
                        );
                    })}
                </div>
            )}

            <ConfirmDialog
                open={Boolean(pending)}
                message={pending ? t('confirmProduct', { name: pending.name }) : ''}
                onConfirm={confirmDelete}
                onClose={() => setPending(null)}
            />
        </div>
    );
}
