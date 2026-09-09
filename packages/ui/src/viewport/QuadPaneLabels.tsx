import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import type { QuadViewId } from './quadLayout.js';

const panes: readonly { readonly id: QuadViewId; readonly key: MessageKey }[] = [
  { id: 'top', key: 'view.quad.top' }, { id: 'isometric', key: 'view.quad.isometric' },
  { id: 'front', key: 'view.quad.front' }, { id: 'right', key: 'view.quad.right' },
];

export function QuadPaneLabels(): React.JSX.Element | null {
  const active = useAppStore((state) => state.quadCamera?.active ?? null);
  if (active === null) return null;
  return <div className="pcad-quad" role="group" aria-label={t('view.quad.title')}>
    {panes.map(({ id, key }) => <div key={id} className="pcad-quad__pane" data-active={active === id}>
      <button type="button" className="pcad-button pcad-quad__label" aria-pressed={active === id}
        onClick={() => useAppStore.getState().setQuadActivePane(id)}>{t(key)}</button>
    </div>)}
  </div>;
}
