/**
 * Small sound effects, made in the browser (Web Audio): no sound files to download.
 * A soft tick for every button, and its own sound for saving, ✓ received, ✗ not matching, sending,
 * a new message, deleting, undo and errors. Each device can switch them off (remembered).
 * Browsers only allow sound after the person has touched the page, so nothing plays before that.
 */

export type SoundName =
    | 'tap'
    | 'nav'
    | 'toggle'
    | 'check'
    | 'uncheck'
    | 'success'
    | 'error'
    | 'flag'
    | 'send'
    | 'message'
    | 'delete'
    | 'undo'
    | 'unlock'
    | 'lock';

const KEY = 'milako.sound';
const VOLUME = 0.32;

let enabled = readEnabled();
let ctx: AudioContext | null = null;
let out: GainNode | null = null;
const listeners = new Set<(on: boolean) => void>();
const lastAt: Partial<Record<SoundName, number>> = {};

/** the last sounds played (also read by the automatic tests) */
const played: string[] = [];
(window as unknown as { __sounds: string[] }).__sounds = played;

function readEnabled(): boolean {
    try {
        return localStorage.getItem(KEY) !== 'off';
    } catch {
        return true;
    }
}

export function soundEnabled(): boolean {
    return enabled;
}

export function onSoundChange(fn: (on: boolean) => void): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

export function setSoundEnabled(next: boolean): void {
    enabled = next;
    try {
        localStorage.setItem(KEY, next ? 'on' : 'off');
    } catch {
        // remembered for this visit only
    }
    listeners.forEach((fn) => fn(next));
    if (next) {
        wake();
        play('toggle');
    }
}

/** Starts (or resumes) the sound engine; called on the person's taps and key presses. */
export function wake(): void {
    if (!enabled) {
        return;
    }
    try {
        if (!ctx) {
            const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!AC) {
                return;
            }
            ctx = new AC();
            out = ctx.createGain();
            out.gain.value = VOLUME;
            // keeps sounds that overlap from getting harsh
            const soft = ctx.createDynamicsCompressor();
            soft.threshold.value = -14;
            soft.ratio.value = 4;
            out.connect(soft);
            soft.connect(ctx.destination);
        }
        if (ctx.state === 'suspended') {
            void ctx.resume().catch(() => undefined);
        }
    } catch {
        ctx = null;
        out = null;
    }
}

interface Note {
    /** start and end frequency (Hz); the pitch glides when they differ */
    f: number;
    to?: number;
    /** seconds after now */
    at?: number;
    dur: number;
    gain: number;
    type?: OscillatorType;
    /** add soft overtones (bell-like) */
    bell?: boolean;
}

function note(ac: AudioContext, dest: AudioNode, n: Note): void {
    const t0 = ac.currentTime + 0.005 + (n.at || 0);
    const voices: Array<[number, number]> = n.bell ? [[1, 1], [2, 0.28], [3.01, 0.08]] : [[1, 1]];
    for (const [mult, part] of voices) {
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.type = n.type || 'sine';
        osc.frequency.setValueAtTime(n.f * mult, t0);
        if (n.to && n.to !== n.f) {
            osc.frequency.exponentialRampToValueAtTime(n.to * mult, t0 + n.dur * 0.9);
        }
        const peak = Math.max(0.0002, n.gain * part);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur);
        osc.connect(g);
        g.connect(dest);
        osc.start(t0);
        osc.stop(t0 + n.dur + 0.03);
    }
}

const RECIPES: Record<SoundName, Note[]> = {
    // soft tick for any button
    tap: [{ f: 1750, to: 1150, dur: 0.035, gain: 0.22 }],
    // menu: a little lower
    nav: [{ f: 980, to: 720, dur: 0.05, gain: 0.26 }],
    // sound switched on
    toggle: [
        { f: 660, dur: 0.07, gain: 0.3 },
        { f: 990, at: 0.06, dur: 0.12, gain: 0.3 },
    ],
    // ✓ received into the warehouse: bright two-note ding
    check: [
        { f: 880, dur: 0.16, gain: 0.34, bell: true },
        { f: 1318.5, at: 0.075, dur: 0.3, gain: 0.36, bell: true },
    ],
    // tick taken away / mark removed
    uncheck: [
        { f: 1174.7, dur: 0.1, gain: 0.24 },
        { f: 783.99, at: 0.07, dur: 0.18, gain: 0.24 },
    ],
    // saved: rising chime
    success: [
        { f: 1046.5, dur: 0.18, gain: 0.28, bell: true },
        { f: 1318.5, at: 0.06, dur: 0.2, gain: 0.28, bell: true },
        { f: 1568, at: 0.12, dur: 0.32, gain: 0.3, bell: true },
    ],
    // something went wrong: low soft "bonk bonk"
    error: [
        { f: 311, to: 262, dur: 0.14, gain: 0.42, type: 'triangle' },
        { f: 233, to: 175, at: 0.13, dur: 0.24, gain: 0.42, type: 'triangle' },
    ],
    // ✗ does not match: attention, falling
    flag: [
        { f: 784, dur: 0.14, gain: 0.36, type: 'triangle' },
        { f: 622.25, at: 0.13, dur: 0.26, gain: 0.36, type: 'triangle' },
    ],
    // message sent: quick upward whoosh + pop
    send: [
        { f: 420, to: 1250, dur: 0.13, gain: 0.26 },
        { f: 1600, at: 0.11, dur: 0.06, gain: 0.16 },
    ],
    // new message: "ding-dong"
    message: [
        { f: 1318.5, dur: 0.34, gain: 0.38, bell: true },
        { f: 1046.5, at: 0.16, dur: 0.46, gain: 0.34, bell: true },
    ],
    // deleted: falling swoop
    delete: [{ f: 520, to: 150, dur: 0.22, gain: 0.32, type: 'triangle' }],
    // undo: rewind
    undo: [
        { f: 1200, to: 640, dur: 0.14, gain: 0.26 },
        { f: 880, at: 0.12, dur: 0.14, gain: 0.22, bell: true },
    ],
    // unlocked: three rising notes
    unlock: [
        { f: 783.99, dur: 0.12, gain: 0.26, bell: true },
        { f: 1046.5, at: 0.06, dur: 0.14, gain: 0.26, bell: true },
        { f: 1318.5, at: 0.12, dur: 0.26, gain: 0.28, bell: true },
    ],
    // locked: three falling notes
    lock: [
        { f: 1318.5, dur: 0.1, gain: 0.22 },
        { f: 1046.5, at: 0.05, dur: 0.1, gain: 0.22 },
        { f: 783.99, at: 0.1, dur: 0.2, gain: 0.24 },
    ],
};

/** Plays a sound (only when sound is on, the page is visible and the person has touched the page). */
export function play(name: SoundName): void {
    if (!enabled || !ctx || !out || document.visibilityState === 'hidden') {
        return;
    }
    const now = performance.now();
    if ((lastAt[name] || 0) > now - 45) {
        return; // the same sound twice at the same moment: once is enough
    }
    lastAt[name] = now;
    try {
        if (ctx.state === 'suspended') {
            void ctx.resume().catch(() => undefined);
        }
        for (const n of RECIPES[name]) {
            note(ctx, out, n);
        }
        played.push(name);
        if (played.length > 40) {
            played.splice(0, played.length - 40);
        }
        if (name === 'message' || name === 'flag') {
            navigator.vibrate?.(name === 'flag' ? [70, 50, 70] : 60); // a short buzz too, on phones that can
        }
    } catch {
        // a sound must never break the page
    }
}

/** A tick for every button and link (installed once). An element can ask for another sound with data-sound="…" or none. */
export function installTapSounds(): void {
    const onClick = (e: MouseEvent) => {
        wake();
        const target = e.target instanceof Element ? e.target : null;
        const el = target ? target.closest('button, a[href], [role="button"], [role="checkbox"], [aria-expanded], select, summary') : null;
        if (!el || (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') {
            return;
        }
        const own = el.closest('[data-sound]')?.getAttribute('data-sound');
        if (own === 'none') {
            return;
        }
        if (own && own in RECIPES) {
            play(own as SoundName);
            return;
        }
        play(el.closest('.bottom-nav, .side-nav') ? 'nav' : 'tap');
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', () => wake(), true);
}
