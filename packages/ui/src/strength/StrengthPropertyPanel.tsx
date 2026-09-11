import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { StrengthPanel } from './StrengthPanel.js';

/** 部品・アセンブリのどちらから開いても同じ右欄を使う。入力の更新はこの区画内に留める。 */
export function StrengthPropertyPanel(): React.JSX.Element | null {
  const session = useAppStore(state => state.strengthSession);
  if (session === null) return null;
  return <section className="pcad-panel pcad-panel--right">
    <h2 className="pcad-panel__title">{t('propertyPanel.title')}</h2>
    <StrengthPanel session={session} />
  </section>;
}
