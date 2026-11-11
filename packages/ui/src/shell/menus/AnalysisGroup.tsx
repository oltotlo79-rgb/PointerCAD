import { t } from '../../i18n/t.js';
import { activeDocumentKind } from '../../store/documentKind.js';
import { useAppStore } from '../../store/useAppStore.js';
import { MeasureIcon } from '../icons.js';
import { analysisMenuItemsFor, type AnalysisToolId } from './analysisMenuItems.js';
import { analysisToolbarReadiness, openAnalysisTool } from './analysisToolbarActions.js';
import { ToolMenu } from './ToolMenu.js';

export function AnalysisGroup(): React.JSX.Element | null {
  const kind = useAppStore(activeDocumentKind);
  const opened = useAppStore(openAnalysisTool);
  const parentOpen = useAppStore(state => state.strengthSession !== null);
  if (kind !== 'part' && kind !== 'assembly') return null;
  const readinessOf = (id: AnalysisToolId) => analysisToolbarReadiness(useAppStore.getState(), id);
  return <div className="pcad-toolbar__group">
    <span className="pcad-toolbar__group-label" title={t('toolbar.analysis.tooltip')}>
      {t('toolbar.analysis.groupLabel')}
    </span>
    <div className="pcad-segmented">
      <ToolMenu items={analysisMenuItemsFor(kind)} groupLabelKey="toolbar.analysis.groupLabel"
        groupTooltipKey="toolbar.analysis.tooltip" GroupIcon={MeasureIcon} commandGroup="analysis"
        activeTool={parentOpen && opened !== 'blocked' ? opened ?? '' : ''} readinessOf={readinessOf} />
    </div>
  </div>;
}
