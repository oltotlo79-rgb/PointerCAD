import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber, evaluateExpression } from '@pointercad/expression';
import { createEmptyPartDocument, createPrimitiveFeature } from '../part/createPartDocument.js';
import { absoluteCoordinate, createEmptySketchDocument, createPointFeature } from '../sketch/createSketchDocument.js';
import { createFeatureFolder, moveFeatureFolderMember } from '../history/featureFolders.js';
import { setFeatureNote } from '../history/featureNotes.js';
import type { PartDocument, PrimitiveFeature } from '../part/types.js';
import { compareDocuments, DocumentComparisonLimit } from './compareDocuments.js';

const options = { relationship: 'versions' as const, beforeAttachmentsDigest: 'same', afterAttachmentsDigest: 'same' };
const e = expressionValueFromNumber;
function expression(source: string) { const result = evaluateExpression(source); if (!result.ok) throw new Error(source); return result.value; }
function box(id: string, size = '20'): PrimitiveFeature {
  return { ...createPrimitiveFeature(createEmptyPartDocument(), 'box'), id, name: id,
    shape: { kind: 'box', sizeX: expression(size), sizeY: e(20), sizeZ: e(20) } };
}
function part(ids = ['box-1']): PartDocument { return { ...createEmptyPartDocument(), solids: ids.map(id => box(id)) }; }
const solids = (before: PartDocument, after: PartDocument) => compareDocuments(before, after, options).changes.filter(change => change.group === 'solid');

describe('二文書の定義は種類・所属と原式を保って比較する', () => {
  it('同じ文書のコピーは無変更で、入力の列挙順・書式版・現在のスケッチで差を作らない', () => {
    const before = part();
    const after: PartDocument = { ...before, schemaVersion: 14, activeSketchId: 'other' };
    const saved = [JSON.stringify(before), JSON.stringify(after)];
    const result = compareDocuments(Object.freeze(before), Object.freeze(after), options);
    expect(result.changes).toEqual([]); expect(result.geometryCompared).toBe(false);
    expect([JSON.stringify(before), JSON.stringify(after)]).toEqual(saved);
  });
  it('追加・削除・寸法の変更を別の履歴として示す', () => {
    const before = part(['old', 'box-1']), after = { ...part(['new']), solids: [box('new'), box('box-1', '30')] };
    const changed = solids(before, after);
    expect(changed.map(change => [change.status, change.beforeName, change.afterName])).toEqual([
      ['removed', 'old', null], ['added', null, 'new'], ['changed', 'box-1', 'box-1'],
    ]);
    expect(changed[2].differences).toEqual([{ path: ['shape', 'sizeX'], kind: 'expression-and-value',
      before: '20', after: '30', beforeStoredValue: 20, afterStoredValue: 30 }]);
  });
  it('20を10+10に変更すると保存値が同じでも原式の変更を残す', () => {
    const before = part(), after = { ...before, solids: [box('box-1', '10+10')] };
    expect(solids(before, after)[0].differences).toEqual([{ path: ['shape', 'sizeX'], kind: 'expression',
      before: '20', after: '10+10', beforeStoredValue: 20, afterStoredValue: 20 }]);
  });
  it('保存値だけが変わった場合を原式の変更と区別し、丸めたdisplayだけは比較しない', () => {
    const before = part(), original = box('box-1');
    if (original.shape.kind !== 'box') throw new Error('box fixture');
    const display = { ...original, shape: { ...original.shape, sizeX: { ...original.shape.sizeX, display: '20.000' } } };
    expect(solids(before, { ...before, solids: [display] })).toEqual([]);
    const changed = { ...display, shape: { ...display.shape, sizeX: { ...display.shape.sizeX, value: 21 } } };
    expect(solids(before, { ...before, solids: [changed] })[0].differences[0].kind).toBe('stored-value');
  });
  it('別々に作った部品のpart-1と同名・同IDの箱を変更として結び付けない', () => {
    const before = part(), after = part();
    expect(before.id).toBe(after.id);
    const result = compareDocuments(before, after, { ...options, relationship: 'unrelated' });
    expect(result.unchanged).toBe(0); expect(result.changes.every(change => change.status !== 'changed')).toBe(true);
    expect(result.changes.filter(change => change.group === 'solid').map(change => change.status)).toEqual(['removed', 'added']);
  });
  it('同じ名前でもIDが違えば、対応を推測して寸法変更へまとめない', () => {
    const before = { ...part(), solids: [{ ...box('one'), name: '同じ箱' }] };
    const after = { ...part(), solids: [{ ...box('two'), name: '同じ箱' }] };
    expect(solids(before, after).map(change => change.status)).toEqual(['removed', 'added']);
  });
  it('先頭への追加は後続を移動扱いにせず、共通の履歴を入れ替えたときだけ順序差を出す', () => {
    const before = part(['one', 'two']);
    expect(solids(before, part(['new', 'one', 'two'])).map(change => change.status)).toEqual(['added']);
    const changed = solids(before, part(['two', 'one']));
    expect(changed).toHaveLength(2); expect(changed.every(change => change.differences[0].kind === 'order')).toBe(true);
  });
  it('同IDの点が別スケッチにあっても、変更した側だけを示す', () => {
    const sketch = createEmptySketchDocument(), point = createPointFeature(sketch, absoluteCoordinate(0, 0, 0));
    const before = { ...part([]), sketches: [{ ...sketch, id: 'first', features: [point] }, { ...sketch, id: 'second', name: '右側', features: [point] }] };
    const after = { ...before, sketches: [before.sketches[0], { ...before.sketches[1], features: [{ ...point, name: '変えた点' }] }] };
    const changes = compareDocuments(before, after, options).changes;
    expect(changes).toHaveLength(1); expect(changes[0]).toMatchObject({ owner: 'second', ownerName: '右側', group: 'sketch-feature', afterName: '変えた点' });
  });
  it('抑制・名前付き数値の単位や原式・メモ・所属も落とさない', () => {
    const before = part();
    let after: PartDocument = { ...before, solids: [{ ...before.solids[0], suppressed: true }],
      parameters: [{ name: '幅', value: e(30), unit: 'mm', description: '加工幅' }] };
    after = setFeatureNote(after, { kind: 'solid', id: 'box-1' }, '<script>設計理由</script>');
    after = moveFeatureFolderMember(createFeatureFolder(after, '加工'), { kind: 'solid', id: 'box-1' }, 'folder-1');
    const changes = compareDocuments(before, after, options).changes;
    expect(changes.map(change => change.group).sort()).toEqual(['folder', 'note', 'parameter', 'solid']);
    expect(changes.find(change => change.group === 'solid')?.differences).toEqual([{ path: ['suppressed'], kind: 'value', before: 'false', after: 'true' }]);
  });
  it('文書の定義が同じでも添付の内容が変わったことを残す', () => {
    const before = part(), result = compareDocuments(before, before, { ...options, afterAttachmentsDigest: 'different' });
    expect(result.changes).toHaveLength(1); expect(result.changes[0].group).toBe('attachments');
  });
  it('差分数・作業量の上限では部分的な一覧を成功として返さない', () => {
    expect(() => compareDocuments(part(), part(), { ...options, maxWork: 1 })).toThrow(DocumentComparisonLimit);
    expect(() => compareDocuments(part(), part(['a', 'b']), { ...options, maxChanges: 1 })).toThrow(DocumentComparisonLimit);
    expect(() => compareDocuments(part(), part(), { ...options, maxWork: Number.NaN })).toThrow(DocumentComparisonLimit);
  });
  it('同じ種類・所属のIDが重複している入力を黙って上書きしない', () => {
    expect(() => compareDocuments(part(['same', 'same']), part(), options)).toThrow('識別子が重複');
  });
});
