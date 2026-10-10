import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

interface ModalProps {
    open: boolean;
    title: string;
    subtitle?: string;
    onClose: () => void;
    children: ReactNode;
    footer?: ReactNode;
    size?: 'sm' | 'md';
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, title, subtitle, onClose, children, footer, size = 'md' }: ModalProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const titleId = useId();
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    useEffect(() => {
        if (!open) {
            return;
        }
        const previous = document.activeElement as HTMLElement | null;
        const panel = panelRef.current;
        const first = panel?.querySelector<HTMLElement>('[data-autofocus]') || panel?.querySelector<HTMLElement>(FOCUSABLE);
        window.setTimeout(() => first?.focus(), 40);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                closeRef.current();
                return;
            }
            if (e.key === 'Tab' && panel) {
                const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
                if (!items.length) {
                    return;
                }
                const firstEl = items[0];
                const lastEl = items[items.length - 1];
                if (e.shiftKey && document.activeElement === firstEl) {
                    e.preventDefault();
                    lastEl.focus();
                } else if (!e.shiftKey && document.activeElement === lastEl) {
                    e.preventDefault();
                    firstEl.focus();
                }
            }
        };
        document.addEventListener('keydown', onKey);
        document.body.classList.add('no-scroll');
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.classList.remove('no-scroll');
            previous?.focus?.();
        };
    }, [open]);

    if (!open) {
        return null;
    }

    return createPortal(
        <div className="modal-root">
            <div className="modal-overlay" onClick={onClose} />
            <div
                ref={panelRef}
                className={`modal-panel modal-${size}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
            >
                <div className="modal-head">
                    <div>
                        <h2 id={titleId} className="modal-title">
                            {title}
                        </h2>
                        {subtitle && <p className="modal-sub">{subtitle}</p>}
                    </div>
                    <button type="button" className="icon-btn" onClick={onClose} aria-label="close">
                        <Icon name="x" />
                    </button>
                </div>
                <div className="modal-body">{children}</div>
                {footer && <div className="modal-foot">{footer}</div>}
            </div>
        </div>,
        document.body,
    );
}
