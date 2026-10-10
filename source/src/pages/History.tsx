import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { PageHeader, Skeleton } from '../components/Bits';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { apiErrorKey } from '../components/EditAccess';
import { useToast } from '../components/Toast';
import { useEditor } from '../lib/editor';
import { useI18n } from '../lib/i18n';
import { useStore } from '../lib/store';
import { errorCode } from '../lib/api';
import { fmt, longDate, parseYm } from '../lib/format';
import type { EntrySnap, HistAct, HistRecord, UserSnap } from '../lib/history';
import type { Product } from '../lib/types';

type Filter = 'all' | HistAct | 'stock';
const PAGE = 60;

function localDay(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function clock(ms: number): string {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const ICONS: Record<HistAct, IconName> = {
    add: 'plus',
    edit: 'pencil',
    delete: 'trash',
    receive: 'warehouse',
    unreceive: 'x',
    flag: 'xCircle',
    unflag: 'check',
    undo: 'undo',
    password: 'key',
};

const STOCK_ACTS: HistAct[] = ['receive', 'unreceive', 'flag', 'unflag'];

export function History() {
    const { t, monthName } = useI18n();
    const { loadHistory, undo, historyVersion } = useStore();
    const { canEdit } = useEditor();
    const toast = useToast();
    const [records, setRecords] = useState<HistRecord[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [loading, setLoading] = useState(false);
    const [filter, setFilter] = useState<Filter>('all');
    const [person, setPerson] = useState('');
    const [shown, setShown] = useState(PAGE);
    const [pending, setPending] = useState<HistRecord | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const doc = await loadHistory();
            setRecords([...doc.records].reverse());
            setFailed(false);
        } catch {
            setFailed(true);
        } finally {
            setLoading(false);
        }
    }, [loadHistory]);

    useEffect(() => {
        void load();
    }, [load, historyVersion]);

    const byId = useMemo(() => new Map((records || []).map((r) => [r.id, r])), [records]);
    const people = useMemo(() => [...new Set((records || []).map((r) => r.by))].sort(), [records]);
    const list = useMemo(
        () =>
            (records || []).filter(
                (r) => (filter === 'all' || r.act === filter || (filter === 'stock' && STOCK_ACTS.includes(r.act))) && (!person || r.by === person),
            ),
        [records, filter, person],
    );

    const monthLabel = (ym: string) => {
        const { y, m } = parseYm(ym);
        return `${monthName(m)} ${y}`;
    };

    const entryWhere = (s: EntrySnap) => (s.date ? longDate(s.date) : monthLabel(s.month));

    /** what happened, in words (title + optional detail lines) */
    const describe = (r: HistRecord): { title: string; details: string[] } => {
        if (r.kind === 'user') {
            const u = (r.after || r.before) as UserSnap | undefined;
            return { title: u && u.name !== r.by ? t('hPasswordFor', { name: u.name }) : t('hPasswordSelf'), details: [] };
        }
        if (r.kind === 'entry') {
            const a = r.after as EntrySnap | undefined;
            const b = r.before as EntrySnap | undefined;
            if (r.act === 'add' && a) {
                return { title: t('hAddEntry', { name: a.name, qty: fmt(a.qty) }), details: [entryWhere(a)].concat(a.note ? [a.note] : []) };
            }
            if (r.act === 'delete' && b) {
                return { title: t('hDelEntry', { name: b.name, qty: fmt(b.qty) }), details: [entryWhere(b)] };
            }
            if ((r.act === 'receive' || r.act === 'unreceive') && (a || b)) {
                const s = (a || b) as EntrySnap;
                return {
                    title: t(r.act === 'receive' ? 'hReceive' : 'hUnreceive', { name: s.name, qty: fmt(s.qty) }),
                    details: [`${t('stockProduced')}: ${entryWhere(s)}`],
                };
            }
            if ((r.act === 'flag' || r.act === 'unflag') && (a || b)) {
                const s = (a || b) as EntrySnap;
                const issue = r.act === 'flag' ? a?.issue : b?.issue;
                const details = [`${t('stockProduced')}: ${entryWhere(s)}`];
                if (issue && issue.counted !== undefined) {
                    details.push(t('hCounted', { n: fmt(issue.counted) }));
                }
                if (issue && issue.reason) {
                    details.push(t('hReason', { text: issue.reason }));
                }
                return { title: t(r.act === 'flag' ? 'hFlag' : 'hUnflag', { name: s.name, qty: fmt(s.qty) }), details };
            }
            if (r.act === 'edit' && a && b) {
                const details: string[] = [];
                if (a.productId !== b.productId) details.push(`${t('product')}: ${b.name} → ${a.name}`);
                if (a.qty !== b.qty) details.push(`${t('quantity')}: ${fmt(b.qty)} → ${fmt(a.qty)}`);
                if (a.date !== b.date || a.month !== b.month) details.push(`${t('date')}: ${entryWhere(b)} → ${entryWhere(a)}`);
                if (a.note !== b.note) details.push(`${t('note')}: ${b.note || '—'} → ${a.note || '—'}`);
                return { title: t('hEditEntry', { name: a.name }), details: details.length ? details : [entryWhere(a)] };
            }
        } else {
            const a = r.after as Product | undefined;
            const b = r.before as Product | undefined;
            if (r.act === 'add' && a) return { title: t('hAddProduct', { name: a.name }), details: [] };
            if (r.act === 'delete' && b) return { title: t('hDelProduct', { name: b.name }), details: [] };
            if (r.act === 'edit' && a && b) return { title: t('hRenameProduct', { from: b.name, to: a.name }), details: [] };
        }
        if (r.act === 'undo') {
            const orig = r.undoOf ? byId.get(r.undoOf) : undefined;
            return { title: t('hUndo', { what: orig ? describe(orig).title : '…' }), details: [] };
        }
        return { title: '—', details: [] };
    };

    const dayLabel = (day: string) => {
        const today = localDay(Date.now());
        const yesterday = localDay(Date.now() - 86_400_000);
        if (day === today) return t('today');
        if (day === yesterday) return t('yesterday');
        return longDate(day);
    };

    const groups = useMemo(() => {
        const out: Array<{ day: string; items: HistRecord[] }> = [];
        for (const r of list.slice(0, shown)) {
            const day = localDay(r.at);
            const last = out[out.length - 1];
            if (last && last.day === day) {
                last.items.push(r);
            } else {
                out.push({ day, items: [r] });
            }
        }
        return out;
    }, [list, shown]);

    const confirmUndo = async () => {
        if (!pending) {
            return;
        }
        try {
            await undo(pending.id);
            toast.show(t('undone'), 'success', 'undo');
        } catch (e) {
            const m = errorCode(e).match(/has_entries:(\d+)/);
            toast.show(m ? t('hasEntries', { n: m[1] }) : t(apiErrorKey(e)), 'error');
            void load();
        } finally {
            setPending(null);
        }
    };

    const filters: Array<{ key: Filter; label: string }> = [
        { key: 'all', label: t('hAll') },
        { key: 'add', label: t('hAdds') },
        { key: 'edit', label: t('hEdits') },
        { key: 'delete', label: t('hDeletes') },
        { key: 'stock', label: t('hStock') },
        { key: 'undo', label: t('hUndos') },
        { key: 'password', label: t('hPasswords') },
    ];

    return (
        <div className="page">
            <PageHeader
                eyebrow={t('company')}
                title={t('historyTitle')}
                sub={t('historySub')}
                actions={
                    <button type="button" className="btn btn-outline" onClick={() => void load()} disabled={loading}>
                        <Icon name="refresh" size={18} />
                        {t('reload')}
                    </button>
                }
            />

            <div className="hist-filters rise">
                <div className="chips" role="group" aria-label={t('historyTitle')}>
                    {filters.map((f) => (
                        <button
                            key={f.key}
                            type="button"
                            className={`chip${filter === f.key ? ' is-active' : ''}`}
                            aria-pressed={filter === f.key}
                            onClick={() => {
                                setFilter(f.key);
                                setShown(PAGE);
                            }}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
                {people.length > 1 && (
                    <div className="select-wrap hist-person">
                        <select value={person} onChange={(e) => setPerson(e.target.value)} aria-label={t('hByPerson')}>
                            <option value="">{t('hEveryone')}</option>
                            {people.map((p) => (
                                <option key={p} value={p}>
                                    {p}
                                </option>
                            ))}
                        </select>
                        <Icon name="chevronDown" size={18} className="select-caret" />
                    </div>
                )}
            </div>

            {records === null && !failed ? (
                <Skeleton rows={4} />
            ) : failed && !records ? (
                <section className="card load-error">
                    <Icon name="alert" size={28} />
                    <h2>{t('loadError')}</h2>
                    <button type="button" className="btn btn-primary" onClick={() => void load()}>
                        <Icon name="refresh" size={18} />
                        {t('retry')}
                    </button>
                </section>
            ) : list.length === 0 ? (
                <section className="card empty rise">
                    <div className="empty-art" aria-hidden="true">
                        <svg viewBox="0 0 120 120">
                            <circle cx="60" cy="60" r="44" pathLength={1} />
                        </svg>
                        <Icon name="history" size={34} />
                    </div>
                    <h2>{t('historyEmpty')}</h2>
                    <p>{t('historyEmptyHint')}</p>
                </section>
            ) : (
                <div className="hist">
                    {groups.map((g) => (
                        <section key={g.day} className="hist-day">
                            <h2 className="hist-day-title">{dayLabel(g.day)}</h2>
                            <ul className="hist-list">
                                {g.items.map((r) => {
                                    const d = describe(r);
                                    const canUndo = canEdit && !r.undoneAt && r.act !== 'undo' && r.act !== 'password';
                                    return (
                                        <li key={r.id} className={`hist-item act-${r.act}${r.undoneAt ? ' is-undone' : ''}`}>
                                            <span className="hist-icon" aria-hidden="true">
                                                <Icon name={ICONS[r.act]} size={17} />
                                            </span>
                                            <div className="hist-body">
                                                <p className="hist-title">{d.title}</p>
                                                {d.details.map((line, i) => (
                                                    <p key={i} className="hist-detail">
                                                        {line}
                                                    </p>
                                                ))}
                                                <p className="hist-meta">
                                                    <Icon name="user" size={13} />
                                                    <span className="hist-by">{r.by}</span>
                                                    <span className="num">{clock(r.at)}</span>
                                                    {r.undoneAt && (
                                                        <span className="badge badge-gold">
                                                            {t('hUndone', { by: r.undoneBy || '—' })}
                                                        </span>
                                                    )}
                                                </p>
                                            </div>
                                            {canUndo && (
                                                <button type="button" className="btn btn-outline btn-sm hist-undo" onClick={() => setPending(r)}>
                                                    <Icon name="undo" size={16} />
                                                    {t('undo')}
                                                </button>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    ))}
                    {list.length > shown && (
                        <button type="button" className="btn btn-ghost hist-more" onClick={() => setShown((n) => n + PAGE)}>
                            {t('showMore')}
                        </button>
                    )}
                </div>
            )}

            <ConfirmDialog
                open={Boolean(pending)}
                message={pending ? t('confirmUndo', { what: describe(pending).title }) : ''}
                confirmLabel={t('undo')}
                icon="undo"
                danger={false}
                onConfirm={confirmUndo}
                onClose={() => setPending(null)}
            />
        </div>
    );
}
