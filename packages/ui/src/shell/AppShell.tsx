import { lazy, Suspense } from 'react';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { FeatureTree } from './FeatureTree.js';
import { PlotPointIcon } from './icons.js';
import { PropertyPanel } from './PropertyPanel.js';
import { StatusBar } from './StatusBar.js';
import { Toolbar } from './Toolbar.js';

/**
 * 3D 表示は three.js を伴って重いので、画面の枠より後から読み込む(NFR-PF-5)。
 * 名前付き輸出を default へ包み直すのは、lazy が default 輸出だけを受け取るため。
 */
const ViewportCanvas = lazy(async () => {
  const viewportModule = await import('../viewport/ViewportCanvas.js');
  return { default: viewportModule.ViewportCanvas };
});

/**
 * 画面の5区画(ツールバー / ツリー / ビューポート+ビューキューブ / プロパティ / ステータスバー)。
 * 区画は増やさない(rules/04-設計の規律.md、要件§7.1)。
 */
export function AppShell(): React.JSX.Element {
  const isComputing = useAppStore((state) => state.isComputing);
  const featureCount = useAppStore((state) => state.sketch.features.length);

  return (
    <div className="pcad-shell">
      <Toolbar />
      <div className="pcad-shell__body">
        <FeatureTree />
        <div className="pcad-viewport">
          <Suspense
            fallback={
              <div className="pcad-viewport__overlay">
                <div className="pcad-card">
                  <span className="pcad-spinner" aria-hidden="true" />
                  <span>{t('viewport.loading')}</span>
                </div>
              </div>
            }
          >
            <ViewportCanvas />
          </Suspense>
          {isComputing ? (
            /* 計算中は中央に札を出す。空状態の案内とは同時に出さない。 */
            <div className="pcad-viewport__overlay">
              <div className="pcad-card">
                <span className="pcad-spinner" aria-hidden="true" />
                <span>{t('statusBar.loading')}</span>
              </div>
            </div>
          ) : featureCount === 0 ? (
            /* 計算が終わって、まだ何もかいていないときだけ最初の一歩を案内する(NFR-UX-6)。 */
            <div className="pcad-viewport__empty-state">
              <PlotPointIcon size={18} />
              <p className="pcad-viewport__empty-text">{t('emptyState.firstStep')}</p>
            </div>
          ) : null}
        </div>
        <PropertyPanel />
      </div>
      <StatusBar />
    </div>
  );
}
