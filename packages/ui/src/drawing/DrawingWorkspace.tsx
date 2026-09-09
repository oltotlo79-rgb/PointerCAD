import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { CubeIcon, LayersIcon, PlaneSectionIcon } from '../shell/icons.js';

export const DRAWING_TREE_KEYS = [
  'drawing.tree.sheet', 'drawing.tree.views', 'drawing.tree.dimensions',
  'drawing.tree.annotations', 'drawing.tree.layers',
] as const satisfies readonly MessageKey[];

export const DRAWING_TOOL_GROUPS = [
  {
    label: 'drawing.toolbar.views',
    tools: ['drawing.tool.baseView', 'drawing.tool.projectedView', 'drawing.tool.isometricView'],
  },
  {
    label: 'drawing.toolbar.sections',
    tools: ['drawing.tool.sectionView', 'drawing.tool.detailView', 'drawing.tool.auxiliaryView', 'drawing.tool.partialView', 'drawing.tool.brokenView'],
  },
  {
    label: 'drawing.toolbar.annotations',
    tools: ['drawing.tool.dimension', 'drawing.tool.annotation', 'drawing.tool.centerMark'],
  },
  {
    label: 'drawing.toolbar.tables',
    tools: ['drawing.tool.table', 'drawing.tool.layer'],
  },
] as const satisfies readonly { readonly label: MessageKey; readonly tools: readonly MessageKey[] }[];

export const DRAWING_PROPERTY_KEYS = [
  'drawing.property.sheet', 'drawing.property.view', 'drawing.property.dimension',
  'drawing.property.annotation', 'drawing.property.table', 'drawing.property.layer',
] as const satisfies readonly MessageKey[];

export function DrawingToolbar(): React.JSX.Element {
  return (
    <header className="pcad-toolbar">
      <div className="pcad-toolbar__brand">
        <CubeIcon size={18} className="pcad-toolbar__mark" />
        <span className="pcad-toolbar__wordmark">{t('app.title')}</span>
      </div>
      <span className="pcad-badge">{t('drawing.mode')}</span>
      <div className="pcad-toolbar__actions">
        {DRAWING_TOOL_GROUPS.map((group) => (
          <div className="pcad-toolbar__group" key={group.label}>
            <span className="pcad-toolbar__group-label">{t(group.label)}</span>
            <div className="pcad-segmented" role="group" aria-label={t(group.label)}>
              {group.tools.map((key) => (
                <button key={key} type="button" className="pcad-button pcad-button--action" title={t(key)}>
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </header>
  );
}

export function DrawingTree(): React.JSX.Element {
  const drawing = useAppStore((state) => state.drawing);
  const counts = [
    drawing === null ? 0 : 1,
    drawing?.views.length ?? 0,
    drawing?.dimensions.length ?? 0,
    drawing?.annotations.length ?? 0,
    drawing?.layers.length ?? 0,
  ];
  return (
    <section className="pcad-panel pcad-panel--left">
      <h2 className="pcad-panel__title">{t('drawing.tree.title')}</h2>
      <div className="pcad-panel__body">
        <ul className="pcad-tree">
          {DRAWING_TREE_KEYS.map((key, index) => (
            <li className="pcad-tree__row pcad-tree__row--section" key={key}>
              {index === 4 ? <LayersIcon size={14} /> : <PlaneSectionIcon size={14} />}
              <span className="pcad-tree__label">{t(key)}</span>
              <span className="pcad-tree__count">{counts[index]}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function DrawingPropertyPanel(): React.JSX.Element {
  const drawing = useAppStore((state) => state.drawing);
  return (
    <section className="pcad-panel pcad-panel--right">
      <h2 className="pcad-panel__title">{t('drawing.property.title')}</h2>
      <div className="pcad-panel__body">
        {DRAWING_PROPERTY_KEYS.map((key) => (
          <section className="pcad-section" key={key}>
            <h3 className="pcad-section__title">{t(key)}</h3>
          </section>
        ))}
        {drawing === null ? null : (
          <dl className="pcad-properties">
            <dt className="pcad-properties__key">{t('drawing.tree.sheet')}</dt>
            <dd className="pcad-properties__value">{drawing.sheet.paperSizeId}</dd>
          </dl>
        )}
      </div>
    </section>
  );
}

export function DrawingViewport(): React.JSX.Element {
  const drawing = useAppStore((state) => state.drawing);
  return (
    <div className="pcad-drawing-viewport" data-testid="drawing-viewport">
      <div className="pcad-drawing-sheet" aria-label={drawing?.name ?? t('drawing.mode')}>
        <p className="pcad-viewport__empty-text">{t('drawing.viewport.empty')}</p>
      </div>
    </div>
  );
}

export function DrawingStatusBar(): React.JSX.Element {
  return (
    <footer className="pcad-statusbar">
      <span className="pcad-statusbar__message" aria-live="polite">
        <span className="pcad-statusbar__text">{t('drawing.status.ready')}</span>
      </span>
      <span className="pcad-statusbar__spacer" />
      <span className="pcad-statusbar__state">mm</span>
    </footer>
  );
}
