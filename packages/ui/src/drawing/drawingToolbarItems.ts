import type { MessageKey } from '../i18n/t.js';
import type { ToolMenuItem } from '../shell/toolbarMenus.js';
import { DrawingSheetIcon, SectionToolIcon, CircleToolIcon, PlaneIcon, TrimToolIcon, LineToolIcon,
  BomIcon, GridIcon, LayersIcon, FileMenuIcon, SaveAsIcon, PrintIcon, OpenFileIcon,
  SnapCenterIcon, WireframeIcon, EditGroupIcon, CubeIcon } from '../shell/icons.js';

export const DRAWING_DIMENSION_KINDS = [
  { key: 'drawing.dimension.length', kind: 'length', measurement: 'trueDistance' },
  { key: 'drawing.dimension.horizontal', kind: 'length', measurement: 'horizontal' },
  { key: 'drawing.dimension.vertical', kind: 'length', measurement: 'vertical' },
  { key: 'drawing.dimension.diameter', kind: 'diameter', measurement: 'radius' },
  { key: 'drawing.dimension.radius', kind: 'radius', measurement: 'radius' },
  { key: 'drawing.dimension.angle', kind: 'angle', measurement: 'angle' },
  { key: 'drawing.dimension.arcLength', kind: 'arcLength', measurement: 'radius' },
  { key: 'drawing.dimension.sphereDiameter', kind: 'sphereDiameter', measurement: 'radius' },
  { key: 'drawing.dimension.sphereRadius', kind: 'sphereRadius', measurement: 'radius' },
  { key: 'drawing.dimension.coordinate', kind: 'coordinate', measurement: 'coordinate' },
] as const;

/**
 * 図面の上の段に図柄のボタンとして常に並ぶファイル操作。部品の「新規・開く・保存」と同じく
 * ▾の一覧(「ファイルのほかの操作」)には重ねない。一覧の名前を部品と同じにしたので、
 * 一覧の中身も「図柄のボタンのほかの操作」にそろえる(w91a、説明書の点検 w65b §3-A)。
 */
export const DRAWING_FILE_BUTTON_ACTIONS = ['open', 'save'] as const;

export const DRAWING_TOOL_GROUPS = [
  /*
   * 見出し(`label`)は部品の図柄の並びの読み上げ名と同じ「ファイル」、▾の一覧の名前(`menuLabel`)は
   * 部品の▾と同じ「ファイルのほかの操作」。部品と図面で同じ役目のボタンを別の名前で呼ばない。
   */
  { label: 'toolbar.file.title', menuLabel: 'toolbar.fileMenu.groupLabel', helpTopic: 'drawing-export', tooltip: 'drawing.toolbar.fileHint', Icon: FileMenuIcon, items: [
    { id: 'saveAs', labelKey: 'toolbar.file.saveAs', tooltipKey: 'toolbar.file.saveAsTooltip', Icon: SaveAsIcon },
    { id: 'refreshSource', labelKey: 'drawing.sourceRefresh.title', tooltipKey: 'drawing.sourceRefresh.hint', Icon: OpenFileIcon },
    { id: 'export', labelKey: 'drawing.export.title', tooltipKey: 'drawing.toolbar.exportHint', Icon: DrawingSheetIcon },
    { id: 'svg', labelKey: 'drawing.action.exportSvg', tooltipKey: 'drawing.toolbar.svgHint', Icon: DrawingSheetIcon },
    { id: 'print', labelKey: 'drawing.print.title', tooltipKey: 'drawing.toolbar.printHint', Icon: PrintIcon },
    { id: 'return', labelKey: 'drawing.file.returnToPart', tooltipKey: 'drawing.toolbar.returnHint', Icon: CubeIcon },
  ] },
  { label: 'drawing.toolbar.views', helpTopic: 'drawing-views', tooltip: 'drawing.toolbar.viewsHint', Icon: DrawingSheetIcon, items: [
    { id: 'baseView', labelKey: 'drawing.tool.baseView', tooltipKey: 'drawing.toolbar.baseHint', Icon: DrawingSheetIcon },
    { id: 'projectedView', labelKey: 'drawing.tool.projectedView', tooltipKey: 'drawing.toolbar.projectedHint', Icon: DrawingSheetIcon },
    { id: 'isometricView', labelKey: 'drawing.tool.isometricView', tooltipKey: 'drawing.toolbar.isoHint', Icon: CubeIcon },
    { id: 'section', labelKey: 'drawing.tool.sectionView', tooltipKey: 'drawing.toolbar.sectionHint', Icon: SectionToolIcon },
    { id: 'detail', labelKey: 'drawing.tool.detailView', tooltipKey: 'drawing.toolbar.detailHint', Icon: CircleToolIcon },
    { id: 'auxiliary', labelKey: 'drawing.tool.auxiliaryView', tooltipKey: 'drawing.toolbar.auxiliaryHint', Icon: PlaneIcon },
    { id: 'partial', labelKey: 'drawing.tool.partialView', tooltipKey: 'drawing.toolbar.partialHint', Icon: TrimToolIcon },
    { id: 'broken', labelKey: 'drawing.tool.brokenView', tooltipKey: 'drawing.toolbar.brokenHint', Icon: LineToolIcon },
  ] },
  { label: 'drawing.toolbar.dimensions', helpTopic: 'dimension', tooltip: 'drawing.toolbar.dimensionsHint', Icon: LineToolIcon, items: [
    ...DRAWING_DIMENSION_KINDS.map((item) => ({ id: item.key, labelKey: item.key, tooltipKey: 'drawing.dimension.selectHint' as const, Icon: LineToolIcon })),
    { id: 'dimension', labelKey: 'drawing.tool.dimension', tooltipKey: 'drawing.dimension.selectHint', Icon: LineToolIcon },
    { id: 'chain', labelKey: 'drawing.series.chain', tooltipKey: 'drawing.series.pick', Icon: LineToolIcon },
    { id: 'parallel', labelKey: 'drawing.series.parallel', tooltipKey: 'drawing.series.pick', Icon: LineToolIcon },
    { id: 'coordinateSeries', labelKey: 'drawing.series.coordinate', tooltipKey: 'drawing.series.pick', Icon: LineToolIcon },
    { id: 'progressive', labelKey: 'drawing.series.progressive', tooltipKey: 'drawing.series.pick', Icon: LineToolIcon },
    { id: 'arrangeDimensions', labelKey: 'drawing.arrange.title', tooltipKey: 'drawing.arrange.select', Icon: GridIcon },
    { id: 'autoDimension', labelKey: 'drawing.dimension.auto', tooltipKey: 'drawing.toolbar.autoHint', Icon: LineToolIcon },
  ] },
  { label: 'drawing.toolbar.annotations', helpTopic: 'drawing-note', tooltip: 'drawing.toolbar.annotationsHint', Icon: EditGroupIcon, items: [
    { id: 'note', labelKey: 'drawing.tool.note', tooltipKey: 'drawing.toolbar.noteHint', Icon: EditGroupIcon },
    { id: 'annotation', labelKey: 'drawing.tool.annotation', tooltipKey: 'drawing.toolbar.annotationHint', Icon: EditGroupIcon },
    { id: 'datum', labelKey: 'drawing.gdt.datum', tooltipKey: 'drawing.gdt.datumHint', Icon: PlaneIcon },
    { id: 'gdt', labelKey: 'drawing.gdt.title', tooltipKey: 'drawing.gdt.hint', Icon: EditGroupIcon },
    { id: 'duplicateGdt', labelKey: 'drawing.gdt.duplicate', tooltipKey: 'drawing.gdt.selectCopy', Icon: EditGroupIcon },
    { id: 'weld', labelKey: 'drawing.weld.title', tooltipKey: 'drawing.weld.pick', Icon: EditGroupIcon },
    { id: 'centerMark', labelKey: 'drawing.tool.centerMark', tooltipKey: 'drawing.toolbar.centerHint', Icon: SnapCenterIcon },
  ] },
  { label: 'toolbar.look.groupLabel', helpTopic: 'drawing-layer', tooltip: 'drawing.toolbar.lookHint', Icon: LayersIcon, items: [
    { id: 'sheet', labelKey: 'drawing.property.sheet', tooltipKey: 'drawing.toolbar.sheetHint', Icon: DrawingSheetIcon },
    { id: 'layer', labelKey: 'drawing.tool.layer', tooltipKey: 'drawing.toolbar.layerHint', Icon: LayersIcon },
    { id: 'hidden', labelKey: 'drawing.view.hidden', tooltipKey: 'drawing.toolbar.hiddenHint', Icon: WireframeIcon },
    { id: 'centers', labelKey: 'drawing.view.centers', tooltipKey: 'drawing.toolbar.centerHint', Icon: SnapCenterIcon },
  ] },
] as const satisfies readonly { readonly label: MessageKey; readonly menuLabel?: MessageKey; readonly helpTopic: string; readonly tooltip: MessageKey; readonly Icon: typeof FileMenuIcon; readonly items: readonly ToolMenuItem<string>[] }[];

export const DRAWING_TABLE_ACTIONS = [
  { id: 'bom', labelKey: 'drawing.table.bom', tooltipKey: 'drawing.toolbar.bomHint', Icon: BomIcon },
  { id: 'table', labelKey: 'drawing.tool.table', tooltipKey: 'drawing.toolbar.tableHint', Icon: GridIcon },
] as const satisfies readonly ToolMenuItem<string>[];

export type DrawingToolbarAction = typeof DRAWING_TOOL_GROUPS[number]['items'][number]['id'] | typeof DRAWING_TABLE_ACTIONS[number]['id']
  | typeof DRAWING_FILE_BUTTON_ACTIONS[number];
