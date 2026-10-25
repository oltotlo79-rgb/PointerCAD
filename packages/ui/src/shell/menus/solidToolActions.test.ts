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
describe('extrude menu explicit targets', () => {
  it('passes live IDs to the actual input without selecting the first or selected body', () => {
    const document = fixture();
    useAppStore.setState({ document, selection: ['body-b', 'body-a'], pickAnchor: [100, 100] });
    runSolidTool('extrude', { ready: true, reasonKey: null });
    const input = useAppStore.getState().numericInput;
    const target = input?.choices.find((choice) => choice.key === 'extrudeTarget');
    expect(target?.value).toBe('');
    expect(target?.presentation).toBe('menu');
    expect(target?.options.map((option) => option.value)).toEqual(['', 'body-a', 'body-b']);
    expect(input?.choices.find((choice) => choice.key === 'extrudeOperation')?.options.map((option) => option.value)).toEqual(['new', 'join', 'cut']);
    expect(useAppStore.getState().document).toBe(document);
  });
  it('does not offer join or cut when no live target exists', () => {
    useAppStore.setState({ document: createEmptyPartDocument(), pickAnchor: [100, 100] });
    runSolidTool('extrude', { ready: true, reasonKey: null });
    expect(useAppStore.getState().numericInput?.choices.find((choice) => choice.key === 'extrudeOperation')?.options.map((option) => option.value)).toEqual(['new']);
  });
});
