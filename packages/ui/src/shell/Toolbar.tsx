import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

export function Toolbar(): React.JSX.Element {
  const projection = useAppStore((state) => state.projection);
  const displayStyle = useAppStore((state) => state.displayStyle);
  const showGrid = useAppStore((state) => state.showGrid);

  return (
    <div className="pcad-toolbar">
      <div className="pcad-toolbar__group">
        <span>{t('toolbar.mode.modeling')}</span>
      </div>

      <div className="pcad-toolbar__group" title={t('toolbar.projection.tooltip')}>
        <button
          type="button"
          className="pcad-toolbar__button"
          aria-pressed={projection === 'perspective'}
          onClick={() => {
            useAppStore.getState().setProjection('perspective');
          }}
        >
          {t('toolbar.projection.perspective')}
        </button>
        <button
          type="button"
          className="pcad-toolbar__button"
          aria-pressed={projection === 'orthographic'}
          onClick={() => {
            useAppStore.getState().setProjection('orthographic');
          }}
        >
          {t('toolbar.projection.orthographic')}
        </button>
      </div>

      <div className="pcad-toolbar__group" title={t('toolbar.displayStyle.tooltip')}>
        <button
          type="button"
          className="pcad-toolbar__button"
          aria-pressed={displayStyle === 'shaded'}
          onClick={() => {
            useAppStore.getState().setDisplayStyle('shaded');
          }}
        >
          {t('toolbar.displayStyle.shaded')}
        </button>
        <button
          type="button"
          className="pcad-toolbar__button"
          aria-pressed={displayStyle === 'shadedWithEdges'}
          onClick={() => {
            useAppStore.getState().setDisplayStyle('shadedWithEdges');
          }}
        >
          {t('toolbar.displayStyle.shadedWithEdges')}
        </button>
        <button
          type="button"
          className="pcad-toolbar__button"
          aria-pressed={displayStyle === 'wireframe'}
          onClick={() => {
            useAppStore.getState().setDisplayStyle('wireframe');
          }}
        >
          {t('toolbar.displayStyle.wireframe')}
        </button>
      </div>

      <div className="pcad-toolbar__group">
        <button
          type="button"
          className="pcad-toolbar__button"
          title={t('toolbar.grid.tooltip')}
          aria-pressed={showGrid}
          onClick={() => {
            useAppStore.getState().setShowGrid(!showGrid);
          }}
        >
          {t('toolbar.grid.label')}
        </button>
        <button
          type="button"
          className="pcad-toolbar__button"
          title={t('toolbar.home.tooltip')}
          onClick={() => {
            useAppStore.getState().requestHomeView();
          }}
        >
          {t('toolbar.home.label')}
        </button>
      </div>
    </div>
  );
}
