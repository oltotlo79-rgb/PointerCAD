import { evaluateExpression, expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { analyzeParameters, assemblyExpressionContext, createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT,
  nextParameterName, type AssemblyDocument, type Parameter } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { assemblyExpressionOwners, assemblyParameterDraftFor, assemblyParameterRows, commitAddAssemblyParameter,
  commitRemoveAssemblyParameter, commitRenameAssemblyParameter, commitReorderAssemblyParameters,
  commitReplaceAssemblyParameter } from './assemblyParameterCommands.js';

const ev = (source: string): ExpressionValue => ({ source, value: 0, display: '0' });
const parameter = (name: string, source: string): Parameter => ({ name, value: ev(source), unit: 'mm', description: '' });
const target = { kind: 'origin', componentId: 'component-1', element: 'origin' } as const;

/** Every assembly expression owner references `a`, `aa` or both (types.ts placement/mate/joint/presentation). */
function fixture(): AssemblyDocument {
  return { ...createAssemblyDocument('組立'),
    parameters: [parameter('a', '2'), parameter('aa', '5'), parameter('c', 'a * 3'), parameter('w', '7')],
    components: [{ id: 'component-1', name: '部品A', source: { kind: 'part', partRef: 'part-1' },
      placement: { ...DEFAULT_COMPONENT_PLACEMENT, position: [ev('a'), ev('aa + 1'), ev('2*a')] },
      fixed: false, visible: true, suppressed: false }],
    mates: [{ id: 'mate-1', name: '距離1', kind: 'distance', a: target, b: target, value: ev('a*2'), flipped: false, suppressed: false }],
    joints: [{ id: 'joint-1', name: '回転1', kind: 'revolute', a: target, b: target, minValue: ev('a'), maxValue: ev('aa'), suppressed: false }],
    presentation: [
      { id: 'step-1', name: '分解1', start: 0, end: 0.5, body: { kind: 'explode', componentIds: ['component-1'],
        direction: { kind: 'world', axis: 'x' }, distance: ev('a + aa') } },
      { id: 'step-2', name: '駆動1', start: 0.5, end: 1, body: { kind: 'joint', jointId: 'joint-1', from: ev('max(a, 1)'), to: ev('a +') } },
    ] };
}
function ok(outcome: ReturnType<typeof commitRenameAssemblyParameter>): AssemblyDocument {
  if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.message}`);
  return outcome.document;
}
const sources = (document: AssemblyDocument): string[] => assemblyExpressionOwners(document).map(owner => owner.value.source);

describe('assembly parameter commands (core)', () => {
  it('lists all six expression owner kinds of the assembly', () => {
    expect(sources(fixture())).toEqual(['a', 'aa + 1', '2*a', 'a*2', 'a', 'aa', 'a + aa', 'max(a, 1)', 'a +']);
  });

  it('renames by identifier token in every owner and dependent parameter, never aa or function names', () => {
    const original = fixture(), before = JSON.stringify(original);
    const renamed = ok(commitRenameAssemblyParameter(original, 'a', 'b'));
    // `a +` does not parse but still tokenizes (renameVariable is token-based), so the reference follows the rename.
    expect(sources(renamed)).toEqual(['b', 'aa + 1', '2*b', 'b*2', 'b', 'aa', 'b + aa', 'max(b, 1)', 'b +']);
    expect(renamed.parameters.map(row => [row.name, row.value.source])).toEqual([['b', '2'], ['aa', '5'], ['c', 'b * 3'], ['w', '7']]);
    // Re-evaluated with the resolver's context: stored values follow (c = 3 b = 6, placement x = b = 2).
    expect(renamed.parameters[2]?.value.value).toBe(6);
    expect(renamed.components[0]?.placement.position[0].value).toBe(2);
    expect(JSON.stringify(original)).toBe(before);
    expect(ok(commitRenameAssemblyParameter(original, 'a', 'a')).parameters.map(row => row.name)).toEqual(['a', 'aa', 'c', 'w']);
  });

  it('keeps unit spellings and the inch mark when a parameter has the same spelling', () => {
    const base = fixture();
    const document: AssemblyDocument = { ...base, parameters: [...base.parameters, parameter('mm', '3'), parameter('in', '1')],
      mates: [{ ...base.mates[0], value: ev('2 mm + (mm) mm') }],
      joints: [{ ...base.joints[0], minValue: ev('(in) mm'), maxValue: ev('2" + a') }] };
    const renamedMm = ok(commitRenameAssemblyParameter(document, 'mm', 't'));
    expect(renamedMm.mates[0]?.value?.source).toBe('2 mm + (t) mm');
    expect(renamedMm.mates[0]?.value?.value).toBe(5);
    expect(renamedMm.joints[0]?.minValue?.source).toBe('(in) mm');
    const renamedIn = ok(commitRenameAssemblyParameter(document, 'in', 'k'));
    expect(renamedIn.joints[0]?.minValue?.source).toBe('(k) mm');
    expect(ok(commitRenameAssemblyParameter(document, 'a', 'b')).joints[0]?.maxValue?.source).toBe('2" + b');
  });

  it('keeps the cached value when a renamed expression still mixes explicit and implicit units', () => {
    const base = fixture();
    const document: AssemblyDocument = { ...base, parameters: [...base.parameters, parameter('mm', '3')],
      mates: [{ ...base.mates[0], value: { source: '2 mm + mm', value: 17, display: '17' } }] };
    const renamed = ok(commitRenameAssemblyParameter(document, 'mm', 't'));
    expect(renamed.mates[0]?.value).toEqual({ source: '2 mm + t', value: 17, display: '17' });
    expect(evaluateExpression('2 mm + t', assemblyExpressionContext(renamed)))
      .toMatchObject({ ok: false, error: { code: 'unitMismatch' } });
  });

  it('refuses unknown, duplicate and invalid names with the translated messages', () => {
    const document = fixture();
    const cases = [
      [commitRenameAssemblyParameter(document, 'missing', 'x'), 'notFound', t('parameter.error.notFound')],
      [commitRenameAssemblyParameter(document, 'a', 'aa'), 'duplicateRename', t('parameter.error.duplicateName')],
      [commitRenameAssemblyParameter(document, 'a', '1x'), 'startsWithDigit', t('parameter.error.startsWithDigit')],
      [commitAddAssemblyParameter(document, parameter('w', '1')), 'duplicateName', t('parameter.error.duplicateName')],
      [commitAddAssemblyParameter(document, parameter('', '1')), 'empty', t('parameter.error.empty')],
      [commitReplaceAssemblyParameter(document, 'missing', { description: 'x' }), 'notFound', t('parameter.error.notFound')],
    ] as const;
    for (const [outcome, reason, message] of cases) {
      expect(outcome).toEqual({ ok: false, reason, message });
    }
  });

  it('refuses removing a parameter used by any owner or parameter and names the owners', () => {
    const document = fixture();
    const used = commitRemoveAssemblyParameter(document, 'a');
    expect(used.ok).toBe(false);
    if (used.ok) return;
    expect(used.reason).toBe('referenced');
    for (const owner of ['部品A', '距離1', '回転1']) expect(used.message).toContain(owner);
    const onlyMate: AssemblyDocument = { ...document, parameters: [...document.parameters, parameter('m', '3')],
      mates: [{ ...document.mates[0], value: ev('m') }] };
    expect(commitRemoveAssemblyParameter(onlyMate, 'm').ok).toBe(false);
    expect(ok(commitRemoveAssemblyParameter(document, 'w')).parameters.map(row => row.name)).toEqual(['a', 'aa', 'c']);
    expect(commitRemoveAssemblyParameter(document, 'missing')).toEqual({ ok: false, reason: 'notFound', message: t('parameter.error.notFound') });
  });

  it('replaces value, unit and description but never the name, and re-evaluates dependents', () => {
    const replaced = ok(commitReplaceAssemblyParameter(fixture(), 'a', { name: 'zzz', value: ev('4'), description: 'pitch' }));
    expect(replaced.parameters.map(row => row.name)).toEqual(['a', 'aa', 'c', 'w']);
    expect(replaced.parameters[0]).toMatchObject({ value: { source: '4', value: 4 }, description: 'pitch' });
    expect(replaced.parameters[2]?.value.value).toBe(12);
    expect(replaced.components[0]?.placement.position[2].value).toBe(8);
    // The stored values equal what the resolver context computes for the same sources.
    const context = assemblyExpressionContext(replaced);
    expect(context.variables?.get('c')).toBe(12);
  });

  it('reorders rows only, ignoring out-of-range moves', () => {
    expect(ok(commitReorderAssemblyParameters(fixture(), 3, 0)).parameters.map(row => row.name)).toEqual(['w', 'a', 'aa', 'c']);
    expect(ok(commitReorderAssemblyParameters(fixture(), 0, 9)).parameters.map(row => row.name)).toEqual(['a', 'aa', 'c', 'w']);
  });

  it('builds rows with circular, invalid and unused flags counted over every owner', () => {
    const base = fixture();
    const document: AssemblyDocument = { ...base, parameters: [...base.parameters, parameter('x', 'y'), parameter('y', 'x'),
      parameter('q', '1 +'), parameter('m', '3')], mates: [{ ...base.mates[0], value: ev('m') }] };
    const rows = new Map(assemblyParameterRows(document).map(row => [row.name, row] as const));
    expect(rows.get('x')?.circular).toBe(true);
    expect(rows.get('q')?.failureMessage).not.toBeNull();
    expect(rows.get('q')?.source).toBe('1 +');
    // `m` is used only by a mate: the resolver's own context (placements only) would call it unused.
    expect(analyzeParameters(document.parameters, document.components.flatMap(c => c.placement.position.map(v => v.source)))
      .unused).toContain('m');
    expect(rows.get('m')?.unused).toBe(false);
    expect(rows.get('w')?.unused).toBe(true);
    expect(rows.get('c')?.value).toBe(6);
    expect([...rows.values()].every(row => row.geometry === undefined)).toBe(true);
  });

  it('drafts a new row with the next free name, value 0 and unit mm', () => {
    const document = fixture();
    expect(assemblyParameterDraftFor(document)).toEqual({ name: nextParameterName(document.parameters),
      value: expressionValueFromNumber(0), unit: 'mm', description: '' });
    const added = ok(commitAddAssemblyParameter(document, assemblyParameterDraftFor(document)));
    expect(added.parameters).toHaveLength(5);
  });
});
