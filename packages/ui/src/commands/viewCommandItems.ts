import type { MessageKey } from '../i18n/t.js';

export const VIEW_COMMAND_ITEMS = [
  { id: 'shaded', labelKey: 'toolbar.displayStyle.shaded', tooltipKey: 'toolbar.displayStyle.shaded' },
  { id: 'shadedWithEdges', labelKey: 'toolbar.displayStyle.shadedWithEdges', tooltipKey: 'toolbar.displayStyle.shadedWithEdges' },
  { id: 'wireframe', labelKey: 'toolbar.displayStyle.wireframe', tooltipKey: 'toolbar.displayStyle.wireframe' },
  { id: 'section', labelKey: 'toolbar.sectionView.label', tooltipKey: 'toolbar.sectionView.tooltip' },
  { id: 'grid', labelKey: 'toolbar.grid.label', tooltipKey: 'toolbar.grid.tooltip' },
  { id: 'chaining', labelKey: 'toolbar.chain.label', tooltipKey: 'toolbar.chain.tooltip' },
  { id: 'snap', labelKey: 'toolbar.snap.label', tooltipKey: 'toolbar.snap.tooltip' },
  { id: 'home', labelKey: 'toolbar.home.label', tooltipKey: 'toolbar.home.tooltip' },
  // 標準の向き。ID はビューキューブの面(viewcube/viewCubeMath.ts の FACE_REGIONS)と同じ名前にする。
  { id: 'front', labelKey: 'toolbar.viewOrientation.front', tooltipKey: 'toolbar.viewOrientation.frontTooltip' },
  { id: 'back', labelKey: 'toolbar.viewOrientation.back', tooltipKey: 'toolbar.viewOrientation.backTooltip' },
  { id: 'right', labelKey: 'toolbar.viewOrientation.right', tooltipKey: 'toolbar.viewOrientation.rightTooltip' },
  { id: 'left', labelKey: 'toolbar.viewOrientation.left', tooltipKey: 'toolbar.viewOrientation.leftTooltip' },
  { id: 'top', labelKey: 'toolbar.viewOrientation.top', tooltipKey: 'toolbar.viewOrientation.topTooltip' },
  { id: 'bottom', labelKey: 'toolbar.viewOrientation.bottom', tooltipKey: 'toolbar.viewOrientation.bottomTooltip' },
  // 全体を表示・選択に合わせる・直前の視点へ戻る(B-08c)。既定のキーは持たない(キーの表で割り当てる)。
  { id: 'fitAll', labelKey: 'toolbar.viewFit.all', tooltipKey: 'toolbar.viewFit.allTooltip' },
  { id: 'fitSelection', labelKey: 'toolbar.viewFit.selection', tooltipKey: 'toolbar.viewFit.selectionTooltip' },
  { id: 'previousView', labelKey: 'toolbar.viewHistory.previous', tooltipKey: 'toolbar.viewHistory.previousTooltip' },
  { id: 'matchWorkPlane', labelKey: 'toolbar.plane.matchView', tooltipKey: 'toolbar.plane.matchViewTooltip' },
] as const satisfies readonly { readonly id: string; readonly labelKey: MessageKey; readonly tooltipKey: MessageKey }[];

export const ASSEMBLY_UTILITY_ITEMS = [
  { id: 'interference', labelKey: 'assembly.tool.interference', tooltipKey: 'assembly.interference.tooltip' },
  { id: 'explode', labelKey: 'assembly.tool.explode', tooltipKey: 'assembly.explode.tooltip' },
  { id: 'bom', labelKey: 'assembly.tool.bom', tooltipKey: 'assembly.bom.tooltip' },
] as const satisfies readonly { readonly id: string; readonly labelKey: MessageKey; readonly tooltipKey: MessageKey }[];
