import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useI18n } from '../lib/i18n';
import { onSoundChange, setSoundEnabled, soundEnabled } from '../lib/sound';

/** Sound effects on / off (remembered on this device): phone top bar, or the sidebar on a computer. */
export function SoundToggle({ variant }: { variant: 'top' | 'side' }) {
    const { t } = useI18n();
    const [on, setOn] = useState(soundEnabled);

    useEffect(() => onSoundChange(setOn), []);

    const toggle = () => setSoundEnabled(!on);

    if (variant === 'side') {
        return (
            <button type="button" className={`side-sound${on ? ' is-on' : ''}`} onClick={toggle} aria-pressed={on} data-sound="none">
                <Icon name={on ? 'volume' : 'volumeOff'} size={18} />
                <span>{t('soundLabel')}</span>
                <span className="side-sound-state">{on ? t('soundOnShort') : t('soundOffShort')}</span>
            </button>
        );
    }
    return (
        <button
            type="button"
            className={`icon-btn top-sound${on ? '' : ' is-off'}`}
            onClick={toggle}
            aria-pressed={on}
            aria-label={t('soundLabel')}
            title={on ? t('soundTurnOff') : t('soundTurnOn')}
            data-sound="none"
        >
            <Icon name={on ? 'volume' : 'volumeOff'} size={19} />
        </button>
    );
}
