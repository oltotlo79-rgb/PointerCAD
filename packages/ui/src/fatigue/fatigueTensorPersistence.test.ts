import { validateProportionalTensorFatigueInput, type FatigueTensorComponent } from '@pointercad/fem';
import { readBeamAnalysisInputs, readFatigueTensorSavedProblem } from '@pointercad/model/beam-analysis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bucklingUiFixture } from '../beam/beamBuckling.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { BASE_EDITS, edited, relative } from './fatigue.testSupport.js';
import { currentFatigueResult, editFatigueSession, fatigueEntryIsSaved, fatigueSavedEntry, restoreTensorFatigueSession,
  savedFatigueEntry, savedFatigueInput, type FatigueEdit, type FatigueSession } from './fatigueSession.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);

type Components = Readonly<Record<FatigueTensorComponent, string>>;
const KEYS: readonly FatigueTensorComponent[] = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'];
/** Typed as a user would type them; several are not exactly representable decimals, so the round trip is meaningful. */
const COMPONENTS: Components = { xx: '0.1', yy: '-33.3', zz: '0', yz: '1e-7', xz: '2.5', xy: '-0.3' };
const FACTORS = '0, 1.5e-3, -0.7, 1';
/** BASE_EDITS (test-only curve and sources) in the tensor mode, as a repeated record, so every field has a value. */
const TENSOR_EDITS: readonly FatigueEdit[] = [...BASE_EDITS, { kind: 'input-mode', value: 'proportional-tensor' },
  ...KEYS.map((component): FatigueEdit => ({ kind: 'tensor-component', index: 0, component, source: COMPONENTS[component] })),
  { kind: 'tensor-factors', index: 0, source: FACTORS },
  { kind: 'history-sequence', index: 0, value: 'repeated-periodic' }, { kind: 'history-repeats', index: 0, source: '10' }];

function session(): FatigueSession {
  const value = useAppStore.getState().fatigueSession;
  if (value === null) throw new Error('No fatigue session');
  return value;
}
function openAssemblyWithStrength(): void {
  const fixture = bucklingUiFixture();
  const assembly = fixture.state.assembly;
  if (assembly === null) throw new Error('Fixture without assembly');
  // The real action creates the Undo stack that applyAssembly needs.
  useAppStore.getState().openAssembly(assembly, fixture.state.assemblyLibrary);
  useAppStore.setState({ strengthSession: fixture.state.strengthSession });
}

describe('proportional tensor fatigue inputs in the document (version 4)', () => {
  it('saves through Undo, never stores a result, reopens the exact doubles without a result, and recalculates the same', async () => {
    openAssemblyWithStrength();
    const before = useAppStore.getState().assembly;
    if (before === null) throw new Error('Assembly closed');
    const others = before.beamAnalysisInputs?.analyses ?? [];
    useAppStore.getState().openFatigue();
    for (const edit of TENSOR_EDITS) useAppStore.getState().editFatigue(edit);
    await useAppStore.getState().runFatigue();
    const first = currentFatigueResult(session(), []);
    if (first === null) throw new Error(`Expected a tensor result: ${session().errorKey ?? ''}`);
    useAppStore.getState().saveFatigue();
    expect(session().errorKey).toBeNull();
    expect(useAppStore.getState().canUndo).toBe(true);
    const assembly = useAppStore.getState().assembly;
    if (assembly === null) throw new Error('Assembly closed');
    expect(assembly.beamAnalysisInputs?.analyses.filter(input => input.kind !== 'fatigue-proportional-tensor')).toEqual(others);
    const stored = savedFatigueEntry(assembly);
    if (stored?.kind !== 'fatigue-proportional-tensor') throw new Error('Expected the tensor configuration');
    expect(savedFatigueInput(assembly)).toBeNull();
    expect(stored.definition.schema).toBe('pointercad-fatigue-saved/4');
    expect(stored.definition.source.documentId).toBe(assembly.id);
    const savedHistory = stored.definition.input.histories[0];
    expect(savedHistory?.reference).toEqual({ unit: 'MPa', components: 'cauchy-tensor-shear-xx-yy-zz-yz-xz-xy',
      xx: 0.1, yy: -33.3, zz: 0, yz: 1e-7, xz: 2.5, xy: -0.3 });
    expect(savedHistory?.loadFactors).toEqual([0, 1.5e-3, -0.7, 1]);
    expect([savedHistory?.sequence, savedHistory?.repeats]).toEqual(['repeated-periodic', 10]);
    expect(JSON.stringify(assembly.beamAnalysisInputs)).not.toMatch(/"(?:damage|cycles|life|analyzed|result)"/u);
    // Neither the converted equivalent stresses nor the conversion of the core are stored: inputs and method only.
    expect(JSON.stringify(stored.definition)).not.toMatch(/"(?:stressMpa|conversions|signedEquivalentReferenceMpa|signTie)"/u);
    expect(currentFatigueResult(session(), assembly.parameters)).toBe(first);
    expect(fatigueEntryIsSaved(session(), assembly.parameters, stored)).toBe(true);
    // Reopen from the document: the same draft values, no result until Calculate, and the same result after it.
    useAppStore.getState().closeFatigue();
    useAppStore.getState().openFatigue();
    expect(session().analyzed).toBeNull();
    expect(session().draft.inputMode).toBe('proportional-tensor');
    const row = session().draft.tensors['history-1'];
    expect(row?.components).toEqual(COMPONENTS);
    expect(row?.loadFactors.split(', ').map(Number)).toEqual([0, 1.5e-3, -0.7, 1]);
    expect(fatigueEntryIsSaved(session(), assembly.parameters, stored)).toBe(true);
    await useAppStore.getState().runFatigue();
    const again = currentFatigueResult(session(), assembly.parameters);
    expect(again?.damage).toBe(first.damage);
    expect(relative(again?.damage ?? Number.NaN, first.damage)).toBe(0);
    // A second save, then Undo restores the first, a second Undo removes it, Redo brings it back.
    useAppStore.getState().editFatigue({ kind: 'tensor-factors', index: 0, source: '0, 1' });
    expect(fatigueEntryIsSaved(session(), assembly.parameters, stored)).toBe(false);
    useAppStore.getState().saveFatigue();
    const second = savedFatigueEntry(useAppStore.getState().assembly ?? before);
    expect(second?.kind === 'fatigue-proportional-tensor' ? second.definition.input.histories[0]?.loadFactors : null).toEqual([0, 1]);
    useAppStore.getState().undoAssembly();
    expect(savedFatigueEntry(useAppStore.getState().assembly ?? before)).toEqual(stored);
    useAppStore.getState().undoAssembly();
    expect(savedFatigueEntry(useAppStore.getState().assembly ?? before)).toBeNull();
    useAppStore.getState().redoAssembly();
    expect(savedFatigueEntry(useAppStore.getState().assembly ?? before)).toEqual(stored);
  });

  it('cold-reads the serialized attachment through the model reader and the actual open action', () => {
    openAssemblyWithStrength();
    useAppStore.getState().openFatigue();
    for (const edit of TENSOR_EDITS) useAppStore.getState().editFatigue(edit);
    useAppStore.getState().saveFatigue();
    const current = useAppStore.getState().assembly;
    if (current === null) throw new Error('Assembly closed');
    const raw: unknown = JSON.parse(JSON.stringify(current.beamAnalysisInputs));
    const parsed = readBeamAnalysisInputs(raw, current.id);
    if (!parsed.ok) throw new Error(parsed.issue.message);
    useAppStore.getState().closeFatigue();
    useAppStore.getState().openAssembly({ ...current, beamAnalysisInputs: parsed.value }, useAppStore.getState().assemblyLibrary);
    useAppStore.setState({ strengthSession: bucklingUiFixture().state.strengthSession });
    useAppStore.getState().openFatigue();
    expect(session().analyzed).toBeNull();
    expect(session().draft.tensors['history-1']?.components).toEqual(COMPONENTS);
    expect(fatigueEntryIsSaved(session(), current.parameters, savedFatigueEntry(current))).toBe(true);
  });

  it('keeps one fatigue configuration: a stress save replaces the tensor one and Undo brings it back', () => {
    openAssemblyWithStrength();
    const before = useAppStore.getState().assembly;
    if (before === null) throw new Error('Assembly closed');
    useAppStore.getState().openFatigue();
    for (const edit of TENSOR_EDITS) useAppStore.getState().editFatigue(edit);
    useAppStore.getState().saveFatigue();
    const tensor = savedFatigueEntry(useAppStore.getState().assembly ?? before);
    useAppStore.getState().editFatigue({ kind: 'input-mode', value: 'stress' });
    useAppStore.getState().saveFatigue();
    const analyses = useAppStore.getState().assembly?.beamAnalysisInputs?.analyses ?? [];
    expect(analyses.filter(input => input.kind === 'fatigue' || input.kind === 'fatigue-proportional-tensor').map(input => input.kind))
      .toEqual(['fatigue']);
    expect(savedFatigueInput(useAppStore.getState().assembly ?? before)?.input.histories[0]?.stressMpa).toEqual([0, 200, 0]);
    useAppStore.getState().undoAssembly();
    expect(savedFatigueEntry(useAppStore.getState().assembly ?? before)).toEqual(tensor);
  });

  it('refuses to save an invalid tensor draft at its field without editing the document', () => {
    openAssemblyWithStrength();
    useAppStore.getState().openFatigue();
    for (const edit of TENSOR_EDITS) useAppStore.getState().editFatigue(edit);
    useAppStore.getState().editFatigue({ kind: 'tensor-component', index: 0, component: 'xy', source: '' });
    const before = useAppStore.getState().assembly;
    useAppStore.getState().saveFatigue();
    expect([session().errorKey, session().focusedField]).toEqual(['fatigue.error.tensorComponent', 'tensor:0:xy']);
    expect(useAppStore.getState().assembly).toBe(before);
    useAppStore.getState().editFatigue({ kind: 'correction-mode', value: 'goodman' });
    useAppStore.getState().editFatigue({ kind: 'tensor-component', index: 0, component: 'xy', source: '-0.3' });
    useAppStore.getState().saveFatigue();
    expect([session().errorKey, session().focusedField]).toEqual(['fatigue.error.tensorCorrection', 'correction:mode']);
    expect(useAppStore.getState().assembly).toBe(before);
  });
});

describe('saved status of a restored tensor configuration', () => {
  const draft = edited(TENSOR_EDITS);
  const entry = fatigueSavedEntry(draft, [], 'document-a');
  if (!entry.ok || entry.entry.kind !== 'fatigue-proportional-tensor') throw new Error('Expected a tensor entry');
  const saved = entry.entry;
  const restored = restoreTensorFatigueSession('document-a', saved.definition);

  it('restores an equal draft with no result, accepted by the model reader', () => {
    expect(restored.analyzed).toBeNull();
    expect(fatigueEntryIsSaved(restored, [], saved)).toBe(true);
    expect(fatigueSavedEntry(restored, [], 'document-a')).toEqual(entry);
    const read = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [saved] }, 'document-a');
    expect(read.ok ? read.value.analyses : null).toEqual([saved]);
  });

  const changes: readonly FatigueEdit[] = [
    ...KEYS.map((component): FatigueEdit => ({ kind: 'tensor-component', index: 0, component, source: '7' })),
    { kind: 'tensor-factors', index: 0, source: '0, 1.5e-3, -0.7, 1, 0' },
    { kind: 'tensor-factors', index: 0, source: '0, 0.0015000000000000002, -0.7, 1' },
    { kind: 'value', field: 'referenceStress', source: '120' }, { kind: 'value', field: 'referenceCycles', source: '3000000' },
    { kind: 'value', field: 'slope', source: '4' }, { kind: 'stress-definition', value: 'amplitude' },
    { kind: 'mean-assumption', value: 'fully-reversed-only' }, { kind: 'cutoff-mode', value: 'value' },
    { kind: 'curve-source', field: 'reference', source: 'another curve source' },
    { kind: 'curve-source', field: 'condition', source: 'another condition' },
    { kind: 'history-sequence', index: 0, value: 'once' }, { kind: 'history-repeats', index: 0, source: '11' },
    { kind: 'history-source', index: 0, field: 'reference', source: 'another record source' },
    { kind: 'history-source', index: 0, field: 'condition', source: 'another record condition' },
    { kind: 'history-add' }, { kind: 'input-mode', value: 'stress' }, { kind: 'correction-mode', value: 'goodman' },
  ];
  it.each(changes)('is no longer saved after $kind $field $component $source', edit => {
    const changed = editFatigueSession(restored, edit);
    expect(changed).not.toBe(restored);
    expect(fatigueEntryIsSaved(changed, [], saved)).toBe(false);
  });
});

/* Model-vs-core verdicts on the same proportional-tensor inputs. Each expected verdict is stated here from the core's
 * documented rules (bounds 1e4 MPa, 1 to 100000 factors, 1 to 64 histories, ids of at most 64 characters, refusal of zero,
 * hydrostatic and rounded-to-zero loads), not taken from either reader, so a drift of either copy fails. */
describe('saved tensor reader agrees with the core reader at every boundary', () => {
  const source = { kind: 'user-supplied', reference: 'boundary table', condition: 'test only' };
  const curve = { id: 'curve', unit: 'MPa', stressDefinition: 'range', meanStressAssumption: 'mean-independent',
    referenceStressMpa: 100, referenceCycles: 2e6, slope: 3, cutoffStressMpa: null, source };
  const reference = (xx: number, yy = 0, zz = 0, yz = 0, xz = 0, xy = 0) =>
    ({ unit: 'MPa', components: 'cauchy-tensor-shear-xx-yy-zz-yz-xz-xy', xx, yy, zz, yz, xz, xy });
  const history = (overrides: Record<string, unknown> = {}) => ({ id: 'h1', reference: reference(100), loadFactors: [0, 1],
    sequence: 'once', repeats: 1, source, ...overrides });
  const problem = (histories: readonly unknown[] = [history()], overrides: Record<string, unknown> = {}) =>
    ({ schema: 'pointercad-fatigue-proportional-tensor/1',
      method: 'proportional-elastic-signed-von-mises-absolute-largest-principal/1', curve, histories, ...overrides });
  const tiny = Number.MIN_VALUE;
  const cases: readonly (readonly [string, unknown, boolean])[] = [
    ['a uniaxial reference', problem(), true],
    ['a component of exactly 1e4 MPa', problem([history({ reference: reference(1e4), loadFactors: [1] })]), true],
    ['a component of 10000.000001 MPa', problem([history({ reference: reference(10000.000001), loadFactors: [1] })]), false],
    ['a non-finite component', problem([history({ reference: reference(Number.POSITIVE_INFINITY) })]), false],
    ['a zero reference', problem([history({ reference: reference(0) })]), false],
    ['a hydrostatic reference', problem([history({ reference: reference(50, 50, 50) })]), false],
    ['a deviator below the hydrostatic tolerance', problem([history({ reference: reference(1e-300, 1e-300, 1e-300, 0, 0, tiny) })]), false],
    ['the smallest uniaxial reference', problem([history({ reference: reference(tiny), loadFactors: [-1, 1] })]), true],
    ['the smallest pure shear reference', problem([history({ reference: reference(0, 0, 0, 0, 0, tiny), loadFactors: [1] })]), true],
    // Scaled by the largest component first, so squares that would underflow or overflow unscaled are representable.
    ['a reference whose square underflows unscaled', problem([history({ reference: reference(1e-200), loadFactors: [1] })]), true],
    ['a shear lost beside a large normal', problem([history({ reference: reference(1e4, 0, 0, 0, 0, 1e-200), loadFactors: [1] })]), true],
    ['0.5 x MIN_VALUE, rounded to zero', problem([history({ reference: reference(0.5), loadFactors: [0, tiny] })]), false],
    ['1 x MIN_VALUE, kept', problem([history({ reference: reference(1), loadFactors: [0, tiny] })]), true],
    ['a tiny nonzero product', problem([history({ reference: reference(1e4), loadFactors: [1e-300] })]), true],
    ['factor x equivalent of exactly 1e4 MPa', problem([history({ loadFactors: [0, 100] })]), true],
    ['factor x equivalent of 10100 MPa', problem([history({ loadFactors: [0, 101] })]), false],
    ['an infinite product of finite values', problem([history({ loadFactors: [0, -Number.MAX_VALUE] })]), false],
    ['no factor', problem([history({ loadFactors: [] })]), false],
    ['100000 factors', problem([history({ loadFactors: new Array<number>(100_000).fill(0.5) })]), true],
    ['100001 factors', problem([history({ loadFactors: new Array<number>(100_001).fill(0.5) })]), false],
    ['repeats 2 on a once record', problem([history({ repeats: 2 })]), false],
    ['1e9 periodic repeats', problem([history({ sequence: 'repeated-periodic', repeats: 1e9 })]), true],
    ['1e9 + 1 periodic repeats', problem([history({ sequence: 'repeated-periodic', repeats: 1e9 + 1 })]), false],
    ['fractional repeats', problem([history({ sequence: 'repeated-periodic', repeats: 1.5 })]), false],
    ['a slope of 0.999', problem([history()], { curve: { ...curve, slope: 0.999 } }), false],
    ['a slope of 20', problem([history()], { curve: { ...curve, slope: 20 } }), true],
    ['a history id of 64 characters', problem([history({ id: 'x'.repeat(64) })]), true],
    ['a history id of 65 characters', problem([history({ id: 'x'.repeat(65) })]), false],
    ['duplicate history ids', problem([history(), history()]), false],
    ['64 histories', problem(Array.from({ length: 64 }, (_, index) => history({ id: `h${index}` }))), true],
    ['65 histories', problem(Array.from({ length: 65 }, (_, index) => history({ id: `h${index}` }))), false],
    ['a Goodman correction field', problem([history()], { correction: {} }), false],
    ['an extra history field', problem([history({ result: 0 })]), false],
    ['another method', problem([history()], { method: 'critical-plane' }), false],
  ];
  it.each(cases)('%s', (_label, value, expected) => {
    let model = true;
    try { readFatigueTensorSavedProblem(value, 'input'); } catch { model = false; }
    expect(model).toBe(expected);
    expect(validateProportionalTensorFatigueInput(value).ok).toBe(expected);
  });
});
