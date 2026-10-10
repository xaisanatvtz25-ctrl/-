import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { useToast } from './Toast';
import { apiErrorKey } from './EditAccess';
import { useI18n } from '../lib/i18n';
import type { Key } from '../lib/i18n';
import { useStore } from '../lib/store';
import { fmt, longDate } from '../lib/format';
import { REASON_MAX, cleanCount } from '../lib/source';
import type { Entry } from '../lib/types';

export interface IssueTarget {
    entry: Entry;
    month: string;
    name: string;
}

const QUICK: Key[] = ['issueQ1', 'issueQ2', 'issueQ3', 'issueQ4'];

/** Warehouse: mark a production run ✗ "does not match", with the reason and the quantity really counted. */
export function IssueModal({ target, onClose }: { target: IssueTarget | null; onClose: () => void }) {
    const { t } = useI18n();
    const { flagIssue } = useStore();
    const toast = useToast();
    const [counted, setCounted] = useState('');
    const [reason, setReason] = useState('');
    const [error, setError] = useState<{ counted?: string; reason?: string }>({});
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (target) {
            setCounted('');
            setReason('');
            setError({});
            setBusy(false);
        }
    }, [target]);

    if (!target) {
        return null;
    }
    const { entry, month, name } = target;

    const addQuick = (key: Key) => {
        const word = t(key);
        setReason((prev) => (prev.trim() ? (prev.includes(word) ? prev : `${prev.trim()}, ${word}`) : word));
        setError((e) => ({ ...e, reason: undefined }));
    };

    const submit = async (ev: FormEvent) => {
        ev.preventDefault();
        const next: { counted?: string; reason?: string } = {};
        const count = counted.trim() === '' ? undefined : cleanCount(counted.trim());
        if (counted.trim() !== '' && (count === undefined || !/^\d+$/.test(counted.trim()))) {
            next.counted = t('qtyInvalid');
        }
        if (!reason.trim()) {
            next.reason = t('issueReasonRequired');
        }
        setError(next);
        if (next.counted || next.reason) {
            return;
        }
        setBusy(true);
        try {
            await flagIssue({ id: entry.id, month }, count, reason);
            toast.show(t('issueSaved'), 'success', 'flag');
            onClose();
        } catch (err) {
            toast.show(t(apiErrorKey(err)), 'error');
            setBusy(false);
        }
    };

    const count = counted.trim() === '' ? undefined : cleanCount(counted.trim());
    const diff = count !== undefined ? count - entry.qty : 0;

    return (
        <Modal
            open
            title={t('issueTitle')}
            subtitle={`${name} · ${entry.date ? longDate(entry.date) : month} · ${t('issueRecorded', { qty: fmt(entry.qty) })}`}
            onClose={busy ? () => undefined : onClose}
            footer={
                <>
                    <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
                        {t('cancel')}
                    </button>
                    <button type="submit" form="issue-form" className="btn btn-danger" disabled={busy}>
                        <Icon name="x" size={18} stroke={2.6} />
                        {busy ? t('saving') : t('issueSend')}
                    </button>
                </>
            }
        >
            <form id="issue-form" className="form" onSubmit={submit} noValidate>
                <div className="field">
                    <label htmlFor="issue-counted">{t('issueCounted')}</label>
                    <div className="issue-count-row">
                        <input
                            id="issue-counted"
                            className="input input-lg num"
                            type="number"
                            inputMode="numeric"
                            min={0}
                            step={1}
                            value={counted}
                            placeholder={t('issueCountedPh', { qty: fmt(entry.qty) })}
                            onChange={(e) => {
                                setCounted(e.target.value);
                                setError((x) => ({ ...x, counted: undefined }));
                            }}
                            aria-invalid={Boolean(error.counted)}
                            data-autofocus
                        />
                        {count !== undefined && diff !== 0 && (
                            <span className={`issue-diff num ${diff < 0 ? 'is-less' : 'is-more'}`}>
                                {t('issueDiff', { diff: `${diff > 0 ? '+' : '−'}${fmt(Math.abs(diff))}` })}
                            </span>
                        )}
                    </div>
                    {error.counted && (
                        <p className="field-error" role="alert">
                            {error.counted}
                        </p>
                    )}
                </div>
                <div className="field">
                    <label htmlFor="issue-reason">{t('issueReason')}</label>
                    <div className="chips issue-quick">
                        {QUICK.map((k) => (
                            <button key={k} type="button" className="chip" onClick={() => addQuick(k)}>
                                {t(k)}
                            </button>
                        ))}
                    </div>
                    <textarea
                        id="issue-reason"
                        className="input textarea"
                        rows={3}
                        maxLength={REASON_MAX}
                        value={reason}
                        placeholder={t('issueReasonPh')}
                        onChange={(e) => {
                            setReason(e.target.value);
                            setError((x) => ({ ...x, reason: undefined }));
                        }}
                        aria-invalid={Boolean(error.reason)}
                    />
                    {error.reason && (
                        <p className="field-error" role="alert">
                            {error.reason}
                        </p>
                    )}
                </div>
                <p className="issue-notify">
                    <Icon name="bell" size={16} />
                    {entry.by ? t('issueNotify', { by: entry.by }) : t('issueNotifyAll')}
                </p>
            </form>
        </Modal>
    );
}
