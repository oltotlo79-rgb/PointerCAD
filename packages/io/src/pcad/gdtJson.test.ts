import { describe, expect, it } from 'vitest';
import { createDrawingDocument, type DrawingDocument, type GdtFeature, type GdtFrameSegment, type ToleranceCharacteristic } from '@pointercad/model';
import { parseDrawing, serializeDrawing } from './drawingJson.js';
import { isRecord, isUnknownArray } from './guards.js';
import { PCAD_SCHEMA_VERSION, SCHEMA_MIGRATIONS } from './schema.js';

const expression = (source: string) => ({ source, value: 999, display: '999' });
const feature = { kind: 'axis', target: { kind: 'subShape', viewId: 'view-1', sourceRef: 'source', componentId: 'frame/part',
  ref: { bodyFeatureId: 'cylinder', index: 2, fingerprint: { kind: 'face', surfaceKind: 'cylinder', area: 100, position: [0, 0, 10], axis: [0, 0, 1], radius: 5 } } } } satisfies GdtFeature;
const segment = (characteristic: ToleranceCharacteristic = 'position'): GdtFrameSegment => ({ characteristic, zone: 'cylinder', material: 'maximum',
  tolerance: { expression: expression('許容/2'), unit: 'inch' }, datums: [{ kind: 'single', member: { datumId: 'datum-a', material: 'none' } },
    { kind: 'common', members: [{ datumId: 'datum-b', material: 'maximum' }, { datumId: 'datum-c', material: 'maximum' }] }], basicDimensionIds: ['dim-1'] });
function document(): DrawingDocument {
  return { ...createDrawingDocument('公差付き図面', { sourceRef: 'source', sourceKind: 'assembly', fileName: 'assembly.pcada', path: '', contentHash: '', importedAt: '' }),
    datums: [{ id: 'datum-a', label: 'A', feature, position: [10, 20], height: 3.5, layerId: 'layer-5' }],
    gdtFrames: [{ id: 'frame-1', feature, segments: [segment(), segment('straightness')], position: [30, 40], height: 3.5, layerId: 'layer-5' }],
    weldSymbols: [{ id: 'weld-1', system: 'B', target: feature.target, sides: [
      { kind: 'fillet', side: 'arrow', size: { kind: 'leg', value: { expression: expression('6'), unit: 'mm' } },
        length: { expression: expression('20'), unit: 'mm' }, pitch: { expression: expression('50'), unit: 'mm' }, count: expression('3'), contour: 'flush', finish: 'grind' },
      { kind: 'fillet', side: 'opposite', size: { kind: 'throat', value: { expression: expression('4'), unit: 'mm' } }, contour: 'convex', finish: 'none' },
    ], allAround: true, fieldWeld: true, tail: 'WPS-01', position: [60, 40], height: 3.5, layerId: 'layer-5' }],
  };
}
function raw(): Record<string, unknown> & { document: Record<string, unknown> } {
  const value: unknown = JSON.parse(serializeDrawing(document()));
  if (!isRecord(value) || !isRecord(value['document'])) throw new Error('fixture');
  return { ...value, document: value['document'] };
}
function firstFrame(value: ReturnType<typeof raw>): Record<string, unknown> {
  const frames = value.document['gdtFrames'];
  if (!isUnknownArray(frames) || !isRecord(frames[0])) throw new Error('fixture');
  return frames[0];
}
describe('版11の製作指示と旧図面の移行', () => {
  it('開先深さ・研磨P・閉じた尾・折れ矢も式と相対位置を完全往復する', () => {
    const original = document(), weld = original.weldSymbols[0];
    const source = { ...original, weldSymbols: [{ ...weld, closedTail: true, arrowBendOffset: [-10, 15] as const,
      sides: [{ ...weld.sides[0], kind: 'jButt' as const, finish: 'polish' as const,
        grooveDepth: { expression: expression('深さ/2'), unit: 'inch' as const } }] }] };
    expect(parseDrawing(serializeDrawing(source))).toMatchObject({ ok: true, document: source });
  });
  it('データムID・配置パス・段・単位・式・共通基準・溶接両側を完全往復する', () => {
    const source = document(), result = parseDrawing(serializeDrawing(source, { savedAt: '2026-09-10T00:00:00Z' }));
    expect(result).toEqual({ ok: true, document: source, kind: 'drawing', savedAt: '2026-09-10T00:00:00Z' });
  });
  it.each<ToleranceCharacteristic>(['straightness', 'flatness', 'roundness', 'cylindricity', 'lineProfile', 'surfaceProfile', 'parallelism', 'perpendicularity',
    'angularity', 'position', 'coaxiality', 'symmetry', 'circularRunout', 'totalRunout'])('%sの意味検証は再解決に任せ、保存時に別の種類へ書き換えない', (kind) => {
    const source = document(), changed = { ...source, gdtFrames: [{ ...source.gdtFrames[0], segments: [segment(kind)] }] };
    expect(parseDrawing(serializeDrawing(changed))).toMatchObject({ ok: true, document: changed });
  });
  it.each([9, 10])('旧版%sの図面に空配列を補い、既存の紙面と寸法は保つ', (version) => {
    const value = raw(); value['schema'] = version; value.document['schemaVersion'] = version;
    delete value.document['datums']; delete value.document['gdtFrames']; delete value.document['weldSymbols'];
    expect(parseDrawing(JSON.stringify(value))).toMatchObject({ ok: true, document: { schemaVersion: PCAD_SCHEMA_VERSION, datums: [], gdtFrames: [], weldSymbols: [], sheet: document().sheet } });
  });
  it('版11で必須配列を失った文書を旧版扱いで救済しない', () => {
    const value = raw(); delete value.document['gdtFrames']; expect(parseDrawing(JSON.stringify(value)).ok).toBe(false);
  });
  it.each(['part', 'assembly'])('版10の%sへ図面用配列を混入しない', (kind) => {
    const migrated = SCHEMA_MIGRATIONS[10]?.({ kind, schema: 10, document: { schemaVersion: 10, name: '保持' } });
    expect(migrated).toEqual({ kind, schema: 11, document: { schemaVersion: 11, name: '保持' } });
  });
  it('古い参照や不合法な公差値を消さずに保存・復元する', () => {
    const source = document(), current = source.gdtFrames[0];
    const invalid = { ...source, gdtFrames: [{ ...current, segments: [{ ...current.segments[0],
      tolerance: { expression: expression('-1'), unit: 'mm' as const }, datums: [{ kind: 'single' as const, member: { datumId: 'deleted', material: 'none' as const } }] }] }] };
    expect(parseDrawing(serializeDrawing(invalid))).toMatchObject({ ok: true, document: invalid });
  });
  it('導出した座標・値・幅・診断を保存せず、未知の指定は失わない', () => {
    const value = raw(), frame = firstFrame(value);
    frame['rowWidths'] = [100]; frame['resolvedFeature'] = { point: [1, 2, 3] }; frame['vendorMeaning'] = { process: '追加情報' };
    const result = parseDrawing(JSON.stringify(value)); expect(result.ok).toBe(true); if (!result.ok) return;
    const saved = serializeDrawing(result.document);
    expect(saved).not.toContain('rowWidths'); expect(saved).not.toContain('resolvedFeature'); expect(saved).toContain('vendorMeaning');
  });
  it.each(['unknown', 'position '])('未知の特性%sを既知の公差として扱わない', (kind) => {
    const value = raw(), frame = firstFrame(value), segments = frame['segments'];
    if (!isUnknownArray(segments) || !isRecord(segments[0])) throw new Error('fixture');
    segments[0]['characteristic'] = kind; expect(parseDrawing(JSON.stringify(value)).ok).toBe(false);
  });
  it('無制限な段・不正な単位・小数の面番号を構造検査で断る', () => {
    const value = raw(); firstFrame(value)['segments'] = Array.from({ length: 9 }, () => segment());
    expect(parseDrawing(JSON.stringify(value)).ok).toBe(false);
    const changed = raw(), frame = firstFrame(changed), segments = frame['segments'];
    if (!isUnknownArray(segments) || !isRecord(segments[0])) throw new Error('fixture');
    segments[0]['tolerance'] = { expression: expression('1'), unit: 'degree' }; expect(parseDrawing(JSON.stringify(changed)).ok).toBe(false);
    const source = document(); expect(parseDrawing(serializeDrawing({ ...source, datums: [{ ...source.datums[0], feature: {
      kind: 'axis', target: { ...feature.target, ref: { ...feature.target.ref, index: 1.5 } },
    } }] })).ok).toBe(false);
  });
});
