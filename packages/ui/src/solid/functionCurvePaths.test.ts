import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber as number } from '@pointercad/expression';
import { createFunctionMathSource, createMathBackend } from '@pointercad/expression/math/worker';
import { appendFeature, createEmptyPartDocument, createFunctionCurve, replaceSketch } from '@pointercad/model';
import { commitShapeEdit, selectedCurvePath, shapeEditReadiness } from './shapeEditCommands.js';
import { sweepGuideCandidates } from './sweepGuideChoices.js';

function fixture() {
  const document = createEmptyPartDocument(), backend = createMathBackend(); let sketch = document.sketches[0];
  const formula = (source: string) => createFunctionMathSource(source, 'text', 'degree',
    { axes: ['X'], parameters: [], coefficients: [] }, backend);
  const interval = { min: number(-10), max: number(10) };
  const curve = createFunctionCurve(sketch, { format: 'pointercad-function/1',
    bounds: { X: interval, Y: interval, Z: interval }, tolerance: number(0.001),
    formula: { kind: 'coordinate-curve', independent: 'X', outputs: { Y: formula('X^2/10'), Z: formula('0') } } });
  sketch = appendFeature(sketch, curve);
  sketch = appendFeature(sketch, { ...curve, id: 'guide', name: '関数の案内線' });
  sketch = appendFeature(sketch, { ...curve, id: 'construction', name: '関数の構築線', construction: true });
  sketch = appendFeature(sketch, { id: 'face', name: '断面', kind: 'face', planeId: 'xy', boundary: [], color: '#6699aa' });
  return { document: replaceSketch(document, sketch), curve };
}

describe('関数曲線を通常の経路と案内線に使う', () => {
  it('断面と関数を選ぶと作成でき、確定後は元の関数を履歴参照として保持する', () => {
    const { document, curve } = fixture(), context = { document, bodies: [], selection: ['face', curve.id, curve.id] };
    expect(shapeEditReadiness(context, 'sweep')).toEqual({ ready: true, reasonKey: null });
    expect(selectedCurvePath(document, context.selection)?.curveIds).toEqual([curve.id]);
    const outcome = commitShapeEdit(context, { kind: 'solid', tool: 'sweep', step: 'sweepOptions',
      values: {}, flags: { sweepFrenet: false }, shapeChoices: { sweepGuide: 'none' } }, 'sweep');
    if (!outcome.ok) throw new Error(outcome.reasonKey);
    expect(outcome.document.solids[0]).toMatchObject({ kind: 'sweep', path: { sketchId: document.activeSketchId, curveIds: [curve.id] } });
    expect(outcome.document.sketches).toEqual(document.sketches);
  });
  it('関数の案内線を選べるが、経路自身と構築線は候補に出さない', () => {
    const { document, curve } = fixture(), path = { sketchId: document.activeSketchId, curveIds: [curve.id] };
    const candidates = sweepGuideCandidates(document, path);
    expect(candidates.map(item => item.reference.curveIds)).toEqual([['guide']]);
    const outcome = commitShapeEdit({ document, bodies: [], selection: ['face', curve.id] }, {
      kind: 'solid', tool: 'sweep', step: 'sweepOptions', values: {}, flags: {}, shapeChoices: { sweepGuide: candidates[0].value },
    }, 'sweep');
    if (!outcome.ok) throw new Error(outcome.reasonKey);
    expect(outcome.document.solids[0]).toMatchObject({ kind: 'sweep', path, guide: candidates[0].reference });
  });
});
