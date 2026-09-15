import { commandDefinition, type CommandDocumentKind, type CommandId } from './commandDefinitions.js';
import { toolbarCommand } from './toolbarCommandCatalog.js';
import { t } from '../i18n/t.js';
import type { RadialMenuSlot } from './radialMenuGeometry.js';

type EightCommands = readonly [CommandId, CommandId, CommandId, CommandId, CommandId, CommandId, CommandId, CommandId];

/** Up, upper-right, right, lower-right, down, lower-left, left, upper-left. */
const RADIAL_COMMANDS = {
  part: ['toolbar.sketch.select', 'toolbar.sketch.line', 'toolbar.shape.circle', 'toolbar.shape.rectangle',
    'toolbar.solidCreate.extrude', 'toolbar.look.measure', 'toolbar.view.home', 'history.undo'],
  assembly: ['toolbar.assembly.placePart', 'toolbar.assembly.placeStandardPart', 'toolbar.mate.coincident',
    'toolbar.mate.distance', 'toolbar.assembly.toggleFixed', 'toolbar.assemblyUtility.bom', 'toolbar.view.home', 'history.undo'],
  drawing: ['toolbar.drawing.baseView', 'toolbar.drawing.dimension', 'toolbar.drawing.note',
    'toolbar.drawing.centerMark', 'toolbar.drawing.export', 'file.save', 'drawing.cancelTool', 'history.undo'],
} as const satisfies Readonly<Record<CommandDocumentKind, EightCommands>>;

export function radialCommandIds(kind: CommandDocumentKind): EightCommands {
  return RADIAL_COMMANDS[kind];
}

/** The same action explanation is visible with mouse movement and keyboard focus. */
export function radialCommandDescription(id: CommandId): string {
  const command = toolbarCommand(id);
  if (command !== null) return t(command.tooltipKey);
  if (id === 'history.undo') return t('radial.undoHint');
  if (id === 'drawing.cancelTool') return t('radial.cancelDrawingHint');
  return t('radial.unavailable');
}

export function radialCommandAt(kind: CommandDocumentKind, slot: RadialMenuSlot): CommandId | null {
  const id = RADIAL_COMMANDS[kind][slot], definition = commandDefinition(id);
  return definition?.documentKinds.includes(kind) === true ? id : null;
}
