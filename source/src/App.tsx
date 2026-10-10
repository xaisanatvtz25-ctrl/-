import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './styles/app.css';
import { I18nProvider, useI18n } from './lib/i18n';
import { StoreProvider, useStore } from './lib/store';
import { EditorProvider, useEditor } from './lib/editor';
import { SessionProvider, useSession } from './lib/session';
import { ToastProvider } from './components/Toast';
import { useHashRoute } from './lib/router';
import { currentYm, parseYm } from './lib/format';
import { latestMonthWithData } from './lib/stats';
import { Overview } from './pages/Overview';
import { Monthly } from './pages/Monthly';
import { Products } from './pages/Products';
import { History } from './pages/History';
import { Stock, pendingByMonth } from './pages/Stock';
import { Chat, previewOf } from './pages/Chat';
import { Weekly } from './pages/Weekly';
import { latestAt, readSeen, samePerson, unreadOf, waitingForMe, writeSeen } from './lib/chat';
import { isNewer, publishedBuild } from './lib/update';
import { onAiRequest } from './lib/aiEvents';
import { useToast } from './components/Toast';
import { fmt } from './lib/format';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Icon } from './components/Icon';
import type { IconName } from './components/Icon';
import { LogoMark } from './components/Logo';
import { LangSwitch } from './components/LangSwitch';
import { SoundToggle } from './components/SoundToggle';
import { AiChat } from './components/AiChat';
import { EntryModal } from './components/EntryModal';
import type { EntryModalState } from './components/EntryModal';
import { ProductModal } from './components/ProductModal';
import type { ProductModalState } from './components/ProductModal';
import { Skeleton } from './components/Bits';

function App() {
    return (
        <I18nProvider>
            <ToastProvider>
                <Root />
            </ToastProvider>
        </I18nProvider>
    );
}

function Root() {
    // nothing is shown (or even loaded) before logging in
    return (
        <SessionProvider>
            <EditorProvider>
                <StoreProvider>
                    <Shell />
                </StoreProvider>
            </EditorProvider>
        </SessionProvider>
    );
}

/** The person logged in (opens the account: change password, log out). */
function UserButton({ onAction }: { onAction?: () => void }) {
    const { t } = useI18n();
    const session = useSession();
    const editor = useEditor();
    return (
        <button
            type="button"
            className="side-user"
            onClick={() => {
                onAction?.();
                editor.openAccount();
            }}
            aria-label={`${t('acTitle')}: ${session.name}`}
        >
            <span className="side-user-avatar" aria-hidden="true">
                <Icon name="user" size={17} />
            </span>
            <span className="side-user-text">
                <strong>{session.name}</strong>
                <small>{t('acOpen')}</small>
            </span>
            <Icon name="chevronRight" size={16} />
        </button>
    );
}

/** Unlock (or lock) control, in the menu (the sidebar on a computer, the ☰ menu on a phone). */
function EditButton({ variant, onAction }: { variant: 'side' | 'top'; onAction?: () => void }) {
    const { t } = useI18n();
    const editor = useEditor();
    const openAccount = () => {
        onAction?.();
        editor.openAccount();
    };
    const login = () => {
        onAction?.();
        editor.requireLogin();
    };
    if (editor.canEdit) {
        return variant === 'side' ? (
            <button type="button" className="side-edit is-on" onClick={openAccount}>
                <span className="side-edit-dot" aria-hidden="true" />
                <span className="side-edit-text">
                    <strong>{t('editingAs')}</strong>
                    <small>{editor.name}</small>
                </span>
                <Icon name="lock" size={18} />
            </button>
        ) : (
            <button
                type="button"
                className="icon-btn top-edit-on"
                onClick={openAccount}
                aria-label={`${t('account')}: ${editor.name}`}
                title={`${t('editingAs')} · ${editor.name}`}
            >
                <Icon name="pencil" size={18} />
                <span className="top-edit-dot" aria-hidden="true" />
            </button>
        );
    }
    return variant === 'side' ? (
        <button type="button" className="side-edit" onClick={login}>
            <Icon name="lock" size={18} />
            <span>{t('editLogin')}</span>
        </button>
    ) : (
        <button type="button" className="icon-btn top-lock" onClick={login} aria-label={t('editLogin')} title={t('editLogin')}>
            <Icon name="lock" size={19} />
        </button>
    );
}

/** true while the screen is narrow (phone or small tablet: the menu is the ☰ drawer) */
function useNarrow(query = '(max-width: 900px)'): boolean {
    const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false));
    useEffect(() => {
        if (!window.matchMedia) {
            return undefined;
        }
        const mq = window.matchMedia(query);
        const on = () => setNarrow(mq.matches);
        on();
        if (mq.addEventListener) {
            mq.addEventListener('change', on);
            return () => mq.removeEventListener('change', on);
        }
        mq.addListener(on);
        return () => mq.removeListener(on);
    }, [query]);
    return narrow;
}

function Shell() {
    const { t } = useI18n();
    const { loaded, loadError, refresh, months, chat, products, source } = useStore();
    const editor = useEditor();
    const toast = useToast();
    const [route, navigate] = useHashRoute();
    const [year, setYearState] = useState(() => parseYm(currentYm()).y);
    // until someone picks a year, show the year of the newest data (e.g. last year in early January)
    const yearPickedRef = useRef(false);
    const setYear = useCallback((y: number) => {
        yearPickedRef.current = true;
        setYearState(y);
    }, []);
    const [aiOpen, setAiOpen] = useState(false);
    // phones: the menu opens from the ☰ button at the top right
    const narrow = useNarrow();
    const [menuOpen, setMenuOpen] = useState(false);
    const menuBtnRef = useRef<HTMLButtonElement>(null);
    const menuCloseRef = useRef<HTMLButtonElement>(null);
    const menuWasOpen = useRef(false);
    const [entryState, setEntryState] = useState<EntryModalState | null>(null);
    const [productState, setProductState] = useState<ProductModalState | null>(null);

    const defaultYm = useMemo(() => {
        const now = currentYm();
        if ((months[now] || []).length) {
            return now;
        }
        return latestMonthWithData(months) || now;
    }, [months]);

    const monthYm = route.name === 'month' ? route.ym || defaultYm : defaultYm;

    useEffect(() => {
        if (route.name === 'month' && route.ym) {
            setYearState(parseYm(route.ym).y);
        }
    }, [route]);

    useEffect(() => {
        if (loaded && !yearPickedRef.current && route.name !== 'month') {
            setYearState(parseYm(defaultYm).y);
        }
    }, [loaded, defaultYm, route.name]);

    useEffect(() => {
        if (route.name !== 'chat') {
            window.scrollTo({ top: 0 }); // the chat scrolls itself (to the new messages)
        }
    }, [route.name]);

    // the assistant can be opened from any page (e.g. with stock sheets to read)
    useEffect(
        () =>
            onAiRequest(() => {
                setMenuOpen(false);
                setAiOpen(true);
            }),
        [],
    );

    // the menu closes when a page is chosen, or when the screen becomes wide
    useEffect(() => {
        setMenuOpen(false);
    }, [route]);
    useEffect(() => {
        if (!narrow) {
            setMenuOpen(false);
        }
    }, [narrow]);
    useEffect(() => {
        const open = menuOpen && narrow;
        document.body.classList.toggle('menu-open', open);
        if (open) {
            menuWasOpen.current = true;
            window.setTimeout(() => menuCloseRef.current?.focus(), 40);
            const onKey = (e: KeyboardEvent) => {
                if (e.key === 'Escape') {
                    setMenuOpen(false);
                }
            };
            document.addEventListener('keydown', onKey);
            return () => document.removeEventListener('keydown', onKey);
        }
        if (menuWasOpen.current) {
            menuWasOpen.current = false;
            const active = document.activeElement;
            if (!active || active === document.body || (active instanceof HTMLElement && active.closest('.sidebar'))) {
                menuBtnRef.current?.focus();
            }
        }
        return undefined;
    }, [menuOpen, narrow]);

    // warehouse: runs still waiting to be ticked as received, and the month to open
    const waiting = useMemo(() => pendingByMonth(months), [months]);
    const waitingCount = waiting.reduce((s, x) => s + x.n, 0);
    const stockYm = useMemo(() => {
        if (route.name === 'stock' && route.ym) {
            return route.ym;
        }
        const now = currentYm();
        if ((months[now] || []).length) {
            return now; // this month already has runs
        }
        if (waiting.length) {
            return waiting[waiting.length - 1].ym; // latest month still waiting
        }
        return defaultYm;
    }, [route, months, waiting, defaultYm]);

    // production ↔ warehouse chat: what is new for the person using this device
    const me = editor.name;
    const [seen, setSeen] = useState(readSeen);
    const markSeen = useCallback((at: number) => {
        setSeen((prev) => {
            if (at > prev) {
                writeSeen(at);
                return at;
            }
            return prev;
        });
    }, []);
    const unread = useMemo(() => unreadOf(chat, me, seen), [chat, me, seen]);
    const mine = useMemo(() => waitingForMe(months, chat, me), [months, chat, me]);

    // a short note when a message arrives while the site is open on another page
    const startRef = useRef(Date.now());
    const notifiedRef = useRef(0);
    useEffect(() => {
        if (!loaded) {
            return;
        }
        const newest = latestAt(chat);
        const fresh = chat.filter((m) => m.at > Math.max(notifiedRef.current, startRef.current) && !samePerson(m.by, me));
        notifiedRef.current = Math.max(notifiedRef.current, newest);
        if (fresh.length && route.name !== 'chat') {
            const last = fresh[fresh.length - 1];
            const text = previewOf(last, t);
            toast.show(`${last.by}: ${text.length > 70 ? text.slice(0, 69) + '…' : text}`, 'info', last.kind === 'flag' ? 'flag' : 'message', 'chat');
        }
        // the route is read at the time of the change only
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chat, loaded]);

    // a newer website was published: offer a reload, and reload by itself when the person comes back to the page
    const [updateReady, setUpdateReady] = useState(false);
    useEffect(() => {
        let alive = true;
        const check = async () => {
            if (document.visibilityState === 'visible' && isNewer(await publishedBuild()) && alive) {
                setUpdateReady(true);
            }
        };
        const first = window.setTimeout(() => void check(), 8000);
        const timer = window.setInterval(() => void check(), 5 * 60_000);
        const onOutdated = () => setUpdateReady(true);
        const onVisible = () => void check();
        window.addEventListener('milako:outdated', onOutdated);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            alive = false;
            window.clearTimeout(first);
            window.clearInterval(timer);
            window.removeEventListener('milako:outdated', onOutdated);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, []);
    useEffect(() => {
        if (!updateReady) {
            return;
        }
        const onVisible = () => {
            const typing = (document.getElementById('chat-input') as HTMLTextAreaElement | null)?.value.trim();
            if (document.visibilityState === 'visible' && !document.querySelector('.modal-root') && !typing) {
                window.location.reload();
            }
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [updateReady]);

    // "(2) Milako" in the browser tab while there are unread messages
    const titleRef = useRef(document.title);
    useEffect(() => {
        document.title = unread.length ? `(${unread.length}) ${titleRef.current}` : titleRef.current;
    }, [unread.length]);

    const nav: Array<{
        key: string;
        label: string;
        icon: IconName;
        href: string;
        active: boolean;
        badge?: number;
        badgeLabel?: string;
    }> = [
        { key: 'overview', label: t('navOverview'), icon: 'overview', href: '#/', active: route.name === 'overview' },
        { key: 'month', label: t('navMonthly'), icon: 'calendar', href: `#/month/${monthYm}`, active: route.name === 'month' },
        {
            key: 'stock',
            label: t('navStock'),
            icon: 'warehouse',
            href: `#/stock/${stockYm}`,
            active: route.name === 'stock',
            badge: waitingCount,
            badgeLabel: t('stockWaitingCount', { n: waitingCount }),
        },
        {
            key: 'chat',
            label: t('navChat'),
            icon: 'chat',
            href: '#/chat',
            active: route.name === 'chat',
            badge: unread.length,
            badgeLabel: t('chatUnreadLabel', { n: unread.length }),
        },
        { key: 'weekly', label: t('navWeekly'), icon: 'bulb', href: '#/weekly', active: route.name === 'weekly' },
        { key: 'products', label: t('navProducts'), icon: 'box', href: '#/products', active: route.name === 'products' },
        { key: 'history', label: t('navHistory'), icon: 'history', href: '#/history', active: route.name === 'history' },
    ];

    // the strip above the page: runs of mine marked ✗ that wait for my answer, else unread messages
    let alert: { tone: 'danger' | 'info'; title: string; sub: string; href: string } | null = null;
    if (loaded && route.name !== 'chat') {
        if (mine.length) {
            const first = mine[0].entry;
            const name = products.find((p) => p.id === first.productId)?.name || '—';
            const counted = first.issue && first.issue.counted !== undefined ? ` · ${t('issueCountLine', { qty: fmt(first.qty), counted: fmt(first.issue.counted) })}` : '';
            alert = {
                tone: 'danger',
                title: t('alertMine', { n: mine.length }),
                sub: `${name}${counted}${first.issue && first.issue.reason ? ` — “${first.issue.reason}”` : ''}`,
                href: `#/chat/run/${encodeURIComponent(first.id)}`,
            };
        } else if (unread.length) {
            const names = [...new Set(unread.map((m) => m.by))].slice(0, 3).join(', ');
            const last = unread[unread.length - 1];
            alert = {
                tone: 'info',
                title: `${t('alertUnread', { n: unread.length })} ${t('alertFrom', { names })}`,
                sub: previewOf(last, t),
                href: last.ref ? `#/chat/run/${encodeURIComponent(last.ref.id)}` : '#/chat',
            };
        }
    }

    // adding or changing data asks for a login first (viewing never does)
    const { requireLogin } = editor;
    const openEntry = useCallback((s: EntryModalState) => requireLogin(() => setEntryState(s)), [requireLogin]);
    const openProduct = useCallback((s: ProductModalState) => requireLogin(() => setProductState(s)), [requireLogin]);
    const closeAi = useCallback(() => setAiOpen(false), []);

    let content;
    if (!loaded && loadError) {
        content = (
            <div className="page">
                <div className="card load-error">
                    <Icon name="alert" size={28} />
                    <h2>{t('loadError')}</h2>
                    <button type="button" className="btn btn-primary" onClick={() => void refresh()}>
                        <Icon name="refresh" size={18} />
                        {t('retry')}
                    </button>
                </div>
            </div>
        );
    } else if (!loaded) {
        content = (
            <div className="page" aria-busy="true">
                <p className="loading-text">{t('loading')}</p>
                <div className="kpi-grid">
                    <Skeleton rows={1} />
                    <Skeleton rows={1} />
                    <Skeleton rows={1} />
                    <Skeleton rows={1} />
                </div>
                <Skeleton rows={3} />
            </div>
        );
    } else if (route.name === 'month') {
        content = (
            <Monthly
                ym={monthYm}
                navigate={navigate}
                openEntry={openEntry}
            />
        );
    } else if (route.name === 'products') {
        content = <Products year={year} setYear={setYear} openEntry={openEntry} openProduct={openProduct} />;
    } else if (route.name === 'history') {
        content = <History />;
    } else if (route.name === 'stock') {
        content = <Stock ym={stockYm} navigate={navigate} />;
    } else if (route.name === 'weekly') {
        content = <Weekly openEntry={openEntry} />;
    } else if (route.name === 'chat') {
        content = <Chat open={route.open} run={route.run} navigate={navigate} openEntry={openEntry} seen={seen} markSeen={markSeen} />;
    } else {
        content = <Overview year={year} setYear={setYear} navigate={navigate} openEntry={openEntry} />;
    }

    return (
        <div className="shell">
            <a href="#main" className="skip-link" onClick={(e) => {
                e.preventDefault();
                document.getElementById('main')?.focus();
            }}>
                Skip
            </a>
            <div className={`menu-scrim${menuOpen ? ' is-open' : ''}`} onClick={() => setMenuOpen(false)} aria-hidden="true" />
            <aside
                id="site-menu"
                className={`sidebar${menuOpen ? ' is-open' : ''}`}
                aria-label={t('menuTitle')}
                role={narrow ? 'dialog' : undefined}
                aria-modal={narrow ? true : undefined}
                inert={narrow && !menuOpen ? true : undefined}
            >
                <div className="side-brand">
                    <span className="side-logo">
                        <LogoMark size={44} light />
                    </span>
                    <span className="side-brand-text">
                        <strong>{t('company')}</strong>
                        <small>{t('system')}</small>
                    </span>
                    <button ref={menuCloseRef} type="button" className="side-close" onClick={() => setMenuOpen(false)} aria-label={t('menuClose')}>
                        <Icon name="x" size={20} />
                    </button>
                </div>
                <nav className="side-nav" aria-label="main">
                    {nav.map((n) => (
                        <a
                            key={n.key}
                            href={n.href}
                            className={`side-link${n.active ? ' is-active' : ''}`}
                            aria-current={n.active ? 'page' : undefined}
                        >
                            <Icon name={n.icon} size={20} />
                            <span>{n.label}</span>
                            {n.badge ? (
                                <span className="nav-badge num" aria-label={n.badgeLabel}>
                                    {n.badge > 99 ? '99+' : n.badge}
                                </span>
                            ) : null}
                        </a>
                    ))}
                    <button
                        type="button"
                        className="side-link side-ai"
                        onClick={() => {
                            setMenuOpen(false);
                            setAiOpen(true);
                        }}
                    >
                        <Icon name="sparkles" size={20} />
                        <span>{t('navAi')}</span>
                        <span className="side-ai-badge">AI</span>
                    </button>
                </nav>
                <div className="side-foot">
                    <div className={`online${source === 'snapshot' ? ' is-snapshot' : ''}`}>
                        <span className="online-dot" aria-hidden="true" />
                        <span>{source === 'snapshot' ? t('dataSnapshot') : t('dataLive')}</span>
                    </div>
                    <UserButton onAction={() => setMenuOpen(false)} />
                    <EditButton variant="side" onAction={() => setMenuOpen(false)} />
                    <SoundToggle variant="side" />
                    <LangSwitch dark />
                </div>
            </aside>

            <header className="topbar">
                <div className="topbar-left">
                    <a href="#/" className="topbar-brand" aria-label={t('navOverview')}>
                        <LogoMark size={34} />
                        <strong>{t('brand')}</strong>
                    </a>
                </div>
                <div className="topbar-actions">
                    <a
                        href="#/chat"
                        className={`icon-btn top-chat${route.name === 'chat' ? ' is-active' : ''}${unread.length ? ' has-new' : ''}`}
                        aria-label={unread.length ? `${t('navChat')} · ${t('chatUnreadLabel', { n: unread.length })}` : t('navChat')}
                        title={t('chatTitle')}
                    >
                        <Icon name="chat" size={19} />
                        {unread.length ? <span className="top-badge num">{unread.length > 99 ? '99+' : unread.length}</span> : null}
                    </a>
                    <button type="button" className="icon-btn top-ai" onClick={() => setAiOpen(true)} aria-label={t('aiOpen')} title={t('navAi')}>
                        <Icon name="sparkles" size={19} />
                    </button>
                    <button
                        ref={menuBtnRef}
                        type="button"
                        className={`icon-btn top-menu${menuOpen ? ' is-active' : ''}`}
                        onClick={() => setMenuOpen((v) => !v)}
                        aria-label={waitingCount ? `${t('menuOpen')} · ${t('stockWaitingCount', { n: waitingCount })}` : t('menuOpen')}
                        title={t('menuTitle')}
                        aria-expanded={menuOpen}
                        aria-controls="site-menu"
                    >
                        <Icon name="menu" size={22} />
                        {waitingCount ? <span className="top-badge num">{waitingCount > 99 ? '99+' : waitingCount}</span> : null}
                    </button>
                </div>
            </header>

            <main id="main" className="main" tabIndex={-1}>
                {updateReady && (
                    <div className="chat-alert-wrap">
                        <button type="button" className="update-bar" onClick={() => window.location.reload()}>
                            <Icon name="refresh" size={18} />
                            <span>{t('updateReady')}</span>
                            <strong>{t('reload')}</strong>
                        </button>
                    </div>
                )}
                {alert && (
                    <div className="chat-alert-wrap">
                        <a href={alert.href} className={`chat-alert is-${alert.tone}`}>
                            <span className="chat-alert-icon" aria-hidden="true">
                                <Icon name={alert.tone === 'danger' ? 'bell' : 'chat'} size={20} />
                            </span>
                            <span className="chat-alert-text">
                                <strong>{alert.title}</strong>
                                <small>{alert.sub}</small>
                            </span>
                            <span className="chat-alert-go">
                                {t('alertGo')}
                                <Icon name="chevronRight" size={16} />
                            </span>
                        </a>
                    </div>
                )}
                <div className="page-anim" key={route.name}>
                    <ErrorBoundary title={t('pageError')} action={t('reload')}>
                        {content}
                    </ErrorBoundary>
                </div>
            </main>

            <button
                type="button"
                className={`fab${aiOpen || route.name === 'chat' ? ' is-hidden' : ''}`}
                onClick={() => setAiOpen(true)}
                aria-label={t('aiOpen')}
            >
                <span className="fab-ring" aria-hidden="true" />
                <Icon name="sparkles" size={24} />
                <span className="fab-label">{t('navAi')}</span>
            </button>

            <AiChat open={aiOpen} onClose={closeAi} />
            <EntryModal
                state={entryState}
                onClose={() => setEntryState(null)}
                onSaved={(m) => {
                    if (route.name === 'month' && m !== monthYm) {
                        navigate(`#/month/${m}`);
                    }
                }}
            />
            <ProductModal state={productState} onClose={() => setProductState(null)} />
        </div>
    );
}

export default App;
