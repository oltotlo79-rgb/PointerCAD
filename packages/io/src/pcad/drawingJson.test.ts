import { describe, expect, it } from 'vitest';

import {
  createDrawingDocument,
  type DrawingDocument,
  type DrawingSource,
} from '@pointercad/model';

import { isRecord, isUnknownArray } from './guards.js';
import { parseDrawing, serializeDrawing } from './drawingJson.js';
import {
  PCAD_APP_NAME,
  PCAD_DRAWING_KIND,
  PCAD_DRAWING_TEMPLATE_KIND,
  PCAD_SCHEMA_VERSION,
} from './schema.js';

const SAVED_AT = '2026-09-09T00:00:00.000Z';
const source: DrawingSource = {
  sourceRef: 'source-1',
  sourceKind: 'part',
  fileName: 'part.pcad',
  path: './part.pcad',
  contentHash: 'abc123',
  importedAt: SAVED_AT,
};

function populatedDrawing(): DrawingDocument {
  const base = createDrawingDocument('部品図', source);
  return {
    ...base,
    views: [{
      id: 'view-1', name: '正面図', kind: 'front', position: [100, 100], scale: null,
      direction: [0, -1, 0], xDir: [1, 0, 0], showHidden: true, showCenterLines: true,
      layerId: 'layer-1', style: null,
    }],
    dimensions: [{
      id: 'dim-1', kind: 'length', measurement: 'horizontal',
      targets: [
        { kind: 'point', viewId: 'view-1', paperPoint: [10, 20], modelPoint: [0, 0, 0] },
        { kind: 'point', viewId: 'view-1', paperPoint: [30, 20], modelPoint: [20, 0, 0] },
      ],
      placement: { commonNormalCoordinate: 30, textPosition: null },
      reference: false, origin: 'manual', layerId: 'layer-4',
    }],
    annotations: [{
      id: 'note-1', kind: 'note', text: '注記', position: [20, 30], height: 3.5,
      layerId: 'layer-5',
    }],
    tables: [{
      id: 'table-1', kind: 'revision', position: [300, 20], columns: ['版', '内容'],
      rows: [['A', '初版']], options: { showHeader: true }, layerId: 'layer-7',
    }],
    balloons: [{
      id: 'balloon-1', itemNumber: 1, componentIds: ['component-1'], position: [200, 100],
      leader: [[190, 90], [200, 100]], layerId: 'layer-5',
    }],
    parameters: [{
      name: '縮尺値', value: { source: '1', value: 1, display: '1' }, unit: 'none', description: '',
    }],
  };
}

describe('図面 document.json', () => {
  it('累進の基準と全点の参照を保存し、実測値・投影線は保存しない', () => {
    const base = populatedDrawing();
    const document = { ...base, dimensions: [{ ...base.dimensions[0], series: { kind: 'progressive' as const, baseIndex: 1 } }] };
    const text = serializeDrawing(document, { savedAt: SAVED_AT });
    expect(parseDrawing(text)).toMatchObject({ ok: true, document });
    expect(text).not.toContain('"ticks"'); expect(text).not.toContain('"progressive":');
  });
  it.each([-1, 0.5, 2])('累進の基準index%sが選択点に対応しなければ読込を断る', (baseIndex) => {
    const base = populatedDrawing();
    const text = serializeDrawing({ ...base, dimensions: [{ ...base.dimensions[0], series: { kind: 'progressive', baseIndex } }] }, { savedAt: SAVED_AT });
    expect(parseDrawing(text).ok).toBe(false);
  });
  it('版9・drawing・アプリ名を決まった順序で書く', () => {
    const text = serializeDrawing(populatedDrawing(), { savedAt: SAVED_AT });
    expect(text.indexOf('"schema"')).toBeLessThan(text.indexOf('"kind"'));
    expect(text).toContain(`"schema": ${String(PCAD_SCHEMA_VERSION)}`);
    expect(text).toContain(`"kind": "${PCAD_DRAWING_KIND}"`);
    expect(text).toContain(`"app": "${PCAD_APP_NAME}"`);
  });

  it('全欄を往復する', () => {
    const document = populatedDrawing();
    const result = parseDrawing(serializeDrawing(document, { savedAt: SAVED_AT }));
    expect(result).toEqual({ ok: true, document, savedAt: SAVED_AT, kind: 'drawing' });
  });
  it('はめあい記号を保存し、寸法依存の上下偏差は保存しない', () => {
    const base = populatedDrawing(), document = { ...base, dimensions: [{ ...base.dimensions[0], fit: { symbol: 'H7', showDeviation: true } }] };
    expect(parseDrawing(serializeDrawing(document, { savedAt: SAVED_AT }))).toMatchObject({ ok: true, document });
    expect(serializeDrawing(document, { savedAt: SAVED_AT })).not.toContain('"upper"');
  });
  it('表面性状の式・面への保存参照とねじ注記のフィーチャー参照を往復する', () => {
    const base = populatedDrawing();
    const document: DrawingDocument = { ...base, annotations: [
      { ...base.annotations[0], kind: 'surfaceFinish', sourceTarget: base.dimensions[0].targets[0],
        surfaceFinish: { process: 'removal', parameter: 'Ra', value: { source: '3.2', value: 3.2, display: '3.2' } } },
      { ...base.annotations[0], id: 'note-2', kind: 'leaderNote', sourceTarget: base.dimensions[0].targets[0], machiningFeatureId: 'thread-1' },
    ] };
    expect(parseDrawing(serializeDrawing(document, { savedAt: SAVED_AT }))).toMatchObject({ ok: true, document });
  });
  it('はめあいと手動公差を同時に持つファイルを断る', () => {
    const base = populatedDrawing(), document = { ...base, dimensions: [{ ...base.dimensions[0], fit: { symbol: 'H7', showDeviation: true },
      tolerance: { kind: 'symmetric' as const, value: 0.1 } }] };
    expect(parseDrawing(serializeDrawing(document, { savedAt: SAVED_AT })).ok).toBe(false);
  });

  it('公差の式と数値の混在を保存して読み直す', () => {
    const base = populatedDrawing();
    const document: DrawingDocument = { ...base, dimensions: [
      { ...base.dimensions[0], tolerance: { kind: 'deviation',
        upper: { source: '板厚/20', value: 0.15, display: '0.15' }, lower: 0 } },
      { ...base.dimensions[0], id: 'dim-2', tolerance: { kind: 'symmetric',
        value: { source: '0.1', value: 0.1, display: '0.1' } } },
    ] };
    expect(parseDrawing(serializeDrawing(document, { savedAt: SAVED_AT })))
      .toEqual({ ok: true, document, savedAt: SAVED_AT, kind: 'drawing' });
  });

  it('公差の式の未知欄を保存・読込の両方で除き、不完全な式は断る', () => {
    const base = populatedDrawing();
    const expression = { source: 'x', value: 0.1, display: '0.1', derivedWidth: 999 };
    const document: DrawingDocument = { ...base, dimensions: [
      { ...base.dimensions[0], tolerance: { kind: 'symmetric', value: expression } },
    ] };
    const serialized = serializeDrawing(document, { savedAt: SAVED_AT });
    expect(serialized).not.toContain('derivedWidth');
    const envelope: unknown = JSON.parse(serialized);
    if (!isRecord(envelope) || !isRecord(envelope['document']) || !isUnknownArray(envelope['document']['dimensions'])) throw new Error('図面JSONが違う');
    const dimension = envelope['document']['dimensions'][0];
    if (!isRecord(dimension) || !isRecord(dimension['tolerance'])) throw new Error('公差がない');
    dimension['tolerance']['value'] = expression;
    const parsed = parseDrawing(JSON.stringify(envelope));
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain('derivedWidth');
    dimension['tolerance']['value'] = { source: 'x', value: 0.1 };
    expect(parseDrawing(JSON.stringify(envelope)).ok).toBe(false);
  });

  it('従来の数値公差を式へ書き換えず往復する', () => {
    const base = populatedDrawing();
    const document: DrawingDocument = { ...base, dimensions: [
      { ...base.dimensions[0], tolerance: { kind: 'symmetric', value: 0.1 } },
      { ...base.dimensions[0], id: 'dim-2', tolerance: { kind: 'deviation', upper: 0, lower: -0.05 } },
    ] };
    expect(parseDrawing(serializeDrawing(document, { savedAt: SAVED_AT })))
      .toEqual({ ok: true, document, savedAt: SAVED_AT, kind: 'drawing' });
  });

  it('消した中心線の元形状IDを保存し、旧版の省略も受け入れる', () => {
    const base = populatedDrawing();
    const document = { ...base, views: base.views.map((view) => ({ ...view, hiddenCenterMarkIds: ['["view-1","edge-1"]'] })) };
    expect(parseDrawing(serializeDrawing(document, { savedAt: SAVED_AT })))
      .toEqual({ ok: true, document, savedAt: SAVED_AT, kind: 'drawing' });
    expect(parseDrawing(serializeDrawing(base, { savedAt: SAVED_AT })).ok).toBe(true);
    const invalid: unknown = JSON.parse(serializeDrawing(document, { savedAt: SAVED_AT }));
    if (!isRecord(invalid) || !isRecord(invalid['document']) || !isUnknownArray(invalid['document']['views'])) throw new Error('図面JSONが違う');
    const first = invalid['document']['views'][0];
    if (!isRecord(first)) throw new Error('図がない');
    first['hiddenCenterMarkIds'] = [5];
    expect(parseDrawing(JSON.stringify(invalid)).ok).toBe(false);
  });

  it('保存時刻が同じなら文字列が完全に一致する', () => {
    const document = populatedDrawing();
    expect(serializeDrawing(document, { savedAt: SAVED_AT }))
      .toBe(serializeDrawing(document, { savedAt: SAVED_AT }));
  });

  it('drawingTemplate も図面の読み手が受け入れる', () => {
    const text = serializeDrawing(populatedDrawing(), {
      savedAt: SAVED_AT,
      kind: PCAD_DRAWING_TEMPLATE_KIND,
    });
    const result = parseDrawing(text);
    expect(result.ok && result.kind).toBe('drawingTemplate');
  });

  it('part は図面として読まず日本語の理由を返す', () => {
    const text = serializeDrawing(populatedDrawing(), { savedAt: SAVED_AT })
      .replace('"kind": "drawing"', '"kind": "part"');
    const result = parseDrawing(text);
    expect(result).toEqual({
      ok: false,
      error: { code: 'unsupportedKind', message: 'この形式の図面ではありません。' },
    });
  });

  it('壊れたJSONを投げずに断る', () => {
    expect(parseDrawing('{')).toMatchObject({ ok: false, error: { code: 'invalidJson' } });
  });

  it('未来版を投げずに断る', () => {
    const text = serializeDrawing(populatedDrawing(), { savedAt: SAVED_AT })
      .replace(`"schema": ${String(PCAD_SCHEMA_VERSION)}`, '"schema": 99');
    expect(parseDrawing(text)).toMatchObject({
      ok: false, error: { code: 'unsupportedNewVersion' },
    });
  });

  it('封筒と文書の版が違えば断る', () => {
    const text = serializeDrawing(populatedDrawing(), { savedAt: SAVED_AT })
      .replace(`"schemaVersion": ${String(PCAD_SCHEMA_VERSION)}`, '"schemaVersion": 8');
    expect(parseDrawing(text)).toMatchObject({ ok: false, error: { code: 'versionMismatch' } });
  });

  it('版8の図面は現行版へ移行して開く', () => {
    const text = serializeDrawing(populatedDrawing(), { savedAt: SAVED_AT })
      .replace(`"schema": ${String(PCAD_SCHEMA_VERSION)}`, '"schema": 8')
      .replace(`"schemaVersion": ${String(PCAD_SCHEMA_VERSION)}`, '"schemaVersion": 8');
    const result = parseDrawing(text);
    expect(result.ok && result.document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
  });

  it('必要な配列が欠けた図面を断る', () => {
    const text = serializeDrawing(populatedDrawing(), { savedAt: SAVED_AT })
      .replace('    "parameters": [', '    "unknownParameters": [');
    expect(parseDrawing(text)).toMatchObject({ ok: false, error: { code: 'invalidField' } });
  });

  it('未知の欄を読み直し・保存時にも保持する(P8-64)', () => {
    const text = serializeDrawing(populatedDrawing(), { savedAt: SAVED_AT });
    const parsed: unknown = JSON.parse(text);
    expect(isRecord(parsed) && isRecord(parsed['document'])).toBe(true);
    if (!isRecord(parsed) || !isRecord(parsed['document'])) return;
    parsed['document']['futureField'] = 123;
    const result = parseDrawing(JSON.stringify(parsed));
    expect(result.ok && result.document).toMatchObject({ futureField: 123 });
    if (result.ok) expect(serializeDrawing(result.document, { savedAt: SAVED_AT })).toContain('"futureField": 123');
  });

  it('投影線と計算済み寸法値を保存しない', () => {
    const raw: unknown = JSON.parse(serializeDrawing(populatedDrawing(), { savedAt: SAVED_AT }));
    expect(isRecord(raw) && isRecord(raw['document'])).toBe(true);
    if (!isRecord(raw) || !isRecord(raw['document'])) return;
    const views = raw['document']['views'];
    const dimensions = raw['document']['dimensions'];
    expect(isUnknownArray(views) && isRecord(views[0])).toBe(true);
    expect(isUnknownArray(dimensions) && isRecord(dimensions[0])).toBe(true);
    if (!isUnknownArray(views) || !isRecord(views[0])
      || !isUnknownArray(dimensions) || !isRecord(dimensions[0])) return;
    views[0]['projectedLines'] = [1, 2];
    dimensions[0]['value'] = 20;
    const parsed = parseDrawing(JSON.stringify(raw));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const text = serializeDrawing(parsed.document, { savedAt: SAVED_AT });
    expect(text).not.toContain('projectedLines');
    expect(text).not.toContain('"value": 20');
  });
});


describe('文字注記の引出線を保存する(P8-52)', () => {
  it.each(['arrow', 'dot'] as const)('複数行・紙上の先端・%sをそのまま往復する', (leaderEnd) => {
    const base = populatedDrawing();
    const document: DrawingDocument = { ...base, annotations: [{ ...base.annotations[0], kind: 'leaderNote',
      text: '加工面を清掃\n8 日 φ', leader: [[60, 70]], leaderEnd }] };
    expect(parseDrawing(serializeDrawing(document, { savedAt: SAVED_AT }))).toMatchObject({ ok: true, document });
  });
  it('未知の先端形状を通常の矢印として読まない', () => {
    const base = populatedDrawing();
    const document: DrawingDocument = { ...base, annotations: [{ ...base.annotations[0], kind: 'leaderNote', leader: [[60, 70]], leaderEnd: 'dot' }] };
    const invalid = serializeDrawing(document, { savedAt: SAVED_AT }).replace('"leaderEnd": "dot"', '"leaderEnd": "triangle"');
    expect(parseDrawing(invalid).ok).toBe(false);
  });
  it('引出線以外の注記へ先端属性を混ぜない', () => {
    const base = populatedDrawing();
    const document: DrawingDocument = { ...base, annotations: [{ ...base.annotations[0], leaderEnd: 'dot' }] };
    expect(parseDrawing(serializeDrawing(document, { savedAt: SAVED_AT })).ok).toBe(false);
  });
});
