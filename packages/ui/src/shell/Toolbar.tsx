import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  CubeIcon,
  GridIcon,
  HomeIcon,
  OrthographicIcon,
  PerspectiveIcon,
  ShadedIcon,
  ShadedWithEdgesIcon,
  WireframeIcon,
} from './icons.js';

/**
 * 画面上端のツールバー(要件§7.1)。
 *
 * 左から「製品名 → モードのタブ」、右へ「投影 / 表示 / 補助 / 視点」の機能グループを並べる。
 * どのグループも区画名を頭に置き、いま選ばれているものをアクセント色の面で示す(NFR-UX-7)。
 * 状態の正本は Zustand ストア1本(rules/04-設計の規律.md)。
 */
export function Toolbar(): React.JSX.Element {
  const projection = useAppStore((state) => state.projection);
  const displayStyle = useAppStore((state) => state.displayStyle);
  const showGrid = useAppStore((state) => state.showGrid);

  return (
    <header className="pcad-toolbar">
      <div className="pcad-toolbar__brand">
        <CubeIcon size={18} className="pcad-toolbar__mark" />
        <span className="pcad-toolbar__wordmark">{t('app.title')}</span>
      </div>

      {/* モードのタブ。今はモデリングだけが使える。 */}
      <nav className="pcad-toolbar__modes" aria-label={t('toolbar.mode.groupLabel')}>
        <button type="button" className="pcad-tab" aria-pressed={true}>
          {t('toolbar.mode.modeling')}
        </button>
        <button
          type="button"
          className="pcad-tab"
          aria-disabled={true}
          title={t('toolbar.mode.comingSoon')}
        >
          {t('toolbar.mode.assembly')}
        </button>
        <button
          type="button"
          className="pcad-tab"
          aria-disabled={true}
          title={t('toolbar.mode.comingSoon')}
        >
          {t('toolbar.mode.drawing')}
        </button>
      </nav>

      <span className="pcad-toolbar__spacer" />

      <div
        className="pcad-toolbar__group"
        role="group"
        aria-label={t('toolbar.projection.groupLabel')}
      >
        <span className="pcad-toolbar__group-label" title={t('toolbar.projection.tooltip')}>
          {t('toolbar.projection.groupLabel')}
        </span>
        <div className="pcad-segmented">
          <button
            type="button"
            className="pcad-button"
            title={t('toolbar.projection.perspective')}
            aria-pressed={projection === 'perspective'}
            onClick={() => {
              useAppStore.getState().setProjection('perspective');
            }}
          >
            <PerspectiveIcon />
            {t('toolbar.projection.perspectiveShort')}
          </button>
          <button
            type="button"
            className="pcad-button"
            title={t('toolbar.projection.orthographic')}
            aria-pressed={projection === 'orthographic'}
            onClick={() => {
              useAppStore.getState().setProjection('orthographic');
            }}
          >
            <OrthographicIcon />
            {t('toolbar.projection.orthographicShort')}
          </button>
        </div>
      </div>

      <div
        className="pcad-toolbar__group"
        role="group"
        aria-label={t('toolbar.displayStyle.groupLabel')}
      >
        <span className="pcad-toolbar__group-label" title={t('toolbar.displayStyle.tooltip')}>
          {t('toolbar.displayStyle.groupLabel')}
        </span>
        <div className="pcad-segmented">
          <button
            type="button"
            className="pcad-button"
            title={t('toolbar.displayStyle.shaded')}
            aria-pressed={displayStyle === 'shaded'}
            onClick={() => {
              useAppStore.getState().setDisplayStyle('shaded');
            }}
          >
            <ShadedIcon />
            {t('toolbar.displayStyle.shadedShort')}
          </button>
          <button
            type="button"
            className="pcad-button"
            title={t('toolbar.displayStyle.shadedWithEdges')}
            aria-pressed={displayStyle === 'shadedWithEdges'}
            onClick={() => {
              useAppStore.getState().setDisplayStyle('shadedWithEdges');
            }}
          >
            <ShadedWithEdgesIcon />
            {t('toolbar.displayStyle.shadedWithEdgesShort')}
          </button>
          <button
            type="button"
            className="pcad-button"
            title={t('toolbar.displayStyle.wireframe')}
            aria-pressed={displayStyle === 'wireframe'}
            onClick={() => {
              useAppStore.getState().setDisplayStyle('wireframe');
            }}
          >
            <WireframeIcon />
            {t('toolbar.displayStyle.wireframeShort')}
          </button>
        </div>
      </div>

      <div
        className="pcad-toolbar__group"
        role="group"
        aria-label={t('toolbar.support.groupLabel')}
      >
        <span className="pcad-toolbar__group-label" title={t('toolbar.support.tooltip')}>
          {t('toolbar.support.groupLabel')}
        </span>
        <div className="pcad-segmented">
          <button
            type="button"
            className="pcad-button"
            title={t('toolbar.grid.tooltip')}
            aria-pressed={showGrid}
            onClick={() => {
              useAppStore.getState().setShowGrid(!showGrid);
            }}
          >
            <GridIcon />
            {t('toolbar.grid.label')}
          </button>
        </div>
      </div>

      <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.view.groupLabel')}>
        <span className="pcad-toolbar__group-label" title={t('toolbar.view.tooltip')}>
          {t('toolbar.view.groupLabel')}
        </span>
        <div className="pcad-segmented">
          <button
            type="button"
            className="pcad-button pcad-button--action"
            title={t('toolbar.home.tooltip')}
            onClick={() => {
              useAppStore.getState().requestHomeView();
            }}
          >
            <HomeIcon />
            {t('toolbar.home.shortLabel')}
          </button>
        </div>
      </div>
    </header>
  );
}
