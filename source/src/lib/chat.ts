/**
 * Production ↔ warehouse chat: who has something new to read, and which ✗ marks still wait for an answer.
 * "Read" is remembered on each device (the chat itself is in data.json, shared by everyone).
 */
import type { ChatMsg, Entry, MonthMap } from './types';

const SEEN_KEY = 'milako.chatSeen';
/** a device opening the chat for the first time counts the last 3 days as new */
const FIRST_LOOK_MS = 3 * 24 * 3600 * 1000;
let seenMemory = 0;

export function readSeen(): number {
    try {
        const v = Number(localStorage.getItem(SEEN_KEY));
        if (Number.isFinite(v) && v > 0) {
            return v;
        }
        const first = Date.now() - FIRST_LOOK_MS;
        localStorage.setItem(SEEN_KEY, String(first));
        return first;
    } catch {
        return seenMemory || (seenMemory = Date.now() - FIRST_LOOK_MS);
    }
}

export function writeSeen(at: number): void {
    seenMemory = at;
    try {
        localStorage.setItem(SEEN_KEY, String(Math.round(at)));
    } catch {
        // storage blocked: remembered for this visit only
    }
}

/** names typed on different phones: ignore spaces and letter case */
export function samePerson(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) {
        return false;
    }
    const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
    return norm(a) === norm(b);
}

export interface FoundRun {
    entry: Entry;
    month: string;
}

/** a run by id (looks in `hint` month first, then everywhere: the date may have been changed) */
export function findRun(months: MonthMap, id: string, hint?: string): FoundRun | null {
    if (hint && months[hint]) {
        const e = months[hint].find((x) => x.id === id);
        if (e) {
            return { entry: e, month: hint };
        }
    }
    for (const month of Object.keys(months)) {
        const e = months[month].find((x) => x.id === id);
        if (e) {
            return { entry: e, month };
        }
    }
    return null;
}

/** messages written by someone else after `seen` */
export function unreadOf(chat: ChatMsg[], me: string, seen: number): ChatMsg[] {
    return chat.filter((m) => m.at > seen && !samePerson(m.by, me));
}

/** every run marked ✗ that is not solved yet, newest mark first */
export function openIssues(months: MonthMap): FoundRun[] {
    const out: FoundRun[] = [];
    for (const month of Object.keys(months)) {
        for (const e of months[month]) {
            if (e.issue) {
                out.push({ entry: e, month });
            }
        }
    }
    return out.sort((a, b) => (b.entry.issue?.at || 0) - (a.entry.issue?.at || 0));
}

/**
 * Runs I recorded (or last changed) that the warehouse marked ✗ and that I have not answered yet:
 * no message, correction or reply from me after the mark.
 */
export function waitingForMe(months: MonthMap, chat: ChatMsg[], me: string): FoundRun[] {
    if (!me) {
        return [];
    }
    return openIssues(months).filter(({ entry }) => {
        const issue = entry.issue!;
        if (samePerson(issue.by, me)) {
            return false; // I marked it myself
        }
        if (!samePerson(entry.by, me) && !samePerson(entry.editedBy, me)) {
            return false;
        }
        if (samePerson(entry.editedBy, me) && (entry.editedAt || 0) > issue.at) {
            return false; // I already corrected it
        }
        return !chat.some((m) => m.ref && m.ref.id === entry.id && m.at > issue.at && samePerson(m.by, me));
    });
}

/** id of the newest ✗ message for each run (only that one shows the buttons) */
export function latestFlags(chat: ChatMsg[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of chat) {
        if (m.kind === 'flag' && m.ref) {
            out.set(m.ref.id, m.id);
        }
    }
    return out;
}

export function latestAt(chat: ChatMsg[]): number {
    return chat.reduce((max, m) => Math.max(max, m.at), 0);
}
