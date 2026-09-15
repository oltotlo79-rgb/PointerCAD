import { executeCommand } from '../../commands/commandRegistry.js';
import { toolbarCommandId } from '../../commands/toolbarCommandCatalog.js';
import { jointKindReadiness, mateKindReadiness } from '../../assembly/mateActions.js';
import { t } from '../../i18n/t.js';
import type { EditToolReadiness } from '../../sketch/editCommands.js';
import { useAppStore } from '../../store/useAppStore.js';
import { BomIcon, CoincidentConstraintIcon, CubeIcon, IntersectIcon, TransformIcon } from '../icons.js';
import { ToolMenu } from './ToolMenu.js';
import { ASSEMBLY_MENU_ITEMS, MATE_MENU_ITEMS, type AssemblyMenuActionId } from './assemblyMenuItems.js';
import { assemblyBuildReadiness, assemblyToolbarIdle,
  explodeActionReadiness, isMateMenuAction } from './assemblyToolActions.js';
export { ASSEMBLY_MENU_ITEMS, MATE_MENU_ITEMS, ASSEMBLY_MATE_TOOLS, ASSEMBLY_JOINT_TOOLS } from './assemblyMenuItems.js';
export type { AssemblyMenuActionId, MateMenuAction } from './assemblyMenuItems.js';
export { startAssemblyPartPlacement, assemblyActionReadiness, explodeActionReadiness } from './assemblyToolActions.js';

export function AssemblyGroup(): React.JSX.Element | null {
  const state = useAppStore();
  const { assembly, selection, assemblyMateDraft: draft } = state;
  if (assembly === null) return null;
  const explodeReadiness = explodeActionReadiness(assembly, selection);
  const idle = assemblyToolbarIdle(state);
  const interferenceReady = assembly.components.filter((component) => component.visible && !component.suppressed).length >= 2
    && state.assemblyView?.sourceDocument === assembly && state.assemblyInterferenceRunner !== null && idle;

  const buildReadiness = (id: AssemblyMenuActionId): EditToolReadiness => assemblyBuildReadiness(state, id);

  return (
    <div className="pcad-toolbar__group" role="group" aria-label={t('assembly.menu.build')}>
      <span className="pcad-toolbar__group-label" title={t('assembly.menu.buildTooltip')}>
        {t('assembly.mode')}
      </span>
      <div className="pcad-segmented">
      <ToolMenu
        items={ASSEMBLY_MENU_ITEMS}
        groupLabelKey="assembly.menu.build"
        groupTooltipKey="assembly.menu.buildTooltip"
        GroupIcon={CubeIcon}
        activeTool={state.standardPartPickerOpen ? 'placeStandardPart' : ''}
        showPressed={false}
        readinessOf={buildReadiness}
        commandGroup="assembly"
      />
      <ToolMenu
        items={MATE_MENU_ITEMS}
        groupLabelKey="assembly.menu.mate"
        groupTooltipKey="assembly.mate.menuTooltip"
        GroupIcon={CoincidentConstraintIcon}
        activeTool={draft?.jointKind ?? draft?.kind ?? ''}
        readinessOf={(id) => isMateMenuAction(id)
          ? mateKindReadiness(state, id)
          : jointKindReadiness(state, id)}
        commandGroup="mate"
      />
      <button type="button" className="pcad-button pcad-button--collapsible"
        title={t(interferenceReady ? 'assembly.interference.tooltip' : 'assembly.interference.notReady')}
        data-command-id={toolbarCommandId('assemblyUtility', 'interference')} data-help-topic="interference"
        aria-label={t('assembly.tool.interference')} aria-disabled={!interferenceReady}
        aria-pressed={state.assemblyInterferenceOpen}
        onClick={() => { executeCommand(toolbarCommandId('assemblyUtility', 'interference')); }}>
        <IntersectIcon /><span className="pcad-button__label">{t('assembly.tool.interference')}</span>
      </button>
      <button type="button" className="pcad-button pcad-button--collapsible"
        title={t(explodeReadiness.ready ? 'assembly.explode.tooltip'
          : explodeReadiness.reasonKey ?? 'assembly.explode.selectComponent')}
        data-command-id={toolbarCommandId('assemblyUtility', 'explode')} data-help-topic="explode"
        aria-label={t('assembly.tool.explode')} aria-disabled={!explodeReadiness.ready || !idle}
        onClick={() => { executeCommand(toolbarCommandId('assemblyUtility', 'explode')); }}>
        <TransformIcon /><span className="pcad-button__label">{t('assembly.tool.explode')}</span>
      </button>
      <button type="button" className="pcad-button pcad-button--collapsible"
        title={t('assembly.bom.tooltip')} data-command-id={toolbarCommandId('assemblyUtility', 'bom')} data-help-topic="bom"
        aria-label={t('assembly.tool.bom')}
        aria-disabled={assembly.components.length === 0}
        aria-pressed={selection.includes('bom')}
        onClick={() => { executeCommand(toolbarCommandId('assemblyUtility', 'bom')); }}>
        <BomIcon /><span className="pcad-button__label">{t('assembly.tool.bom')}</span>
      </button>
      </div>
    </div>
  );
}
