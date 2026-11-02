import { describe, expect, it } from 'vitest';
import { readFatigueDetailSavedInput, readFatigueDetailSavedProblem } from './fatigueDetailInput.js';
import { InputIssue } from './analysisValidation.js';

// Initial contract 4434d0df…66f2fb0 plus Root root-answer.json geometry/coefficient/compression decision: L16–20 exact input fields; L28–34 geometry/limits;
// L44–52 force meanings, identity, stress definition and history; L56–57 sourced curve;
// L84 schema6/input-only persistence. Synthetic calibration, not a material/code default.
const source = { kind: 'user-supplied', reference: 'synthetic calibration', condition: 'unit test only' };
function fixture() {
  const geometry: Record<string, unknown> = { kind: 'fillet-throat-area', throatMm: 4, effectiveLengthMm: 10, lines: 2 };
  return { schema: 'pointercad-fatigue-saved/6', id: 'fatigue', source: { documentId: 'doc' }, input: {
    schema: 'pointercad-fatigue-detail/1', detail: { id: 'joint', kind: 'weld', method: 'fillet-weld-nominal-shear/1',
      loadPath: 'concentric-in-plane-shear', geometry },
    loading: { detailId: 'joint', location: 'joint centroid', quantity: 'weld-group-concentric-shear-force', histories: [
      { id: 'h1', unit: 'N', forceN: [100, -100, 0], sequence: 'once', repeats: 1, source: { ...source } }] },
    curve: { detailStress: 'weld-fillet-throat-nominal-shear', calibration: { id: 'curve', unit: 'MPa',
      stressDefinition: 'range', meanStressAssumption: 'mean-independent',
      segments: [{ fromStressMpa: 400, fromCycles: 1e5, slope: 3 }, { fromStressMpa: 200, fromCycles: 8e5, slope: 5 }],
      endCycles: 1e8, end: 'none', applicability: { material: 'synthetic', detail: 'synthetic', scope: 'test' }, source: { ...source } } },
  } };
}
function bolt(threaded = true) {
  const f = fixture();
  return { ...f, input: { ...f.input, detail: { id: 'joint', kind: 'bolt', method: 'bolt-axial-nominal/1', geometry: threaded
    ? { kind: 'iso-metric-thread-tensile-stress-area', nominalDiameterMm: 10, pitchMm: 1.5 }
    : { kind: 'nominal-shank-area', nominalDiameterMm: 10 } },
  loading: { ...f.input.loading, quantity: 'bolt-total-axial-force', histories: [{ ...f.input.loading.histories[0], forceN: [100, 0, 200] }] },
  curve: { ...f.input.curve, detailStress: threaded ? 'bolt-axial-normal-tensile-stress-area' : 'bolt-axial-normal-nominal-shank-area' } } };
}
function refusal(value: unknown): InputIssue {
  try { readFatigueDetailSavedInput(value); } catch (error) {
    if (error instanceof InputIssue) return error;
    throw error;
  }
  throw new Error('Expected refusal');
}

describe('saved detail fatigue schema6 strict input', () => {
  it.each(['force', 'stress'])('refuses zero derived area in %s branch without inventing a dimension minimum', quantity => {
    for (const kind of ['fillet-throat-area', 'fillet-leg-area']) {
      const f = fixture();
      const throat = kind === 'fillet-throat-area';
      f.input.detail.geometry = { kind, [throat ? 'throatMm' : 'legMm']: 1e-200, effectiveLengthMm: 1e-200, lines: 1 };
      f.input.curve.detailStress = throat ? 'weld-fillet-throat-nominal-shear' : 'weld-fillet-leg-nominal-shear';
      const loading = quantity === 'force' ? { ...f.input.loading, histories: [{ ...f.input.loading.histories[0], forceN: [0, 0] }] }
        : { detailId: 'joint', location: 'centroid', quantity: 'detail-stress', stress: f.input.curve.detailStress,
          histories: [{ id: 'h', unit: 'MPa', stressMpa: [0, 80], sequence: 'once', repeats: 1, source }] };
      expect(refusal({ ...f, input: { ...f.input, loading } }).path).toBe('definition.input.detail.geometry');
      // A subnormal but positive area is supported; there is no made-up lower dimension bound.
      f.input.detail.geometry = { ...f.input.detail.geometry, [throat ? 'throatMm' : 'legMm']: 1e-160, effectiveLengthMm: 1e-160 };
      const positive = { ...f, input: { ...f.input, loading } };
      expect(readFatigueDetailSavedInput(positive)).toEqual(positive);
    }
  });
  it.each([false, true])('round trips weld area variant leg=%s without derived data (contract L28–29,84)', leg => {
    const value = fixture();
    if (leg) {
      value.input.detail.geometry.kind = 'fillet-leg-area';
      Reflect.deleteProperty(value.input.detail.geometry, 'throatMm'); value.input.detail.geometry.legMm = 4;
      value.input.curve.detailStress = 'weld-fillet-leg-nominal-shear';
    }
    const read = readFatigueDetailSavedInput(value);
    expect(read).toEqual(value);
    expect(readFatigueDetailSavedInput(JSON.parse(JSON.stringify(read)))).toEqual(value);
    expect(readFatigueDetailSavedProblem(value.input)).toEqual(value.input);
    expect(Object.keys(read.input)).toEqual(['schema', 'detail', 'curve', 'loading']);
    expect(read.input.loading.histories[0]).not.toHaveProperty('stressMpa');
  });
  it.each([false, true])('round trips bolt area threaded=%s and total axial zero (contract L30–31,45)', threaded => {
    const value = bolt(threaded);
    expect(readFatigueDetailSavedInput(value)).toEqual(value);
    expect(readFatigueDetailSavedInput(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });
  it.each(['weld', 'bolt'])('accepts explicit matching %s stress (contract L47,49)', kind => {
    const f = kind === 'weld' ? fixture() : bolt();
    const value = { ...f, input: { ...f.input, loading: { detailId: 'joint', location: 'section', quantity: 'detail-stress',
      stress: f.input.curve.detailStress, histories: [{ id: 'h', unit: 'MPa', stressMpa: [0, 100], sequence: 'once', repeats: 1, source }] } } };
    expect(readFatigueDetailSavedInput(value)).toEqual(value);
    expect(refusal({ ...value, input: { ...value.input, loading: { ...value.input.loading, stress: 'weld-fillet-leg-nominal-shear' } } }).path).toBe('definition.input.loading.stress');
  });
  it('owns all nested input and returned values independently (contract §5)', () => {
    const value = fixture(); const expected = structuredClone(value);
    const read = readFatigueDetailSavedInput(value);
    value.input.loading.histories[0].forceN[0] = 999;
    value.input.curve.calibration.segments[0].slope = 9;
    value.source.documentId = 'other'; value.input.loading.histories[0].source.reference = 'changed';
    expect(read).toEqual(expected);
    const other = readFatigueDetailSavedInput(expected);
    expect(other.input.curve).not.toBe(read.input.curve);
    expect(other.input.loading.histories).not.toBe(read.input.loading.histories);
  });
  it.each([
    ['schema', (f: ReturnType<typeof fixture>) => { f.schema = 'pointercad-fatigue-saved/5'; }],
    ['input.schema', (f: ReturnType<typeof fixture>) => { f.input.schema = 'pointercad-fatigue-detail/2'; }],
    ['id', (f: ReturnType<typeof fixture>) => { f.id = 'another'; }],
    ['source.documentId', (f: ReturnType<typeof fixture>) => { f.source.documentId = ''; }],
    ['detail.kind', (f: ReturnType<typeof fixture>) => { f.input.detail.kind = 'unknown'; }],
    ['detail.method', (f: ReturnType<typeof fixture>) => { f.input.detail.method = 'bolt-axial-nominal/1'; }],
    ['detail.id', (f: ReturnType<typeof fixture>) => { f.input.detail.id = ''; }],
    ['detail.loadPath', (f: ReturnType<typeof fixture>) => { f.input.detail.loadPath = 'eccentric'; }],
    ['geometry.kind', (f: ReturnType<typeof fixture>) => { f.input.detail.geometry.kind = 'unequal-leg'; }],
    ['geometry.throatMm=0', (f: ReturnType<typeof fixture>) => { f.input.detail.geometry.throatMm = 0; }],
    ['geometry.throatMm>100', (f: ReturnType<typeof fixture>) => { f.input.detail.geometry.throatMm = 101; }],
    ['geometry.length=0', (f: ReturnType<typeof fixture>) => { f.input.detail.geometry.effectiveLengthMm = 0; }],
    ['geometry.length>10000', (f: ReturnType<typeof fixture>) => { f.input.detail.geometry.effectiveLengthMm = 10001; }],
    ['geometry.lines=0', (f: ReturnType<typeof fixture>) => { f.input.detail.geometry.lines = 0; }],
    ['geometry.lines=65', (f: ReturnType<typeof fixture>) => { f.input.detail.geometry.lines = 65; }],
    ['geometry.lines fractional', (f: ReturnType<typeof fixture>) => { f.input.detail.geometry.lines = 1.5; }],
    ['loading.binding', (f: ReturnType<typeof fixture>) => { f.input.loading.detailId = 'other'; }],
    ['loading.location', (f: ReturnType<typeof fixture>) => { f.input.loading.location = ''; }],
    ['loading.quantity', (f: ReturnType<typeof fixture>) => { f.input.loading.quantity = 'bolt-total-axial-force'; }],
    ['curve.stress', (f: ReturnType<typeof fixture>) => { f.input.curve.detailStress = 'weld-fillet-leg-nominal-shear'; }],
    ['histories empty', (f: ReturnType<typeof fixture>) => { f.input.loading.histories = []; }],
    ['force empty', (f: ReturnType<typeof fixture>) => { f.input.loading.histories[0].forceN = []; }],
    ['force unit', (f: ReturnType<typeof fixture>) => { f.input.loading.histories[0].unit = 'kN'; }],
    ['force bound', (f: ReturnType<typeof fixture>) => { f.input.loading.histories[0].forceN = [1e9 + 1]; }],
    ['sequence', (f: ReturnType<typeof fixture>) => { f.input.loading.histories[0].sequence = 'unordered'; }],
    ['once repeats', (f: ReturnType<typeof fixture>) => { f.input.loading.histories[0].repeats = 2; }],
    ['source', (f: ReturnType<typeof fixture>) => { f.input.loading.histories[0].source.reference = ''; }],
    ['curve calibration', (f: ReturnType<typeof fixture>) => { f.input.curve.calibration.segments[1].fromStressMpa = 210; }],
  ])('refuses %s (contract §§2.1–2.3,6)', (_name, mutate) => {
    const f = fixture(); mutate(f); expect(() => readFatigueDetailSavedInput(f)).toThrow(InputIssue);
  });
  it.each([NaN, Infinity, -Infinity])('refuses nonfinite %s at every numeric leaf', number => {
    const f = fixture();
    const paths: readonly (readonly string[])[] = [['detail', 'geometry', 'throatMm'], ['detail', 'geometry', 'effectiveLengthMm'],
      ['detail', 'geometry', 'lines'], ['loading', 'histories', '0', 'forceN', '0'], ['loading', 'histories', '0', 'repeats'],
      ['curve', 'calibration', 'segments', '0', 'fromStressMpa'], ['curve', 'calibration', 'segments', '0', 'fromCycles'],
      ['curve', 'calibration', 'segments', '0', 'slope'], ['curve', 'calibration', 'endCycles']];
    for (const keys of paths) {
      const value = structuredClone(f); let node: unknown = value.input;
      for (const key of keys.slice(0, -1)) {
        if (node === null || typeof node !== 'object') throw new Error('fixture object');
        node = Reflect.get(node, key);
      }
      if (node === null || typeof node !== 'object') throw new Error('fixture object');
      Reflect.set(node, keys[keys.length - 1], number);
      expect(() => readFatigueDetailSavedInput(value)).toThrow(InputIssue);
    }
  });
  it('rejects every missing/extra field and accessor without invoking it (contract exact §2)', () => {
    let calls = 0;
    const walk = (value: object, visit: (record: object, key: string) => void): void => {
      for (const key of Object.keys(value)) {
        visit(value, key);
        const child: unknown = Reflect.get(value, key);
        if (child !== null && typeof child === 'object') walk(child, visit);
      }
    };
    const f = fixture();
    walk(f, (record, key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined) throw new Error('fixture key');
      Reflect.deleteProperty(record, key); expect(() => readFatigueDetailSavedInput(f)).toThrow(InputIssue);
      Object.defineProperty(record, key, descriptor);
    });
    // Separate traversal for getters; descriptor restoration uses only the original data descriptor.
    walk(f, (record, key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined) throw new Error('fixture key');
      Object.defineProperty(record, key, { configurable: true, enumerable: true, get: () => { calls += 1; throw new Error('must not run'); } });
      expect(() => readFatigueDetailSavedInput(f)).toThrow(InputIssue); Object.defineProperty(record, key, descriptor);
      Object.defineProperty(record, 'derived', { configurable: true, enumerable: true, value: 1 });
      expect(() => readFatigueDetailSavedInput(f)).toThrow(InputIssue); Reflect.deleteProperty(record, 'derived');
    });
    expect(calls).toBe(0);
  });
  it.each([false, true])('rejects external joint force and bolt compression, threaded=%s (L45–46)', threaded => {
    const f = bolt(threaded); f.input.loading.quantity = 'joint-external-axial-force';
    expect(refusal(f).path).toBe('definition.input.loading.quantity');
    f.input.loading.quantity = 'bolt-total-axial-force'; f.input.loading.histories[0].forceN = [-1];
    expect(refusal(f).path).toBe('definition.input.loading.histories[0].forceN[0]');
  });
  it.each([0.99, 201])('rejects bolt diameter %s (L34)', diameter => {
    const f = bolt(); f.input.detail.geometry.nominalDiameterMm = diameter; expect(() => readFatigueDetailSavedInput(f)).toThrow(InputIssue);
  });
  it.each([0, -1, 2.5001])('rejects bolt pitch %s (L34)', pitchMm => {
    const f = bolt(); expect(() => readFatigueDetailSavedInput({ ...f, input: { ...f.input,
      detail: { ...f.input.detail, geometry: { kind: 'iso-metric-thread-tensile-stress-area', nominalDiameterMm: 10, pitchMm } } } })).toThrow(InputIssue);
  });
  it('rejects bolt stress compression and the superseded equal-leg representation (Root decision)', () => {
    const f = bolt();
    const loading = { detailId: 'joint', location: 'bolt section', quantity: 'detail-stress',
      stress: 'bolt-axial-normal-tensile-stress-area', histories: [
        { id: 'h', unit: 'MPa', stressMpa: [0, -1], sequence: 'once', repeats: 1, source }] };
    expect(refusal({ ...f, input: { ...f.input, loading } }).path).toBe('definition.input.loading.histories[0].stressMpa[1]');
    const old = fixture(); old.input.detail.geometry = { kind: 'equal-leg-fillet-effective-throat', legMm: 4, effectiveLengthMm: 10, lines: 2 };
    expect(() => readFatigueDetailSavedInput(old)).toThrow(InputIssue);
  });
  it('uses the exact basic-profile coefficient at the converted stress bound (Root decision)', () => {
    const f = bolt(); const exactArea = Math.PI / 4 * (10 - (13 * Math.sqrt(3) / 24) * 1.5) ** 2;
    const roundedArea = Math.PI / 4 * (10 - 0.9382 * 1.5) ** 2;
    // Between the two areas: exact profile stress is below 1e4 MPa, rounded coefficient would reject it.
    f.input.loading.histories[0].forceN = [(exactArea + roundedArea) * 0.5 * 1e4];
    expect(readFatigueDetailSavedInput(f)).toEqual(f);
  });
  it('checks converted stress ceiling from each independent area, without saving it (L51)', () => {
    // A_throat=2*4*10, A_leg=80, A_thread=pi/4*(10-(13*sqrt(3)/24)*1.5)^2, A_shank=25*pi.
    const weld = fixture(); const leg = fixture(); leg.input.detail.geometry.kind = 'fillet-leg-area';
    Reflect.deleteProperty(leg.input.detail.geometry, 'throatMm'); leg.input.detail.geometry.legMm = 4;
    leg.input.curve.detailStress = 'weld-fillet-leg-nominal-shear';
    const pairs = [[weld, 80], [leg, 80], [bolt(), Math.PI / 4 * (10 - (13 * Math.sqrt(3) / 24) * 1.5) ** 2], [bolt(false), 25 * Math.PI]] as const;
    for (const [f, area] of pairs) {
      f.input.loading.histories[0].forceN = [area * 9999]; expect(readFatigueDetailSavedInput(f)).toEqual(f);
      f.input.loading.histories[0].forceN = [area * 10001]; expect(refusal(f).path).toBe('definition.input.loading.histories[0].forceN[0]');
    }
  });
  it('keeps repeated ordering and rejects duplicate histories, holes and hidden fields', () => {
    const f = fixture(); f.input.loading.histories[0].sequence = 'repeated-periodic'; f.input.loading.histories[0].repeats = 1e9;
    expect(readFatigueDetailSavedInput(f)).toEqual(f);
    f.input.loading.histories.push(structuredClone(f.input.loading.histories[0])); expect(refusal(f).path).toBe('definition.input.loading.histories[1].id');
    const hole = fixture(); Reflect.deleteProperty(hole.input.loading.histories[0].forceN, '1'); expect(() => readFatigueDetailSavedInput(hole)).toThrow(InputIssue);
    const hidden = fixture(); Object.defineProperty(hidden.input, 'damage', { value: 0 }); expect(() => readFatigueDetailSavedInput(hidden)).toThrow(InputIssue);
    const symbol = fixture(); Object.defineProperty(symbol.input, Symbol('life'), { value: 1 }); expect(() => readFatigueDetailSavedInput(symbol)).toThrow(InputIssue);
  });
  it('accepts exact supported weld and force maxima and rejects counts beyond the contract', () => {
    const f = fixture(); f.input.detail.geometry = { ...f.input.detail.geometry, throatMm: 100, effectiveLengthMm: 10000, lines: 64 };
    f.input.loading.histories[0].forceN = [1e9, -1e9]; expect(readFatigueDetailSavedInput(f)).toEqual(f);
    f.input.loading.histories = Array.from({ length: 64 }, (_, i) => ({ ...f.input.loading.histories[0], id: `h${i}` }));
    expect(readFatigueDetailSavedInput(f)).toEqual(f);
    f.input.loading.histories.push({ ...f.input.loading.histories[0], id: 'last' });
    expect(() => readFatigueDetailSavedInput(f)).toThrow(InputIssue);
    const points = fixture(); points.input.loading.histories[0].forceN = Array.from({ length: 100000 }, () => 0);
    expect(readFatigueDetailSavedInput(points)).toEqual(points);
    points.input.loading.histories[0].forceN.push(0); expect(() => readFatigueDetailSavedInput(points)).toThrow(InputIssue);
  });
  it.each([1, 200])('accepts diameter %s and the exact pitch fraction boundary (L34)', nominalDiameterMm => {
    const f = bolt(); const value = { ...f, input: { ...f.input, detail: { ...f.input.detail,
      geometry: { kind: 'iso-metric-thread-tensile-stress-area', nominalDiameterMm, pitchMm: nominalDiameterMm / 4 } } } };
    expect(readFatigueDetailSavedInput(value)).toEqual(value);
  });
  it('rejects cyclic, inherited, nested and derived input data instead of evaluating it', () => {
    const cyclic = fixture(); Object.defineProperty(cyclic.input, 'cycle', { value: cyclic.input, enumerable: true });
    expect(() => readFatigueDetailSavedInput(cyclic)).toThrow(InputIssue);
    const inherited = fixture(); Object.setPrototypeOf(inherited.input.detail, { material: 'hidden' });
    expect(() => readFatigueDetailSavedInput(inherited)).toThrow(InputIssue);
    for (const field of ['areaMm2', 'stressHistories', 'damage', 'life']) {
      const f = fixture(); Object.defineProperty(f.input, field, { value: 1, enumerable: true });
      expect(() => readFatigueDetailSavedInput(f)).toThrow(InputIssue);
    }
  });
});
