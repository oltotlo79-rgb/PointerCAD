import {
  findComponent,
  type AssemblyDocument,
  type JointKind,
  type MateKind,
} from '@pointercad/model';
import { cancelMate, jointKindReadiness, mateKindReadiness, startJoint, startMate } from '../../assembly/mateActions.js';
import {
  startPlaceSubAssembly,
  startReplaceSelectedComponent,
} from '../../assembly/replaceActions.js';
import {
  startPlaceComponent,
  toggleSelectedFixed,
} from '../../assembly/placeComponentActions.js';
import { t } from '../../i18n/t.js';
import type { EditToolReadiness } from '../../sketch/editCommands.js';
import { useAppStore } from '../../store/useAppStore.js';
import {
  AngleConstraintIcon,
  BomIcon,
  CoincidentConstraintIcon,
  ConcentricConstraintIcon,
  CubeIcon,
  CylinderIcon,
  DistanceConstraintIcon,
  FixConstraintIcon,
  IntersectIcon,
  LayersIcon,
  ParallelConstraintIcon,
  RevolveIcon,
  SphereIcon,
  TangentConstraintIcon,
  ThreadShaftIcon,
  TransformIcon,
} from '../icons.js';
import type { ToolMenuItem } from '../toolbarMenus.js';
import { ToolMenu } from './ToolMenu.js';

export type AssemblyMenuActionId =
  | 'placePart'
  | 'placeStandardPart'
  | 'placeSubAssembly'
  | 'replacePart'
  | 'toggleFixed';

/** 「組む」の正本。計画書 §0.43 の5項目をこの順に保つ。 */
export const ASSEMBLY_MENU_ITEMS: readonly ToolMenuItem<AssemblyMenuActionId>[] = [
  { id: 'placePart', labelKey: 'assembly.tool.placePart', tooltipKey: 'assembly.tool.placePartTooltip', Icon: CubeIcon },
  { id: 'placeStandardPart', labelKey: 'assembly.tool.placeStandardPart', tooltipKey: 'assembly.tool.placeStandardPartTooltip', Icon: ThreadShaftIcon },
  { id: 'placeSubAssembly', labelKey: 'assembly.tool.placeSubAssembly', tooltipKey: 'assembly.tool.placeSubAssemblyTooltip', Icon: LayersIcon },
  { id: 'replacePart', labelKey: 'assembly.tool.replacePart', tooltipKey: 'assembly.tool.replacePartTooltip', Icon: TransformIcon },
  { id: 'toggleFixed', labelKey: 'assembly.tool.fixComponent', tooltipKey: 'assembly.tool.fixComponentTooltip', Icon: FixConstraintIcon },
];

export const ASSEMBLY_MATE_TOOLS: readonly (ToolMenuItem<MateKind> & { readonly kind: MateKind })[] = [
  { id: 'coincident', kind: 'coincident', labelKey: 'assembly.tool.mateCoincident', tooltipKey: 'assembly.mate.coincidentTooltip', Icon: CoincidentConstraintIcon },
  { id: 'concentric', kind: 'concentric', labelKey: 'assembly.tool.mateConcentric', tooltipKey: 'assembly.mate.concentricTooltip', Icon: ConcentricConstraintIcon },
  { id: 'distance', kind: 'distance', labelKey: 'assembly.tool.mateDistance', tooltipKey: 'assembly.mate.distanceTooltip', Icon: DistanceConstraintIcon },
  { id: 'angle', kind: 'angle', labelKey: 'assembly.tool.mateAngle', tooltipKey: 'assembly.mate.angleTooltip', Icon: AngleConstraintIcon },
  { id: 'parallel', kind: 'parallel', labelKey: 'assembly.tool.mateParallel', tooltipKey: 'assembly.mate.parallelTooltip', Icon: ParallelConstraintIcon },
  { id: 'tangent', kind: 'tangent', labelKey: 'assembly.tool.mateTangent', tooltipKey: 'assembly.mate.tangentTooltip', Icon: TangentConstraintIcon },
];

export const ASSEMBLY_JOINT_TOOLS: readonly (ToolMenuItem<JointKind> & { readonly kind: JointKind })[] = [
  { id: 'revolute', kind: 'revolute', labelKey: 'assembly.tool.jointRevolute', tooltipKey: 'assembly.joint.revoluteTooltip', Icon: RevolveIcon },
  { id: 'slider', kind: 'slider', labelKey: 'assembly.tool.jointSlider', tooltipKey: 'assembly.joint.sliderTooltip', Icon: TransformIcon },
  { id: 'cylindrical', kind: 'cylindrical', labelKey: 'assembly.tool.jointCylindrical', tooltipKey: 'assembly.joint.cylindricalTooltip', Icon: CylinderIcon },
  { id: 'ball', kind: 'ball', labelKey: 'assembly.tool.jointBall', tooltipKey: 'assembly.joint.ballTooltip', Icon: SphereIcon },
];

export type MateMenuAction = MateKind | JointKind;
/** 「合わせる」の正本。合致6種 + ジョイント4種。 */
export const MATE_MENU_ITEMS: readonly ToolMenuItem<MateMenuAction>[] = [
  ...ASSEMBLY_MATE_TOOLS,
  ...ASSEMBLY_JOINT_TOOLS,
];

function isMateMenuAction(id: MateMenuAction): id is MateKind {
  switch (id) {
    case 'coincident':
    case 'concentric':
    case 'distance':
    case 'angle':
    case 'parallel':
    case 'tangent':
      return true;
    case 'revolute':
    case 'slider':
    case 'cylindrical':
    case 'ball':
      return false;
  }
}

export function startAssemblyPartPlacement(deps?: Parameters<typeof startPlaceComponent>[0]): Promise<void> {
  cancelMate();
  return startPlaceComponent(deps);
}

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
  const { assembly, selection, assemblyPlacement: placement, assemblyMateDraft: draft } = state;
  if (assembly === null) return null;
  const selectedReadiness = assemblyActionReadiness(assembly, selection);
  const explodeReadiness = explodeActionReadiness(assembly, selection);
  const idle = placement === null && draft === null && state.assemblyDrag === null
    && !state.isComputing && !state.assemblyReplacementBusy && state.assemblyReplacementPreview === null;
  const interferenceReady = assembly.components.filter((component) => component.visible && !component.suppressed).length >= 2
    && state.assemblyView?.sourceDocument === assembly && state.assemblyInterferenceRunner !== null && idle;

  const buildReadiness = (id: AssemblyMenuActionId): EditToolReadiness => {
    if (id === 'placePart') return placement === null && !state.assemblyReplacementBusy
      ? { ready: true, reasonKey: null } : { ready: false, reasonKey: 'assembly.tool.placementBusy' };
    if (id === 'placeStandardPart' || id === 'placeSubAssembly') return idle
      ? { ready: true, reasonKey: null } : { ready: false, reasonKey: 'assembly.tool.placementBusy' };
    if (id === 'replacePart') return idle && state.assemblyReplacementRunner !== null
      ? selectedReadiness : { ready: false, reasonKey: 'assembly.tool.placementBusy' };
    return selectedReadiness;
  };

  const chooseBuild = (id: AssemblyMenuActionId): void => {
    if (!buildReadiness(id).ready) return;
    if (id === 'placePart') void startAssemblyPartPlacement();
    else if (id === 'placeStandardPart') state.openStandardPartPicker();
    else if (id === 'placeSubAssembly') void startPlaceSubAssembly();
    else if (id === 'replacePart') void startReplaceSelectedComponent();
    else toggleSelectedFixed();
  };

  return (
    <div className="pcad-toolbar__group" role="group" aria-label={t('assembly.menu.build')}>
      <ToolMenu
        items={ASSEMBLY_MENU_ITEMS}
        groupLabelKey="assembly.menu.build"
        groupTooltipKey="assembly.menu.buildTooltip"
        GroupIcon={CubeIcon}
        activeTool={state.standardPartPickerOpen ? 'placeStandardPart' : ''}
        showPressed={false}
        readinessOf={buildReadiness}
        onChoose={chooseBuild}
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
        onChoose={(id) => {
          if (isMateMenuAction(id)) {
            if (mateKindReadiness(useAppStore.getState(), id).ready) startMate(id);
          } else if (jointKindReadiness(useAppStore.getState(), id).ready) {
            startJoint(id);
          }
        }}
      />
      <button type="button" className="pcad-button pcad-button--collapsible"
        title={t(interferenceReady ? 'assembly.interference.tooltip' : 'assembly.interference.notReady')}
        aria-label={t('assembly.tool.interference')} aria-disabled={!interferenceReady}
        aria-pressed={state.assemblyInterferenceOpen}
        onClick={() => { if (interferenceReady) state.runAssemblyInterference(); }}>
        <IntersectIcon /><span className="pcad-button__label">{t('assembly.tool.interference')}</span>
      </button>
      <button type="button" className="pcad-button pcad-button--collapsible"
        title={t(explodeReadiness.ready ? 'assembly.explode.tooltip'
          : explodeReadiness.reasonKey ?? 'assembly.explode.selectComponent')}
        aria-label={t('assembly.tool.explode')} aria-disabled={!explodeReadiness.ready || !idle}
        onClick={() => { if (explodeReadiness.ready && idle) state.beginAssemblyExplode(); }}>
        <TransformIcon /><span className="pcad-button__label">{t('assembly.tool.explode')}</span>
      </button>
      <button type="button" className="pcad-button pcad-button--collapsible"
        title={t('assembly.bom.tooltip')} aria-label={t('assembly.tool.bom')}
        aria-disabled={assembly.components.length === 0}
        aria-pressed={selection.includes('bom')}
        onClick={() => { if (assembly.components.length > 0) state.setSelection(['bom']); }}>
        <BomIcon /><span className="pcad-button__label">{t('assembly.tool.bom')}</span>
      </button>
    </div>
  );
}
