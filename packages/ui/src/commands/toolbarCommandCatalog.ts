import { VIEW_COMMAND_ITEMS, ASSEMBLY_UTILITY_ITEMS } from './viewCommandItems.js';
import { SHEET_METAL_MENU_ITEMS } from '../sheetMetal/sheetMetalMenuItems.js';
import { SCRIPT_MENU_ITEMS } from '../scripting/scriptMenuItems.js';
import { DRAWING_TABLE_ACTIONS, DRAWING_TOOL_GROUPS } from '../drawing/drawingToolbarItems.js';
import type { MessageKey } from '../i18n/t.js';
import { FILE_ACTIONS } from '../shell/menus/fileToolbarDescriptors.js';
import { TOOLS, PLANES, PLANE_TOOLS, REFERENCE_TOOLS, SNAP_KINDS_UI } from '../shell/menus/sketchToolDescriptors.js';
import { FILE_MENU_ITEMS } from '../shell/menus/fileMenuItems.js';
import { SHAPE_MENU_ITEMS, EDIT_MENU_ITEMS, CONSTRAINT_MENU_ITEMS } from '../shell/menus/sketchMenuItems.js';
import { CREATE_MENU_ITEMS, COMBINE_MENU_ITEMS, MACHINING_MENU_ITEMS } from '../shell/menus/solidMenuItems.js';
import { PROJECTION_MENU_ITEMS, LOOK_MENU_ITEMS } from '../shell/menus/lookMenuItems.js';
import { ASSEMBLY_MENU_ITEMS, MATE_MENU_ITEMS } from '../shell/menus/assemblyMenuItems.js';

export type ToolbarCommandGroup =
  | 'file'
  | 'fileMenu'
  | 'sketch'
  | 'shape'
  | 'edit'
  | 'constraint'
  | 'solidCreate'
  | 'solidCombine'
  | 'solidMachining'
  | 'projection'
  | 'look'
  | 'assembly'
  | 'mate'
  | 'sheetMetal'
  | 'script'
  | 'drawing'
  | 'view'
  | 'plane'
  | 'reference'
  | 'snap'
  | 'assemblyUtility';

interface ExistingDescriptor {
  readonly id: string;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
}

export interface ToolbarCommandCatalogEntry {
  readonly id: ToolbarCommandId;
  readonly group: ToolbarCommandGroup;
  readonly sourceId: string;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
  readonly documentKinds: readonly ('part' | 'assembly' | 'drawing')[];
  readonly helpTopic: string;
}

export type ToolbarCommandId = `toolbar.${ToolbarCommandGroup}.${string}` | 'file.new' | 'file.open' | 'file.save' | 'file.saveAs';

export function toolbarCommandId(group: ToolbarCommandGroup, sourceId: string): ToolbarCommandId {
  if (group === 'drawing' && sourceId === 'saveAs') return 'file.saveAs';
  if (group === 'file' || group === 'drawing') {
    if (sourceId === 'new') return 'file.new';
    if (sourceId === 'open') return 'file.open';
    if (sourceId === 'save') return 'file.save';
  }
  if (group === 'fileMenu' && sourceId === 'saveAs') return 'file.saveAs';
  return `toolbar.${group}.${sourceId}`;
}

function toolbarDocumentKinds(group: ToolbarCommandGroup, id: string): readonly ('part' | 'assembly' | 'drawing')[] {
  if (group === 'file' || (group === 'fileMenu' && id === 'saveAs')) return ['part', 'assembly', 'drawing'];
  if (group === 'drawing') return ['drawing'];
  if (group === 'view') return ['section', 'chaining', 'snap', 'matchWorkPlane'].includes(id) ? ['part'] : ['part', 'assembly'];
  if (group === 'assembly' || group === 'mate' || group === 'assemblyUtility') return ['assembly'];
  if (group === 'projection' || (group === 'look' && id === 'strength')) return ['part', 'assembly'];
  if (group === 'fileMenu' && ['newAssembly', 'newDrawingFromPart', 'newDrawingFromTemplate'].includes(id)) return ['part', 'assembly'];
  return ['part'];
}

function toolbarHelpTopic(group: ToolbarCommandGroup, id: string): string {
  if (group === 'assemblyUtility') return id;
  if (group === 'reference') return id.startsWith('referencePlane') ? 'work-plane-custom' : 'reference-geometry';
  if (group === 'view' && id === 'section') return 'section-view';
  if (group === 'view' && id === 'snap') return 'snap';
  if (group === 'view' && id === 'matchWorkPlane') return 'work-plane';
  if (group === 'view' && id === 'chaining') return 'sketch-tools';
  if (group === 'drawing') {
    if (['datum', 'gdt', 'duplicateGdt'].includes(id)) return 'gdt';
    if (id === 'weld') return 'welding';
    if (id === 'bom') return 'drawing-bom';
    if (id === 'table') return 'drawing-table';
    if (id === 'section') return 'drawing-section';
    if (id === 'sheet') return 'drawing-scale';
    if (['chain', 'parallel', 'coordinateSeries', 'progressive'].includes(id)) return 'dimension-series';
    if (id === 'autoDimension') return 'dimension-auto';
    if (id === 'arrangeDimensions') return 'dimension-arrange';
    return DRAWING_TOOL_GROUPS.find(group => group.items.some(item => item.id === id))?.helpTopic ?? 'drawing';
  }
  if (group === 'sheetMetal') {
    if (id === 'sheetFlange') return 'sheet-metal-flange';
    if (id === 'sheetBend' || id === 'sheetRelief') return 'sheet-metal-bend-relief';
    return id === 'sheetUnfold' ? 'sheet-metal-flat' : 'sheet-metal';
  }
  const specific: Readonly<Record<string, string>> = {
    'fileMenu.compareDocuments': 'document-diff', 'fileMenu.exportShape': 'export', 'fileMenu.importShape': 'import',
    'fileMenu.saveAsTemplate': 'template', 'fileMenu.newFromTemplate': 'template', 'fileMenu.print': 'print-save-as',
    'fileMenu.newDrawingFromPart': 'drawing', 'fileMenu.newDrawingFromTemplate': 'drawing', 'fileMenu.newAssembly': 'assembly',
    'shape.functionPlot': 'function-curve', 'shape.text': 'text-sketch', 'shape.ellipse': 'ellipse', 'shape.spline': 'spline',
    'sketch.face': 'face-and-color', 'sketch.select': 'selection',
    'edit.sketchFillet': 'sketch-fillet', 'edit.sketchChamfer': 'sketch-fillet',
    'edit.mirror': 'copy-array', 'edit.copy': 'copy-array', 'edit.linearArray': 'copy-array', 'edit.circularArray': 'copy-array',
    'edit.projectedCurve': 'project-intersect', 'edit.planeSection': 'project-intersect',
    'look.appearance': 'appearance-color', 'look.measure': 'measure', 'look.strength': 'strength',
    'look.canvas': 'canvas', 'look.printCheck': 'print-check',
    'assembly.placeStandardPart': 'standard-parts', 'assembly.placeSubAssembly': 'replace-subassembly',
    'assembly.replacePart': 'replace-subassembly',
  };
  const exact = specific[`${group}.${id}`];
  if (exact !== undefined) return exact;
  if (group === 'mate') return ['revolute', 'slider', 'cylindrical', 'ball'].includes(id) ? 'joint' : 'mate';
  if (group === 'solidCreate' || group === 'solidMachining') {
    if (id === 'sphereGridPoint') return 'sphere-grid';
    if (id === 'threadShaft') return 'thread';
    if (id === 'spring') return 'spring';
    if (id === 'hole') return 'hole';
    if (id === 'threadHole') return 'thread';
    if (['fillet', 'chamfer'].includes(id)) return 'fillet-chamfer';
    if (['linearPattern', 'circularPattern'].includes(id)) return 'pattern';
    if (['box', 'cylinder', 'sphere', 'cone', 'torus'].includes(id)) return 'primitive';
    if (['loft', 'ruled'].includes(id)) return 'ruled-loft';
    if (['extrude', 'revolve', 'sew'].includes(id)) return 'solid-basics';
    if (id.toLowerCase().includes('cut')) return 'cut';
    return 'shape-edit';
  }
  const fallback: Readonly<Record<ToolbarCommandGroup, string>> = {
    file: 'save-and-open', fileMenu: 'save-and-open', sketch: 'sketch-tools', shape: 'shapes', edit: 'edit-curves',
    constraint: 'constraints', solidCreate: 'solid-basics', solidCombine: 'solid-combine', solidMachining: 'shape-edit',
    projection: 'viewport', look: 'appearance-color', assembly: 'assembly-place', mate: 'mate',
    sheetMetal: 'sheet-metal', script: 'scripts', drawing: 'drawing',
    view: 'viewport', plane: 'work-plane', reference: 'reference-geometry', snap: 'snap', assemblyUtility: 'assembly',
  };
  return fallback[group];
}

function entries(
  group: ToolbarCommandGroup,
  descriptors: readonly ExistingDescriptor[],
): readonly ToolbarCommandCatalogEntry[] {
  return descriptors.map((descriptor) => ({
    id: toolbarCommandId(group, descriptor.id),
    group,
    sourceId: descriptor.id,
    labelKey: descriptor.labelKey,
    tooltipKey: descriptor.tooltipKey,
    documentKinds: toolbarDocumentKinds(group, descriptor.id),
    helpTopic: toolbarHelpTopic(group, descriptor.id),
  }));
}

function createToolbarCommandCatalog(): readonly ToolbarCommandCatalogEntry[] {
  const catalog = [
    ...entries('file', FILE_ACTIONS),
    ...entries('fileMenu', FILE_MENU_ITEMS),
    ...entries('sketch', TOOLS),
    ...entries('shape', SHAPE_MENU_ITEMS),
    ...entries('edit', EDIT_MENU_ITEMS),
    ...entries('constraint', CONSTRAINT_MENU_ITEMS),
    ...entries('solidCreate', CREATE_MENU_ITEMS),
    ...entries('solidCombine', COMBINE_MENU_ITEMS),
    ...entries('solidMachining', MACHINING_MENU_ITEMS),
    ...entries('projection', PROJECTION_MENU_ITEMS),
    ...entries('look', LOOK_MENU_ITEMS),
    ...entries('assembly', ASSEMBLY_MENU_ITEMS),
    ...entries('mate', MATE_MENU_ITEMS),
    ...entries('sheetMetal', SHEET_METAL_MENU_ITEMS),
    ...entries('script', SCRIPT_MENU_ITEMS),
    ...DRAWING_TOOL_GROUPS.flatMap(group => entries('drawing', group.items.filter(item => !['open', 'save', 'saveAs'].includes(item.id)))),
    ...entries('drawing', DRAWING_TABLE_ACTIONS),
    ...entries('view', VIEW_COMMAND_ITEMS),
    ...entries('assemblyUtility', ASSEMBLY_UTILITY_ITEMS),
    ...entries('plane', [...PLANES, { id: 'free', labelKey: 'toolbar.plane.free', tooltipKey: 'toolbar.plane.freeTooltip' }]),
    ...entries('reference', [...PLANE_TOOLS, ...REFERENCE_TOOLS]),
    ...entries('snap', SNAP_KINDS_UI.map(item => ({ ...item, id: item.kind }))),
  ];
  const ids = new Set<string>();
  for (const command of catalog) {
    if (ids.has(command.id)) throw new Error(`Duplicate toolbar command id: ${command.id}`);
    ids.add(command.id);
  }
  return Object.freeze(catalog);
}

/** 画面と共有するdescriptorから生成し、道具名を別の一覧へ書き写さない。 */
export const TOOLBAR_COMMAND_CATALOG = createToolbarCommandCatalog();

export function toolbarCommand(id: string): ToolbarCommandCatalogEntry | null {
  return TOOLBAR_COMMAND_CATALOG.find((entry) => entry.id === id) ?? null;
}
