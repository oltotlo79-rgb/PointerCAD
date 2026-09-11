import { describe, expect, it } from 'vitest';
import { readSerializedScriptCommand } from './commandValidation.js';
import { validateScriptReferences, type ScriptReference } from './commandReferences.js';
import { scriptUtf8Bytes } from './scriptBytes.js';
import { resolveScriptModule } from './scriptModules.js';
import { locateScriptError } from './scriptLocation.js';
import { SCRIPT_LIMITS, type ScriptCommand } from './scriptTypes.js';

const callStack = '    at box (pointercad-internal-bootstrap.js:92:12)\n    at <eval> (user-script.js:3:2)';
const box: ScriptCommand = { kind: 'solid.box', resultId: 'execution:1', callStack,
  fields: { origin: ['0', '0', '0'], axis: 'z', x: '20', y: '20', z: '20' } };
function parse(value: unknown, remaining = SCRIPT_LIMITS.commandBytes) {
  return readSerializedScriptCommand(JSON.stringify(value), 'execution', remaining);
}

describe('P11 host command boundary', () => {
  it('copies expression sources and verifies result namespace before accepting a command', () => {
    const input = { ...box, fields: { ...box.fields, x: 'sqrt(2)/3+厚み' } };
    expect(parse(input)).toMatchObject({ ok: true, command: input });
    expect(parse({ ...input, resultId: 'other-document:1' })).toMatchObject({ ok: false, reason: 'resultId' });
  });
  it.each([
    { ...box, fields: { ...box.fields, hidden: 'fetch' } },
    { ...box, unexpected: true },
    { ...box, fields: { ...box.fields, x: 20 } },
    { ...box, fields: { ...box.fields, origin: ['0', '0'] } },
    { ...box, fields: { ...box.fields, axis: 'other' } },
    { ...box, kind: 'solid.execute' },
    { ...box, resultId: 'execution:01' },
    { ...box, resultId: 'execution:1001' },
    { ...box, callStack: 'x'.repeat(SCRIPT_LIMITS.stackCharacters + 1) },
  ])('rejects malformed or unknown fields %#', value => {
    expect(parse(value).ok).toBe(false);
  });
  it('rejects dangerous object keys parsed as own fields, with no prototype mutation', () => {
    const serialized = JSON.stringify(box).replace('"fields":{', '"fields":{"__proto__":{"polluted":true},');
    expect(readSerializedScriptCommand(serialized, 'execution', SCRIPT_LIMITS.commandBytes)).toMatchObject({ ok: false, reason: 'fields' });
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
  it('enforces byte length on Japanese sources at exact boundaries', () => {
    const text = JSON.stringify({ ...box, fields: { ...box.fields, x: '厚み' } });
    const bytes = new TextEncoder().encode(text).byteLength;
    expect(readSerializedScriptCommand(text, 'execution', bytes).ok).toBe(true);
    expect(readSerializedScriptCommand(text, 'execution', bytes - 1)).toMatchObject({ ok: false, reason: 'bytes' });
  });
  it.each(['ascii', '日本語', '🛠️', '\ud800', '\udc00', '\ud800a\udc00'])('counts UTF-8 without allocating a copy: %j', value => {
    const bytes = new TextEncoder().encode(value).byteLength;
    expect(scriptUtf8Bytes(value, bytes)).toBe(bytes);
    expect(scriptUtf8Bytes(value, bytes - 1)).toBeNull();
  });
  it('accepts only sequential unique result IDs', () => {
    expect(validateScriptReferences([box], new Map(), 'execution')).toEqual({ ok: true });
    expect(validateScriptReferences([box, box], new Map(), 'execution')).toMatchObject({ ok: false, reason: 'duplicate', commandIndex: 1 });
    expect(validateScriptReferences([{ ...box, resultId: 'execution:2' }], new Map(), 'execution')).toMatchObject({ ok: false, reason: 'order' });
  });
  it('rejects an edge assembled from points in different sketches', () => {
    const known = new Map<string, ScriptReference>([
      ['sketch-a', { kind: 'sketch', sketch: null }], ['p-a', { kind: 'point', sketch: 'sketch-a' }],
      ['p-b', { kind: 'point', sketch: 'sketch-b' }],
    ]);
    const line: ScriptCommand = { kind: 'sketch.line', resultId: 'execution:1', callStack,
      fields: { sketch: 'sketch-a', start: 'p-a', end: 'p-b' } };
    expect(validateScriptReferences([line], known, 'execution')).toMatchObject({ ok: false, reason: 'owner', reference: 'p-b' });
    expect(known.size).toBe(3);
  });
  it('rejects future or wrong-kind references while accepting prior results', () => {
    const hole: ScriptCommand = { kind: 'solid.hole', resultId: 'execution:2', callStack,
      fields: { target: 'execution:1', origin: ['0', '0', '0'], axis: 'z', diameter: '2', depth: '5' } };
    expect(validateScriptReferences([box, hole], new Map(), 'execution')).toEqual({ ok: true });
    expect(validateScriptReferences([{ ...hole, resultId: 'execution:1', fields: { ...hole.fields, target: 'execution:2' } }], new Map(), 'execution'))
      .toMatchObject({ ok: false, reason: 'order', reference: 'execution:2' });
    const extrude: ScriptCommand = { kind: 'solid.extrude', resultId: 'execution:2', callStack, fields: { face: 'execution:1', distance: '3' } };
    expect(validateScriptReferences([box, extrude], new Map(), 'execution')).toMatchObject({ ok: false, reason: 'kind' });
  });
  it('rejects the 1001st command as a whole batch', () => {
    const commands = Array.from({ length: 1001 }, (_, index) => ({ ...box, resultId: `execution:${index + 1}` }));
    expect(validateScriptReferences(commands, new Map(), 'execution')).toMatchObject({ ok: false, reason: 'count', commandIndex: 1000 });
    expect(validateScriptReferences(commands.slice(0, 1000), new Map(), 'execution')).toEqual({ ok: true });
  });
  it('resolves only registered local modules and preserves relative folders', () => {
    const modules = new Map([['helpers/value.js', 'export const value = 42;'], ['local.js', 'export {};']]);
    expect(resolveScriptModule('helpers/main.js', './value.js', modules)).toBe('helpers/value.js');
    for (const name of ['../local.js', '/local.js', 'https://remote.test/a.js', 'file:///tmp/a.js', 'local.js?x', '%2e%2e/a.js', 'C:/a.js']) {
      expect(resolveScriptModule('user-script.js', name, modules)).toBeNull();
    }
  });
  it('reports only real source locations and skips private wrapper frames', () => {
    const sources = new Map([['user-script.js', '// first\n// second\n cad.solid.box({});']]);
    expect(locateScriptError(callStack, sources)).toEqual({ file: 'user-script.js', line: 3, column: 2 });
    expect(locateScriptError('at user-script.js:9999:1', sources)).toBeNull();
  });
});
