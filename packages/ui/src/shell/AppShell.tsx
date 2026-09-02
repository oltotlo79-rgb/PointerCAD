import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { ViewportCanvas } from '../viewport/ViewportCanvas.js';
import { FeatureTree } from './FeatureTree.js';
import { PropertyPanel } from './PropertyPanel.js';
import { StatusBar } from './StatusBar.js';
import { Toolbar } from './Toolbar.js';

export function AppShell(): React.JSX.Element {
  const mesh = useAppStore((state) => state.mesh);

  return (
    <div className="pcad-shell">
      <Toolbar />
      <div className="pcad-shell__body">
        <FeatureTree />
        <div className="pcad-viewport">
          <ViewportCanvas />
          {/* 空状態ガイド(NFR-UX-6)。形ができたら引っ込める。 */}
          {mesh === null ? (
            <p className="pcad-viewport__empty-state">{t('emptyState.firstStep')}</p>
          ) : null}
        </div>
        <PropertyPanel />
      </div>
      <StatusBar />
    </div>
  );
}
