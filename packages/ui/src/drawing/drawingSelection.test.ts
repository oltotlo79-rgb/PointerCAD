import { describe, expect, it } from 'vitest';
import { createDrawingDocument } from '@pointercad/model';
import type { DimensionTarget } from '@pointercad/drawing';
import { drawingTableRowOwner, selectedDrawingComponents, selectedDrawingTableRows } from './drawingSelection.js';

function fixture() {
  const document = createDrawingDocument('組図', { sourceRef: 'source', sourceKind: 'assembly', fileName: 'assembly.pcada', path: '', contentHash: '', importedAt: '' });
  return { ...document, balloons: [{ id: 'balloon-1', itemNumber: 1, componentIds: ['a', 'b'], position: [30, 40] as const, leader: [[10, 20] as const], layerId: 'layer-1' }] };
}
const tables = [{ id: 'table:1', rowComponentIds: [['c'], ['a', 'b']] }, { id: 'table:2', rowComponentIds: [['a'], ['c']] }];
describe('表・配置・風船の双方向の対応表示(P8-59)', () => {
  it('表の行で選んだ配置を取り出し、削除対象の選択配列は変えない', () => {
    const ids = ['table:1', 'component:a'];
    expect([...selectedDrawingComponents(fixture(), ids, [])]).toEqual(['a']);
    expect(ids).toEqual(['table:1', 'component:a']);
  });
  it('風船から対応する全配置へつなぐ', () => {
    expect([...selectedDrawingComponents(fixture(), ['balloon-1'], [])]).toEqual(['a', 'b']);
  });
  it('投影線の参照元から、同じ部品の別配置を混ぜず配置を取り出す', () => {
    const target: DimensionTarget = { kind: 'subShape', viewId: 'view-1', sourceRef: 'source', componentId: 'b',
      ref: { bodyFeatureId: 'box', index: 0, fingerprint: { kind: 'edge', curveKind: 'line', length: 20, position: [0, 0, 0], axis: null, radius: null } } };
    expect([...selectedDrawingComponents(fixture(), [], [target])]).toEqual(['b']);
  });
  it('配置から並びの違う複数の表の該当行だけを強調する', () => {
    expect([...selectedDrawingTableRows(tables, [], new Set(['a']))]).toEqual([
      drawingTableRowOwner('table:1', 2), drawingTableRowOwner('table:2', 1),
    ]);
  });
  it('表全体を選んだ場合はその表の全行だけを強調する', () => {
    expect([...selectedDrawingTableRows(tables, ['table:1'], new Set())]).toEqual([
      drawingTableRowOwner('table:1', 1), drawingTableRowOwner('table:1', 2),
    ]);
  });
  it('対応する配置がないと他の表を光らせない', () => {
    expect(selectedDrawingTableRows(tables, [], new Set(['missing'])).size).toBe(0);
  });
  it('見出しとデータ行・区切り文字を持つIDを区別する', () => {
    expect(drawingTableRowOwner('table:1', 0)).toBe('table:1');
    expect(drawingTableRowOwner('table:1', 2)).not.toBe(drawingTableRowOwner('table', 12));
  });
});
