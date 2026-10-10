import { useState } from 'react';
import { Modal } from './Modal';
import { useI18n } from '../lib/i18n';
import { Icon } from './Icon';
import type { IconName } from './Icon';

interface Props {
    open: boolean;
    message: string;
    confirmLabel?: string;
    /** button look: red with a bin (default) or blue with another icon */
    icon?: IconName;
    danger?: boolean;
    onConfirm: () => Promise<void> | void;
    onClose: () => void;
}

export function ConfirmDialog({ open, message, confirmLabel, icon = 'trash', danger = true, onConfirm, onClose }: Props) {
    const { t } = useI18n();
    const [busy, setBusy] = useState(false);

    const run = async () => {
        setBusy(true);
        try {
            await onConfirm();
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            open={open}
            title={icon === 'trash' ? t('confirmTitle') : t('confirmPlain')}
            onClose={busy ? () => undefined : onClose}
            size="sm"
            footer={
                <>
                    <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
                        {t('cancel')}
                    </button>
                    <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={run} disabled={busy} data-autofocus>
                        <Icon name={icon} size={16} />
                        {busy ? t('saving') : confirmLabel || t('delete')}
                    </button>
                </>
            }
        >
            <p className="confirm-text">{message}</p>
        </Modal>
    );
}
