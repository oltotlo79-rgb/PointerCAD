import type { PartDocument } from '../part/types.js';
import type { LengthUnit } from '../units/length.js';
import { validateScriptReferences, type ScriptReference } from './commandReferences.js';
import { ScriptCommandError, type ScriptCommandChange, type ScriptModelReference } from './scriptCommandContext.js';
import { applyScriptSketchCommand } from './scriptSketchCommands.js';
import { applyScriptSolidCommand } from './scriptSolidCommands.js';
import { applyScriptParameterCommand } from './scriptParameterCommand.js';
import { locateScriptError } from './scriptLocation.js';
import { plainText } from '../failureText.js';
import { scriptFailure, scriptInternalFailure, type ScriptCommand, type ScriptFailure } from './scriptTypes.js';
import { applyScriptFunctionCommand, type CompiledScriptFunction, type ScriptFunctionCompiler } from './scriptFunctionCommands.js';
export type ScriptCommandBatch = {
  readonly ok: true;
  readonly document: PartDocument;
  readonly locations: ReadonlyMap<string, string>;
} | {
  readonly ok: false;
  readonly error: ScriptFailure;
};
/** Build immutable definitions, with no app state or kernel access. */
function createCommandBuilder(initial: PartDocument, commands: readonly ScriptCommand[], existing: ReadonlyMap<string, ScriptModelReference>, commandNamespace: string, lengthUnit: LengthUnit, sources: ReadonlyMap<string, string>) {
  const owners = new Map([...existing].filter(([, reference]) => reference.kind === 'sketch')
    .map(([alias, reference]) => [reference.featureId, alias]));
  const catalog = new Map<string, ScriptReference>([...existing].map(([alias, reference]) => [alias, {
    kind: reference.kind, sketch: reference.kind === 'sketch' || reference.sketchId === null ? null : owners.get(reference.sketchId) ?? null,
  }]));
  const check = validateScriptReferences(commands, catalog, commandNamespace);
  let failure: ScriptFailure | null = check.ok ? null : scriptFailure('referenceSequence',
    locateScriptError(commands[check.commandIndex]?.callStack ?? '', sources));
  const references = new Map(existing), locations = new Map<string, string>();
  let document = initial;
  const fail = (command: ScriptCommand, error: unknown) => {
    const location = locateScriptError(command.callStack, sources);
    if (error instanceof ScriptCommandError) {
      failure = typeof error.detail === 'string' ? scriptFailure(error.detail, location) : { kind: 'command', text: error.detail, location };
    } else {
      failure = scriptInternalFailure(error, location);
    }
  };
  const step = (command: ScriptCommand, compiled?: CompiledScriptFunction) => {
    if (failure !== null)
      return;
    const context = { document, references, lengthUnit };
    try {
      let change: ScriptCommandChange;
      switch (command.kind) {
        case 'function.curve':
        case 'function.surface':
          change = applyScriptFunctionCommand(context, command, compiled);
          break;
        case 'parameter.set':
          change = applyScriptParameterCommand(context, command);
          break;
        case 'sketch.create':
        case 'sketch.point':
        case 'sketch.line':
        case 'sketch.face':
          change = applyScriptSketchCommand(context, command);
          break;
        default: change = applyScriptSolidCommand(context, command);
      }
      document = change.document;
      if (command.resultId !== null && change.reference !== null)
        references.set(command.resultId, change.reference);
      for (const id of change.featureIds)
        locations.set(id, command.callStack);
    }
    catch (error) {
      fail(command, error);
    }
  };
  return {
    get document() { return document; }, get ok() { return failure === null; }, step, fail,
    result: (): ScriptCommandBatch => failure === null ? { ok: true, document, locations } : { ok: false, error: failure }
  };
}
export function applyScriptCommands(...input: Parameters<typeof createCommandBuilder>): ScriptCommandBatch {
  const builder = createCommandBuilder(...input);
  for (const command of input[1]) {
    if (!builder.ok)
      break;
    builder.step(command);
  }
  return builder.result();
}
/** Compile in document order, so preceding parameter edits and newly created sketches apply. */
export async function prepareScriptCommands(input: Readonly<Parameters<typeof createCommandBuilder>>, compile: ScriptFunctionCompiler, shouldCancel: () => boolean): Promise<ScriptCommandBatch> {
  const builder = createCommandBuilder(...input), cancelled = (): ScriptCommandBatch => ({ ok: false, error: scriptFailure('cancelled') });
  for (const command of input[1]) {
    if (shouldCancel())
      return cancelled();
    if (!builder.ok)
      break;
    try {
      const prepared = command.kind === 'function.curve' || command.kind === 'function.surface'
        ? await compile(builder.document, command.fields.definition, shouldCancel) : undefined;
      if (shouldCancel())
        return cancelled();
      builder.step(command, prepared);
    }
    catch (error) {
      if (shouldCancel()) return cancelled();
      // The function form reports editable fields as a DataError. All other compiler exceptions retain their cause.
      builder.fail(command, error instanceof DOMException && error.name === 'DataError'
        ? new ScriptCommandError(plainText(error.message)) : error);
    }
  }
  return shouldCancel() ? cancelled() : builder.result();
}
