import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { useI18n } from '../lib/i18n';
import { useStore } from '../lib/store';
import { useToast } from './Toast';
import { errorCode } from '../lib/api';
import { apiErrorKey } from './EditAccess';
import type { Product } from '../lib/types';

export interface ProductModalState {
    mode: 'add' | 'rename';
    product?: Product;
}

interface Props {
    state: ProductModalState | null;
    onClose: () => void;
}

export function ProductModal({ state, onClose }: Props) {
    const { t } = useI18n();
    const { addProduct, renameProduct } = useStore();
    const toast = useToast();
    const [name, setName] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (state) {
            setName(state.product?.name || '');
            setError('');
            setBusy(false);
        }
    }, [state]);

    if (!state) {
        return null;
    }
    const isRename = state.mode === 'rename';

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const clean = name.replace(/\s+/g, ' ').trim();
        if (!clean) {
            setError(t('nameRequired'));
            return;
        }
        setBusy(true);
        try {
            if (isRename && state.product) {
                await renameProduct(state.product.id, clean);
                toast.show(t('savedOnline'));
            } else {
                await addProduct(clean);
                toast.show(t('productAdded'));
            }
            onClose();
        } catch (err) {
            const code = errorCode(err);
            setError(code === 'duplicate_name' ? t('duplicate') : t(apiErrorKey(err)));
            setBusy(false);
        }
    };

    return (
        <Modal
            open
            size="sm"
            title={isRename ? t('editProduct') : t('addProduct')}
            onClose={busy ? () => undefined : onClose}
            footer={
                <>
                    <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
                        {t('cancel')}
                    </button>
                    <button type="submit" form="product-form" className="btn btn-primary" disabled={busy}>
                        <Icon name="check" size={18} />
                        {busy ? t('saving') : t('save')}
                    </button>
                </>
            }
        >
            <form id="product-form" className="form" onSubmit={submit} noValidate>
                <div className="field">
                    <label htmlFor="p-name">{t('productName')}</label>
                    <input
                        id="p-name"
                        className="input input-lg"
                        type="text"
                        maxLength={80}
                        value={name}
                        placeholder={t('productNamePh')}
                        onChange={(e) => {
                            setName(e.target.value);
                            setError('');
                        }}
                        aria-invalid={Boolean(error)}
                        data-autofocus
                    />
                    {error && (
                        <p className="field-error" role="alert">
                            {error}
                        </p>
                    )}
                </div>
            </form>
        </Modal>
    );
}
