/** Unknown VM output is parsed, bounded and copied at the host boundary. No guest coercion. */
import { scriptUtf8Bytes } from './scriptBytes.js';
import { SCRIPT_LIMITS, type ScriptAxis, type ScriptCommand, type ScriptCoordinate, type ScriptPlane } from './scriptTypes.js';

type Row = Record<string, unknown>;
type ReadResult = { readonly ok: true; readonly command: ScriptCommand; readonly bytes: number }
  | { readonly ok: false; readonly reason: string };

class CommandInputError extends Error {}
function fail(field: string): never { throw new CommandInputError(field); }
function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function row(value: unknown, keys: readonly string[]): Row {
  if (!isRow(value)) return fail('object');
  const record = value;
  const ownKeys = Object.keys(record);
  if (ownKeys.length !== keys.length || ownKeys.some(key => !keys.includes(key))) return fail('fields');
  return record;
}
function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() === '') return fail(field);
  return value;
}
function reference(value: unknown): string { return text(value, 'reference', SCRIPT_LIMITS.identifierCharacters); }
function expression(value: unknown): string { return text(value, 'expression', SCRIPT_LIMITS.expressionCharacters); }
function vector(value: unknown): ScriptCoordinate {
  if (!Array.isArray(value) || value.length !== 3) return fail('coordinate');
  return [expression(value[0]), expression(value[1]), expression(value[2])];
}
function axis(value: unknown): ScriptAxis {
  if (value === 'x' || value === 'y' || value === 'z') return value;
  return fail('axis');
}
function plane(value: unknown): ScriptPlane {
  if (value === 'xy' || value === 'xz' || value === 'yz') return value;
  return fail('plane');
}
function basePrimitive(value: Row): { readonly origin: ScriptCoordinate; readonly axis: ScriptAxis } {
  return { origin: vector(value.origin), axis: axis(value.axis) };
}

function readCommand(input: unknown, executionId: string): ScriptCommand {
  const command = row(input, ['kind', 'resultId', 'fields', 'callStack']);
  const callStack = text(command.callStack, 'callStack', SCRIPT_LIMITS.stackCharacters);
  if (command.kind === 'parameter.set') {
    if (command.resultId !== null) return fail('resultId');
    const fields = row(command.fields, ['name', 'source', 'unit']);
    const unit = fields.unit;
    if (unit !== null && unit !== 'mm' && unit !== 'degree' && unit !== 'none') return fail('unit');
    return { kind: command.kind, callStack, resultId: null,
      fields: { name: reference(fields.name), source: expression(fields.source), unit } };
  }
  const resultId = reference(command.resultId);
  if (!resultId.startsWith(`${executionId}:`)) return fail('resultId');
  const serial = resultId.slice(executionId.length + 1);
  if (!/^[1-9][0-9]{0,3}$/.test(serial) || Number(serial) > SCRIPT_LIMITS.commands) return fail('resultId');
  const common = { callStack, resultId };
  switch (command.kind) {
    case 'sketch.create': {
      const fields = row(command.fields, ['name', 'plane']);
      return { ...common, kind: command.kind, fields: { name: reference(fields.name), plane: plane(fields.plane) } };
    }
    case 'sketch.point': {
      const fields = row(command.fields, ['sketch', 'coordinates']);
      return { ...common, kind: command.kind, fields: { sketch: reference(fields.sketch), coordinates: vector(fields.coordinates) } };
    }
    case 'sketch.line': {
      const fields = row(command.fields, ['sketch', 'start', 'end']);
      return { ...common, kind: command.kind,
        fields: { sketch: reference(fields.sketch), start: reference(fields.start), end: reference(fields.end) } };
    }
    case 'sketch.face': {
      const fields = row(command.fields, ['sketch', 'edges']);
      if (!Array.isArray(fields.edges) || fields.edges.length < 3 || fields.edges.length > SCRIPT_LIMITS.commands) return fail('edges');
      const edges = fields.edges.map(reference);
      if (new Set(edges).size !== edges.length) return fail('edges');
      return { ...common, kind: command.kind, fields: { sketch: reference(fields.sketch), edges } };
    }
    case 'solid.box': {
      const fields = row(command.fields, ['origin', 'axis', 'x', 'y', 'z']);
      return { ...common, kind: command.kind,
        fields: { ...basePrimitive(fields), x: expression(fields.x), y: expression(fields.y), z: expression(fields.z) } };
    }
    case 'solid.sphere': {
      const fields = row(command.fields, ['origin', 'axis', 'radius']);
      return { ...common, kind: command.kind, fields: { ...basePrimitive(fields), radius: expression(fields.radius) } };
    }
    case 'solid.cylinder': {
      const fields = row(command.fields, ['origin', 'axis', 'radius', 'height']);
      return { ...common, kind: command.kind,
        fields: { ...basePrimitive(fields), radius: expression(fields.radius), height: expression(fields.height) } };
    }
    case 'solid.cone': {
      const fields = row(command.fields, ['origin', 'axis', 'bottomRadius', 'topRadius', 'height']);
      return { ...common, kind: command.kind, fields: { ...basePrimitive(fields),
        bottomRadius: expression(fields.bottomRadius), topRadius: expression(fields.topRadius), height: expression(fields.height) } };
    }
    case 'solid.torus': {
      const fields = row(command.fields, ['origin', 'axis', 'majorRadius', 'minorRadius']);
      return { ...common, kind: command.kind,
        fields: { ...basePrimitive(fields), majorRadius: expression(fields.majorRadius), minorRadius: expression(fields.minorRadius) } };
    }
    case 'solid.extrude': {
      const fields = row(command.fields, ['face', 'distance']);
      return { ...common, kind: command.kind, fields: { face: reference(fields.face), distance: expression(fields.distance) } };
    }
    case 'solid.hole': {
      const fields = row(command.fields, ['target', 'origin', 'axis', 'diameter', 'depth']);
      return { ...common, kind: command.kind, fields: { target: reference(fields.target), origin: vector(fields.origin),
        axis: axis(fields.axis), diameter: expression(fields.diameter), depth: expression(fields.depth) } };
    }
    default: return fail('kind');
  }
}

/** Parse only text copied from VM memory, never a guest object or its proxy. */
export function readSerializedScriptCommand(serialized: string, executionId: string, remainingBytes: number): ReadResult {
  const bytes = scriptUtf8Bytes(serialized, Math.min(remainingBytes, SCRIPT_LIMITS.commandBytes));
  if (bytes === null) return { ok: false, reason: 'bytes' };
  try {
    const parsed: unknown = JSON.parse(serialized);
    return { ok: true, command: readCommand(parsed, executionId), bytes };
  } catch (error) {
    if (error instanceof CommandInputError) return { ok: false, reason: error.message };
    if (error instanceof SyntaxError) return { ok: false, reason: 'json' };
    throw error;
  }
}
