import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { useI18n } from '../lib/i18n';
import { useStore } from '../lib/store';
import { useToast } from './Toast';
import { apiErrorKey } from './EditAccess';
import { currentYm, parseYm, todayIso, toYm } from '../lib/format';
import type { Entry } from '../lib/types';

export interface EntryModalState {
    mode: 'add' | 'edit';
    month: string;
    productId?: string;
    entry?: Entry;
    /** suggested quantity and date (from "what to produce today") */
    qty?: number;
    date?: string;
}

interface Props {
    state: EntryModalState | null;
    onClose: () => void;
    onSaved?: (month: string) => void;
}

export function EntryModal({ state, onClose, onSaved }: Props) {
    const { t, monthName } = useI18n();
    const { products, addEntry, updateEntry } = useStore();
    const toast = useToast();
    const [productId, setProductId] = useState('');
    const [qty, setQty] = useState('');
    const [date, setDate] = useState('');
    const [year, setYear] = useState(2026);
    const [month, setMonth] = useState(1);
    const [note, setNote] = useState('');
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!state) {
            return;
        }
        const target = parseYm(state.month || currentYm());
        setErrors({});
        setBusy(false);
        if (state.mode === 'edit' && state.entry) {
            setProductId(state.entry.productId);
            setQty(String(state.entry.qty));
            setDate(state.entry.date);
            setNote(state.entry.note || '');
        } else {
            setProductId(state.productId || '');
            setQty(state.qty ? String(state.qty) : '');
            const today = todayIso();
            setDate(state.date || (today.slice(0, 7) === state.month ? today : ''));
            setNote('');
        }
        setYear(target.y);
        setMonth(target.m);
    }, [state]);

    useEffect(() => {
        if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
            const p = parseYm(date.slice(0, 7));
            setYear(p.y);
            setMonth(p.m);
        }
    }, [date]);

    if (!state) {
        return null;
    }

    const isEdit = state.mode === 'edit';
    const thisYear = parseYm(currentYm()).y;
    const years = [thisYear - 2, thisYear - 1, thisYear, thisYear + 1];
    if (!years.includes(year)) {
        years.push(year);
        years.sort();
    }

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const next: Record<string, string> = {};
        const q = Number(qty);
        if (!productId) {
            next.product = t('productRequired');
        }
        if (!qty || !Number.isFinite(q) || q <= 0) {
            next.qty = t('qtyInvalid');
        }
        setErrors(next);
        if (Object.keys(next).length) {
            return;
        }
        const input = { productId, qty: Math.round(q), date, month: date ? date.slice(0, 7) : toYm(year, month), note: note.trim() };
        setBusy(true);
        try {
            const res = isEdit && state.entry ? await updateEntry(state.entry.id, state.month, input) : await addEntry(input);
            toast.show(t('savedOnline'));
            onClose();
            onSaved?.(res.month);
        } catch (err) {
            toast.show(t(apiErrorKey(err)), 'error');
            setBusy(false);
        }
    };

    return (
        <Modal
            open
            title={isEdit ? t('editProduction') : t('addProduction')}
            subtitle={`${t('month')} ${monthName(month)} ${year}`}
            onClose={busy ? () => undefined : onClose}
            footer={
                <>
                    <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
                        {t('cancel')}
                    </button>
                    <button type="submit" form="entry-form" className="btn btn-primary" disabled={busy}>
                        <Icon name="check" size={18} />
                        {busy ? t('saving') : t('save')}
                    </button>
                </>
            }
        >
            <form id="entry-form" className="form" onSubmit={submit} noValidate>
                <div className="field">
                    <label htmlFor="f-product">{t('product')}</label>
                    <div className="select-wrap">
                        <select
                            id="f-product"
                            value={productId}
                            onChange={(e) => setProductId(e.target.value)}
                            aria-invalid={Boolean(errors.product)}
                            data-autofocus={!state.productId && !isEdit ? true : undefined}
                        >
                            <option value="">{t('selectProduct')}</option>
                            {products.map((p, i) => (
                                <option key={p.id} value={p.id}>
                                    {i + 1}. {p.name}
                                </option>
                            ))}
                        </select>
                        <Icon name="chevronDown" size={18} className="select-caret" />
                    </div>
                    {errors.product && (
                        <p className="field-error" role="alert">
                            {errors.product}
                        </p>
                    )}
                </div>
                <div className="field">
                    <label htmlFor="f-qty">{t('quantity')}</label>
                    <input
                        id="f-qty"
                        className="input input-lg num"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        step={1}
                        value={qty}
                        placeholder="0"
                        onChange={(e) => setQty(e.target.value)}
                        aria-invalid={Boolean(errors.qty)}
                        data-autofocus={state.productId || isEdit ? true : undefined}
                    />
                    {errors.qty && (
                        <p className="field-error" role="alert">
                            {errors.qty}
                        </p>
                    )}
                </div>
                <div className="field-row">
                    <div className="field">
                        <label htmlFor="f-date">
                            {t('date')} <span className="hint">({t('optional')})</span>
                        </label>
                        <input id="f-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                    </div>
                    <div className="field">
                        <label htmlFor="f-month">{t('month')}</label>
                        <div className="month-pick">
                            <div className="select-wrap">
                                <select
                                    id="f-month"
                                    value={month}
                                    disabled={Boolean(date)}
                                    onChange={(e) => setMonth(Number(e.target.value))}
                                >
                                    {Array.from({ length: 12 }, (_, i) => (
                                        <option key={i + 1} value={i + 1}>
                                            {i + 1} · {monthName(i + 1)}
                                        </option>
                                    ))}
                                </select>
                                <Icon name="chevronDown" size={18} className="select-caret" />
                            </div>
                            <div className="select-wrap">
                                <select
                                    aria-label={t('year')}
                                    value={year}
                                    disabled={Boolean(date)}
                                    onChange={(e) => setYear(Number(e.target.value))}
                                >
                                    {years.map((y) => (
                                        <option key={y} value={y}>
                                            {y}
                                        </option>
                                    ))}
                                </select>
                                <Icon name="chevronDown" size={18} className="select-caret" />
                            </div>
                        </div>
                    </div>
                </div>
                <p className="hint">{t('dateHelp')}</p>
                <div className="field">
                    <label htmlFor="f-note">
                        {t('note')} <span className="hint">({t('optional')})</span>
                    </label>
                    <input id="f-note" className="input" type="text" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
            </form>
        </Modal>
    );
}
