import { createAssemblyDocument, createAssemblyDocumentBundle, STEEL_PRODUCTS } from '@pointercad/model';
import { readDocumentBundle, writeDocumentBundle } from '@pointercad/io';
import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { resetTestStore } from '../store/testing/createTestStore.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { cancelPlaceComponent, commitPlaceComponent } from './placeComponentActions.js';
import { beginSteelBendPlacement, buildSteelBendChoice, DEFAULT_STEEL_BEND_SOURCES } from './steelBendPicker.js';
import { SteelBendFields } from './SteelBendFields.js';
import { recomputePart, type PartDocument } from '@pointercad/model';
import { afterAll, beforeAll, vi } from 'vitest';
import { createNativeKernelBridgeForNodeTests, initializeNativeKernelForNodeTests } from '../../../model/src/testing/createNativeKernelBridge.node.js';
import { buildSteelBendEdit, commitSteelBendEdit, readSteelBendEditInput,
  selectedSteelBendEditTarget, type SteelBendSources } from './steelBendPicker.js';

describe('W05 picker refusal reasons, unmodified input and zero history increments', () => {
  it.each([
    { name: 'nonfinite expression', key: 'SS400:flatBar:FB 50×6', bad: { radius: '10^1000' }, good: { radius: '30' }, reason: 'invalidExpression', offset: 25, width: 50 },
    { name: 'Ri zero', key: 'SGP:steelPipe:15A', bad: { radius: '0' }, good: { radius: '0.000000001' }, reason: 'invalidRadius', offset: 10.85, width: 21.7 },
    { name: 'zero leg', key: 'SS400:flatBar:FB 50×6', bad: { firstLeg: '0' }, good: { firstLeg: '0.000000001' }, reason: 'invalidLength', offset: 25, width: 50 },
    { name: '180 degrees', key: 'SS400:flatBar:FB 50×6', bad: { angleDegrees: '180' }, good: { angleDegrees: '179.999' }, reason: 'invalidAngle', offset: 25, width: 50 },
    { name: 'tight R', key: 'SS400:flatBar:FB 50×6', bad: { radius: String(Math.hypot(50, 6) / 2 - 25) },
      good: { radius: String(Math.hypot(50, 6) / 2 - 25 + 1e-8) }, reason: 'radiusTooTight', offset: 25, width: 50 },
    { name: 'zero tangent after setback', key: 'SS400:flatBar:FB 50×6', bad: { legDimension: 'inside', firstLeg: '30' },
      good: { legDimension: 'inside', firstLeg: '30.00000001' }, reason: 'insufficientLegLength', offset: 25, width: 50 },
  ] as const)('$name reports its i18n reason and accepts the independently computed positive boundary', (test) => {
    const row = product(test.key);
    const sources = { ...DEFAULT_STEEL_BEND_SOURCES, radius: '30', firstLeg: '100', secondLeg: '200', ...test.bad };
    const beforeSources = structuredClone(sources), beforeRow = structuredClone(row), before = useAppStore.getState();
    const persistentBefore = structuredClone({ document: before.assembly, library: before.assemblyLibrary, history: before.assemblyUndoStack });
    const failed = buildSteelBendChoice(row, sources);
    expect(failed).toEqual({ ok: false, reason: test.reason });
    const key = `assembly.steel.bend.${test.reason}` as const;
    expect(t(key)).not.toBe(key);
    expect(t(key).length).toBeGreaterThan(10);
    const markup = renderToStaticMarkup(createElement(SteelBendFields, { sources, result: failed, onChange: () => {} }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(t(key));
    expect(sources).toEqual(beforeSources);
    expect(row).toEqual(beforeRow);
    expect(useAppStore.getState()).toBe(before);
    expect(useAppStore.getState().assemblyUndoStack).toEqual(before.assemblyUndoStack);
    expect(useAppStore.getState().assemblyUndoStack?.past).toEqual(persistentBefore.history?.past);
    expect(useAppStore.getState().assemblyUndoStack?.future).toEqual(persistentBefore.history?.future);
    const after = useAppStore.getState();
    expect({ document: after.assembly, library: after.assemblyLibrary, history: after.assemblyUndoStack }).toEqual(persistentBefore);
    const accepted = { ...sources, ...test.good }, result = buildSteelBendChoice(row, accepted);
    if (!result.ok) throw new Error(result.reason);
    const radius = Number(accepted.radius), theta = Number(accepted.angleDegrees) * Math.PI / 180;
    const setback = accepted.legDimension === 'inside' ? radius : 0;
    const first = Number(accepted.firstLeg) - setback, second = Number(accepted.secondLeg) - setback;
    const rc = radius + test.offset, length = first + second + rc * theta;
    expect(result.geometry.insideRadiusMm).toBe(radius);
    expect(result.geometry.outsideRadiusMm).toBeCloseTo(radius + test.width, 11);
    expect(result.geometry.centrelineLengthMm).toBeCloseTo(length, 11);
    expect(result.geometry.secondTangent[0]).toBeCloseTo(rc * (1 - Math.cos(theta)), 11);
    expect(result.geometry.secondTangent[2]).toBeCloseTo(first + rc * Math.sin(theta), 11);
    expect(result.geometry.end[0]).toBeCloseTo(rc * (1 - Math.cos(theta)) + second * Math.sin(theta), 11);
    expect(result.geometry.end[2]).toBeCloseTo(first + rc * Math.sin(theta) + second * Math.cos(theta), 11);
    expect(Number(result.document.steelStockSource?.options.length)).toBeCloseTo(length, 11);
    expect(useAppStore.getState()).toBe(before);
  });

  it.each(['missing row', 'forged material', 'forged condition'] as const)('%s cannot relabel existing purchased material', (kind) => {
    const row = product('SS400:flatBar:FB 50×6');
    const forged = kind === 'missing row' ? { ...row, key: 'unknown-product' }
      : kind === 'forged material' ? { ...row, materialGrade: 'S45C' as const }
      : { ...row, condition: 'brightBar-heatTreatmentUnspecified' as const };
    const input = { ...DEFAULT_STEEL_BEND_SOURCES }, snapshot = structuredClone({ forged, input });
    const before = useAppStore.getState();
    const failed = buildSteelBendChoice(forged, input);
    expect(failed).toEqual({ ok: false, reason: 'unsupportedSource' });
    expect(t('assembly.steel.bend.unsupportedSource')).toContain('出自');
    const markup = renderToStaticMarkup(createElement(SteelBendFields, { sources: input, result: failed, onChange: () => {} }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(t('assembly.steel.bend.unsupportedSource'));
    expect({ forged, input }).toEqual(snapshot);
    expect(useAppStore.getState()).toBe(before);
    const recovered = buildSteelBendChoice(row, input);
    if (!recovered.ok) throw new Error(recovered.reason);
    expect(recovered.geometry.centrelineLengthMm).toBeCloseTo(400 + 125 * Math.PI / 2, 12);
    expect(recovered.document.steelStockSource?.options.steelProduct).toBe(row.key);
  });
});

function product(key: string) {
  const found = STEEL_PRODUCTS.find((row) => row.key === key);
  if (found === undefined) throw new Error('Missing sourced product');
  return found;
}
beforeEach(() => {
  resetTestStore();
  useAppStore.getState().openAssembly(createAssemblyDocument('Bend placement'));
  useAppStore.getState().openStandardPartPicker();
});

describe('bent picker passes an editable part through actual library placement', () => {
  it('keeps legacy sources without a direction and evaluates periodic direction expressions', () => {
    const row = product('SS400:flatBar:FB 50×6');
    const legacy = { radius: '100', angleDegrees: '90', firstLeg: '200', secondLeg: '200',
      radiusConvention: 'inside', legDimension: 'tangent' } as const;
    const omitted = buildSteelBendChoice(row, legacy);
    const zero = buildSteelBendChoice(row, DEFAULT_STEEL_BEND_SOURCES);
    if (!omitted.ok || !zero.ok) throw new Error('Default bend failed');
    expect(omitted.geometry).toEqual(zero.geometry);
    expect(omitted.document.references).toEqual([]);
    const periodic = buildSteelBendChoice(row, { ...legacy, directionDegrees: '360+90' });
    if (!periodic.ok) throw new Error(periodic.reason);
    expect(periodic.geometry.centrelineRadiusMm).toBe(103);
    expect(periodic.document.references).toMatchObject([{ plane: { angle: { value: 90 } } }]);
  });

  it.each([0, 90, 45, 180])('at %s degrees evaluates expressions and preserves plane/sweep/source through one Undo and save/read', async (directionDegrees) => {
    const row = product('SS400:flatBar:FB 50×6');
    const beforeProduct = structuredClone(row);
    const result = buildSteelBendChoice(row, { ...DEFAULT_STEEL_BEND_SOURCES,
      radius: '15*2', firstLeg: '50*2', secondLeg: '100*2', directionDegrees: `${directionDegrees}/2*2` });
    if (!result.ok) throw new Error(result.reason);
    const width = directionDegrees === 90 ? 6 : directionDegrees === 45 ? 56 / Math.sqrt(2) : 50;
    const expectedLength = 300 + (30 + width / 2) * Math.PI / 2;
    expect(result.geometry.centrelineLengthMm).toBeCloseTo(expectedLength, 12);
    expect(Number(result.document.steelStockSource?.options.length)).toBeCloseTo(expectedLength, 12);
    expect(result.document.steelStockSource).toMatchObject({ catalog: 'flatBar', size: row.size });
    expect(result.document.solids[0].kind).toBe('sweep');
    if (directionDegrees === 0) expect(result.document.references).toEqual([]);
    else expect(result.document.references).toMatchObject([{ kind: 'referencePlane',
      plane: { kind: 'tilted', angle: { value: directionDegrees }, axis: { kind: 'world', axis: 'z' } } }]);
    expect(row).toEqual(beforeProduct);
    const before = useAppStore.getState();
    expect(beginSteelBendPlacement(result)).toBe(true);
    expect(useAppStore.getState().assemblyPlacement).toMatchObject({ kind: 'ready', document: result.document });
    expect(useAppStore.getState().assembly).toBe(before.assembly);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    await commitPlaceComponent();
    const placed = useAppStore.getState();
    const component = placed.assembly?.components[0];
    if (component?.source.kind !== 'part') throw new Error('Bend was not persisted as a library part');
    const stored = placed.assemblyLibrary.parts.get(component.source.partRef);
    expect(stored).toEqual(result.document);
    expect(placed.selection).toEqual([component.id]);
    placed.undoAssembly();
    expect(useAppStore.getState().assembly).toEqual(before.assembly);
    useAppStore.getState().redoAssembly();
    expect(useAppStore.getState().assemblyLibrary.parts.get(component.source.partRef)).toEqual(stored);
    if (stored === undefined) throw new Error('Missing stored part');
    const restored = useAppStore.getState();
    if (restored.assembly === null) throw new Error('Missing assembly');
    const bytes = await writeDocumentBundle(createAssemblyDocumentBundle(restored.assembly, restored.assemblyLibrary));
    const reopened = await readDocumentBundle(bytes, 'assembly');
    expect(reopened.ok).toBe(true);
    if (!reopened.ok || reopened.bundle.kind !== 'assembly') throw new Error('Assembly roundtrip failed');
    expect(reopened.bundle.embeddedDocuments.get(component.source.partRef)?.document).toEqual(stored);
    expect(reopened.bundle.document.components[0].source).toEqual(component.source);
  });

  it('keeps pipe outer/inner sweeps and subtraction in the actual callback document; cancel changes no history', () => {
    const result = buildSteelBendChoice(product('SGP:steelPipe:15A'), DEFAULT_STEEL_BEND_SOURCES);
    if (!result.ok) throw new Error(result.reason);
    expect(result.document.solids.map((solid) => solid.kind)).toEqual(['sweep', 'sweep', 'boolean']);
    expect(result.document.solids[2]).toMatchObject({ operation: 'subtract' });
    const before = useAppStore.getState();
    expect(beginSteelBendPlacement(result)).toBe(true);
    expect(useAppStore.getState().assemblyPlacement?.kind === 'ready'
      ? useAppStore.getState().assemblyPlacement : null).toMatchObject({ document: result.document });
    cancelPlaceComponent();
    const after = useAppStore.getState();
    expect(after.assembly).toBe(before.assembly);
    expect(after.assemblyLibrary).toBe(before.assemblyLibrary);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(after.assemblyPlacement).toBeNull();
  });

  it('rejects invalid expression/angle/zero leg and stale or busy placement without mutation', () => {
    const row = product('SS400:flatBar:FB 50×6');
    for (const [change, reason] of [
      [{ radius: 'not_a_number(' }, 'invalidExpression'], [{ angleDegrees: '180' }, 'invalidAngle'],
      [{ firstLeg: '0' }, 'invalidLength'],
      [{ directionDegrees: 'not_a_number(' }, 'invalidExpression'],
    ] as const) expect(buildSteelBendChoice(row, { ...DEFAULT_STEEL_BEND_SOURCES, ...change }))
      .toEqual({ ok: false, reason });
    const result = buildSteelBendChoice(row, DEFAULT_STEEL_BEND_SOURCES);
    if (!result.ok) throw new Error(result.reason);
    useAppStore.getState().closeStandardPartPicker();
    const before = useAppStore.getState();
    expect(beginSteelBendPlacement(result)).toBe(false);
    expect(useAppStore.getState()).toBe(before);
    useAppStore.getState().openStandardPartPicker();
    useAppStore.setState({ isComputing: true });
    const busy = useAppStore.getState();
    expect(beginSteelBendPlacement(result)).toBe(false);
    expect(useAppStore.getState()).toBe(busy);
  });

  it('inside/outside radius and leg conventions describe the same independent geometry', () => {
    const row = product('SS400:flatBar:FB 50×6');
    const tangent = buildSteelBendChoice(row, { ...DEFAULT_STEEL_BEND_SOURCES,
      radius: '30', firstLeg: '100', secondLeg: '200' });
    if (!tangent.ok) throw new Error(tangent.reason);
    for (const radiusConvention of ['inside', 'outside'] as const) {
      for (const legDimension of ['tangent', 'inside', 'outside'] as const) {
        const setback = legDimension === 'tangent' ? 0 : legDimension === 'inside' ? 30 : 80;
        const result = buildSteelBendChoice(row, { ...DEFAULT_STEEL_BEND_SOURCES, radiusConvention, legDimension,
          radius: radiusConvention === 'inside' ? '30' : '80', firstLeg: String(100 + setback), secondLeg: String(200 + setback) });
        if (!result.ok) throw new Error(result.reason);
        expect(result.geometry.insideRadiusMm).toBe(30);
        expect(result.geometry.outsideRadiusMm).toBe(80);
        expect(result.geometry.firstTangentLengthMm).toBeCloseTo(100, 12);
        expect(result.geometry.secondTangentLengthMm).toBeCloseTo(200, 12);
        expect(result.geometry.centrelineLengthMm).toBeCloseTo(300 + 55 * Math.PI / 2, 12);
      }
    }
  });
});

// W04 uses the W03 saved assembly path, rather than constructing a target from defaults.
async function savedEditTarget(key = 'SS400:flatBar:FB 50×6', sources: SteelBendSources = {
  radius: '(30) + 0', angleDegrees: '(90) + 0', directionDegrees: '(0) + 0',
  firstLeg: '(100) + 0', secondLeg: '(200) + 0', radiusConvention: 'inside', legDimension: 'tangent',
}) {
  const built = buildSteelBendChoice(product(key), sources);
  if (!built.ok) throw new Error(built.reason);
  expect(beginSteelBendPlacement(built)).toBe(true);
  await commitPlaceComponent();
  const placed = useAppStore.getState();
  if (placed.assembly === null) throw new Error('Missing assembly');
  const bytes = await writeDocumentBundle(createAssemblyDocumentBundle(placed.assembly, placed.assemblyLibrary));
  const reopened = await readDocumentBundle(bytes, 'assembly');
  if (!reopened.ok || reopened.bundle.kind !== 'assembly') throw new Error('W03 saved assembly did not reopen');
  const parts = new Map([...reopened.bundle.embeddedDocuments].map(([ref, part]) => [ref, part.document]));
  useAppStore.getState().openAssembly(reopened.bundle.document, { ...placed.assemblyLibrary, parts });
  useAppStore.getState().setSelection(placed.selection);
  useAppStore.getState().openStandardPartPicker();
  const target = selectedSteelBendEditTarget(useAppStore.getState());
  if (target === null) throw new Error('No selected saved bend');
  return { target, sources, built };
}

function expectUnchangedEdit(before: ReturnType<typeof useAppStore.getState>): void {
  const after = useAppStore.getState();
  expect(after.assembly).toBe(before.assembly);
  expect(after.assemblyLibrary).toBe(before.assemblyLibrary);
  expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
  expect(after.assemblyUndoStack?.past).toEqual(before.assemblyUndoStack?.past);
  expect(after.assemblyUndoStack?.future).toEqual(before.assemblyUndoStack?.future);
}

describe('W04 saved bend edit, one Undo and one Redo with independent W01 geometry', () => {
  const bridge = createNativeKernelBridgeForNodeTests();
  beforeAll(initializeNativeKernelForNodeTests, 180_000);
  afterAll(() => { bridge.dispose(); });
  // W01 section oracles: rectangle, rolled angle with corner/root radii, and hollow pipe.
  const angleArea = 564 + (1 - Math.PI / 4) * (6.5 ** 2 - 2 * 4.5 ** 2);
  const angleCentroid = (8292 + (1 - Math.PI / 4) * 6.5 ** 2 * 12.5 - 6.5 ** 3 / 6
    - (1 - Math.PI / 4) * 4.5 ** 2 * 47 - 4.5 ** 3 / 3) / angleArea;
  it.each([
    { key: 'SS400:flatBar:FB 50×6', direction: 0, radius: 30, width: 50, offset: 25, area: 300 },
    { key: 'SS400:equalAngle:L 50×50×6', direction: 180, radius: 100, width: 50, offset: angleCentroid, area: angleArea },
    { key: 'SGP:steelPipe:15A', direction: 45, radius: 30, width: 21.7, offset: 10.85, area: Math.PI * (10.85 ** 2 - 8.05 ** 2) },
  ])('$key direction $direction: equivalent outside R and changed expressions commit once and restore whole snapshots', async test => {
    const initial: SteelBendSources = { radius: `(${test.radius}) + 0`, angleDegrees: '(90) + 0',
      directionDegrees: `(${test.direction}) + 0`, firstLeg: '(100) + 0', secondLeg: '(200) + 0',
      radiusConvention: 'inside', legDimension: 'tangent' };
    const { target } = await savedEditTarget(test.key, initial);
    const before = useAppStore.getState(), snapshot = structuredClone(target.document);
    const next: SteelBendSources = { ...initial, radiusConvention: 'outside', radius: `${test.radius} + ${test.width}`,
      angleDegrees: '45 * 2', firstLeg: '50 * 2', secondLeg: '100 * 2', directionDegrees: `${test.direction} / 2 * 2` };
    const result = await commitSteelBendEdit(target, next);
    if (!result.ok) throw new Error(result.reason);
    const after = useAppStore.getState(), edited = after.assemblyLibrary.parts.get(target.partRef);
    expect(edited).toEqual(result.document);
    expect(target.document).toEqual(snapshot);
    expect(after.assembly).toEqual(before.assembly);
    expect(after.assemblyUndoStack?.past.length).toBe((before.assemblyUndoStack?.past.length ?? 0) + 1);
    expect(edited?.id).toBe(snapshot.id);
    expect(edited?.solids.map(feature => feature.id)).toEqual(snapshot.solids.map(feature => feature.id));
    expect(readSteelBendEditInput(result.document)).toEqual({ ok: true, sources: next, product: product(test.key) });
    expect(result.document.steelStockSource).toEqual({ ...snapshot.steelStockSource,
      options: { ...snapshot.steelStockSource?.options, length: String(result.geometry.centrelineLengthMm) } });
    expect(after.assemblyLibrary.attachments).toEqual(before.assemblyLibrary.attachments);
    expect(after.assemblyLibrary.partFiles.map(file => [file.ref, file.fileName, file.path, file.attachmentsDigest]))
      .toEqual(before.assemblyLibrary.partFiles.map(file => [file.ref, file.fileName, file.path, file.attachmentsDigest]));
    const rc = test.radius + test.offset, radians = test.direction * Math.PI / 180;
    const length = 300 + rc * Math.PI / 2, volume = test.area * length;
    expect(result.geometry.insideRadiusMm).toBeCloseTo(test.radius, 11);
    expect(result.geometry.outsideRadiusMm).toBeCloseTo(test.radius + test.width, 11);
    expect(result.geometry.centrelineLengthMm).toBeCloseTo(length, 11);
    for (const [point, expected] of [
      [result.geometry.firstTangent, [0, 0, 100]],
      [result.geometry.secondTangent, [rc * Math.cos(radians), rc * Math.sin(radians), 100 + rc]],
      [result.geometry.end, [(rc + 200) * Math.cos(radians), (rc + 200) * Math.sin(radians), 100 + rc]],
    ]) point.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 9));
    const assertVolume = async (document: PartDocument): Promise<void> => {
      const computed = await recomputePart(document, bridge);
      expect(computed.errors).toEqual([]);
      expect(computed.bodies).toHaveLength(1);
      expect(computed.bodies[0].isValid).toBe(true);
      expect(computed.bodies[0].volume).toBeGreaterThan(0);
      expect(Math.abs(computed.bodies[0].volume - volume) / volume).toBeLessThanOrEqual(1e-9);
    };
    await assertVolume(result.document);
    after.undoAssembly();
    const undone = useAppStore.getState();
    expect(undone.assembly).toEqual(before.assembly);
    expect(undone.assemblyLibrary).toEqual(before.assemblyLibrary);
    expect(undone.assemblyLibrary.parts.get(target.partRef)).toEqual(snapshot);
    expect(undone.assemblyUndoStack?.past).toEqual(before.assemblyUndoStack?.past);
    expect(readSteelBendEditInput(target.document)).toEqual({ ok: true, sources: initial, product: product(test.key) });
    await assertVolume(target.document);
    undone.redoAssembly();
    expect(useAppStore.getState().assemblyLibrary).toEqual(after.assemblyLibrary);
    // The existing history contract clears the gesture/coalescing clock on Undo/Redo.
    expect(useAppStore.getState().assemblyUndoStack).toEqual({ ...after.assemblyUndoStack, coalesceKey: null, coalesceAt: 0 });
    await assertVolume(result.document);
  });
});

describe('W04 edit refusal and cancellation leave saved document and complete history intact', () => {
  it('a library hashing failure preserves the real Redo branch and releases the busy state for retry', async () => {
    const { target, sources } = await savedEditTarget();
    expect(await commitSteelBendEdit(target, { ...sources, radius: '31' })).toMatchObject({ ok: true });
    useAppStore.getState().undoAssembly();
    useAppStore.getState().setSelection([target.componentId]);
    useAppStore.getState().openStandardPartPicker();
    const retry = selectedSteelBendEditTarget(useAppStore.getState());
    if (retry === null) throw new Error('Missing restored edit target');
    const before = useAppStore.getState();
    expect(before.assemblyUndoStack?.future).toHaveLength(1);
    // Inject a failure only; successful replacements still use the real library operation.
    const failedHash = vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('Hash unavailable'));
    try {
      expect(await commitSteelBendEdit(retry, { ...sources, radius: '32' })).toEqual({ ok: false, reason: 'failed' });
      expectUnchangedEdit(before);
      expect(useAppStore.getState().assemblyReplacementBusy).toBe(false);
      expect(useAppStore.getState().assemblyReplacementRequestId).toBeNull();
    } finally { failedHash.mockRestore(); }
    before.redoAssembly();
    expect(readSteelBendEditInput(useAppStore.getState().assemblyLibrary.parts.get(target.partRef) ?? target.document))
      .toMatchObject({ ok: true, sources: { ...sources, radius: '31' } });
  });

  it.each([
    { bad: { radius: '10^1000' }, reason: 'invalidExpression' },
    { bad: { radius: '0' }, reason: 'invalidRadius' },
    { bad: { firstLeg: '0' }, reason: 'invalidLength' },
    { bad: { angleDegrees: '180' }, reason: 'invalidAngle' },
    { bad: { directionDegrees: 'unfinished(' }, reason: 'invalidExpression' },
    { bad: { radius: String(Math.hypot(50, 6) / 2 - 25) }, reason: 'radiusTooTight' },
    { bad: { firstLeg: '30', legDimension: 'inside' }, reason: 'insufficientLegLength' },
  ] as const)('$reason rejects $bad without history and permits a subsequent valid edit', async test => {
    const { target, sources } = await savedEditTarget();
    const before = useAppStore.getState(), snapshot = structuredClone(target.document);
    expect(await commitSteelBendEdit(target, { ...sources, ...test.bad })).toEqual({ ok: false, reason: test.reason });
    expectUnchangedEdit(before);
    expect(target.document).toEqual(snapshot);
    expect(await commitSteelBendEdit(target, { ...sources, radius: '31' })).toMatchObject({ ok: true });
    expect(useAppStore.getState().assemblyUndoStack?.past.length).toBe((before.assemblyUndoStack?.past.length ?? 0) + 1);
  });

  it.each(['cancel before', 'cancel pending', 'selection changes back', 'close and reopen', 'document changes', 'busy', 'double submit'] as const)(
    '%s cannot publish a stale edit', async kind => {
      const { target, sources } = await savedEditTarget();
      const controller = new AbortController();
      if (kind === 'cancel before') controller.abort();
      if (kind === 'busy') useAppStore.setState({ isComputing: true });
      const before = useAppStore.getState();
      const pending = commitSteelBendEdit(target, { ...sources, radius: '31' }, controller.signal);
      if (kind === 'cancel pending') controller.abort();
      if (kind === 'selection changes back') {
        useAppStore.getState().setSelection([]);
        useAppStore.getState().setSelection([target.componentId]);
      }
      if (kind === 'close and reopen') {
        useAppStore.getState().closeStandardPartPicker();
        useAppStore.getState().openStandardPartPicker();
      }
      if (kind === 'document changes') useAppStore.getState().openAssembly(createAssemblyDocument('Different document'));
      const changed = useAppStore.getState();
      if (kind === 'double submit') {
        expect(await commitSteelBendEdit(target, sources)).toEqual({ ok: false, reason: 'unavailable' });
        expect(await pending).toMatchObject({ ok: true });
        expect(useAppStore.getState().assemblyUndoStack?.past.length).toBe((before.assemblyUndoStack?.past.length ?? 0) + 1);
      } else {
        expect(await pending).toEqual({ ok: false, reason: 'unavailable' });
        expectUnchangedEdit(kind === 'document changes' ? changed : before);
      }
      expect(useAppStore.getState().assemblyReplacementBusy).toBe(false);
      expect(useAppStore.getState().assemblyReplacementRequestId).toBeNull();
    });

  it('keeps the absent legacy direction absent on an edit and restores it on Undo', async () => {
    const sources: SteelBendSources = { radius: '30', angleDegrees: '90', firstLeg: '100', secondLeg: '200',
      radiusConvention: 'inside', legDimension: 'tangent' };
    const { target } = await savedEditTarget('SS400:flatBar:FB 50×6', sources);
    expect(readSteelBendEditInput(target.document)).toMatchObject({ ok: true, sources });
    const saved = readSteelBendEditInput(target.document);
    if (!saved.ok) throw new Error(saved.reason);
    expect(saved.sources).not.toHaveProperty('directionDegrees');
    const result = await commitSteelBendEdit(target, { ...saved.sources, radius: '31' });
    if (!result.ok) throw new Error(result.reason);
    expect(result.document.solids[0]).toMatchObject({ steelBend: { radius: { source: '31' } } });
    expect(result.document.solids[0]).not.toHaveProperty('steelBend.directionDegrees');
    useAppStore.getState().undoAssembly();
    expect(useAppStore.getState().assemblyLibrary.parts.get(target.partRef)).toEqual(target.document);
  });

  it('does not turn an ordinary or unselected component into a default bend edit', () => {
    expect(selectedSteelBendEditTarget(useAppStore.getState())).toBeNull();
    expect(buildSteelBendEdit({ ...productDocument(), solids: [] }, DEFAULT_STEEL_BEND_SOURCES))
      .toEqual({ ok: false, reason: 'missing' });
  });
});

function productDocument(): PartDocument {
  const result = buildSteelBendChoice(product('SS400:flatBar:FB 50×6'), DEFAULT_STEEL_BEND_SOURCES);
  if (!result.ok) throw new Error(result.reason);
  return result.document;
}

it('a pending bend edit uses the shared document identity when only attachments change', async () => {
  const { target, sources } = await savedEditTarget();
  const before = useAppStore.getState();
  const pending = commitSteelBendEdit(target, { ...sources, radius: '31' });
  before.addImportedAttachments(new Map([['late-shape', Uint8Array.of(1)]]), new Map());
  const changed = useAppStore.getState();
  expect(await pending).toEqual({ ok: false, reason: 'unavailable' });
  expectUnchangedEdit(before);
  expect(useAppStore.getState().importedShapes).toBe(changed.importedShapes);
  expect(useAppStore.getState().assemblyReplacementBusy).toBe(false);
  expect(useAppStore.getState().assemblyReplacementRequestId).toBeNull();
});
