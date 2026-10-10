/**
 * Which version of the website this page runs, and whether a newer one was published since it was opened.
 * A page left open on a phone keeps running its old code until it is reloaded; old code must not save
 * data whose format it does not know (see SCHEMA in source.ts), so open pages look for updates.
 */
export const BUILD: string = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

/** the build stamp of the website as published now (null when it cannot be read) */
export async function publishedBuild(): Promise<string | null> {
    try {
        const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit' });
        if (!res.ok) {
            return null;
        }
        const json = (await res.json()) as { build?: unknown };
        return typeof json.build === 'string' && /^\d{8,14}$/.test(json.build) ? json.build : null;
    } catch {
        return null;
    }
}

export function isNewer(published: string | null): boolean {
    return Boolean(published && BUILD !== 'dev' && published > BUILD);
}

/** tell the page that the data was saved by a newer website (this one must reload before saving) */
export function announceOutdated(): void {
    window.dispatchEvent(new Event('milako:outdated'));
}
