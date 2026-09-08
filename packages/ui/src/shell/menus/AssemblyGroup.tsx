import { findComponent, type AssemblyDocument } from '@pointercad/model';
import { t } from '../../i18n/t.js';
import type { EditToolReadiness } from '../../sketch/editCommands.js';
import { useAppStore } from '../../store/useAppStore.js';
import {
  deleteSelectedComponents,
  duplicateSelectedComponent,
  startPlaceComponent,
  toggleSelectedFixed,
  toggleSelectedVisible,
} from '../../assembly/placeComponentActions.js';
import { CopyToolIcon, CubeIcon, EmptyBoxIcon, FixConstraintIcon, IntersectIcon, LayersIcon,
  ThreadShaftIcon, TransformIcon } from '../icons.js';
import { AngleConstraintIcon, CoincidentConstraintIcon, ConcentricConstraintIcon,
  DistanceConstraintIcon, ParallelConstraintIcon, TangentConstraintIcon } from '../icons.js';
import { cancelMate, deleteAssemblyMate, editAssemblyMate, flipAssemblyMate, mateKindReadiness, startMate } from '../../assembly/mateActions.js';
import type { MateKind } from '@pointercad/model';
import type { ToolMenuItem } from '../toolbarMenus.js';
import { ToolMenu } from './ToolMenu.js';

export type AssemblyMenuActionId = 'duplicate' | 'delete' | 'toggleFixed' | 'toggleVisible';

export const ASSEMBLY_MENU_ITEMS: readonly ToolMenuItem<AssemblyMenuActionId>[] = [
  { id: 'duplicate', labelKey: 'assembly.tool.duplicate', tooltipKey: 'assembly.tool.duplicateTooltip', Icon: CopyToolIcon },
  { id: 'delete', labelKey: 'assembly.tool.delete', tooltipKey: 'assembly.tool.deleteTooltip', Icon: EmptyBoxIcon },
  { id: 'toggleFixed', labelKey: 'assembly.tool.toggleFixed', tooltipKey: 'assembly.tool.toggleFixedTooltip', Icon: FixConstraintIcon },
  { id: 'toggleVisible', labelKey: 'assembly.tool.toggleVisible', tooltipKey: 'assembly.tool.toggleVisibleTooltip', Icon: LayersIcon },
];

export const ASSEMBLY_MATE_TOOLS: readonly (ToolMenuItem<MateKind> & { readonly kind: MateKind })[] = [
  { id: 'coincident', kind: 'coincident', labelKey: 'assembly.tool.mateCoincident', tooltipKey: 'assembly.mate.coincidentTooltip', Icon: CoincidentConstraintIcon },
  { id: 'concentric', kind: 'concentric', labelKey: 'assembly.tool.mateConcentric', tooltipKey: 'assembly.mate.concentricTooltip', Icon: ConcentricConstraintIcon },
  { id: 'distance', kind: 'distance', labelKey: 'assembly.tool.mateDistance', tooltipKey: 'assembly.mate.distanceTooltip', Icon: DistanceConstraintIcon },
  { id: 'angle', kind: 'angle', labelKey: 'assembly.tool.mateAngle', tooltipKey: 'assembly.mate.angleTooltip', Icon: AngleConstraintIcon },
  { id: 'parallel', kind: 'parallel', labelKey: 'assembly.tool.mateParallel', tooltipKey: 'assembly.mate.parallelTooltip', Icon: ParallelConstraintIcon },
  { id: 'tangent', kind: 'tangent', labelKey: 'assembly.tool.mateTangent', tooltipKey: 'assembly.mate.tangentTooltip', Icon: TangentConstraintIcon },
];
type MateMenuAction = MateKind | 'editMate' | 'flipMate' | 'deleteMate';
const MATE_MENU_ITEMS: readonly ToolMenuItem<MateMenuAction>[] = [
  ...ASSEMBLY_MATE_TOOLS,
  { id: 'editMate', labelKey: 'assembly.mate.edit', tooltipKey: 'assembly.mate.editTooltip', Icon: DistanceConstraintIcon },
  { id: 'flipMate', labelKey: 'assembly.mate.flip', tooltipKey: 'assembly.mate.flipTooltip', Icon: ParallelConstraintIcon },
  { id: 'deleteMate', labelKey: 'assembly.mate.delete', tooltipKey: 'assembly.mate.deleteTooltip', Icon: EmptyBoxIcon },
];

/** 配置入口も同じ操作の寿命へ揃える。ファイル選択を開く前に合致を取り消す。 */
export function startAssemblyPartPlacement(deps?: Parameters<typeof startPlaceComponent>[0]): Promise<void> {
  cancelMate();
  return startPlaceComponent(deps);
}

/** 部品1個を対象にする操作の押せる条件と、断る理由の正本。 */
export function assemblyActionReadiness(
  assembly: AssemblyDocument,
  selection: readonly string[],
): EditToolReadiness {
  const components = selection.filter((id) => findComponent(assembly, id) !== undefined);
  return components.length === 1
    ? { ready: true, reasonKey: null }
    : { ready: false, reasonKey: 'assembly.tool.selectOneComponentReason' };
}

export function explodeActionReadiness(
  assembly: AssemblyDocument,
  selection: readonly string[],
): EditToolReadiness {
  return selection.some((id) => findComponent(assembly, id) !== undefined)
    ? { ready: true, reasonKey: null }
    : { ready: false, reasonKey: 'assembly.explode.selectComponent' };
}

export function AssemblyGroup(): React.JSX.Element | null {
  const state = useAppStore();
  const { assembly, selection, assemblyPlacement: placement, assemblyMateDraft: mateDraft } = state;
  if (assembly === null) return null;
  const readiness = assemblyActionReadiness(assembly, selection);
  const explodeReadiness = explodeActionReadiness(assembly, selection);
  const placeReady = placement === null && !state.standardPartPickerOpen;
  const standardPartReady = placement === null && state.assemblyDrag === null && !state.isComputing;
  const interferenceReady = assembly.components.filter((component) => component.visible && !component.suppressed).length >= 2
    && state.assemblyView?.sourceDocument === assembly && state.assemblyInterferenceRunner !== null
    && !state.isComputing && placement === null && mateDraft === null && state.assemblyDrag === null;
  const selectedMate = selection.length === 1 ? assembly.mates.find((mate) => mate.id === selection[0]) : undefined;

  const choose = (id: AssemblyMenuActionId): void => {
    if (!assemblyActionReadiness(assembly, useAppStore.getState().selection).ready) return;
    switch (id) {
      case 'duplicate': duplicateSelectedComponent(); return;
      case 'delete': deleteSelectedComponents(); return;
      case 'toggleFixed': toggleSelectedFixed(); return;
      case 'toggleVisible': toggleSelectedVisible(); return;
    }
  };

  return (
    <div className="pcad-toolbar__group" role="group" aria-label={t('assembly.menu.build')}>
      <span className="pcad-toolbar__group-label" title={t('assembly.menu.buildTooltip')}>
        {t('assembly.menu.build')}
      </span>
      <div className="pcad-segmented">
        <button
          type="button"
          className="pcad-button pcad-button--collapsible"
          title={t(placeReady ? 'assembly.tool.placePartTooltip' : 'assembly.tool.placementBusy')}
          aria-label={t('assembly.tool.placePart')}
          aria-disabled={!placeReady}
          onClick={() => { if (placeReady) void startAssemblyPartPlacement(); }}
        >
          <CubeIcon />
          <span className="pcad-button__label">{t('assembly.tool.placePart')}</span>
        </button>
        <button
          type="button"
          className="pcad-button pcad-button--collapsible"
          title={t(standardPartReady
            ? 'assembly.tool.placeStandardPartTooltip' : 'assembly.tool.placementBusy')}
          aria-label={t('assembly.tool.placeStandardPart')}
          aria-disabled={!standardPartReady}
          aria-pressed={state.standardPartPickerOpen}
          onClick={() => {
            if (!standardPartReady) return;
            if (useAppStore.getState().standardPartPickerOpen) {
              useAppStore.getState().closeStandardPartPicker();
            } else {
              cancelMate();
              useAppStore.getState().openStandardPartPicker();
            }
          }}
        >
          <ThreadShaftIcon />
          <span className="pcad-button__label">{t('assembly.tool.placeStandardPart')}</span>
        </button>
        <ToolMenu
          items={ASSEMBLY_MENU_ITEMS}
          groupLabelKey="assembly.menu.component"
          groupTooltipKey="assembly.menu.componentTooltip"
          GroupIcon={CopyToolIcon}
          activeTool=""
          showPressed={false}
          readinessOf={() => readiness}
          onChoose={choose}
        />
        <ToolMenu items={MATE_MENU_ITEMS} groupLabelKey="assembly.menu.mate" groupTooltipKey="assembly.mate.menuTooltip"
          GroupIcon={CoincidentConstraintIcon} activeTool={mateDraft?.kind ?? ''}
          readinessOf={(id) => id === 'editMate' || id === 'flipMate' || id === 'deleteMate'
            ? { ready: selectedMate !== undefined && placement === null, reasonKey: selectedMate !== undefined && placement === null ? null : 'assembly.mate.selectMate' }
            : mateKindReadiness(state, id)}
          onChoose={(id) => {
            if (id === 'editMate' || id === 'flipMate' || id === 'deleteMate') {
              if (selectedMate === undefined || placement !== null) return;
              if (id === 'editMate') editAssemblyMate(selectedMate.id);
              else if (id === 'flipMate') flipAssemblyMate(selectedMate.id);
              else deleteAssemblyMate(selectedMate.id);
            } else if (mateKindReadiness(useAppStore.getState(), id).ready) startMate(id);
          }} />
        <button type="button" className="pcad-button pcad-button--collapsible"
          title={t(explodeReadiness.ready ? 'assembly.explode.tooltip'
            : explodeReadiness.reasonKey ?? 'assembly.explode.selectComponent')}
          aria-label={t('assembly.tool.explode')} aria-disabled={!explodeReadiness.ready}
          onClick={() => { if (explodeReadiness.ready) useAppStore.getState().beginAssemblyExplode(); }}>
          <TransformIcon />
          <span className="pcad-button__label">{t('assembly.tool.explode')}</span>
        </button>
        <button type="button" className="pcad-button pcad-button--collapsible"
          title={t(interferenceReady ? 'assembly.interference.tooltip' : 'assembly.interference.notReady')}
          aria-label={t('assembly.tool.interference')} aria-disabled={!interferenceReady}
          aria-pressed={state.assemblyInterferenceOpen}
          onClick={() => { if (interferenceReady) useAppStore.getState().runAssemblyInterference(); }}>
          <IntersectIcon />
          <span className="pcad-button__label">{t('assembly.tool.interference')}</span>
        </button>
      </div>
    </div>
  );
}
