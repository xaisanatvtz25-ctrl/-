import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/Bits';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { apiErrorKey } from '../components/EditAccess';
import { PlanList } from '../components/PlanList';
import { useToast } from '../components/Toast';
import type { EntryModalState } from '../components/EntryModal';
import { useEditor } from '../lib/editor';
import { useI18n } from '../lib/i18n';
import type { Key } from '../lib/i18n';
import { useStore } from '../lib/store';
import { fmt, longDate, todayIso } from '../lib/format';
import { openAi } from '../lib/aiEvents';
import { SHEET_NAMES, canon, parseNum } from '../lib/stockSheet';
import type { SheetRead } from '../lib/stockSheet';
import { DEFAULT_SETTINGS, analyze, cleanSettings, daysBetween, planStart, schedule, topSellers } from '../lib/stockAnalysis';
import type { Group, Result, StockSettings, Week } from '../lib/stockAnalysis';
import { cachedStock, loadStock, saveStock } from '../lib/stockStore';
import type { StockDoc } from '../lib/stockStore';
import { getDraft, newDraftId, onDraftChange, setDraft } from '../lib/stockDraft';
import type { StockDraft } from '../lib/stockDraft';
import {
    PLAN_MAX,
    askSet,
    computeLines,
    matchOf,
    producedBetween,
    readLocalAliases,
    readLocalIgnore,
    todayView,
    weekRows,
    writeLocalAliases,
    writeLocalIgnore,
} from '../lib/stockFlow';
import type { Cell, Line, Slot, TodayItem } from '../lib/stockFlow';
import type { PlanItem } from '../lib/types';

/** one of the productions chosen (at most PLAN_MAX) */
interface Choice {
    productId: string;
    qty: number;
    date: string;
}

const MANUAL: SheetRead = { method: 'manual', fileName: '', date: '', dateText: '', rows: [] };

function num(n: number | null, digits = 0): string {
    if (n === null || !Number.isFinite(n)) {
        return '—';
    }
    return digits ? n.toLocaleString('en-US', { maximumFractionDigits: digits }) : fmt(n);
}

function rate(n: number | null): string {
    if (n === null) {
        return '—';
    }
    return n >= 10 ? fmt(n) : n.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

const GROUP_TONE: Record<Group, string> = { urgent: 'is-urgent', next: 'is-next', later: 'is-later', refill: 'is-refill', nodata: 'is-nodata' };

/**
 * "ວັນນີ້ຄວນຜະລິດຫຍັງດີ?": the stock written to the AI assistant is checked here, the analysis shows what
 * runs low and what sells best, and 4 productions are chosen and sent to the production list.
 */
export function Weekly({ openEntry }: { openEntry: (s: EntryModalState) => void }) {
    const { t } = useI18n();
    const { products, months, plan, sendPlan, setPlanDone } = useStore();
    const { canEdit, requireLogin, token, name: me } = useEditor();
    const toast = useToast();
    const today = todayIso();

    const [stock, setStock] = useState<StockDoc | null>(cachedStock);
    const [draft, setDraftState] = useState<StockDraft | null>(getDraft);
    const [edits, setEdits] = useState<Record<string, string>>({});
    const [okRows, setOkRows] = useState<Set<string>>(new Set());
    const [picks, setPicks] = useState<Record<Slot, Record<string, number | 'none'>>>({ prev: {}, curr: {} });
    const [dateEdit, setDateEdit] = useState<Record<Slot, string | null>>({ prev: null, curr: null });
    const [localAliases, setLocalAliases] = useState<Record<string, string>>(readLocalAliases);
    const [localIgnore, setLocalIgnore] = useState<string[]>(readLocalIgnore);
    // names matched (or skipped) by hand during this visit: their questions stay on screen (the choice can be changed)
    const [sessionKeys, setSessionKeys] = useState<Set<string>>(new Set());
    // the answers given name by name (row → product id, or 'skip')
    const [rowPicks, setRowPicks] = useState<Record<Slot, Record<number, string>>>({ prev: {}, curr: {} });
    const [settings, setSettings] = useState<StockSettings>(() => (cachedStock() ? (cachedStock() as StockDoc).settings : DEFAULT_SETTINGS));
    const settingsTouched = useRef(false);
    const [chosen, setChosen] = useState<Choice[] | null>(null);
    const [start, setStart] = useState('');
    const [showAll, setShowAll] = useState(false);
    const [confirmSend, setConfirmSend] = useState(false);
    const [busyPlan, setBusyPlan] = useState<string | null>(null);
    const [openWeek, setOpenWeek] = useState<string | null>(null);
    const [moreAlts, setMoreAlts] = useState(false);
    // a plan is still being made: choosing a new one is asked for (it replaces that plan)
    const [replan, setReplan] = useState(false);

    // what the assistant has read (it may arrive while this page is open)
    useEffect(() => onDraftChange(() => setDraftState(getDraft())), []);
    const draftId = draft ? draft.id : '';
    useEffect(() => {
        setEdits({});
        setOkRows(new Set());
        setPicks({ prev: {}, curr: {} });
        setRowPicks({ prev: {}, curr: {} });
        setDateEdit({ prev: null, curr: null });
        setChosen(null);
        setStart('');
        setShowAll(false);
    }, [draftId]);

    // the saved analyses (everyone can read them)
    useEffect(() => {
        let alive = true;
        loadStock(token || undefined)
            .then((doc) => {
                if (alive) {
                    setStock(doc);
                    if (!settingsTouched.current) {
                        setSettings(doc.settings);
                    }
                }
            })
            .catch(() => {
                if (alive) {
                    setStock((cur) => cur || { version: 1, schema: 1, settings: DEFAULT_SETTINGS, aliases: {}, ignore: [], weeks: [] });
                }
            });
        return () => {
            alive = false;
        };
    }, [token]);

    const nameOf = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);
    const lastWeek = stock && stock.weeks.length ? stock.weeks[stock.weeks.length - 1] : null;
    const aliases = useMemo(() => ({ ...(stock ? stock.aliases : {}), ...localAliases }), [stock, localAliases]);
    const ignore = useMemo(() => [...(stock ? stock.ignore || [] : []), ...localIgnore], [stock, localIgnore]);
    const askAliases = useMemo(() => Object.fromEntries(Object.entries(aliases).filter(([k]) => !sessionKeys.has(k))), [aliases, sessionKeys]);
    const askIgnore = useMemo(() => ignore.filter((k) => !sessionKeys.has(k)), [ignore, sessionKeys]);

    /* ---------- the two sheets ---------- */

    const currSheet = draft ? draft.curr : null;
    const prevSheet = draft && draft.prev && draft.prev !== 'saved' ? draft.prev : null;
    // "the last saved sheet" as the previous one: the newest saved analysis before this sheet
    const savedPrev = useMemo(() => {
        if (!draft || draft.prev !== 'saved' || !stock) {
            return null;
        }
        const before = stock.weeks.filter((w) => !draft.curr.date || w.currDate < draft.curr.date);
        return before.length ? before[before.length - 1] : null;
    }, [draft, stock]);
    const usingSaved = Boolean(savedPrev);
    const prevPresent = usingSaved || Boolean(prevSheet);
    const currPresent = Boolean(currSheet);

    const prevMatch = useMemo(() => matchOf(products, prevSheet, aliases, picks.prev, ignore), [products, prevSheet, aliases, picks.prev, ignore]);
    const currMatch = useMemo(() => matchOf(products, currSheet, aliases, picks.curr, ignore), [products, currSheet, aliases, picks.curr, ignore]);
    // what to ask (names that changed): stays on screen with the person's choice once made
    const prevAsk = useMemo(() => askSet(products, prevSheet, askAliases, askIgnore), [products, prevSheet, askAliases, askIgnore]);
    const currAsk = useMemo(() => askSet(products, currSheet, askAliases, askIgnore), [products, currSheet, askAliases, askIgnore]);

    const lines: Line[] = computeLines({
        products,
        prev: { sheet: prevSheet, saved: savedPrev, match: prevMatch },
        curr: { sheet: currSheet, saved: null, match: currMatch },
        prevPresent,
        currPresent,
        notOnSheet: (pid) => picks.curr[pid] === 'none',
        edits,
        okRows,
    });
    const flaggedCount = lines.filter((l) => l.flagged).length;
    const openQuestions = (slot: Slot, a: typeof prevAsk) =>
        a.mode === 'product' ? a.products.filter((pid) => picks[slot][pid] === undefined).length : a.mode === 'row' ? a.rows.filter((i) => rowPicks[slot][i] === undefined).length : 0;
    const unanswered = (prevSheet ? openQuestions('prev', prevAsk) : 0) + (currPresent ? openQuestions('curr', currAsk) : 0);

    const prevDate = dateEdit.prev ?? (savedPrev ? savedPrev.currDate : prevSheet ? prevSheet.date : '');
    const currDate = dateEdit.curr ?? (currSheet ? currSheet.date : '');
    const days = prevDate && currDate ? daysBetween(prevDate, currDate) : 0;

    /* ---------- the analysis: this draft, or else the last saved one ---------- */

    const shownWeek: Week | null = draft ? null : lastWeek;
    const aPrev = draft ? prevDate : shownWeek ? shownWeek.prevDate : '';
    const aCurr = draft ? currDate : shownWeek ? shownWeek.currDate : '';
    const aDays = draft ? days : shownWeek ? shownWeek.days : 0;
    const aId = draft ? `w${prevDate}_${currDate}` : shownWeek ? shownWeek.id : '';
    const rows = draft ? weekRows(lines) : shownWeek ? shownWeek.rows : [];
    const ready = draft ? prevPresent && currPresent && days > 0 : Boolean(shownWeek && shownWeek.days > 0);
    const history = useMemo(() => (stock ? stock.weeks.filter((w) => w.id !== aId) : []), [stock, aId]);
    const rowsKey = JSON.stringify(rows);
    const results: Result[] = useMemo(
        () => (ready ? analyze(rows, aDays, aCurr, history, settings) : []),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [ready, rowsKey, aDays, aCurr, history, settings],
    );
    const view: TodayItem[] = useMemo(() => (ready ? todayView(results, months, aCurr, today, settings) : []), [ready, results, months, aCurr, today, settings]);
    const viewOf = useMemo(() => new Map(view.map((v) => [v.productId, v])), [view]);
    // running low: those that need producing this round or the next, fewest days left first
    const low = useMemo(() => view.filter((v) => v.group === 'urgent' || v.group === 'next').sort((a, b) => a.cover - b.cover).slice(0, 5), [view]);
    const top = useMemo(() => topSellers(results), [results]);
    const counts = { urgent: 0, next: 0, later: 0 } as Record<string, number>;
    results.forEach((r) => (counts[r.group] = (counts[r.group] || 0) + 1));

    // produced between the two sheets according to the website (received into the warehouse, else production date)
    const recorded = useMemo(() => producedBetween(months, prevDate, currDate, 'received'), [months, prevDate, currDate]);

    /* ---------- the productions chosen ---------- */

    const startDate = start || planStart(aCurr, today);
    const autoChoice = useMemo(() => {
        const items = view.filter((v) => v.suggest > 0).slice(0, PLAN_MAX);
        const dates = schedule(items.length, startDate, settings.perDay);
        return items.map((v, i) => ({ productId: v.productId, qty: v.suggest, date: dates[i] }));
    }, [view, startDate, settings.perDay]);
    const choice = chosen ?? autoChoice;
    const changeChoice = (fn: (list: Choice[]) => Choice[]) => setChosen(fn(choice.map((c) => ({ ...c }))));
    const full = choice.length >= PLAN_MAX;
    const others = view.filter((v) => !choice.some((c) => c.productId === v.productId));
    const choiceTotal = choice.reduce((s, c) => s + (c.qty > 0 ? c.qty : 0), 0);

    const addChoice = (productId: string) => {
        if (full) {
            return;
        }
        const v = viewOf.get(productId);
        const qty = v ? (v.suggest > 0 ? v.suggest : Math.ceil(v.daily * settings.target)) : 0;
        changeChoice((list) => [...list, { productId, qty, date: list.length ? list[list.length - 1].date : startDate }]);
    };

    /* ---------- actions ---------- */

    const startManual = () => {
        setDraft({ id: newDraftId(), at: Date.now(), prev: lastWeek ? 'saved' : MANUAL, curr: MANUAL, source: 'manual' });
        setShowAll(true);
    };

    const clearDraft = () => {
        setDraft(null);
    };

    const pickRow = (slot: Slot, pid: string, value: string) => {
        setPicks((p) => {
            const next = { ...p[slot] };
            if (value === '') {
                delete next[pid];
            } else if (value === 'none') {
                next[pid] = 'none';
            } else {
                next[pid] = Number(value);
            }
            return { ...p, [slot]: next };
        });
        const sheet = slot === 'prev' ? prevSheet : currSheet;
        if (sheet && value !== '' && value !== 'none') {
            const row = sheet.rows[Number(value)];
            if (row && row.name) {
                // remembered for the next time (saved for everyone with the analysis)
                const key = canon(row.name);
                const nextAliases = { ...localAliases, [key]: pid };
                setLocalAliases(nextAliases);
                writeLocalAliases(nextAliases);
                setSessionKeys((s) => new Set([...s, key]));
            }
        }
        setChosen(null);
    };

    /** a name that is not known: which product it is (or none of them) */
    const pickProduct = (slot: Slot, row: number, value: string) => {
        const sheet = slot === 'prev' ? prevSheet : currSheet;
        const name = sheet && sheet.rows[row] ? sheet.rows[row].name : '';
        const key = canon(name);
        setRowPicks((r) => {
            const next = { ...r[slot] };
            if (value) {
                next[row] = value;
            } else {
                delete next[row];
            }
            return { ...r, [slot]: next };
        });
        setPicks((p) => {
            const next = { ...p[slot] };
            for (const pid of Object.keys(next)) {
                if (next[pid] === row) {
                    delete next[pid]; // this name was given to another product before
                }
            }
            if (value && value !== 'skip') {
                next[value] = row;
            }
            return { ...p, [slot]: next };
        });
        if (key) {
            // remembered for the next time (saved for everyone with the analysis)
            const nextAliases = { ...localAliases };
            delete nextAliases[key];
            if (value && value !== 'skip') {
                nextAliases[key] = value;
            }
            setLocalAliases(nextAliases);
            writeLocalAliases(nextAliases);
            const nextIgnore = localIgnore.filter((k) => k !== key);
            if (value === 'skip') {
                nextIgnore.push(key);
            }
            setLocalIgnore(nextIgnore);
            writeLocalIgnore(nextIgnore);
            setSessionKeys((s) => new Set([...s, key]));
        }
        setChosen(null);
    };

    const setCell = (pid: string, cell: Cell, value: string) => {
        setEdits((e) => ({ ...e, [`${pid}:${cell}`]: value }));
        setChosen(null);
    };

    const useRecords = () => {
        setEdits((e) => {
            const next = { ...e };
            recorded.forEach((qty, pid) => {
                next[`${pid}:made`] = String(qty);
            });
            return next;
        });
        setChosen(null);
    };

    const changeSetting = (k: keyof StockSettings, value: string) => {
        settingsTouched.current = true;
        setSettings((s) => cleanSettings({ ...s, [k]: value === '' ? s[k] : Number(value) }));
        setChosen(null);
    };

    const askSend = () => {
        requireLogin(() => {
            if (draft && unanswered > 0) {
                toast.show(t('wkAnswerMissing'), 'error');
                return;
            }
            setConfirmSend(true);
        });
    };

    const doSend = async () => {
        const items = choice.filter((c) => c.qty > 0);
        try {
            if (draft) {
                const week: Week = {
                    id: aId,
                    savedAt: Date.now(),
                    by: me,
                    prevDate,
                    currDate,
                    days,
                    rows,
                    files: { prev: prevSheet ? prevSheet.fileName || undefined : undefined, curr: currSheet ? currSheet.fileName || undefined : undefined },
                };
                const saved = await saveStock(token, (doc) => {
                    doc.weeks = doc.weeks.filter((w) => w.id !== week.id);
                    doc.weeks.push(week);
                    Object.assign(doc.aliases, localAliases);
                    for (const k of Object.keys(localAliases)) {
                        doc.ignore = doc.ignore.filter((x) => x !== k);
                    }
                    doc.ignore = [...new Set([...doc.ignore, ...localIgnore])].filter((k) => !doc.aliases[k]);
                    doc.settings = settings;
                });
                setStock(saved);
                setLocalAliases({});
                writeLocalAliases({});
                setLocalIgnore([]);
                writeLocalIgnore([]);
            }
            await sendPlan(aId, items);
            if (draft) {
                setDraft(null); // saved: the page now shows the saved analysis
            }
            setReplan(false);
            setChosen(null);
            toast.show(items.length ? t('wkSent') : t('wkSavedOnly'), 'success');
        } catch (e) {
            toast.show(t(apiErrorKey(e)), 'error');
        }
    };

    const recordPlan = (item: PlanItem) => {
        openEntry({ mode: 'add', month: today.slice(0, 7), productId: item.productId, qty: item.qty, date: today });
    };

    const togglePlan = async (item: PlanItem, done: boolean) => {
        setBusyPlan(item.id);
        try {
            await setPlanDone(item.id, done);
        } catch (e) {
            toast.show(t(apiErrorKey(e)), 'error');
        } finally {
            setBusyPlan(null);
        }
    };

    /* ---------- view ---------- */

    const groupLabel = (g: Group) => t(`wkGroup_${g}` as Key);
    const coverText = (r: Result) => (r.cover === null ? '—' : r.cover === Infinity ? t('wkNoOut') : t('wkDaysN', { n: rate(r.cover) }));
    const method: Record<string, Key> = { typed: 'wkByTyped', text: 'wkByText', ai: 'wkByAi', manual: 'wkByManual', saved: 'wkBySaved' };

    const writeStock = (label: string, primary: boolean) => (
        <button type="button" className={`btn ${primary ? 'btn-primary' : 'btn-outline'} wk-write`} onClick={() => openAi({ template: true })}>
            <Icon name="clipboard" size={18} />
            {label}
        </button>
    );

    const sheetLine = (title: string, sheet: SheetRead | null, saved: Week | null, found: number | null) => (
        <div className="wk-src-sheet">
            <span className="wk-src-label">{title}</span>
            {saved ? (
                <span className="wk-src-file">
                    <Icon name="history" size={14} />
                    {t('wkSourceSaved', { date: longDate(saved.currDate) })}
                </span>
            ) : sheet ? (
                <span className="wk-src-file">
                    <span className="wk-file">{sheet.fileName || t('wkByManual')}</span>
                    {sheet.date && <span className="num">· {longDate(sheet.date)}</span>}
                    {sheet.method !== 'manual' && sheet.date && !sheet.dateText && <span className="wk-src-today">{t('wkDateToday')}</span>}
                    <span className="badge badge-sky">{t(method[sheet.method])}</span>
                    {found !== null && sheet.method !== 'manual' && <span className="wk-found">{t('wkFound', { n: found, total: products.length })}</span>}
                </span>
            ) : (
                <span className="wk-src-missing">{t('wkNeedPrev')}</span>
            )}
        </div>
    );

    const cellInput = (l: Line, cell: Cell, label: string, fromSheet: number | null, extra?: ReactNode) => {
        const r = edits[`${l.pid}:${cell}`];
        const value = r !== undefined ? r : fromSheet === null ? '' : String(fromSheet);
        const flag = l.bad.includes(cell) ? 'is-bad' : l.unclear.includes(cell) && !okRows.has(l.pid) ? 'is-unclear' : '';
        const mm = l.mismatch && !okRows.has(l.pid) && (cell === 'qty' || cell === 'south' || cell === 'left') ? ' is-mismatch' : '';
        return (
            <label className={`wk-cell ${flag}${mm}`}>
                <span className="wk-cell-label">{label}</span>
                <input
                    className="input wk-input num"
                    inputMode="decimal"
                    value={value}
                    data-cell={cell}
                    onChange={(e) => setCell(l.pid, cell, e.target.value)}
                    aria-invalid={flag === 'is-bad'}
                />
                {extra}
            </label>
        );
    };

    const askBox = (slot: Slot, ask: ReturnType<typeof askSet>) => {
        const sheet = slot === 'prev' ? prevSheet : currSheet;
        if (!sheet || sheet.method === 'manual' || ask.mode === 'none') {
            return null;
        }
        const m = matchOf(products, sheet, aliases, picks[slot], ignore);
        const rowLabel = (i: number) => `${sheet.rows[i].name || '—'}${sheet.rows[i].remain !== null ? ` · ${num(sheet.rows[i].remain, 2)}` : ''}`;
        if (ask.mode === 'row') {
            // a few names that are not known: which product is each (or none of the 25)
            const taken = new Set(Object.values(rowPicks[slot]).filter((v) => v !== 'skip'));
            const found = new Set(m ? [...m.rows.keys()] : []);
            return (
                <div className="wk-ask" data-slot={slot} data-mode="row">
                    <p className="wk-ask-title">
                        <Icon name="alert" size={17} />
                        {t('wkUnknownTitle', { n: ask.rows.length, sheet: slot === 'prev' ? t('wkPrev') : t('wkCurr') })}
                    </p>
                    {ask.rows.map((i) => {
                        const v = rowPicks[slot][i];
                        return (
                            <div key={i} className={`wk-ask-row${v === undefined ? ' is-open' : ''}`}>
                                <div className="wk-ask-name">
                                    <strong>“{sheet.rows[i].name}”</strong>
                                    <small>{rowLabel(i)}</small>
                                </div>
                                <div className="select-wrap">
                                    <select value={v === undefined ? '' : v} onChange={(e) => pickProduct(slot, i, e.target.value)} data-row={i}>
                                        <option value="">{t('wkPickProduct')}</option>
                                        {products
                                            .filter((p) => p.id === v || (!taken.has(p.id) && !found.has(p.id)))
                                            .map((p) => (
                                                <option key={p.id} value={p.id}>
                                                    {p.name}
                                                    {SHEET_NAMES[p.id] ? ` (${SHEET_NAMES[p.id]})` : ''}
                                                </option>
                                            ))}
                                        <option value="skip">{t('wkNotOurs')}</option>
                                    </select>
                                    <Icon name="chevronDown" size={18} className="select-caret" />
                                </div>
                            </div>
                        );
                    })}
                    <p className="hint">{t('wkRemember')}</p>
                </div>
            );
        }
        const offered = (pid: string) => {
            const mine = picks[slot][pid];
            return [...(m ? m.free : []), ...(typeof mine === 'number' ? [mine] : [])].sort((a, b) => a - b);
        };
        return (
            <div className="wk-ask" data-slot={slot} data-mode="product">
                <p className="wk-ask-title">
                    <Icon name="alert" size={17} />
                    {t('wkMissingTitle', { n: ask.products.length, sheet: slot === 'prev' ? t('wkPrev') : t('wkCurr') })}
                </p>
                {ask.products.map((pid) => {
                    const v = picks[slot][pid];
                    return (
                        <div key={pid} className={`wk-ask-row${v === undefined ? ' is-open' : ''}`}>
                            <div className="wk-ask-name">
                                <strong>{nameOf.get(pid)}</strong>
                                <small>{SHEET_NAMES[pid] ? t('wkExpected', { name: SHEET_NAMES[pid] }) : t('wkNoExpected')}</small>
                            </div>
                            <div className="select-wrap">
                                <select value={v === undefined ? '' : String(v)} onChange={(e) => pickRow(slot, pid, e.target.value)} data-pid={pid}>
                                    <option value="">{t('wkPick')}</option>
                                    {offered(pid).map((i) => (
                                        <option key={i} value={i}>
                                            {rowLabel(i)}
                                        </option>
                                    ))}
                                    <option value="none">{t('wkNotInSheet')}</option>
                                </select>
                                <Icon name="chevronDown" size={18} className="select-caret" />
                            </div>
                        </div>
                    );
                })}
                <p className="hint">{t('wkRemember')}</p>
            </div>
        );
    };

    const resultTable = (list: Result[]) => (
        <div className="wk-res" role="table" aria-label={t('wkStep3')}>
            <div className="wk-res-row wk-res-head" role="row">
                <span role="columnheader">#</span>
                <span role="columnheader">{t('wkThProduct')}</span>
                <span role="columnheader">{t('wkThLeft')}</span>
                <span role="columnheader">{t('wkThOut')}</span>
                <span role="columnheader">{t('wkThDaily')}</span>
                <span role="columnheader">{t('wkThCover')}</span>
                <span role="columnheader">{t('wkThGroup')}</span>
                <span role="columnheader">{t('wkThSuggest')}</span>
            </div>
            {list.map((r, i) => (
                <div key={r.productId} className={`wk-res-row ${GROUP_TONE[r.group]}`} role="row" data-pid={r.productId}>
                    <span className="wk-res-no num" role="cell">
                        {i + 1}
                    </span>
                    <span className="wk-res-name" role="cell">
                        {nameOf.get(r.productId) || r.productId}
                    </span>
                    <span className="num" role="cell" data-label={t('wkThLeft')}>
                        {num(r.left, 2)}
                    </span>
                    <span className="num" role="cell" data-label={t('wkThOut')}>
                        {r.refill ? (
                            <span className="wk-refill">
                                <span className="badge wk-refill-badge">{t('wkGroup_refill')}</span>
                                <small>{t('wkSouth', { n: num(r.south, 2) })}</small>
                            </span>
                        ) : (
                            num(r.out, 2)
                        )}
                    </span>
                    <span className="num" role="cell" data-label={t('wkThDaily')}>
                        {rate(r.daily)}
                        {r.weeks > 1 && <small className="wk-avg">{t('wkAvg', { n: r.weeks })}</small>}
                    </span>
                    <span className="num wk-cover" role="cell" data-label={t('wkThCover')}>
                        {coverText(r)}
                    </span>
                    <span role="cell" data-label={t('wkThGroup')}>
                        <span className={`wk-group ${GROUP_TONE[r.group]}`}>{groupLabel(r.group)}</span>
                    </span>
                    <span className="num wk-suggest" role="cell" data-label={t('wkThSuggest')}>
                        {r.suggest > 0 ? fmt(r.suggest) : '—'}
                    </span>
                </div>
            ))}
        </div>
    );

    const leftNowText = (v: TodayItem) =>
        Number.isFinite(v.cover) ? t('wkLeftNow', { n: fmt(Math.round(v.leftNow)), days: rate(v.cover) }) : t('wkLeftNowNoOut', { n: fmt(Math.round(v.leftNow)) });

    const planDone = plan.filter((p) => p.done).length;
    const planOpen = plan.length - planDone;
    const showChoose = ready && (Boolean(draft) || planOpen === 0 || replan);
    const weeksNewest = stock ? [...stock.weeks].reverse() : [];
    let step = 0;

    return (
        <div className="page weekly-page">
            <PageHeader
                eyebrow={t('company')}
                title={t('wkTitle')}
                sub={t('wkSub')}
                actions={
                    draft && (
                        <button type="button" className="btn btn-ghost wk-clear" onClick={clearDraft}>
                            <Icon name="refresh" size={18} />
                            {t('wkStartOver')}
                        </button>
                    )
                }
            />

            {plan.length > 0 && (
                <section className="card wk-current rise">
                    <div className="card-head">
                        <div>
                            <h2 className="card-title">{t('wkCurrentPlan')}</h2>
                            <p className="card-sub">{t('planProgress', { done: planDone, total: plan.length })}</p>
                        </div>
                    </div>
                    <PlanList items={plan} products={products} today={today} canEdit={canEdit} onRecord={recordPlan} onToggle={togglePlan} busy={busyPlan} />
                </section>
            )}

            {draft ? (
                <section className="card wk-source rise">
                    <div className="wk-source-head">
                        <span className="wk-source-icon" aria-hidden="true">
                            <Icon name={draft.source === 'manual' ? 'pencil' : 'sparkles'} size={20} />
                        </span>
                        <div>
                            <h2 className="card-title">{draft.source === 'manual' ? t('wkFromManual') : t('wkFromAi')}</h2>
                            <p className="card-sub">{t('wkFromAiSub')}</p>
                        </div>
                    </div>
                    <div className="wk-src-sheets">
                        {sheetLine(t('wkPrev'), prevSheet, savedPrev, prevMatch ? prevMatch.rows.size : null)}
                        {sheetLine(t('wkCurr'), currSheet, null, currMatch ? currMatch.rows.size : null)}
                    </div>
                    <div className="wk-source-actions">
                        {writeStock(t('wkSendNew'), !prevPresent)}
                        <button type="button" className="btn btn-ghost btn-sm" onClick={clearDraft}>
                            <Icon name="x" size={16} />
                            {t('wkClear')}
                        </button>
                    </div>
                </section>
            ) : (
                <section className="card wk-start rise">
                    <span className="wk-start-icon" aria-hidden="true">
                        <Icon name="sparkles" size={26} />
                    </span>
                    <h2 className="wk-start-title">{t('wkStartTitle')}</h2>
                    <p className="wk-start-text">{t('wkStartText')}</p>
                    <div className="wk-start-actions">
                        {writeStock(t('wkSendToAi'), true)}
                        <button type="button" className="btn btn-outline" onClick={() => openAi()}>
                            <Icon name="sparkles" size={18} />
                            {t('wkOpenAi')}
                        </button>
                    </div>
                    <div className="wk-example" aria-label={t('wkExampleTitle')}>
                        <p className="wk-example-title">{t('wkExampleTitle')}</p>
                        <pre className="wk-example-text">{t('wkExampleText')}</pre>
                    </div>
                    <p className="hint wk-start-hint">{lastWeek ? t('wkStartHintSaved', { date: longDate(lastWeek.currDate) }) : t('wkStartHint')}</p>
                    <button type="button" className="link-btn wk-manual" onClick={startManual}>
                        <Icon name="pencil" size={15} />
                        {t('wkManual')}
                    </button>
                </section>
            )}

            {draft && (
                <section className="card wk-step rise">
                    <h2 className="wk-step-title">
                        <span className="wk-step-no num">{(step += 1)}</span>
                        {t('wkStep2')}
                    </h2>
                    <div className="wk-dates">
                        <label className="field">
                            <span className="wk-date-label">
                                {t('wkPrev')} · {t('wkSheetDate')}
                            </span>
                            <input className="input" type="date" value={prevDate} onChange={(e) => setDateEdit((d) => ({ ...d, prev: e.target.value }))} data-date="prev" />
                            {prevPresent && !prevDate && <span className="field-error">{t('wkNoDate')}</span>}
                        </label>
                        <label className="field">
                            <span className="wk-date-label">
                                {t('wkCurr')} · {t('wkSheetDate')}
                            </span>
                            <input className="input" type="date" value={currDate} onChange={(e) => setDateEdit((d) => ({ ...d, curr: e.target.value }))} data-date="curr" />
                            {currPresent && !currDate && <span className="field-error">{t('wkNoDate')}</span>}
                        </label>
                        <div className={`wk-days${prevDate && currDate && days <= 0 ? ' is-bad' : ''}`}>
                            {prevDate && currDate ? (days > 0 ? t('wkDaysBetween', { n: days }) : t('wkDaysBad')) : '—'}
                        </div>
                    </div>

                    {askBox('prev', prevAsk)}
                    {askBox('curr', currAsk)}

                    <div className={`wk-check${flaggedCount ? ' is-warn' : ' is-ok'}`}>
                        <Icon name={flaggedCount ? 'alert' : 'check'} size={17} />
                        <span>{flaggedCount ? t('wkCheckN', { n: flaggedCount }) : t('wkAllGood')}</span>
                        <button type="button" className="link-btn wk-show-all" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
                            {showAll ? (flaggedCount ? t('wkCheckOnly') : t('close')) : t('wkShowAll', { n: lines.filter((l) => !l.excluded).length })}
                        </button>
                        {recorded.size > 0 && (
                            <button type="button" className="link-btn wk-use-records" onClick={useRecords} title={t('wkFromRecordsTitle')}>
                                {t('wkUseRecords')}
                            </button>
                        )}
                    </div>
                    <ol className="wk-review">
                        {lines
                            .filter((l) => showAll || l.flagged)
                            .map((l) => {
                                const p = products.find((x) => x.id === l.pid);
                                const index = products.findIndex((x) => x.id === l.pid) + 1;
                                if (l.excluded) {
                                    return (
                                        <li key={l.pid} className="wk-row is-out" data-pid={l.pid}>
                                            <span className="wk-no num">{index}</span>
                                            <span className="wk-name">{p ? p.name : l.pid}</span>
                                            <span className="wk-out-note">{picks.curr[l.pid] === 'none' ? t('wkNotInSheet') : t('wkNotFound')}</span>
                                        </li>
                                    );
                                }
                                const rec = recorded.get(l.pid);
                                return (
                                    <li key={l.pid} className={`wk-row${l.flagged ? ' is-flag' : ''}`} data-pid={l.pid}>
                                        <div className="wk-row-head">
                                            <span className="wk-no num">{index}</span>
                                            <div className="wk-row-names">
                                                <p className="wk-name">{p ? p.name : l.pid}</p>
                                                {l.currSide.rowName && <p className="wk-sheetname">{l.currSide.rowName}</p>}
                                            </div>
                                            {l.flagged && l.bad.length === 0 && (
                                                <button type="button" className="btn btn-ghost btn-sm wk-ok" onClick={() => setOkRows((s) => new Set([...s, l.pid]))}>
                                                    <Icon name="check" size={15} />
                                                    {t('wkConfirmRow')}
                                                </button>
                                            )}
                                        </div>
                                        <div className="wk-cells">
                                            {cellInput(l, 'prev', t('wkColPrev'), l.prevSide.found ? l.prevSide.qty : null)}
                                            {cellInput(l, 'qty', t('wkColQty'), l.currSide.qty)}
                                            {cellInput(l, 'south', t('wkColSouth'), l.currSide.south)}
                                            {cellInput(l, 'left', t('wkColLeft'), l.currSide.remain)}
                                            {cellInput(
                                                l,
                                                'made',
                                                `${t('wkColMade')} ${t('optional')}`,
                                                null,
                                                rec ? (
                                                    <button type="button" className="link-btn wk-rec" title={t('wkFromRecordsTitle')} onClick={() => setCell(l.pid, 'made', String(rec))}>
                                                        {t('wkFromRecords', { n: fmt(rec) })}
                                                    </button>
                                                ) : undefined,
                                            )}
                                        </div>
                                        {l.flagged && l.mismatch && (
                                            <p className="wk-warn">
                                                <Icon name="alert" size={14} />
                                                {t('wkMismatch')}: {num(l.qty, 2)} − {num(l.south, 2)} = {num((l.qty || 0) - (l.south || 0), 2)} ≠ {num(l.left, 2)}
                                            </p>
                                        )}
                                        {l.flagged && l.unclear.length > 0 && (
                                            <p className="wk-warn">
                                                <Icon name="eye" size={14} />
                                                {t('wkUnclear')}
                                            </p>
                                        )}
                                    </li>
                                );
                            })}
                    </ol>
                </section>
            )}

            {(draft || shownWeek) && (
                <section className="card wk-step rise">
                    <h2 className="wk-step-title">
                        <span className="wk-step-no num">{(step += 1)}</span>
                        {t('wkStep3')}
                    </h2>
                    {!ready ? (
                        <p className="empty-mini wk-wait">{t('wkNeedBoth')}</p>
                    ) : (
                        <>
                            {!draft && shownWeek && <p className="wk-latest">{t('wkLatestNote', { from: longDate(shownWeek.prevDate), to: longDate(shownWeek.currDate), by: shownWeek.by })}</p>}
                            <div className="wk-kpis">
                                <div className="wk-kpi">
                                    <span>{t('wkDaysBetween', { n: aDays })}</span>
                                    <strong className="num">
                                        {longDate(aPrev)} → {longDate(aCurr)}
                                    </strong>
                                </div>
                                <div className="wk-kpi is-urgent">
                                    <span>{t('wkGroup_urgent')}</span>
                                    <strong className="num">{counts.urgent || 0}</strong>
                                </div>
                                <div className="wk-kpi is-next">
                                    <span>{t('wkGroup_next')}</span>
                                    <strong className="num">{counts.next || 0}</strong>
                                </div>
                                <div className="wk-kpi is-later">
                                    <span>{t('wkGroup_later')}</span>
                                    <strong className="num">{counts.later || 0}</strong>
                                </div>
                            </div>

                            <details className="wk-settings">
                                <summary>
                                    <Icon name="layers" size={16} />
                                    {t('wkSettings')} · {settings.urgent} / {settings.soon} / {settings.target} · {settings.perDay}
                                </summary>
                                <div className="wk-settings-grid">
                                    {(
                                        [
                                            ['urgent', 'wkSetUrgent'],
                                            ['soon', 'wkSetSoon'],
                                            ['target', 'wkSetTarget'],
                                            ['perDay', 'wkSetPerDay'],
                                        ] as Array<[keyof StockSettings, Key]>
                                    ).map(([k, label]) => (
                                        <label key={k} className="field">
                                            <span className="wk-date-label">{t(label)}</span>
                                            <input className="input num" type="number" min={1} value={settings[k]} data-setting={k} onChange={(e) => changeSetting(k, e.target.value)} />
                                        </label>
                                    ))}
                                    <button
                                        type="button"
                                        className="btn btn-ghost btn-sm"
                                        onClick={() => {
                                            settingsTouched.current = true;
                                            setSettings(DEFAULT_SETTINGS);
                                            setChosen(null);
                                        }}
                                    >
                                        {t('wkSetReset')}
                                    </button>
                                </div>
                            </details>

                            <div className="wk-insights">
                                {view.length > 0 && (
                                    <div className="wk-top wk-low">
                                        <h3 className="wk-sub-title">
                                            <Icon name="alert" size={17} />
                                            {t('wkLowTitle')}
                                        </h3>
                                        {low.length === 0 && <p className="empty-mini">{t('wkLowNone')}</p>}
                                        <ol className="wk-top-list">
                                            {low.map((v, i) => (
                                                    <li key={v.productId} className="wk-top-item">
                                                        <span className="wk-top-rank num">{i + 1}</span>
                                                        <span className="wk-top-name">{nameOf.get(v.productId)}</span>
                                                        <span className="wk-top-rate num">{t('wkDaysN', { n: rate(v.cover) })}</span>
                                                    </li>
                                                ))}
                                        </ol>
                                    </div>
                                )}
                                {top.length > 0 && (
                                    <div className="wk-top">
                                        <h3 className="wk-sub-title">
                                            <Icon name="trendUp" size={17} />
                                            {t('wkTop5')}
                                        </h3>
                                        <ol className="wk-top-list">
                                            {top.map((r, i) => (
                                                <li key={r.productId} className="wk-top-item">
                                                    <span className="wk-top-rank num">{i + 1}</span>
                                                    <span className="wk-top-name">{nameOf.get(r.productId)}</span>
                                                    <span className="wk-top-rate num">{t('wkPerDayN', { n: rate(r.daily) })}</span>
                                                </li>
                                            ))}
                                        </ol>
                                    </div>
                                )}
                            </div>

                            <details className="wk-table">
                                <summary>
                                    <Icon name="layers" size={16} />
                                    {t('wkTableAll', { n: results.length })}
                                </summary>
                                {resultTable(results)}
                            </details>
                        </>
                    )}
                </section>
            )}

            {ready && !showChoose && (
                <section className="card wk-replan rise">
                    <p>
                        <Icon name="check" size={17} />
                        {t('wkPlanRunning', { done: planDone, total: plan.length })}
                    </p>
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => setReplan(true)}>
                        <Icon name="refresh" size={15} />
                        {t('wkReplan', { n: PLAN_MAX })}
                    </button>
                </section>
            )}

            {showChoose && (
                <section className="card wk-step wk-plan rise">
                    <h2 className="wk-step-title">
                        <span className="wk-step-no num">{(step += 1)}</span>
                        {t('wkChooseTitle', { n: PLAN_MAX })}
                        <span className={`wk-chosen-count num${full ? ' is-full' : ''}`}>{t('wkChosenN', { n: choice.length, max: PLAN_MAX })}</span>
                    </h2>
                    <p className="hint">{t('wkChooseHint', { date: longDate(today) })}</p>
                    {choice.length === 0 ? (
                        <p className="empty-mini wk-wait">{t('wkPlanEmpty')}</p>
                    ) : (
                        <ol className="wk-plan-list">
                            {choice.map((c, i) => {
                                const v = viewOf.get(c.productId);
                                return (
                                    <li key={c.productId} className="wk-plan-item" data-pid={c.productId}>
                                        <span className="wk-plan-no num">{i + 1}</span>
                                        <div className="wk-plan-name">
                                            <strong>{nameOf.get(c.productId)}</strong>
                                            {v && <span className={`wk-group ${GROUP_TONE[v.group]}`}>{groupLabel(v.group)}</span>}
                                        </div>
                                        {v && (
                                            <p className="wk-plan-why">
                                                <span>{leftNowText(v)}</span>
                                                {v.producedSince > 0 && <span className="is-made">{t('wkMadeSince', { n: fmt(v.producedSince) })}</span>}
                                            </p>
                                        )}
                                        <input
                                            className="input num wk-plan-qty"
                                            inputMode="numeric"
                                            value={c.qty ? String(c.qty) : ''}
                                            aria-label={t('quantity')}
                                            onChange={(e) => {
                                                const n = parseNum(e.target.value);
                                                changeChoice((list) => {
                                                    list[i].qty = typeof n === 'number' ? Math.round(n) : 0;
                                                    return list;
                                                });
                                            }}
                                        />
                                        <input
                                            className="input wk-plan-date"
                                            type="date"
                                            value={c.date}
                                            aria-label={t('date')}
                                            onChange={(e) =>
                                                changeChoice((list) => {
                                                    list[i].date = e.target.value;
                                                    return list;
                                                })
                                            }
                                        />
                                        <div className="wk-plan-move">
                                            <button
                                                type="button"
                                                className="icon-btn icon-btn-sm"
                                                aria-label={t('wkUp')}
                                                disabled={i === 0}
                                                onClick={() =>
                                                    changeChoice((list) => {
                                                        [list[i - 1], list[i]] = [list[i], list[i - 1]];
                                                        return list;
                                                    })
                                                }
                                            >
                                                <Icon name="chevronLeft" size={16} style={{ transform: 'rotate(90deg)' }} />
                                            </button>
                                            <button
                                                type="button"
                                                className="icon-btn icon-btn-sm"
                                                aria-label={t('wkDown')}
                                                disabled={i === choice.length - 1}
                                                onClick={() =>
                                                    changeChoice((list) => {
                                                        [list[i + 1], list[i]] = [list[i], list[i + 1]];
                                                        return list;
                                                    })
                                                }
                                            >
                                                <Icon name="chevronRight" size={16} style={{ transform: 'rotate(90deg)' }} />
                                            </button>
                                            <button
                                                type="button"
                                                className="icon-btn icon-btn-sm icon-btn-danger"
                                                aria-label={t('wkRemove')}
                                                onClick={() => changeChoice((list) => list.filter((_, k) => k !== i))}
                                            >
                                                <Icon name="x" size={16} />
                                            </button>
                                        </div>
                                    </li>
                                );
                            })}
                        </ol>
                    )}

                    <div className="wk-alts">
                        <h3 className="wk-sub-title">
                            <Icon name="plus" size={16} />
                            {t('wkAlternatives')}
                        </h3>
                        {full && <p className="hint wk-full-hint">{t('wkFullHint', { max: PLAN_MAX })}</p>}
                        <div className="wk-alt-list">
                            {others.slice(0, moreAlts ? 25 : 8).map((v) => (
                                <button
                                    key={v.productId}
                                    type="button"
                                    className={`wk-alt ${GROUP_TONE[v.group]}`}
                                    disabled={full}
                                    onClick={() => addChoice(v.productId)}
                                    data-pid={v.productId}
                                >
                                    <span className="wk-alt-name">{nameOf.get(v.productId)}</span>
                                    <span className="wk-alt-days num">{Number.isFinite(v.cover) ? t('wkDaysN', { n: rate(v.cover) }) : t('wkNoOut')}</span>
                                </button>
                            ))}
                            {others.length > 8 && (
                                <button type="button" className="link-btn wk-alt-more" onClick={() => setMoreAlts((x) => !x)} aria-expanded={moreAlts}>
                                    {moreAlts ? t('close') : t('wkMoreAlts', { n: others.length - 8 })}
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="wk-plan-tools">
                        <label className="field">
                            <span className="wk-date-label">{t('wkPlanStart')}</span>
                            <input
                                className="input"
                                type="date"
                                value={startDate}
                                onChange={(e) => {
                                    setStart(e.target.value);
                                    if (chosen) {
                                        const dates = schedule(chosen.length, e.target.value || startDate, settings.perDay);
                                        setChosen(chosen.map((c, i) => ({ ...c, date: dates[i] })));
                                    }
                                }}
                            />
                        </label>
                        {chosen && (
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setChosen(null)}>
                                <Icon name="refresh" size={15} />
                                {t('wkPlanReset')}
                            </button>
                        )}
                    </div>
                    <div className="wk-plan-foot">
                        <span className="wk-plan-total num">{t('wkPlanTotal', { n: choice.filter((c) => c.qty > 0).length, qty: fmt(choiceTotal) })}</span>
                        <button type="button" className="btn btn-primary wk-send" onClick={askSend} disabled={!draft && !choice.some((c) => c.qty > 0)}>
                            <Icon name="send" size={18} />
                            {choice.some((c) => c.qty > 0) || !draft ? t('wkSend') : t('wkSaveOnly')}
                        </button>
                    </div>
                </section>
            )}

            <section className="card wk-step rise">
                <h2 className="wk-step-title">
                    <Icon name="history" size={18} />
                    {t('wkHistory')}
                </h2>
                {weeksNewest.length === 0 ? (
                    <p className="empty-mini wk-wait">{t('wkHistoryEmpty')}</p>
                ) : (
                    <ul className="wk-hist">
                        {weeksNewest.map((w) => {
                            const before = stock ? stock.weeks.filter((x) => x.currDate < w.currDate) : [];
                            const res = analyze(w.rows, w.days, w.currDate, before, settings);
                            const u = res.filter((r) => r.group === 'urgent').length;
                            const n = res.filter((r) => r.group === 'next').length;
                            const open = openWeek === w.id;
                            return (
                                <li key={w.id} className={`wk-hist-item${open ? ' is-open' : ''}`}>
                                    <button type="button" className="wk-hist-head" onClick={() => setOpenWeek(open ? null : w.id)} aria-expanded={open}>
                                        <span className="wk-hist-dates num">{t('wkWeekLine', { from: longDate(w.prevDate), to: longDate(w.currDate), days: w.days })}</span>
                                        <span className="wk-hist-counts">{t('wkCounts', { u, n })}</span>
                                        <span className="wk-hist-by">{w.by}</span>
                                        <Icon name="chevronDown" size={18} className="wk-hist-caret" />
                                    </button>
                                    {open && <div className="wk-hist-body">{resultTable(res)}</div>}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>

            <ConfirmDialog
                open={confirmSend}
                message={
                    choice.some((c) => c.qty > 0)
                        ? t('wkSendConfirm', { n: choice.filter((c) => c.qty > 0).length, qty: fmt(choiceTotal) })
                        : t('wkSaveConfirm')
                }
                confirmLabel={choice.some((c) => c.qty > 0) || !draft ? t('wkSend') : t('wkSaveOnly')}
                icon="send"
                danger={false}
                onConfirm={async () => {
                    await doSend();
                    setConfirmSend(false);
                }}
                onClose={() => setConfirmSend(false)}
            />
        </div>
    );
}
