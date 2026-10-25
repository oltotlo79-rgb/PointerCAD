import { analyzeFatigue, analyzeFatigueWithMeanStressCorrection, validateFatigueInput,
  validateFatigueMeanStressCorrection, type FatigueInput } from '@pointercad/fem';
import type { Parameter } from '@pointercad/model';
import { FATIGUE_SAVED_GOODMAN_SCHEMA, readFatigueSavedInput, readFatigueSavedProblem } from '@pointercad/model/beam-analysis';
import { describe, expect, it } from 'vitest';
import { BASE_DAMAGE, BASE_EDITS, BASE_LIFE, edited, relative } from './fatigue.testSupport.js';
import { createFatigueSession, currentFatigueResult, editFatigueSession, fatigueCorrection, fatigueDraftIsSaved,
  fatigueErrorField, fatigueInput, fatigueSavedInput, parseStressList, restoreFatigueSession,
  type FatigueEdit, type FatigueSession } from './fatigueSession.js';

/** Contract tolerance of the core tests, fixed before execution (floating sums of exact powers). */
const TOLERANCE = 1e-12;

function input(session: FatigueSession, parameters: readonly Parameter[] = []): FatigueInput {
  const checked = fatigueInput(session, parameters);
  if (!checked.ok) throw new Error(`Draft refused: ${checked.key} ${checked.field ?? ''} ${checked.diagnostic ?? ''}`);
  return checked.input;
}
function run(session: FatigueSession, parameters: readonly Parameter[] = []): FatigueSession {
  const built = input(session, parameters);
  const analysis = analyzeFatigue(built);
  if (!analysis.ok) throw new Error(`Analysis refused: ${analysis.code} ${analysis.path}`);
  return { ...session, analyzed: { input: built, result: analysis.result } };
}

describe('fatigue stress list', () => {
  it('keeps the order and reads only plain numbers in MPa', () => {
    expect(parseStressList('0, 200\n-200;0')).toEqual({ ok: true, values: [0, 200, -200, 0] });
    expect(parseStressList(' 1e2 , .5 ,, -0 ')).toEqual({ ok: true, values: [100, 0.5, 0] });
    expect(parseStressList('10 MPa')).toEqual({ ok: false, point: 2 });
    expect(parseStressList('1, 2, 0x10')).toEqual({ ok: false, point: 3 });
    expect(parseStressList('Infinity')).toEqual({ ok: false, point: 1 });
    expect(parseStressList('1e400')).toEqual({ ok: false, point: 1 });
    expect(parseStressList(' \n ')).toEqual({ ok: false, point: null });
  });
});

describe('fatigue draft', () => {
  it('starts with nothing assumed: no curve value, convention, cut-off choice, history or source', () => {
    const session = createFatigueSession('fatigue-owner');
    expect(Object.values(session.draft.values)).toEqual(['', '', '', '']);
    expect([session.draft.stressDefinition, session.draft.meanStressAssumption, session.draft.cutoffMode]).toEqual(['', '', '']);
    expect(session.draft.histories).toEqual([{ key: 'history-1', stress: '', sequence: '', repeats: '',
      source: { reference: '', condition: '' }, imported: null }]);
    expect(session.draft.axialImport).toEqual({ memberId: '', sequence: '', repeats: '', reference: '' });
    const checked = fatigueInput(session, []);
    expect(checked.ok ? null : [checked.key, checked.field]).toEqual(['fatigue.error.stressDefinition', 'stressDefinition']);
  });

  it('refuses each missing explicit choice or source at its own field', () => {
    const without = (kind: FatigueEdit['kind'], field?: string): readonly FatigueEdit[] =>
      BASE_EDITS.filter(edit => edit.kind !== kind || ('field' in edit && field !== undefined && edit.field !== field));
    const cases: readonly (readonly [readonly FatigueEdit[], string, string])[] = [
      [without('mean-assumption'), 'fatigue.error.meanAssumption', 'meanStressAssumption'],
      [without('cutoff-mode'), 'fatigue.error.cutoffMode', 'cutoffMode'],
      [without('curve-source', 'condition'), 'fatigue.error.source', 'curve:condition'],
      [without('history-sequence'), 'fatigue.error.sequence', 'history:0:sequence'],
      [without('history-source', 'reference'), 'fatigue.error.source', 'history:0:reference'],
      [[...BASE_EDITS, { kind: 'history-stress', index: 0, source: '0, 2OO, 0' }], 'fatigue.error.stressEntry', 'history:0:stress'],
      [[...BASE_EDITS, { kind: 'value', field: 'slope', source: '25' }], 'fatigue.error.bound', 'slope'],
    ];
    for (const [edits, key, field] of cases) {
      const checked = fatigueInput(edited(edits), []);
      expect(checked.ok ? null : [checked.key, checked.field], `${key} ${field}`).toEqual([key, field]);
    }
  });

  it('builds exactly the hand-written core input (MPa, no conversion, once counted once)', () => {
    expect(input(edited(BASE_EDITS))).toEqual({ schema: 'pointercad-fatigue/1', curve: { id: 'curve', unit: 'MPa',
      stressDefinition: 'range', meanStressAssumption: 'mean-independent', referenceStressMpa: 100, referenceCycles: 2000000,
      slope: 3, cutoffStressMpa: null, source: { kind: 'user-supplied', reference: 'Test constants only, not a material or code curve',
        condition: 'unit test' } },
    histories: [{ id: 'history-1', unit: 'MPa', stressMpa: [0, 200, 0], sequence: 'once', repeats: 1,
      source: { kind: 'user-supplied', reference: 'hand-written test history', condition: 'unit test' } }] });
  });

  it('every input edit discards the result; focus does not; a refused edit changes nothing', () => {
    const analyzed = run(edited(BASE_EDITS));
    expect(currentFatigueResult(analyzed, [])).not.toBeNull();
    expect(editFatigueSession(analyzed, { kind: 'focus', field: 'slope' }).analyzed).not.toBeNull();
    const changed = editFatigueSession(analyzed, { kind: 'value', field: 'slope', source: '3' });
    expect(changed.analyzed).toBeNull();
    expect(changed.revision).toBe(analyzed.revision + 1);
    expect(editFatigueSession(analyzed, { kind: 'history-remove', index: 0 })).toBe(analyzed);
    expect(editFatigueSession(analyzed, { kind: 'history-stress', index: 5, source: '1' })).toBe(analyzed);
  });

  it('a parameter change that alters the curve hides the old result; an unrelated one keeps it', () => {
    const parameter = (name: string, value: number): Parameter => ({ name, unit: 'none', description: '',
      value: { source: String(value), value, display: String(value) } });
    const session = edited([...BASE_EDITS, { kind: 'value', field: 'referenceStress', source: 'sref' }]);
    const analyzed = run(session, [parameter('sref', 100), parameter('other', 1)]);
    expect(currentFatigueResult(analyzed, [parameter('sref', 100), parameter('other', 2)])).not.toBeNull();
    expect(currentFatigueResult(analyzed, [parameter('sref', 120), parameter('other', 1)])).toBeNull();
  });
});

describe('fatigue results from the actual core', () => {
  it('two half cycles of range 200 against a range curve give D = 4e-6 and 250000 repetitions', () => {
    const result = run(edited(BASE_EDITS)).analyzed?.result;
    expect(result?.histories[0]?.cycles.map(cycle => [cycle.count, cycle.rangeMpa, cycle.meanMpa])).toEqual([[0.5, 200, 100], [0.5, 200, 100]]);
    expect(relative(result?.damage ?? Number.NaN, BASE_DAMAGE)).toBeLessThan(TOLERANCE);
    expect(result?.life.kind).toBe('finite');
    expect(relative(result?.life.kind === 'finite' ? result.life.spectrumRepetitions : Number.NaN, BASE_LIFE)).toBeLessThan(TOLERANCE);
  });

  it('the same curve read as an amplitude curve gives D / 8 (S = range / 2 = 100 MPa)', () => {
    const result = run(edited([...BASE_EDITS, { kind: 'stress-definition', value: 'amplitude' }])).analyzed?.result;
    expect(relative(result?.damage ?? Number.NaN, BASE_DAMAGE / 8)).toBeLessThan(TOLERANCE);
  });

  it('a cut-off above every cycle gives no damaging cycle; a cut-off equal to the cycle stress counts it', () => {
    const cut = (value: string) => run(edited([...BASE_EDITS, { kind: 'cutoff-mode', value: 'value' },
      { kind: 'value', field: 'cutoff', source: value }])).analyzed?.result;
    const above = cut('250');
    expect(above?.damage).toBe(0);
    expect(above?.life).toEqual({ kind: 'no-damaging-cycle' });
    expect(relative(cut('200')?.damage ?? Number.NaN, BASE_DAMAGE)).toBeLessThan(TOLERANCE);
  });

  it('a positive damage below the double range is reported as underflow, never as no damage', () => {
    // (1e-300 / 1e4)^20 = 1e-6080 underflows to 0 although the cycle is damaging (no cut-off).
    const result = run(edited([...BASE_EDITS, { kind: 'value', field: 'referenceStress', source: '10000' },
      { kind: 'value', field: 'referenceCycles', source: '1' }, { kind: 'value', field: 'slope', source: '20' },
      { kind: 'history-stress', index: 0, source: '0, 1e-300, 0' }])).analyzed?.result;
    expect(result?.damage).toBe(0);
    expect(result?.life).toEqual({ kind: 'not-representable', reason: 'damage-underflow' });
  });

  it('a repeated fully reversed history is accepted by a fully-reversed-only curve and multiplied by its repeats', () => {
    // Closed loop 100, -100, 100: two half cycles of range 200 and mean 0 per period (0.5 + 0.5 = one cycle);
    // D = 1000 * (200/100)^3 / 2e6 = 4e-3, life 250.
    const result = run(edited([...BASE_EDITS, { kind: 'mean-assumption', value: 'fully-reversed-only' },
      { kind: 'history-stress', index: 0, source: '100, -100' }, { kind: 'history-sequence', index: 0, value: 'repeated-periodic' },
      { kind: 'history-repeats', index: 0, source: '1000' }])).analyzed?.result;
    expect(relative(result?.damage ?? Number.NaN, 4e-3)).toBeLessThan(TOLERANCE);
    expect(relative(result?.life.kind === 'finite' ? result.life.spectrumRepetitions : Number.NaN, 250)).toBeLessThan(TOLERANCE);
  });

  it('a nonzero-mean cycle under a fully-reversed-only curve is refused at its history', () => {
    const analysis = analyzeFatigue(input(edited([...BASE_EDITS, { kind: 'mean-assumption', value: 'fully-reversed-only' }])));
    expect(analysis.ok ? null : analysis.code).toBe('fatigue-mean');
    expect(analysis.ok ? null : fatigueErrorField(analysis.path).field).toBe('history:0:stress');
  });

  it('maps core refusal paths to panel fields and 1-based stress positions', () => {
    expect(fatigueErrorField('curve.cutoffStressMpa')).toEqual({ field: 'cutoff', point: null });
    expect(fatigueErrorField('histories[2].stressMpa[9]')).toEqual({ field: 'history:2:stress', point: 10 });
    expect(fatigueErrorField('histories[1].repeats')).toEqual({ field: 'history:1:repeats', point: null });
    expect(fatigueErrorField('histories')).toEqual({ field: null, point: null });
  });
});

describe('saved fatigue reader agrees with the core reader', () => {
  it('accepts and refuses the same inputs at every bound (the model cannot import the core)', () => {
    const base = input(edited(BASE_EDITS));
    const curveCase = (change: object): unknown => ({ ...base, curve: { ...base.curve, ...change } });
    const historyCase = (change: object): unknown => ({ ...base, histories: [{ ...base.histories[0], ...change }] });
    const holes = new Array<number>(2);
    holes[1] = 1;
    const cases: readonly unknown[] = [base,
      curveCase({ slope: 1 }), curveCase({ slope: 20 }), curveCase({ slope: 0.999 }), curveCase({ slope: 20.000001 }),
      curveCase({ referenceStressMpa: 1 }), curveCase({ referenceStressMpa: 1e4 }), curveCase({ referenceStressMpa: 0.5 }),
      curveCase({ referenceCycles: 1e12 }), curveCase({ referenceCycles: 1e12 + 1 }), curveCase({ cutoffStressMpa: 0 }),
      curveCase({ cutoffStressMpa: 2e4 }), curveCase({ cutoffStressMpa: 20000.001 }), curveCase({ cutoffStressMpa: Number.NaN }),
      curveCase({ stressDefinition: 'peak' }), curveCase({ meanStressAssumption: 'goodman' }), curveCase({ unit: 'Pa' }),
      curveCase({ id: 'x'.repeat(65) }), curveCase({ source: { kind: 'user-supplied', reference: ' ', condition: 'c' } }),
      curveCase({ source: { kind: 'standard', reference: 'r', condition: 'c' } }), curveCase({ extra: 1 }),
      historyCase({ stressMpa: [1e4, -1e4] }), historyCase({ stressMpa: [10000.000001] }), historyCase({ stressMpa: [] }),
      historyCase({ stressMpa: holes }), historyCase({ repeats: 2 }), historyCase({ sequence: 'repeated-periodic', repeats: 1e9 }),
      historyCase({ sequence: 'repeated-periodic', repeats: 1e9 + 1 }), historyCase({ sequence: 'repeated-periodic', repeats: 1.5 }),
      historyCase({ sequence: 'random' }), historyCase({ unit: 'ksi' }),
      { ...base, histories: [base.histories[0], base.histories[0]] }, { ...base, histories: [] },
      { ...base, histories: Array.from({ length: 65 }, (_, index) => ({ ...base.histories[0], id: `h${index}` })) },
      { ...base, schema: 'pointercad-fatigue/2' }, { ...base, extra: true },
    ];
    for (const [index, value] of cases.entries()) {
      let model = true;
      try { readFatigueSavedProblem(value, 'input'); } catch { model = false; }
      expect(model, `case ${index}`).toBe(validateFatigueInput(value).ok);
    }
  });
});

const GOODMAN_EDITS: readonly FatigueEdit[] = [...BASE_EDITS,
  { kind: 'stress-definition', value: 'amplitude' }, { kind: 'mean-assumption', value: 'fully-reversed-only' },
  { kind: 'value', field: 'referenceCycles', source: '1000000' }, { kind: 'value', field: 'slope', source: '2' },
  { kind: 'history-stress', index: 0, source: '150, 250' },
  { kind: 'history-sequence', index: 0, value: 'repeated-periodic' }, { kind: 'history-repeats', index: 0, source: '1' },
  { kind: 'correction-mode', value: 'goodman' }, { kind: 'correction-applicability', value: true },
  { kind: 'correction-value', field: 'ultimateTensileStrengthMpa', source: '400 MPa' },
  { kind: 'correction-value', field: 'yieldStrengthMpa', source: '0.3 GPa' },
  { kind: 'correction-value', field: 'minimumCycles', source: '1001' },
  { kind: 'correction-source', field: 'reference', source: 'synthetic strengths only' },
  { kind: 'correction-source', field: 'condition', source: 'elastic, symmetric yield; minimum life 1001' },
];
function correctedRun(session: FatigueSession, parameters: readonly Parameter[] = []): FatigueSession {
  const built = input(session, parameters), correction = fatigueCorrection(session, parameters);
  if (!correction.ok || correction.correction === null) throw new Error('Expected explicit correction');
  const analyzed = analyzeFatigueWithMeanStressCorrection(built, correction.correction);
  if (!analyzed.ok) throw new Error(`Correction refused: ${analyzed.code}`);
  return { ...session, analyzed: { input: built, result: analyzed.result, correction: correction.correction } };
}

describe('explicit Goodman session and saved identity', () => {
  it('defaults to legacy calculation without strengths and requires a separate applicability statement after opting in', () => {
    const legacy = edited(BASE_EDITS);
    expect(legacy.draft.correction).toEqual({ mode: 'none', elasticSymmetricYield: false,
      values: { ultimateTensileStrengthMpa: '', yieldStrengthMpa: '', minimumCycles: '' }, source: { reference: '', condition: '' } });
    expect(fatigueCorrection(legacy, [])).toEqual({ ok: true, correction: null });
    const opted = editFatigueSession(legacy, { kind: 'correction-mode', value: 'goodman' });
    expect(fatigueCorrection(opted, [])).toEqual({ ok: false, key: 'fatigue.error.correctionApplicability',
      field: 'correction:applicability', diagnostic: null });
  });

  it('the real core gives 1e-6 damage and one million repetitions for mean 200 and amplitude 50, with original means retained', () => {
    const session = correctedRun(edited(GOODMAN_EDITS)), result = currentFatigueResult(session, []);
    if (result === null || !('correction' in result)) throw new Error('Expected corrected result');
    expect(relative(result.damage, 1e-6)).toBeLessThan(TOLERANCE);
    expect(result.life.kind).toBe('finite');
    expect(relative(result.life.kind === 'finite' ? result.life.spectrumRepetitions : NaN, 1e6)).toBeLessThan(TOLERANCE);
    expect(result.histories[0]?.cycles.map(cycle => [cycle.count, cycle.meanMpa, cycle.rangeMpa]))
      .toEqual([[0.5, 200, 100], [0.5, 200, 100]]);
    expect(result.histories[0]?.equivalentStressMpa).toEqual([100, 100]);
    expect(result.correction.source.reference).toBe('synthetic strengths only');
  });

  const changed: readonly FatigueEdit[] = [
    { kind: 'correction-mode', value: 'none' }, { kind: 'correction-applicability', value: false },
    { kind: 'correction-value', field: 'ultimateTensileStrengthMpa', source: '500' },
    { kind: 'correction-value', field: 'yieldStrengthMpa', source: '290' },
    { kind: 'correction-value', field: 'minimumCycles', source: '2000' },
    { kind: 'correction-source', field: 'reference', source: 'changed' },
    { kind: 'correction-source', field: 'condition', source: 'changed' },
  ];
  it.each(changed)('invalidates the result and saved identity for $kind $field', edit => {
    const session = correctedRun(edited(GOODMAN_EDITS));
    const saved = fatigueSavedInput(session, [], session.ownerId);
    if (!saved.ok) throw new Error('Expected saved input');
    const next = editFatigueSession(session, edit);
    expect(next.analyzed).toBeNull();
    expect(next.revision).toBe(session.revision + 1);
    expect(currentFatigueResult(next, [])).toBeNull();
    expect(fatigueDraftIsSaved(next, [], saved.saved)).toBe(false);
    // Even a retained stale result cannot bypass the independently rebuilt correction identity.
    expect(currentFatigueResult({ ...next, analyzed: session.analyzed }, [])).toBeNull();
  });

  it('a changed strength parameter hides results while an unrelated parameter and focus keep them', () => {
    const parameter = (name: string, value: number): Parameter => ({ name, unit: 'none', description: '',
      value: { source: String(value), value, display: String(value) } });
    const draft = edited([...GOODMAN_EDITS, { kind: 'correction-value', field: 'ultimateTensileStrengthMpa', source: 'uts' }]);
    const session = correctedRun(draft, [parameter('uts', 400), parameter('other', 1)]);
    expect(currentFatigueResult(editFatigueSession(session, { kind: 'focus', field: null }),
      [parameter('uts', 400), parameter('other', 2)])).not.toBeNull();
    expect(currentFatigueResult(session, [parameter('uts', 500), parameter('other', 1)])).toBeNull();
  });

  it('restores v3 inputs exactly without a result, and leaves old v2 uncorrected', () => {
    const session = correctedRun(edited(GOODMAN_EDITS)), checked = fatigueSavedInput(session, [], session.ownerId);
    if (!checked.ok || checked.saved.schema !== FATIGUE_SAVED_GOODMAN_SCHEMA) throw new Error('Expected v3');
    const read = readFatigueSavedInput(checked.saved, 'fatigue'), restored = restoreFatigueSession(session.ownerId, read);
    expect(restored.analyzed).toBeNull();
    expect(fatigueDraftIsSaved(restored, [], read)).toBe(true);
    expect(fatigueSavedInput(restored, [], session.ownerId)).toEqual(checked);
    const legacy = fatigueSavedInput(edited(BASE_EDITS), [], session.ownerId);
    if (!legacy.ok) throw new Error('Expected legacy input');
    expect(legacy.saved.schema).toBe('pointercad-fatigue-saved/2');
    expect(restoreFatigueSession(session.ownerId, legacy.saved).draft.correction.mode).toBe('none');
  });

  it('rejects incompatible curves and compares model/core correction bounds without manufacturing defaults', () => {
    const incompatible = fatigueCorrection(edited([...GOODMAN_EDITS, { kind: 'mean-assumption', value: 'mean-independent' }]), []);
    expect(incompatible).toEqual({ ok: false, key: 'fatigue.error.correctionCurve', field: 'meanStressAssumption', diagnostic: null });
    const saved = fatigueSavedInput(edited(GOODMAN_EDITS), [], 'fatigue-owner');
    if (!saved.ok || saved.saved.schema !== FATIGUE_SAVED_GOODMAN_SCHEMA) throw new Error('Expected v3');
    for (const change of [{ yieldStrengthMpa: 0 }, { yieldStrengthMpa: 401 }, { ultimateTensileStrengthMpa: Infinity },
      { minimumCycles: 1000 }, { minimumCycles: 1e12 }, { minimumCycles: 1e12 + 1 },
      { source: { kind: 'user-supplied', reference: '', condition: 'test' } }, { unit: 'Pa' }, { extra: true }]) {
      const correction = { ...saved.saved.correction, ...change };
      let model = true;
      try { readFatigueSavedInput({ ...saved.saved, correction }, 'fatigue'); } catch { model = false; }
      expect(model, JSON.stringify(change)).toBe(validateFatigueMeanStressCorrection(correction).ok);
    }
  });
});
