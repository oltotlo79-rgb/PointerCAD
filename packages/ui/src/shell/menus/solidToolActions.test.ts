import { expressionValueFromNumber } from '@pointercad/expression';
import { appendSolid, createEmptyPartDocument, type PartDocument } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStore } from '../../store/testing/createTestStore.js';
import { useAppStore } from '../../store/useAppStore.js';
import { runSolidTool } from './solidToolActions.js';
function fixture(): PartDocument {
  const base = createEmptyPartDocument();
  const feature = { id: 'body-a', name: 'A', kind: 'extrude' as const, suppressed: false,
    profile: { sketchId: base.activeSketchId, faceFeatureId: 'face' },
    distance: expressionValueFromNumber(10), reversed: false, symmetric: false };
  return appendSolid(appendSolid(base, feature), { ...feature, id: 'body-b', name: 'B' });
}

beforeEach(resetTestStore);
const creationTools = ['extrude', 'revolve', 'sphere', 'box', 'cylinder', 'cone', 'torus'] as const;

describe('solid creation menu explicit targets', () => {
  it.each(creationTools)('%s opens the result and target controls without selecting a body by order', tool => {
    const document = fixture();
    useAppStore.setState({ document, selection: ['body-b', 'body-a'], pickAnchor: [100, 100] });
    runSolidTool(tool, { ready: true, reasonKey: null });
    const input = useAppStore.getState().numericInput;
    const target = input?.choices.find((choice) => choice.key === 'extrudeTarget');
    expect(input?.toolId).toBe(tool);
    expect(target?.labelKey).toBe(tool === 'extrude' ? 'numericInput.choice.extrudeTarget' : 'numericInput.choice.solidTarget');
    const result = input?.choices.find(choice => choice.key === 'extrudeOperation');
    expect(result?.labelKey).toBe(tool === 'extrude' ? 'numericInput.choice.extrudeOperation' : 'numericInput.choice.solidOperation');
    expect(result?.value).toBe('new');
    expect(target?.value).toBe('');
    expect(target?.presentation).toBe('menu');
    expect(target?.options.map((option) => option.value)).toEqual(['', 'body-a', 'body-b']);
    expect(result?.options.map(option => option.value)).toEqual(['new', 'join', 'cut']);
    expect(useAppStore.getState().document).toBe(document);
  });
  it.each(creationTools)('%s offers only new without a live target', tool => {
    useAppStore.setState({ document: createEmptyPartDocument(), pickAnchor: [100, 100] });
    runSolidTool(tool, { ready: true, reasonKey: null });
    expect(useAppStore.getState().numericInput?.choices.find((choice) => choice.key === 'extrudeOperation')?.options.map((option) => option.value)).toEqual(['new']);
  });
});
