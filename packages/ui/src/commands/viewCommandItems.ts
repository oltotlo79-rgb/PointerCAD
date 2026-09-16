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
  { id: 'matchWorkPlane', labelKey: 'toolbar.plane.matchView', tooltipKey: 'toolbar.plane.matchViewTooltip' },
] as const satisfies readonly { readonly id: string; readonly labelKey: MessageKey; readonly tooltipKey: MessageKey }[];

export const ASSEMBLY_UTILITY_ITEMS = [
  { id: 'interference', labelKey: 'assembly.tool.interference', tooltipKey: 'assembly.interference.tooltip' },
  { id: 'explode', labelKey: 'assembly.tool.explode', tooltipKey: 'assembly.explode.tooltip' },
  { id: 'bom', labelKey: 'assembly.tool.bom', tooltipKey: 'assembly.bom.tooltip' },
] as const satisfies readonly { readonly id: string; readonly labelKey: MessageKey; readonly tooltipKey: MessageKey }[];
