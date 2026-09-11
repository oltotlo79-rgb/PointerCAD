import type { SheetMetalFeature } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { checkRecord, type Checked } from './guards.js';
import { readSheetBaseFeature, readSheetBendFeature, readSheetFlangeFeature, readSheetReliefFeature, serializeSheetMetalFeature } from './codecs/sheetMetal.js';
import { readSolidFeatureBase } from './codecs/solidBase.js';

const n = (value: number, source = String(value)) => ({ source, value, display: String(value) });
const base = { id: 's0', name: '基板', suppressed: false };
const profile = { sketchId: 'sketch', faceFeatureId: 'outer' };
const rule = { thickness: n(2, '板厚'), innerRadius: n(3), kFactor: n(0.4, '係数') };
const fixtures: readonly SheetMetalFeature[] = [
  { ...base, kind: 'sheetBase', profile, holes: [{ ...profile, faceFeatureId: 'round-hole' }], reversed: true, rule },
  { ...base, id: 's1', kind: 'sheetFlange', targetFeatureId: 's0', edges: [{ panelId: 'panel-0', boundaryId: 'edge-2' }, { panelId: 'panel-0', boundaryId: 'edge-4' }],
    length: n(20, '幅*2'), angle: n(-90), startOffset: n(1), endOffset: n(2), lengthBasis: 'outer',
    rule: { innerRadius: n(4), kFactor: null }, profile: { face: { sketchId: 'flange', faceFeatureId: 'trapezoid' }, baselineId: 'lower-edge', holes: [] } },
  { ...base, id: 's2', kind: 'sheetBend', targetFeatureId: 's1', panelId: 'panel-1', line: { sketchId: 'bend-lines', lineFeatureId: 'crease-2' },
    fixedSide: 'right', angle: n(45), rule: { innerRadius: null, kFactor: n(0.3) } },
  { ...base, id: 's3', kind: 'sheetRelief', targetFeatureId: 's2', boundary: { panelId: 'panel-1', boundaryId: 'edge-1' },
    position: n(5), width: n(2), depth: n(5, 'R+板厚'), shape: 'slot' },
];
function read(kind: SheetMetalFeature['kind'], value: unknown): Checked<SheetMetalFeature> {
  const record = checkRecord(value, 'feature'); if (!record.ok) return record;
  const identity = readSolidFeatureBase(record.value, 'feature'); if (!identity.ok) return identity;
  switch (kind) {
    case 'sheetBase': return readSheetBaseFeature(record.value, 'feature', identity.value);
    case 'sheetFlange': return readSheetFlangeFeature(record.value, 'feature', identity.value);
    case 'sheetBend': return readSheetBendFeature(record.value, 'feature', identity.value);
    case 'sheetRelief': return readSheetReliefFeature(record.value, 'feature', identity.value);
  }
}

describe('P10 板金入力codecの往復と破損拒否', () => {
  it.each(fixtures)('$kindの全入力・式・安定参照をJSON文字列経由で保持する', (feature) => {
    const encoded = serializeSheetMetalFeature(feature);
    const decoded: unknown = JSON.parse(JSON.stringify(encoded));
    expect(read(feature.kind, decoded)).toEqual({ ok: true, value: feature });
    expect(encoded).not.toBe(feature);
  });
  it('nullの条件継承・矩形フランジは保持し、欄の欠落と混同しない', () => {
    const feature = fixtures[1];
    if (feature.kind !== 'sheetFlange') throw new Error('フランジの独立fixtureが必要です');
    const rectangle = { ...feature, profile: null, lengthBasis: 'tangent' as const, rule: { innerRadius: null, kFactor: null } };
    expect(read('sheetFlange', serializeSheetMetalFeature(rectangle))).toEqual({ ok: true, value: rectangle });
    expect(read('sheetFlange', { ...rectangle, rule: { innerRadius: null } }).ok).toBe(false);
    expect(read('sheetFlange', { ...rectangle, profile: undefined }).ok).toBe(false);
  });
  it('リリーフの明示継ぎ目を往復し、省略は維持し、空・重複・非配列を拒否する', () => {
    const feature = fixtures[3]; if (feature.kind !== 'sheetRelief') throw new Error('リリーフが必要です');
    const explicit = { ...feature, seamConnectionIds: ['corner-3', 'corner-1'] };
    const encoded = serializeSheetMetalFeature(explicit), decoded: unknown = JSON.parse(JSON.stringify(encoded));
    expect(read('sheetRelief', decoded)).toEqual({ ok: true, value: explicit });
    expect(encoded).not.toBe(explicit);
    if (encoded.kind !== 'sheetRelief') throw new Error('リリーフが必要です');
    expect(encoded.seamConnectionIds).not.toBe(explicit.seamConnectionIds);
    expect(read('sheetRelief', serializeSheetMetalFeature(feature))).toEqual({ ok: true, value: feature });
    for (const seamConnectionIds of [null, 'corner-1', [''], ['  '], [1], ['same', 'same']])
      expect(read('sheetRelief', { ...feature, seamConnectionIds }).ok).toBe(false);
  });
  it('NaN/Infinity/null/非数値と無効な板厚・Kを場所付きで断る', () => {
    for (const value of [NaN, Infinity, -Infinity, null, '2', 0, -1]) {
      const result = read('sheetBase', { ...fixtures[0], rule: { ...rule, thickness: { ...rule.thickness, value } } });
      expect(result).toEqual({ ok: false, problem: { path: 'feature.rule.thickness.value', reason: 'type' } });
    }
    for (const value of [-0.1, 0.6]) expect(read('sheetBase', { ...fixtures[0], rule: { ...rule, kFactor: n(value) } }).ok).toBe(false);
    expect(read('sheetFlange', { ...fixtures[1], angle: n(180) }).ok).toBe(false);
    expect(read('sheetRelief', { ...fixtures[3], width: n(-1) }).ok).toBe(false);
  });
  it('重複穴・空/重複縁・自己参照・壊れた曲げ線を断る', () => {
    expect(read('sheetBase', { ...fixtures[0], holes: [profile] }).ok).toBe(false);
    expect(read('sheetBase', { ...fixtures[0], profile: { ...profile, sketchId: '' } }).ok).toBe(false);
    expect(read('sheetFlange', { ...fixtures[1], edges: [] }).ok).toBe(false);
    const edge = { panelId: 'panel', boundaryId: 'edge' };
    expect(read('sheetFlange', { ...fixtures[1], edges: [edge, edge] }).ok).toBe(false);
    expect(read('sheetFlange', { ...fixtures[1], edges: [{ ...edge, boundaryId: '' }] }).ok).toBe(false);
    expect(read('sheetBend', { ...fixtures[2], line: { sketchId: 'sketch' } }).ok).toBe(false);
    for (const feature of fixtures.slice(1)) expect(read(feature.kind, { ...feature, targetFeatureId: feature.id }).ok).toBe(false);
  });
  it('計算結果や表示モードが実行時オブジェクトへ混ざっても保存しない', () => {
    for (const feature of fixtures) {
      const withTransient = { ...feature, mesh: new Float32Array([1, 2, 3]), flatCoordinates: [[1, 2]], displayMode: 'flat' };
      expect(serializeSheetMetalFeature(withTransient)).toEqual(feature);
      expect(JSON.stringify(serializeSheetMetalFeature(withTransient))).not.toContain('flatCoordinates');
    }
  });
  it('任意輪郭の基準縁欠落と重複する穴を拒否する', () => {
    const face = { sketchId: 'flange', faceFeatureId: 'outline' };
    for (const invalid of [
      { face, holes: [] }, { face, baselineId: '', holes: [] },
      { face, baselineId: 'edge', holes: [face] },
      { face, baselineId: 'edge', holes: [profile, profile] },
    ]) expect(read('sheetFlange', { ...fixtures[1], profile: invalid }).ok).toBe(false);
  });
});
