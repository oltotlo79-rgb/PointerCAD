import { FeatureTree } from './FeatureTree.js';
import { PropertyPanel } from './PropertyPanel.js';
import { StatusBar } from './StatusBar.js';
import { Toolbar } from './Toolbar.js';
import { t } from '../i18n/t.js';

export function AppShell(): React.JSX.Element {
  return (
    <div className="pcad-shell">
      <Toolbar />
      <div className="pcad-shell__body">
        <FeatureTree />
        <div className="pcad-viewport">
          <p className="pcad-viewport__empty-state">{t('emptyState.firstStep')}</p>
        </div>
        <PropertyPanel />
      </div>
      <StatusBar />
    </div>
  );
}
