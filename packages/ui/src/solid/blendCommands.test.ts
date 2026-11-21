import { expressionValueFromNumber } from '@pointercad/expression';
import { appendSolid, createEmptyPartDocument, findSolid, liveBodyIds, type SolidBody, type SurfaceFeature, type Vec3 } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { planeBody } from '../assembly/filletWeldBodies.testSupport.js';
import {
  commitNumericInput, createNumericInput, reduceNumericInput, SOLID_TOOL_STEPS, toggleNumericInput,
} from '../sketch/numericInput.js';
import { executeToolbarCommand } from '../commands/toolbarCommandExecution.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { partRepairSlots } from './referenceRepairSlots.js';
import { commitSolidInput, solidToolReadiness } from './solidCommands.js';
import { setSolidChoice, setSolidField, setSolidToggle, summarizeSolid } from './solidSummary.js';
import { subShapeElementId, subShapeRefOf } from './subShapeSelection.js';

function plate(id: string, corners: readonly [Vec3, Vec3, Vec3, Vec3], normal: Vec3) {
  const sheet = planeBody(corners, normal);
  const body: SolidBody = {
    ...sheet, featureId: id, bodyKind: 'shell',
    faces: sheet.faces.map(face => ({ ...face, boundaryEdgeIndices: sheet.edges.map(edge => edge.index) })),
  };
  const feature: SurfaceFeature = {
    id, name: id, kind: 'surface', suppressed: false,
    operation: { kind: 'planar', profile: { sketchId: `sketch-${id}`, curveIds: ['outline'] } },
  };
  return { body, feature };
}

const first = plate('sheet-a', [[0, 0, 0], [10, 0, 0], [10, -2, 0], [0, -2, 0]], [0, 0, -1]);
const second = plate('sheet-b', [[10, 3, 3], [0, 3, 3], [0, 3, 5], [10, 3, 5]], [0, 1, 0]);
const part = appendSolid(appendSolid(createEmptyPartDocument(), first.feature), second.feature);
const bodies = [first.body, second.body];

// Choose a boundary of each constructed rectangle by its geometry and read its current address.
function edgeAt(body: SolidBody, y: number, z: number): string {
  const edge = body.edges.find(item => item.start[1] === y && item.end[1] === y && item.midpoint[2] === z);
  if (edge === undefined) throw new Error('Missing fixture edge');
  return subShapeElementId(body.featureId, 'edge', edge.index);
}
const a = edgeAt(first.body, 0, 0);
const b = edgeAt(second.body, 3, 3);
const other = edgeAt(first.body, -2, 0);
const initial = createNumericInput('blend', SOLID_TOOL_STEPS.blend);

function input(flipB = true) {
  const state = reduceNumericInput(initial, { type: 'edit', index: 0, source: '2+1' });
  const filled = reduceNumericInput(state, { type: 'edit', index: 1, source: '2*3' });
  const result = commitNumericInput(flipB ? toggleNumericInput(filled, 'flipB') : filled);
  if (result.kind !== 'solidCommitted') throw new Error(result.kind);
  return result.commit;
}

function create(selection: readonly string[], flipB = true) {
  const outcome = commitSolidInput(part, selection, input(flipB), bodies);
  if (!outcome.ok) throw new Error(outcome.reasonKey);
  const feature = findSolid(outcome.document, outcome.featureId);
  if (feature?.kind !== 'surface' || feature.operation.kind !== 'blend') throw new Error('Missing blend');
  return { document: outcome.document, feature, operation: feature.operation };
}

describe('blend surface', () => {
  it('enters edge selection and opens the weight fields without losing the selected pair', () => {
    resetTestStore();
    try {
      useAppStore.setState({ document: part, bodies });
      const store = useAppStore.getState();
      const command = 'toolbar.solidMachining.blend';
      expect(executeToolbarCommand(command).ready).toBe(true);
      expect(useAppStore.getState()).toMatchObject({ selectionKind: 'edge', solidErrorKey: 'surfaceBlend.select', numericInput: null });
      store.setSelection([b]);
      store.toggleSelection(a);
      expect(executeToolbarCommand(command).ready).toBe(true);
      expect(useAppStore.getState().selection).toEqual([b, a]);
      expect(useAppStore.getState().numericInput).toMatchObject({
        toolId: 'blend', step: 'blendWeights',
        fields: [{ key: 'weightA', unit: 'mm' }, { key: 'weightB', unit: 'mm' }],
        toggles: [{ key: 'flipB', value: false }],
      });
    } finally {
      resetTestStore();
    }
  });

  it('takes distinct current edges in selection order, including two edges on the same body', () => {
    for (const selection of [[b, a], [a, other]]) {
      expect(solidToolReadiness(part, selection, 'blend', bodies)).toEqual({ ready: true, reasonKey: null });
      const { document, feature, operation } = create(selection, false);
      expect([operation.a, operation.b]).toEqual(selection.map(id => subShapeRefOf(bodies, id)));
      expect(operation.flipB).toBe(false);
      expect(document.schemaVersion).toBe(24);
      expect(liveBodyIds(document)).toEqual([first.feature.id, second.feature.id, feature.id]);
    }
  });

  it('checks the original selection and current boundary ownership again when confirmed', () => {
    const reasonKey = 'surfaceBlend.select';
    const face = first.body.faces[0];
    const shared = { ...first.body, faces: [face, { ...face, index: face.index + 1 }] };
    const free = { ...first.body, faces: [{ ...face, boundaryEdgeIndices: [] }] };
    const incomplete = { ...first.body, faces: [{ ...face, boundaryEdgeIndices: undefined }] };
    expect(solidToolReadiness(part, [a, b], 'blend', [incomplete, second.body]).ready).toBe(true);
    for (const candidates of [[shared, second.body], [free, second.body], [first.body], [{ ...first.body, isValid: false }, second.body]]) {
      expect(solidToolReadiness(part, [a, b], 'blend', candidates)).toEqual({ ready: false, reasonKey });
      expect(commitSolidInput(part, [a, b], input(), candidates)).toEqual({ ok: false, reasonKey });
    }
    const onlyFirst = appendSolid(createEmptyPartDocument(), first.feature);
    expect(commitSolidInput(onlyFirst, [a, b], input(), bodies)).toEqual({ ok: false, reasonKey });
    const selectedFace = subShapeElementId(first.body.featureId, 'face', face.index);
    for (const selection of [[], [a], [a, a], [a, b, other], [a, selectedFace], [first.body.featureId, b]]) {
      expect(solidToolReadiness(part, selection, 'blend', bodies)).toEqual({ ready: false, reasonKey });
      expect(commitSolidInput(part, selection, input(), bodies)).toEqual({ ok: false, reasonKey });
    }
  });

  it('validates both positive lengths in the input and at commit', () => {
    const defaults = commitNumericInput(initial);
    if (defaults.kind !== 'solidCommitted') throw new Error(defaults.kind);
    expect(defaults.commit.values).toMatchObject({ weightA: { value: 1 }, weightB: { value: 1 } });
    expect(defaults.commit.flags.flipB).toBe(false);
    const commit = input();
    for (const [index, key] of ['weightA', 'weightB'].entries()) {
      expect(commitNumericInput(reduceNumericInput(initial, { type: 'edit', index, source: '0' })).kind).toBe('blocked');
      for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const values = { ...commit.values, [key]: { ...expressionValueFromNumber(1), value: invalid } };
        expect(commitSolidInput(part, [a, b], { ...commit, values }, bodies)).toEqual({ ok: false, reasonKey: 'surfaceBlend.positive' });
      }
    }
  });

  it('shows both expressions and corresponding bodies, and edits each property independently', () => {
    const { document, feature, operation } = create([a, b]);
    const summary = summarizeSolid(document, feature);
    expect(summary.fields.map(f => [f.key, f.unit, f.value.source, f.value.value])).toEqual([
      ['weightA', 'mm', '2+1', 3], ['weightB', 'mm', '2*3', 6],
    ]);
    expect(summary.toggles).toEqual([{ key: 'flipB', labelKey: 'surfaceBlend.flipB', value: true }]);
    expect(summary.references.map(ref => [ref.labelKey, ref.elementId])).toEqual([
      ['surfaceBlend.edgeA', first.feature.id], ['surfaceBlend.edgeB', second.feature.id],
    ]);
    expect(summary.choices).toMatchObject([{ value: 'blend', options: [{ value: 'blend', labelKey: 'toolbar.machining.blend' }] }]);
    expect(setSolidChoice(feature, 'surfaceOperation', 'planar')).toBe(feature);
    const value = expressionValueFromNumber(4);
    for (const key of ['weightA', 'weightB'] as const) {
      expect(setSolidField(feature, key, value)).toEqual({ ...feature, operation: { ...operation, [key]: value } });
    }
    expect(setSolidToggle(feature, 'flipB', false)).toEqual({ ...feature, operation: { ...operation, flipB: false } });
  });

  it('repairs either edge independently and retains the weights and direction', () => {
    const { document, feature, operation } = create([a, b]);
    const slots = partRepairSlots(document).filter(slot => slot.ownerId === feature.id);
    expect(slots.map(slot => [slot.field, slot.requirement, slot.reference])).toEqual([
      ['a', 'same-kind', operation.a], ['b', 'same-kind', operation.b],
    ]);
    const replacement = subShapeRefOf(bodies, other);
    if (replacement === null) throw new Error('Missing replacement');
    for (const slot of slots) {
      expect(findSolid(slot.replace(replacement), feature.id)).toEqual({
        ...feature, operation: { ...operation, [slot.field]: replacement },
      });
    }
  });
});
