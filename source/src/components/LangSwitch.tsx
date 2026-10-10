import { useI18n } from '../lib/i18n';
import type { Lang } from '../lib/i18n';

const OPTIONS: Array<{ value: Lang; label: string }> = [
    { value: 'lo', label: 'ລາວ' },
    { value: 'th', label: 'ไทย' },
];

export function LangSwitch({ dark = false }: { dark?: boolean }) {
    const { lang, setLang, t } = useI18n();
    return (
        <div className={`seg${dark ? ' seg-dark' : ''}`} role="group" aria-label={t('language')}>
            {OPTIONS.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    className={`seg-btn${lang === o.value ? ' is-active' : ''}`}
                    aria-pressed={lang === o.value}
                    onClick={() => setLang(o.value)}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}
