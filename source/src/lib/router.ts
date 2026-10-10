import { useCallback, useEffect, useState } from 'react';

/**
 * Minimal hash router (#/..., never absolute paths) so the app works from any
 * static host path.
 */
export type Route =
    | { name: 'overview' }
    | { name: 'month'; ym: string | null }
    | { name: 'products' }
    | { name: 'stock'; ym: string | null }
    | { name: 'history' }
    /** weekly stock analysis */
    | { name: 'weekly' }
    /** #/chat, #/chat/open (only runs still marked ✗), #/chat/run/<id> (jump to that run) */
    | { name: 'chat'; open: boolean; run: string | null };

function parse(hash: string): Route {
    const path = hash.replace(/^#/, '') || '/';
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'chat') {
        let run: string | null = null;
        if (parts[1] === 'run' && parts[2]) {
            try {
                run = decodeURIComponent(parts[2]).slice(0, 80);
            } catch {
                run = null;
            }
        }
        return { name: 'chat', open: parts[1] === 'open', run };
    }
    if (parts[0] === 'month') {
        const ym = parts[1] && /^\d{4}-(0[1-9]|1[0-2])$/.test(parts[1]) ? parts[1] : null;
        return { name: 'month', ym };
    }
    if (parts[0] === 'products') {
        return { name: 'products' };
    }
    if (parts[0] === 'history') {
        return { name: 'history' };
    }
    if (parts[0] === 'weekly') {
        return { name: 'weekly' };
    }
    if (parts[0] === 'stock') {
        const ym = parts[1] && /^\d{4}-(0[1-9]|1[0-2])$/.test(parts[1]) ? parts[1] : null;
        return { name: 'stock', ym };
    }
    return { name: 'overview' };
}

export function routeKey(route: Route): string {
    return route.name;
}

export function useHashRoute(): [Route, (to: string) => void] {
    const [route, setRoute] = useState<Route>(() => parse(window.location.hash));

    useEffect(() => {
        const onChange = () => setRoute(parse(window.location.hash));
        window.addEventListener('hashchange', onChange);
        return () => window.removeEventListener('hashchange', onChange);
    }, []);

    const navigate = useCallback((to: string) => {
        const target = to.startsWith('#') ? to : `#${to}`;
        if (window.location.hash !== target) {
            window.location.hash = target;
        } else {
            setRoute(parse(target));
        }
    }, []);

    return [route, navigate];
}
