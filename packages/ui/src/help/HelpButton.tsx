import { t } from '../i18n/t.js';
import { HelpIcon } from '../shell/icons.js';
import { useAppStore } from '../store/useAppStore.js';
import { contextualHelpTopic } from './helpContext.js';

export function HelpButton(): React.JSX.Element {
  return <button type="button" className="pcad-button pcad-button--icon" title={t('help.open')} aria-label={t('help.open')}
    onClick={() => { const state = useAppStore.getState(); state.openHelpTopic(contextualHelpTopic(state)); }}><HelpIcon /></button>;
}
