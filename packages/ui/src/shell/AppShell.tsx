import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { ViewportCanvas } from '../viewport/ViewportCanvas.js';
import { FeatureTree } from './FeatureTree.js';
import { PlotPointIcon } from './icons.js';
import { PropertyPanel } from './PropertyPanel.js';
import { StatusBar } from './StatusBar.js';
import { Toolbar } from './Toolbar.js';

/**
 * 画面の5区画(ツールバー / ツリー / ビューポート+ビューキューブ / プロパティ / ステータスバー)。
 * 区画は増やさない(rules/04-設計の規律.md、要件§7.1)。
 */
export function AppShell(): React.JSX.Element {
  const mesh = useAppStore((state) => state.mesh);
  const isComputing = useAppStore((state) => state.isComputing);

  return (
    <div className="pcad-shell">
      <Toolbar />
      <div className="pcad-shell__body">
        <FeatureTree />
        <div className="pcad-viewport">
          <ViewportCanvas />
          {isComputing ? (
            /* 計算中は中央に札を出す。空状態の案内とは同時に出さない。 */
            <div className="pcad-viewport__overlay">
              <div className="pcad-card">
                <span className="pcad-spinner" aria-hidden="true" />
                <span>{t('statusBar.loading')}</span>
              </div>
            </div>
          ) : mesh === null ? (
            /* 計算が終わって、まだ形が無いときだけ最初の一歩を案内する(NFR-UX-6)。 */
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
