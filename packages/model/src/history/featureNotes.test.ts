import { describe, expect, it } from 'vitest';
import { absoluteCoordinate, createEmptySketchDocument, createPointFeature } from '../sketch/createSketchDocument.js';
import { createEmptyPartDocument, createPrimitiveFeature } from '../part/createPartDocument.js';
import { affectsShape } from '../part/documentChange.js';
import { DEFAULT_TOOL_DEFAULTS, documentFromTemplate, templateFromDocument } from '../part/templates.js';
import type { PartDocument } from '../part/types.js';
import { FEATURE_NOTE_MAX_LENGTH, featureNoteOf, pruneRemovedFeatureNotes, setFeatureNote, type FeatureNoteTarget } from './featureNotes.js';

function fixture(): PartDocument {
  const empty = createEmptyPartDocument(), sketch = createEmptySketchDocument();
  const point = createPointFeature(sketch, absoluteCoordinate(1, 2, 3));
  return { ...empty, sketches: [{ ...sketch, id: 'first', features: [point] }, { ...sketch, id: 'second', features: [point] }],
    activeSketchId: 'first', solids: [{ ...createPrimitiveFeature(empty, 'box'), id: point.id }] };
}
const point: FeatureNoteTarget = { kind: 'sketch-feature', sketchId: 'first', id: 'point-1' };

describe('設計メモは対象を保持し、形と履歴の順序を変えない', () => {
  it('同じIDの別スケッチ・立体へ文章を漏らさず、同じ名前でも区別する', () => {
    const original = fixture();
    const first = setFeatureNote(original, point, '加工前に位置を確認\n<script>このままの文章</script>');
    const second = setFeatureNote(first, { ...point, sketchId: 'second' }, '別の加工');
    const next = setFeatureNote(second, { kind: 'solid', id: point.id }, '箱の設計');
    expect(featureNoteOf(next, point)).toBe('加工前に位置を確認\n<script>このままの文章</script>');
    expect(featureNoteOf(next, { ...point, sketchId: 'second' })).toBe('別の加工');
    expect(featureNoteOf(next, { kind: 'solid', id: point.id })).toBe('箱の設計');
    expect(original.featureNotes).toBeUndefined();
    expect(next.sketches).toBe(original.sketches); expect(next.solids).toBe(original.solids);
    expect(affectsShape(original, next)).toBe(false);
  });
  it('同じ文章は何も変えず、空白だけで消し、本文の空白は保存する', () => {
    const original = fixture(), next = setFeatureNote(original, point, '  位置の理由\n');
    expect(featureNoteOf(next, point)).toBe('  位置の理由\n');
    expect(setFeatureNote(next, point, '  位置の理由\n')).toBe(next);
    expect(setFeatureNote(original, point, ' \n ')).toBe(original);
    const removed = setFeatureNote(next, point, ' \n ');
    expect(removed.featureNotes).toEqual([]); expect(affectsShape(next, removed)).toBe(false);
  });
  it('未知の対象と文字数超過を拒否し、元の文章を切り詰めない', () => {
    const original = setFeatureNote(fixture(), point, '元の文章');
    expect(() => setFeatureNote(original, { ...point, sketchId: 'absent' }, '変更')).toThrow();
    expect(() => setFeatureNote(original, point, 'あ'.repeat(FEATURE_NOTE_MAX_LENGTH + 1))).toThrow();
    expect(featureNoteOf(original, point)).toBe('元の文章');
    expect(featureNoteOf(setFeatureNote(original, point, 'あ'.repeat(FEATURE_NOTE_MAX_LENGTH)), point)).toHaveLength(FEATURE_NOTE_MAX_LENGTH);
  });
  it('対象削除のときだけ付属のメモを消し、抑制・改名・並べ替えでは残す', () => {
    const original = setFeatureNote(setFeatureNote(fixture(), point, '点の理由'), { kind: 'solid', id: point.id }, '箱の理由');
    const hidden = { ...original, solids: original.solids.map(solid => ({ ...solid, name: '別名', suppressed: true })) };
    expect(pruneRemovedFeatureNotes(original, hidden)).toBe(hidden);
    const reordered = { ...original, sketches: [...original.sketches].reverse() };
    expect(pruneRemovedFeatureNotes(original, reordered)).toBe(reordered);
    const deleted = pruneRemovedFeatureNotes(original, { ...original, sketches: [original.sketches[1]], activeSketchId: 'second' });
    expect(featureNoteOf(deleted, point)).toBe('');
    expect(featureNoteOf(deleted, { kind: 'solid', id: point.id })).toBe('箱の理由');
    expect(featureNoteOf(original, point)).toBe('点の理由');
  });
  it('読込み時点で参照先が無い文章を、無関係な編集の際に黙って消さない', () => {
    const original = { ...fixture(), featureNotes: [{ target: { kind: 'solid' as const, id: 'missing' }, text: '復旧の手掛かり' }] };
    const next = { ...original, solids: [] };
    expect(pruneRemovedFeatureNotes(original, next)).toBe(next);
  });
  it('ひな形は図形の履歴と一緒にメモを外し、新しい図形へ元の説明を移さない', () => {
    const original = setFeatureNote(fixture(), point, '元の点だけの設計理由');
    const template = templateFromDocument(original, { lengthUnit: 'mm', toolDefaults: DEFAULT_TOOL_DEFAULTS });
    expect(template.document.featureNotes).toEqual([]);
    expect(documentFromTemplate(template).featureNotes).toBeUndefined();
    expect(featureNoteOf(original, point)).toBe('元の点だけの設計理由');
  });
});
