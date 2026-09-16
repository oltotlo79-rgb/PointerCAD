import type { JointKind, MateKind } from '@pointercad/model';
import type { ToolMenuItem } from './menuItem.js';
import { AngleConstraintIcon, CoincidentConstraintIcon, ConcentricConstraintIcon, CubeIcon, CylinderIcon, DistanceConstraintIcon, FixConstraintIcon, LayersIcon, ParallelConstraintIcon, RevolveIcon, SphereIcon, TangentConstraintIcon, ThreadShaftIcon, TransformIcon } from '../icons.js';

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
