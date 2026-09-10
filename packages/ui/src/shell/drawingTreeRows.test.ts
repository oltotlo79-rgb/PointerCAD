import { describe, expect, it } from 'vitest';
import { createDrawingDocument, type DrawingRefreshResult } from '@pointercad/model';
import type { DrawingDocument } from '@pointercad/drawing';
import { drawingTreeGroups, drawingTreeRowKey, type DrawingTreeLabels } from './drawingTreeRows.js';

const labels: DrawingTreeLabels = {
  dimension: (dimension, index) => `${index}: ${dimension.measurement}`,
  annotation: (kind, index) => `${kind} ${index}`,
  table: (kind, index) => `${kind} ${index}`,
  balloon: (number) => `部品 ${number}`,
};

function fixture(): DrawingDocument {
  const document = createDrawingDocument('組立図', {
    sourceRef: 'source', sourceKind: 'assembly', fileName: 'assembly.pcaa', path: '', contentHash: '', importedAt: '',
  });
  return {
    ...document,
    views: [{ id: 'view', name: '右側面', kind: 'right', position: [100, 100], scale: null,
      direction: [1, 0, 0], xDir: [0, 1, 0], showHidden: true, showCenterLines: true, layerId: document.layers[0].id }],
    dimensions: [{ id: 'dimension', kind: 'length', measurement: 'horizontal', targets: [],
      placement: { commonNormalCoordinate: 20, textPosition: null }, reference: false, origin: 'manual', layerId: document.layers[0].id }],
    annotations: [{ id: 'note', kind: 'note', text: '取付面\nきずをつけない', position: [30, 40], height: 3.5, layerId: document.layers[0].id }],
    balloons: [{ id: 'balloon', itemNumber: 5, componentIds: ['occurrence'], position: [40, 50], leader: [], layerId: document.layers[0].id }],
    tables: [{ id: 'table', kind: 'bom', position: [30, 100], columns: [], options: {}, layerId: document.layers[0].id }],
  };
}

function resolved(document: DrawingDocument, status: 'resolved' | 'unresolved' = 'resolved'): DrawingRefreshResult {
  return {
    ok: true, document, projection: { ok: true, views: [], failures: [], cancelled: false },
    dimensions: [{ dimension: document.dimensions[0], status, targets: [], value: status === 'resolved' ? 20 : null,
      coordinates: null, text: status === 'resolved' ? '20' : '?', reason: status === 'resolved' ? null : 'target' }],
    unresolvedCount: status === 'unresolved' ? 1 : 0, sourceChangedExternally: false,
  };
}

describe('図面ツリーの各束と表示対象(P8-67)', () => {
  it('閉じた図面では5つの束が空で、前の図面の行を残さない', () => {
    const groups = drawingTreeGroups(null, resolved(fixture()), labels);
    expect(groups.map((group) => group.id)).toEqual(['views', 'dimensions', 'annotations', 'tables', 'layers']);
    expect(groups.flatMap((group) => group.rows)).toEqual([]);
  });

  it('図は保存した名前と同じIDを持ち、部品番号と混ざらない', () => {
    expect(drawingTreeGroups(fixture(), null, labels)[0].rows).toMatchObject([{ id: 'view', label: '右側面', kind: 'view' }]);
  });

  it('水平と垂直の寸法を同じ長さとして表示しない', () => {
    const document = fixture();
    const dimensions = [...document.dimensions, { ...document.dimensions[0], id: 'vertical', measurement: 'vertical' as const }];
    expect(drawingTreeGroups({ ...document, dimensions }, null, labels)[1].rows.map((row) => row.label))
      .toEqual(['1: horizontal', '2: vertical']);
  });

  it('現在の文書で解決した寸法の値を表示する', () => {
    const document = fixture();
    expect(drawingTreeGroups(document, resolved(document), labels)[1].rows[0]).toMatchObject({ label: '1: horizontal — 20', unresolved: false });
  });

  it('参照が消えた寸法を行ごと残して未解決の印を付ける', () => {
    const document = fixture();
    expect(drawingTreeGroups(document, resolved(document, 'unresolved'), labels)[1].rows[0])
      .toMatchObject({ id: 'dimension', label: '1: horizontal — ?', unresolved: true });
  });

  it('同じIDを含んでも前の文書の値を表示しない', () => {
    expect(drawingTreeGroups(fixture(), resolved(fixture()), labels)[1].rows[0].label).toBe('1: horizontal');
  });

  it('再計算の失敗で保存されている行を消さない', () => {
    const groups = drawingTreeGroups(fixture(), { ok: false, message: '計算失敗' }, labels);
    expect(groups[1].rows).toHaveLength(1);
    expect(groups[1].rows[0].label).toBe('1: horizontal');
  });

  it('複数行の注記は先頭の内容で見分けられる', () => {
    expect(drawingTreeGroups(fixture(), null, labels)[2].rows[0].label).toBe('取付面');
  });

  it('長い注記を省略してもサロゲート文字を途中で切らない', () => {
    const document = fixture();
    const annotations = [{ ...document.annotations[0], text: '🔧'.repeat(45) }];
    const label = drawingTreeGroups({ ...document, annotations }, null, labels)[2].rows[0].label;
    expect(label).toBe(`${'🔧'.repeat(40)}…`);
  });

  it('文字が空の注記にも道具の種類と番号を付ける', () => {
    const document = fixture();
    const annotations = [{ ...document.annotations[0], text: ' \r\n ' }];
    expect(drawingTreeGroups({ ...document, annotations }, null, labels)[2].rows[0].label).toBe('note 1');
  });

  it.each(['bom', 'hole', 'revision'] as const)('%sの表が独立した表の束から選べる', (kind) => {
    const document = fixture();
    const tables = [{ ...document.tables[0], kind }];
    expect(drawingTreeGroups({ ...document, tables }, null, labels)[3].rows[0]).toMatchObject({ id: 'table', kind: 'table', label: `${kind} 1` });
  });

  it('風船は部品番号を使って注記の束へ並べる', () => {
    expect(drawingTreeGroups(fixture(), null, labels)[2].rows[1]).toMatchObject({ id: 'balloon', kind: 'balloon', label: '部品 5' });
  });

  it('使っていないレイヤーも再び選択できる', () => {
    const document = fixture();
    expect(drawingTreeGroups(document, null, labels)[4].rows.map((row) => row.id)).toEqual(document.layers.map((layer) => layer.id));
  });

  it('区切り文字や同じIDを含む別種類の行のキーが衝突しない', () => {
    const keys = [drawingTreeRowKey('annotation', 'table:a'), drawingTreeRowKey('table', 'annotation:a'),
      drawingTreeRowKey('annotation', 'same'), drawingTreeRowKey('table', 'same')];
    expect(new Set(keys).size).toBe(4);
  });

  it('改名と並べ替えで行のキーを失わない', () => {
    const document = fixture();
    const before = drawingTreeGroups(document, null, labels)[0].rows[0];
    const next = { ...document, views: [{ ...document.views[0], id: 'other', name: '追加図' }, { ...document.views[0], name: '改名後' }] };
    const after = drawingTreeGroups(next, null, labels)[0].rows[1];
    expect(after.key).toBe(before.key);
    expect(after.label).toBe('改名後');
    expect(document.views[0].name).toBe('右側面');
  });
});
