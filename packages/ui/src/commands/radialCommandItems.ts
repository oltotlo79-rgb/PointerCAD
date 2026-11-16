import { type CommandDocumentKind, type CommandId } from './commandDefinitions.js';
import { EMPTY_RADIAL_COMMANDS, type EightCommands, type RadialCommands } from './radialCommandSettings.js';
import { toolbarCommand } from './toolbarCommandCatalog.js';
import { t } from '../i18n/t.js';

/** Up, upper-right, right, lower-right, down, lower-left, left, upper-left. */
const RADIAL_COMMANDS = {
  part: ['toolbar.sketch.select', 'toolbar.sketch.line', 'toolbar.shape.circle', 'toolbar.shape.rectangle',
    'toolbar.solidCreate.extrude', 'toolbar.look.measure', 'toolbar.view.home', 'history.undo'],
  assembly: ['toolbar.assembly.placePart', 'toolbar.assembly.placeStandardPart', 'toolbar.mate.coincident',
    'toolbar.mate.distance', 'toolbar.assembly.toggleFixed', 'toolbar.assemblyUtility.bom', 'toolbar.view.home', 'history.undo'],
  drawing: ['toolbar.drawing.baseView', 'toolbar.drawing.dimension', 'toolbar.drawing.note',
    'toolbar.drawing.centerMark', 'toolbar.drawing.export', 'file.save', 'drawing.cancelTool', 'history.undo'],
} as const satisfies Readonly<Record<CommandDocumentKind, EightCommands>>;

/** 既定の 8 つ(利用者が選ばなかった種類と、「既定に戻す」で使う)。 */
export function defaultRadialCommandIds(kind: CommandDocumentKind): EightCommands {
  return RADIAL_COMMANDS[kind];
}

/**
 * 今の 8 つ。利用者が選んだ並び(B-08f)があればそれ、無ければ既定。部品で点を選んでいる時の 3 つの命令は、
 * 選んだ並びでも 2 番目(右上)に出す(既定の「線分」の場所。選択の文脈の命令を見つけやすい場所に保つ)。
 */
export function radialCommandIds(kind: CommandDocumentKind, connectPoints = false, faceFromPoints = false,
  pointAtReference = false, custom: RadialCommands = EMPTY_RADIAL_COMMANDS): EightCommands {
  const base = custom[kind] ?? RADIAL_COMMANDS[kind];
  const contextual = kind !== 'part' ? null : faceFromPoints ? 'sketch.faceFromPoints'
    : pointAtReference ? 'sketch.pointAtReference' : connectPoints ? 'sketch.connectPoints' : null;
  if (contextual === null) return base;
  // Three or more selected points offer the face in the same place as the two-point connection; one selected part
  // reference point offers a sketch point that follows it, in the same place as the point commands.
  const [select, , ...rest] = base;
  return [select, contextual, ...rest];
}

/** The same action explanation is visible with mouse movement and keyboard focus. */
export function radialCommandDescription(id: CommandId): string {
  if (id === 'sketch.connectPoints') return t('sketch.connect.hint');
  if (id === 'sketch.faceFromPoints') return t('sketch.facePoints.hint');
  if (id === 'sketch.pointAtReference') return t('radial.pointAtReferenceHint');
  const command = toolbarCommand(id);
  if (command !== null) return t(command.tooltipKey);
  if (id === 'history.undo') return t('radial.undoHint');
  if (id === 'drawing.cancelTool') return t('radial.cancelDrawingHint');
  return t('radial.unavailable');
}
