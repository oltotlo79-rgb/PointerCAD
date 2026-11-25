import { describe, expect, it, vi } from 'vitest';

import { buildStandardPartFromSource } from '../../standard/buildStandardPart.js';
import { origin } from '../../standard/partPrimitives.js';
import { adjusterVolume, buildAdjusterPart, buildFootBasePart, type AdjusterDimensions } from '../profiles/framePartShapes.js';
import { PRODUCT_CATALOG_REGISTRY } from '../registry.js';
import { catalogItemNominalMass, createCatalogItemSource } from '../source.js';
import { ADJUSTER_FAMILY, type AdjusterRecord } from './framePartCatalog.js';

// 寸法は検査用。行の取り込みから形・体積までを通すため、この単体だけで追加分の表を差し替える。
const samples = vi.hoisted(() => {
  const rectangle = {
    key: 'plate-sample', size: '板皿の試験片', slot: 0, page: 1, material: 'steel', massG: 120, simplified: [],
    thread: 'M12', threadLength: 30, padThickness: 6,
    platePad: { width: 80, depth: 64, holes: [[10, 10, 6], [70, 10, 8], [70, 54, 8], [10, 54, 6]] },
  } as const satisfies AdjusterRecord;
  const chamfer = { ...rectangle, key: 'chamfer-sample', hexHeight: 4, platePad: { ...rectangle.platePad,
    outline: [[0, 0], [80, 0], [80, 52], [68, 64], [0, 64]], shaftCenter: [28, 39] } } as const satisfies AdjusterRecord;
  return { rectangle, chamfer };
});
vi.mock('./extraAdjusterRows.js', () => ({ EXTRA_ADJUSTER_RECORDS: [samples.rectangle, samples.chamfer] }));

describe('板皿のアジャスター', () => {
  it.each([
    { record: samples.rectangle, x: 40, y: 32, cutArea: 0, hex: 0 },
    { record: samples.chamfer, x: 28, y: 39, cutArea: 12 * 12 / 2, hex: samples.chamfer.hexHeight },
  ])('族の行 $record.key の保存情報から板・軸・和を再現する', async ({ record, x, y, cutArea, hex }) => {
    await PRODUCT_CATALOG_REGISTRY.ensure([ADJUSTER_FAMILY.id]);
    const family = PRODUCT_CATALOG_REGISTRY.loaded(ADJUSTER_FAMILY.id);
    const row = family?.rows.find((item) => item.key === record.key);
    if (family === undefined || row === undefined) throw new Error(record.key);
    const plate = record.platePad;
    expect(row.dims).toEqual({ padWidth: plate.width, padDepth: plate.depth, holeCount: plate.holes.length, shaftCenterX: x, shaftCenterY: y,
      padThickness: record.padThickness, threadLength: record.threadLength, ...('hexHeight' in record ? { hexHeight: hex } : {}), massG: record.massG });
    const height = record.threadLength + hex;
    const holesArea = plate.holes.reduce((sum, [, , diameter]) => sum + Math.PI * (diameter / 2) ** 2, 0);
    const volume = (plate.width * plate.depth - cutArea - holesArea) * record.padThickness + Math.PI * 6 ** 2 * height;
    expect(family.nominalVolume(row, {})).toBeCloseTo(volume, 9);
    const source = createCatalogItemSource(family, row);
    expect(source.options).toEqual({ family: 't-slot-adjuster', item: record.key });
    expect(catalogItemNominalMass(source)).toBe(record.massG);
    const part = buildStandardPartFromSource(source);
    const pad = buildFootBasePart({ ...plate, thickness: record.padThickness });
    if (part === null || pad === null) throw new Error(record.key);
    expect(part.name).toBe(record.size);
    expect(part.sketches).toEqual(pad.sketches);
    expect(part.solids.slice(0, -2)).toEqual(pad.solids);
    expect(pad.solids.filter((solid) => solid.kind === 'boolean' && solid.operation === 'subtract')).toHaveLength(plate.holes.length);
    const shaft = part.solids.at(-2);
    expect(shaft).toMatchObject({ kind: 'primitive', origin: origin(x - plate.width / 2, y - plate.depth / 2, record.padThickness),
      shape: { kind: 'cylinder', radius: { value: 6 }, height: { value: height } } });
    expect(part.solids.at(-1)).toMatchObject({ kind: 'boolean', operation: 'union', targetFeatureId: pad.solids.at(-1)?.id, toolFeatureId: shaft?.id });
  });

  const base = samples.rectangle;
  const plate = base.platePad;
  const lOutline = [[0, 0], [80, 0], [80, 20], [24, 20], [24, 64], [0, 64]] as const;
  it('L 形の残る腕に軸を置ける', () => {
    const dims: AdjusterDimensions = { ...base, platePad: { ...plate, outline: lOutline, holes: [[70, 10, 8]], shaftCenter: [14, 42] } };
    const area = 80 * 20 + 24 * (64 - 20) - Math.PI * 4 ** 2;
    expect(buildAdjusterPart(dims)).not.toBeNull();
    expect(adjusterVolume(dims)).toBeCloseTo(area * base.padThickness + Math.PI * 6 ** 2 * base.threadLength, 9);
  });

  const invalid: readonly (readonly [string, AdjusterDimensions])[] = [
    ['穴が板の外へ出る', { ...base, platePad: { ...plate, holes: [[2, 40, 6]] } }],
    ['穴どうしが重なる', { ...base, platePad: { ...plate, holes: [[10, 10, 6], [14, 10, 8]] } }],
    ['穴どうしが接する', { ...base, platePad: { ...plate, holes: [[10, 10, 6], [17, 10, 8]] } }],
    ['軸の円が板の外へ出る', { ...base, platePad: { ...plate, shaftCenter: [5, 32] } }],
    ['軸の円が辺に接する', { ...base, platePad: { ...plate, shaftCenter: [6, 32] } }],
    ['軸が斜辺にかかる', { ...base, platePad: { ...samples.chamfer.platePad, holes: [], shaftCenter: [73, 57] } }],
    ['軸中心が L 形の切り欠きにある', { ...base, platePad: { ...plate, outline: lOutline, holes: [] } }],
    ['軸と穴が重なる', { ...base, platePad: { ...plate, shaftCenter: [15, 10] } }],
    ['軸と穴が接する', { ...base, platePad: { ...plate, shaftCenter: [19, 10] } }],
    ['丸皿と板皿が両方ある', { ...base, padDiameter: 40 }],
    ['皿が無い', { thread: base.thread, threadLength: base.threadLength, padThickness: base.padThickness }],
    ['ねじの呼びが表に無い', { ...base, thread: 'M99' }],
    ['板の厚さがゼロ', { ...base, padThickness: 0 }],
    ['六角部の高さが負', { ...base, hexHeight: -1 }],
    ['軸の合計高さが有限でない', { ...base, threadLength: Number.MAX_VALUE, hexHeight: Number.MAX_VALUE }],
  ];
  it.each(invalid)('%s ときは形と体積の両方を断る', (_reason, dims) => {
    expect(buildAdjusterPart(dims)).toBeNull();
    expect(adjusterVolume(dims)).toBeNull();
  });
});
