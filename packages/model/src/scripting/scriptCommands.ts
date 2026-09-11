import type { PartDocument } from '../part/types.js';
import type { LengthUnit } from '../units/length.js';
import { validateScriptReferences, type ScriptReference } from './commandReferences.js';
import { ScriptCommandError, type ScriptCommandChange, type ScriptModelReference } from './scriptCommandContext.js';
import { applyScriptSketchCommand } from './scriptSketchCommands.js';
import { applyScriptSolidCommand } from './scriptSolidCommands.js';
import { applyScriptParameterCommand } from './scriptParameterCommand.js';
import { locateScriptError } from './scriptLocation.js';
import type { ScriptCommand, ScriptFailure } from './scriptTypes.js';

export type ScriptCommandBatch = { readonly ok: true; readonly document: PartDocument; readonly locations: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly error: ScriptFailure };
/** Build immutable definitions, with no app state or kernel access. */
export function applyScriptCommands(initial: PartDocument, commands: readonly ScriptCommand[],
  existing: ReadonlyMap<string, ScriptModelReference>, commandNamespace: string, lengthUnit: LengthUnit,
  sources: ReadonlyMap<string, string>): ScriptCommandBatch {
  const owners = new Map([...existing].filter(([, reference]) => reference.kind === 'sketch')
    .map(([alias, reference]) => [reference.featureId, alias]));
  const catalog = new Map<string, ScriptReference>([...existing].map(([alias, reference]) => [alias, {
    kind: reference.kind, sketch: reference.kind === 'sketch' || reference.sketchId === null ? null : owners.get(reference.sketchId) ?? null,
  }]));
  const check = validateScriptReferences(commands, catalog, commandNamespace);
  if (!check.ok) return { ok: false, error: { kind: 'command', message: '要素の参照・順番・種類が一致しません。',
    location: locateScriptError(commands[check.commandIndex]?.callStack ?? '', sources) } };
  const references = new Map(existing), locations = new Map<string, string>();
  let document = initial;
  for (const command of commands) {
    const context = { document, references, lengthUnit };
    try {
      let change: ScriptCommandChange;
      switch (command.kind) {
        case 'parameter.set': change = applyScriptParameterCommand(context, command); break;
        case 'sketch.create': case 'sketch.point': case 'sketch.line': case 'sketch.face': change = applyScriptSketchCommand(context, command); break;
        default: change = applyScriptSolidCommand(context, command);
      }
      document = change.document;
      if (command.resultId !== null && change.reference !== null) references.set(command.resultId, change.reference);
      for (const id of change.featureIds) locations.set(id, command.callStack);
    } catch (error) {
      return { ok: false, error: { kind: 'command', message: error instanceof ScriptCommandError ? error.message : '入力から操作を作成できませんでした。',
        location: locateScriptError(command.callStack, sources) } };
    }
  }
  return { ok: true, document, locations };
}
