import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { play } from '../lib/sound';
import type { SoundName } from '../lib/sound';

type Tone = 'success' | 'error' | 'info';

interface ToastItem {
    id: number;
    tone: Tone;
    text: string;
    icon?: IconName;
}

interface ToastValue {
    /**
     * A short note at the top of the screen. It also makes a sound: the tone's own
     * (success chime, error) unless another one is given; 'none' for silence. Notes ('info') are silent by default.
     */
    show: (text: string, tone?: Tone, sound?: SoundName | 'none', icon?: IconName) => void;
}

const ToastContext = createContext<ToastValue | null>(null);
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
    const [items, setItems] = useState<ToastItem[]>([]);

    const show = useCallback((text: string, tone: Tone = 'success', sound?: SoundName | 'none', icon?: IconName) => {
        seq += 1;
        const id = seq;
        setItems((prev) => [...prev.slice(-2), { id, tone, text, icon }]);
        window.setTimeout(() => {
            setItems((prev) => prev.filter((t) => t.id !== id));
        }, tone === 'error' ? 5200 : 3200);
        const s = sound || (tone === 'error' ? 'error' : tone === 'success' ? 'success' : 'none');
        if (s !== 'none') {
            play(s);
        }
    }, []);

    const value = useMemo(() => ({ show }), [show]);

    return (
        <ToastContext.Provider value={value}>
            {children}
            <div className="toast-stack" role="status" aria-live="polite">
                {items.map((t) => (
                    <div key={t.id} className={`toast toast-${t.tone}`}>
                        <span className="toast-icon">
                            <Icon name={t.icon || (t.tone === 'error' ? 'alert' : t.tone === 'info' ? 'clock' : 'check')} size={16} stroke={2.4} />
                        </span>
                        <span>{t.text}</span>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}

export function useToast(): ToastValue {
    const ctx = useContext(ToastContext);
    if (!ctx) {
        throw new Error('useToast must be used inside ToastProvider');
    }
    return ctx;
}
