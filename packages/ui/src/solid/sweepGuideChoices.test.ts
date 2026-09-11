import { absoluteCoordinate, appendFeature, createEmptyPartDocument, replaceSketch, type PartDocument, type SweepFeature } from '@pointercad/model';
import { afterEach, describe, expect, it } from 'vitest';
import { createNumericInput, numericFocusTargets, numericToggleEnabled, reduceNumericInput } from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';
import { runSolidTool } from '../shell/menus/solidToolActions.js';
import { commitShapeEdit, selectedCurvePath } from './shapeEditCommands.js';
import { setSolidChoice, summarizeSolid } from './solidSummary.js';
import { sweepGuideCandidates, sweepGuideValue } from './sweepGuideChoices.js';

const savedStore = useAppStore.getState();
afterEach(() => { useAppStore.setState(savedStore); });
function fixture(): PartDocument {
  const base = createEmptyPartDocument(); let sketch = base.sketches[0];
  sketch = appendFeature(sketch, { id: 'face', name: '断面', kind: 'face', planeId: 'xy', boundary: [], color: '#6699aa' });
  for (const [id, name, x, construction] of [
    ['path', '経路', 0, false], ['guide', '案内線', 5, false], ['construction', '構築線', 10, true],
  ] satisfies readonly (readonly [string, string, number, boolean])[]) {
    sketch = appendFeature(sketch, { id, name, kind: 'line', planeId: 'free', construction,
      from: absoluteCoordinate(x, 0, 0), to: absoluteCoordinate(x / 2, 0, 100) });
  }
  return replaceSketch(base, sketch);
}
function create(guided: boolean) {
  const document = fixture(), path = { sketchId: document.activeSketchId, curveIds: ['path'] };
  const guide = sweepGuideCandidates(document, path)[0];
  const outcome = commitShapeEdit({ document, bodies: [], selection: ['face', 'path'] }, {
    kind: 'solid', tool: 'sweep', step: 'sweepOptions', values: {}, flags: { sweepFrenet: true },
    shapeChoices: { sweepGuide: guided ? guide.value : 'none' },
  }, 'sweep');
  expect(outcome.ok).toBe(true); if (!outcome.ok) throw new Error(outcome.reasonKey);
  const feature = outcome.document.solids[0];
  if (feature.kind !== 'sweep') throw new Error('スイープが作られていない');
  return { document: outcome.document, feature, guide };
}

describe('P11b 案内線の選択・作成・再編集', () => {
  it('経路と構築線は案内候補に混ぜず、スケッチ名と線の名前で区別する', () => {
    const document = fixture(), path = selectedCurvePath(document, ['face', 'path']);
    const candidates = sweepGuideCandidates(document, path ?? undefined);
    expect(candidates.map((candidate) => candidate.reference.curveIds)).toEqual([['guide']]);
    expect(candidates[0].label).toContain('案内線');
    expect(candidates[0].label).toContain(document.sketches[0].name);
  });
  it('実メニュー入口が候補を数値欄へ渡し、既定は案内なし', () => {
    const document = fixture();
    useAppStore.setState({ document, selection: ['face', 'path'], pickAnchor: [100, 100] });
    runSolidTool('sweep', { ready: true, reasonKey: null });
    const input = useAppStore.getState().numericInput;
    expect(input?.choices).toEqual([expect.objectContaining({ key: 'sweepGuide', value: 'none', presentation: 'menu',
      options: [expect.objectContaining({ value: 'none' }), expect.objectContaining({ label: `${document.sketches[0].name} / 案内線` })] })]);
  });
  it('案内ありでは効かない向き切替を無効にしてTabから除外し、なしへ戻すと値を保つ', () => {
    const { guide } = create(true);
    const initial = createNumericInput('sweep', 'sweepOptions', undefined, { sweepGuides: [guide] });
    const flipped = reduceNumericInput(initial, { type: 'toggle', key: 'sweepFrenet' });
    const chosen = reduceNumericInput(flipped, { type: 'choose', key: 'sweepGuide', value: guide.value });
    expect(numericToggleEnabled(chosen, 'sweepFrenet')).toBe(false);
    expect(numericFocusTargets(chosen)).toEqual([{ kind: 'choice', index: 0 }]);
    expect(reduceNumericInput(chosen, { type: 'toggle', key: 'sweepFrenet' })).toBe(chosen);
    const restored = reduceNumericInput(chosen, { type: 'choose', key: 'sweepGuide', value: 'none' });
    expect(restored.toggles).toEqual(flipped.toggles);
    expect(numericFocusTargets(restored)).toContainEqual({ kind: 'toggle', index: 0 });
  });
  it('案内線を経路へ連結せず独立参照で保存し、既存の選択は保持する', () => {
    const { document, feature, guide } = create(true);
    expect(feature.guide).toEqual(guide.reference); expect(feature.path.curveIds).toEqual(['path']);
    expect(document.sketches).toEqual(fixture().sketches);
  });
  it('作成後に案内を外し再指定でき、プロパティも同じ候補を使う', () => {
    const { document, feature, guide } = create(true);
    expect(summarizeSolid(document, feature).choices[0].value).toBe(sweepGuideValue(guide.reference));
    expect(summarizeSolid(document, feature).toggles).toEqual([]);
    const plain = setSolidChoice(feature, 'sweepGuide', 'none', undefined, {}, document);
    expect(plain).not.toHaveProperty('guide');
    expect(setSolidChoice(plain, 'sweepGuide', guide.value, undefined, {}, document)).toEqual(feature);
  });
  it('削除済みの候補や経路そのものを渡されても黙って案内なしに変えない', () => {
    const { document, feature } = create(true);
    const values = ['missing', sweepGuideValue(feature.path)];
    for (const value of values) {
      expect(setSolidChoice(feature, 'sweepGuide', value, undefined, {}, document)).toBe(feature);
      expect(commitShapeEdit({ document, bodies: [], selection: ['face', 'path'] }, {
        kind: 'solid', tool: 'sweep', step: 'sweepOptions', values: {}, flags: {}, shapeChoices: { sweepGuide: value },
      }, 'sweep')).toEqual({ ok: false, reasonKey: 'shapeError.noSweepGuide' });
    }
    const old: SweepFeature = { ...feature, guide: undefined };
    expect(summarizeSolid(document, old).toggles[0].key).toBe('sweepFrenet');
  });
  it('参照切れや保存済みの複数線も欄に残り、解除できる', () => {
    const { document, feature } = create(true);
    for (const curveIds of [['absent'], ['guide', 'path']]) {
      const reference = { sketchId: feature.path.sketchId, curveIds };
      const stored: SweepFeature = { ...feature, guide: reference };
      const choice = summarizeSolid(document, stored).choices[0];
      const selected = choice.options.find((option) => option.value === choice.value);
      expect(selected?.label).toBeTruthy();
      if (curveIds[0] === 'absent') expect(selected?.label).toContain('見つからない案内線');
      expect(setSolidChoice(stored, 'sweepGuide', choice.value, undefined, {}, document)).toBe(stored);
      expect(setSolidChoice(stored, 'sweepGuide', 'none', undefined, {}, document)).not.toHaveProperty('guide');
    }
  });
});
