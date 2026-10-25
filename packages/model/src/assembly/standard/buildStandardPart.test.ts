import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalPartDocumentText } from '../partLibrary.js';
import { STEEL_GOLDEN } from './steelGolden.fixture.js';

import { resolveSketch } from '../../sketch/resolveSketch.js';
import { STEEL_PRODUCTS, steelProductOptions } from './steelCatalog.js';
import { liveBodyIds } from '../../part/createPartDocument.js';
import {
  buildStandardPart, buildStandardPartFromSource, createStandardPartSource,
  DEFAULT_STANDARD_FASTENER_LENGTH, DEFAULT_STANDARD_SECTION_LENGTH,
  standardPartNominalVolume,
} from './buildStandardPart.js';
import { findHexBolt } from './fasteners.js';
import { MISUMI_HEX_BOLT_MAIN_EVIDENCE } from './hexBoltEvidence.js';
import {
  HEX_BOLT_LENGTH_THREAD_GENERATOR_REVISION, STANDARD_CATALOG_REVISION, STANDARD_PART_GENERATOR_REVISION,
} from './types.js';
import type { PartDocument } from '../../part/types.js';

describe('saved legacy and steel r1 frozen canonical SHA-256', () => {
  it('retains exactly 41 legacy and 31 original steel inputs with 72 distinct frozen hashes', () => {
    expect(STEEL_GOLDEN).toHaveLength(72);
    expect(STEEL_GOLDEN.filter(({ source }) => source.catalogRevision === STANDARD_CATALOG_REVISION)).toHaveLength(41);
    expect(STEEL_GOLDEN.filter(({ source }) => source.catalogRevision === 'jp-steel-2026-10-10-r1')).toHaveLength(31);
    expect(new Set(STEEL_GOLDEN.map(({ sha256 }) => sha256)).size).toBe(72);
  });

  it.each(STEEL_GOLDEN)('$source.catalogRevision / $source.catalog / $source.size / $sha256', ({ source, sha256 }) => {
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    const document = buildStandardPartFromSource(source);
    if (document === null) throw new Error(`Cannot rebuild frozen ${source.catalog} ${source.size}`);
    const text = canonicalPartDocumentText(document).replace(/\r\n?/g, '\n');
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(sha256);
    expect(canonicalPartDocumentText({ ...document }).replace(/\r\n?/g, '\n')).toBe(text);
  });
});

describe('寸法表から普通の部品文書を組む台本', () => {
  it('pairs cylindrical weld radius with revision 3 and computes circular-sector volume instead of triangular volume', () => {
    const options = { length: '25', weldId: 'weld-1', weldSegment: '0', weldStation: '0', contactLength: '100',
      weldParts: 'a,b', weldCylinderRadius: '10' };
    const source = createStandardPartSource('filletWeld', '2x3', options);
    expect(source.generatorRevision).toBe('fillet-weld-3');
    expect(buildStandardPartFromSource(source)).not.toBeNull();
    const expected = (30 * Math.sin(0.2) - 100 * (0.2 - Math.sin(0.2))) * 25 / 2;
    expect(standardPartNominalVolume('filletWeld', '2x3', options)).toBeCloseTo(expected, 10);
    expect(expected).not.toBe(75);
    expect(standardPartNominalVolume('filletWeld', '6x1', options)).toBeNull();
    expect(standardPartNominalVolume('filletWeld', '2x3', { ...options, weldAngle: '60' })).toBeNull();
    for (const radius of ['0', '-1', 'Infinity', 'NaN', '']) {
      expect(standardPartNominalVolume('filletWeld', '2x3', { ...options, weldCylinderRadius: radius })).toBeNull();
    }
    const { weldCylinderRadius: removed, ...legacy } = options;
    expect(removed).toBe('10');
    expect(createStandardPartSource('filletWeld', '2x3', legacy).generatorRevision).toBe('fillet-weld-1');
    expect(standardPartNominalVolume('filletWeld', '2x3', legacy)).toBe(75);
    expect(createStandardPartSource('filletWeld', '2x3', { ...legacy, weldAngle: '60' }).generatorRevision).toBe('fillet-weld-2');
    expect(standardPartNominalVolume('filletWeld', '2x3', { ...legacy, weldAngle: '60' })).toBeCloseTo(75 * Math.sqrt(3) / 2, 10);
  });

  it('M8×30六角ボルトは正六角形・押し出し・円柱・簡略外ねじ・和で1ボディになる', () => {
    const document = buildStandardPart('hexBolt', 'M8', { length: '30' });
    expect(document?.name).toBe('六角ボルト M8×30');
    expect(document?.sketches[0].features.some((feature) => feature.kind === 'polygon')).toBe(true);
    expect(document?.solids.map((feature) => feature.kind)).toEqual([
      'extrude', 'primitive', 'threadShaft', 'boolean',
    ]);
    expect(document === null ? [] : liveBodyIds(document)).toHaveLength(1);
  });

  it('六角ボルト・ナットの既定は附属書JAで、本体規格も選べる', () => {
    expect(buildStandardPart('hexBolt', 'M8')?.solids[0]).not.toEqual(
      buildStandardPart('hexBolt', 'M8', { dimensionSeries: 'main' })?.solids[0],
    );
    expect(buildStandardPart('hexNut', 'M8')?.solids[0]).not.toEqual(
      buildStandardPart('hexNut', 'M8', { dimensionSeries: 'main' })?.solids[0],
    );
  });

  it('六角ボルトの長さは利用者の式のまま円柱へ保存する', () => {
    const document = buildStandardPart('hexBolt', 'M8', { length: '10*3' });
    const shaft = document?.solids.find(
      (feature) => feature.kind === 'primitive' && feature.shape.kind === 'cylinder',
    );
    expect(shaft?.kind).toBe('primitive');
    if (shaft?.kind === 'primitive' && shaft.shape.kind === 'cylinder') {
      expect(shaft.shape.height).toMatchObject({ source: '10*3', value: 30 });
    }
  });

  it('六角ナットは正六角柱へP3の下穴径で簡略ねじ穴を通す', () => {
    const document = buildStandardPart('hexNut', 'M8', { dimensionSeries: 'main' });
    expect(document?.solids.map((feature) => feature.kind)).toEqual(['extrude', 'threadHole']);
    const thread = document?.solids.at(-1);
    expect(thread?.kind).toBe('threadHole');
    if (thread?.kind === 'threadHole') {
      expect(thread.drillDiameter.value).toBeCloseTo(6.646835306586815, 10);
      expect(thread.representation).toBe('simplified');
    }
  });

  it('細目を選ぶと共有ねじ表のピッチを外ねじとねじ穴へ保存する', () => {
    const bolt = buildStandardPart('hexBolt', 'M8', { threadSeries: 'fine' });
    const nut = buildStandardPart('hexNut', 'M8', { threadSeries: 'fine' });
    expect(bolt?.solids.find((feature) => feature.kind === 'threadShaft')).toMatchObject({
      series: 'fine', pitch: { value: 1 },
    });
    expect(nut?.solids.find((feature) => feature.kind === 'threadHole')).toMatchObject({
      series: 'fine', pitch: { value: 1 },
    });
  });

  it('平座金は円柱へ貫通穴を通して1ボディにする', () => {
    const document = buildStandardPart('plainWasher', 'M8');
    expect(document?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'hole']);
    expect(document === null ? [] : liveBodyIds(document)).toHaveLength(1);
  });

  it('ばね座金は円環から切り欠きを引き、ねじれを作らない', () => {
    const document = buildStandardPart('springWasher', 'M8');
    expect(document?.solids.map((feature) => feature.kind)).toEqual([
      'primitive', 'primitive', 'boolean', 'primitive', 'boolean',
    ]);
    expect(document === null ? [] : liveBodyIds(document)).toHaveLength(1);
  });

  it('六角穴付きボルトは頭の六角穴を差し引く', () => {
    const document = buildStandardPart('socketHeadCapScrew', 'M8', { length: '30' });
    expect(document?.solids.filter((feature) =>
      feature.kind === 'boolean' && feature.operation === 'subtract',
    )).toHaveLength(1);
    expect(document === null ? [] : liveBodyIds(document)).toHaveLength(1);
  });

  it('十字穴付きなべ小ねじは頭・軸・外ねじ・十字の2切削を1ボディにする', () => {
    const document = buildStandardPart('panHeadScrew', 'M8', { length: '30' });
    expect(document?.name).toBe('十字穴付きなべ小ねじ M8×30');
    expect(document?.solids.filter((feature) =>
      feature.kind === 'boolean' && feature.operation === 'subtract',
    )).toHaveLength(2);
    expect(document === null ? [] : liveBodyIds(document)).toHaveLength(1);
  });

  it('深溝玉軸受は外輪・内輪・中間環の3ボディを作る', () => {
    const document = buildStandardPart('deepGrooveBallBearing', '6000');
    expect(document?.solids).toHaveLength(9);
    expect(document === null ? [] : liveBodyIds(document)).toHaveLength(3);
  });

  it.each([
    ['equalAngle', 'L 50×50×6'],
    ['channel', '[ 100×50×5×7.5'],
    ['hBeam', 'H 100×100×6×8'],
  ] as const)('%sは閉じた断面を長さの式で1回押し出す', (catalog, size) => {
    const document = buildStandardPart(catalog, size, { length: '500*2' });
    expect(document?.solids).toHaveLength(1);
    expect(document?.solids[0].kind).toBe('extrude');
    if (document?.solids[0].kind === 'extrude') {
      expect(document.solids[0].distance).toMatchObject({ source: '500*2', value: 1000 });
    }
    expect(document === null ? [] : liveBodyIds(document)).toHaveLength(1);
  });

  it('同じ呼びと指定から2回組むと同じ文書になる', () => {
    expect(buildStandardPart('hexBolt', 'M8', { length: '30' }))
      .toEqual(buildStandardPart('hexBolt', 'M8', { length: '30' }));
  });

  it('呼びまたは長さを変えると文書が変わる', () => {
    const m8 = buildStandardPart('hexBolt', 'M8', { length: '30' });
    expect(buildStandardPart('hexBolt', 'M10', { length: '30' })).not.toEqual(m8);
    expect(buildStandardPart('hexBolt', 'M8', { length: '40' })).not.toEqual(m8);
  });

  it('表にない呼び・0以下・壊れた長さは断る', () => {
    expect(buildStandardPart('hexBolt', 'M7')).toBeNull();
    expect(buildStandardPart('hexBolt', 'M8', { length: '0' })).toBeNull();
    expect(buildStandardPart('equalAngle', 'L 50×50×6', { length: '1/' })).toBeNull();
    expect(buildStandardPart('socketHeadCapScrew', 'M18')).toBeNull();
  });

  it('既定長はボルト30mm・形鋼1000mm', () => {
    expect(DEFAULT_STANDARD_FASTENER_LENGTH).toBe('30');
    expect(DEFAULT_STANDARD_SECTION_LENGTH).toBe('1000');
    expect(buildStandardPart('hexBolt', 'M8')?.name).toContain('×30');
    expect(buildStandardPart('equalAngle', 'L 50×50×6')?.name).toContain('長さ1000');
  });
});

describe('規格部品の版と体積の検算', () => {
  it('新規出どころへ寸法表版と生成器版を必ず保存する', () => {
    expect(createStandardPartSource('hexBolt', 'M8', { length: '30' })).toEqual({
      kind: 'standardPart', catalog: 'hexBolt', size: 'M8',
      options: { length: '30', dimensionSeries: 'annexJA', threadSeries: 'coarse' },
      catalogRevision: STANDARD_CATALOG_REVISION,
      generatorRevision: STANDARD_PART_GENERATOR_REVISION,
    });
  });

  it('保存版が一致すると組める', () => {
    const source = createStandardPartSource('plainWasher', 'M8');
    expect(buildStandardPartFromSource(source)?.name).toBe('平座金 M8');
  });

  it('未知の寸法表版を現在表で代用しない', () => {
    const source = { ...createStandardPartSource('hexBolt', 'M8'), catalogRevision: 'old' };
    expect(buildStandardPartFromSource(source)).toBeNull();
  });

  it('未知の生成器版を現在台本で代用しない', () => {
    const source = { ...createStandardPartSource('hexBolt', 'M8'), generatorRevision: 'old' };
    expect(buildStandardPartFromSource(source)).toBeNull();
  });

  it('M8×30六角ボルトの簡略体積と鋼質量を固定する', () => {
    const volume = standardPartNominalVolume('hexBolt', 'M8', {
      length: '30', dimensionSeries: 'main',
    });
    expect(volume).not.toBeNull();
    expect(volume ?? 0).toBeCloseTo(2283.668, 2);
    expect((volume ?? 0) / 1000 * 7.85).toBeCloseTo(17.927, 2);
  });

  it('M8六角ナットの簡略体積を固定する', () => {
    expect(standardPartNominalVolume('hexNut', 'M8', { dimensionSeries: 'main' }))
      .toBeCloseTo(759.282, 2);
  });

  it('M8平座金の簡略体積を固定する', () => {
    expect(standardPartNominalVolume('plainWasher', 'M8')).toBeCloseTo(233.03, 2);
  });

  it('L50×50×6・1mの角を丸めない形は公表質量と2%以内で一致する', () => {
    const volume = standardPartNominalVolume('equalAngle', 'L 50×50×6', { length: '1000' });
    const massKg = (volume ?? 0) / 1e9 * 7_850;
    expect(massKg).toBeCloseTo(4.4274, 4);
    expect(Math.abs(massKg - 4.43) / 4.43).toBeLessThan(0.02);
  });

  it.each([
    ['springWasher', 'M8'],
    ['socketHeadCapScrew', 'M8'],
    ['panHeadScrew', 'M8'],
    ['deepGrooveBallBearing', '6000'],
    ['channel', '[ 100×50×5×7.5'],
    ['hBeam', 'H 100×100×6×8'],
  ] as const)('%sの簡略体積は正である', (catalog, size) => {
    expect(standardPartNominalVolume(catalog, size)).toBeGreaterThan(0);
  });
});

describe('versioned analytic steel profile generation', () => {
  const sections = STEEL_PRODUCTS.filter((row) => row.geometry === 'profileSection');
  it.each(sections)('$size uses actual analytic arcs, a closed resolved face and one ordinary extrusion', (row) => {
    const source = createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length: '50*2' });
    expect(source.generatorRevision).toBe('3-steel-profile-1');
    const document = buildStandardPartFromSource(source);
    if (document === null) throw new Error('Missing generated section');
    const sketch = resolveSketch(document.sketches[0]);
    expect(sketch.errors).toEqual([]);
    expect(sketch.faces).toHaveLength(1);
    expect(sketch.arcs).toHaveLength(row.catalog === 'equalAngle' ? 3 : 4);
    expect(sketch.faces[0].curves.filter((curve) => curve.kind === 'arc')).toHaveLength(sketch.arcs.length);
    expect(document.solids).toHaveLength(1);
    expect(document.solids[0]).toMatchObject({ kind: 'extrude', distance: { source: '50*2', value: 100 } });
    expect(liveBodyIds(document)).toHaveLength(1);
  });
  it.each(sections)('$size retains exact old polygon geometry under saved2-steel-1', (row) => {
    const current = createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length: '100' });
    const saved = { ...current, generatorRevision: '2-steel-1' };
    const old = buildStandardPartFromSource(saved);
    const legacy = buildStandardPart(row.catalog, row.size, { length: '100' });
    expect(old).not.toBeNull();
    expect(old?.sketches).toEqual(legacy?.sketches);
    expect(old?.solids).toEqual(legacy?.solids);
    expect(old?.sketches[0].features.some((feature) => feature.kind === 'arc')).toBe(false);
    expect(buildStandardPartFromSource(current)?.sketches).not.toEqual(old?.sketches);
  });
  it.each(STEEL_PRODUCTS.filter((row) => row.geometry === 'nominal'))('$key keeps nominal shape identical across steel generator versions', (row) => {
    const current = createStandardPartSource(row.catalog, row.size, steelProductOptions(row));
    const saved = { ...current, generatorRevision: '2-steel-1' };
    const oldDocument = buildStandardPartFromSource(saved);
    const currentDocument = buildStandardPartFromSource(current);
    if (oldDocument === null || currentDocument === null) throw new Error('Missing nominal steel document');
    expect(oldDocument.steelStockSource).toEqual(saved);
    expect(currentDocument.steelStockSource).toEqual(current);
    const { steelStockSource: oldSource, ...oldShape } = oldDocument;
    const { steelStockSource: currentSource, ...currentShape } = currentDocument;
    expect(oldSource?.generatorRevision).toBe('2-steel-1');
    expect(currentSource?.generatorRevision).toBe('3-steel-profile-1');
    expect(oldShape).toEqual(currentShape);
  });
});

function boltShape(document: PartDocument | null): { readonly length: number; readonly thread: number } {
  const shaft = document?.solids.find((feature) => feature.kind === 'primitive' && feature.shape.kind === 'cylinder');
  const thread = document?.solids.find((feature) => feature.kind === 'threadShaft');
  if (shaft?.kind !== 'primitive' || shaft.shape.kind !== 'cylinder' || thread?.kind !== 'threadShaft') {
    throw new Error('六角ボルトの軸またはねじが無い');
  }
  expect(thread.targetFeatureId).toBe(shaft.id);
  expect(thread.fromEnd).toBe('last');
  return { length: shaft.shape.height.value, thread: thread.length.value };
}

const mainCoarse = (length: string) => ({ length, dimensionSeries: 'main', threadSeries: 'coarse' });

describe('六角ボルトの長さの区分ごとのねじ部の版(追加要件6)', () => {
  it('旧版 1 で保存した 125mm 超の本体規格のボルトは、読み直しても b(ℓ≤125)の形のまま', () => {
    const current = createStandardPartSource('hexBolt', 'M20', mainCoarse('150'));
    const saved = { ...current, generatorRevision: STANDARD_PART_GENERATOR_REVISION };
    const reloaded = buildStandardPartFromSource(structuredClone(saved));
    expect(boltShape(reloaded)).toEqual({ length: 150, thread: 46 });
    expect(buildStandardPartFromSource(saved)).toEqual(reloaded);
    const next = buildStandardPartFromSource(current);
    expect(boltShape(next)).toEqual({ length: 150, thread: 52 });
    expect(next?.solids.filter((feature) => feature.kind !== 'threadShaft'))
      .toEqual(reloaded?.solids.filter((feature) => feature.kind !== 'threadShaft'));
    expect(next?.sketches).toEqual(reloaded?.sketches);
  });

  it.each([
    ['125', STANDARD_PART_GENERATOR_REVISION, 46],
    ['126', HEX_BOLT_LENGTH_THREAD_GENERATOR_REVISION, 52],
    ['200', HEX_BOLT_LENGTH_THREAD_GENERATOR_REVISION, 52],
    ['201', HEX_BOLT_LENGTH_THREAD_GENERATOR_REVISION, 65],
    ['100*2', HEX_BOLT_LENGTH_THREAD_GENERATOR_REVISION, 52],
  ] as const)('M20 本体規格・並目の長さ %s は版 %s・ねじ部 %dmm', (length, revision, thread) => {
    const source = createStandardPartSource('hexBolt', 'M20', mainCoarse(length));
    expect(source.generatorRevision).toBe(revision);
    const document = buildStandardPartFromSource(source);
    expect(boltShape(document).thread).toBe(thread);
    expect(buildStandardPart('hexBolt', 'M20', mainCoarse(length))).toEqual(document);
  });

  it.each([
    ['附属書JA', 'M20', { length: '150', dimensionSeries: 'annexJA', threadSeries: 'coarse' }, 46],
    ['細目', 'M20', { length: '150', dimensionSeries: 'main', threadSeries: 'fine' }, 46],
    ['根拠の無い第2選択', 'M14', mainCoarse('150'), 34],
  ] as const)('%s は 125mm を超えても版 1 のまま b(ℓ≤125)で作る', (_label, size, options, thread) => {
    const source = createStandardPartSource('hexBolt', size, options);
    expect(source.generatorRevision).toBe(STANDARD_PART_GENERATOR_REVISION);
    expect(boltShape(buildStandardPartFromSource(source)).thread).toBe(thread);
  });

  const evidenceRows = MISUMI_HEX_BOLT_MAIN_EVIDENCE.filter((row) => findHexBolt(row.nominal, 'main') !== undefined);

  it('根拠のある全ての呼びで、125mm 以下は新旧の版の形が一致する', () => {
    expect(evidenceRows.map((row) => row.nominal)).toEqual(['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M16', 'M20']);
    for (const row of evidenceRows) {
      for (const length of ['8', String(row.threadLength.upTo125), '60', '125']) {
        const old = createStandardPartSource('hexBolt', row.nominal, mainCoarse(length));
        expect(old.generatorRevision).toBe(STANDARD_PART_GENERATOR_REVISION);
        expect(buildStandardPartFromSource({ ...old, generatorRevision: HEX_BOLT_LENGTH_THREAD_GENERATOR_REVISION }))
          .toEqual(buildStandardPartFromSource(old));
      }
    }
  });

  it('全長は呼び長さのまま、ねじ部は先端から続き全長を超えず、区分の境で根拠の値へ切り替わる', () => {
    for (const row of evidenceRows) {
      for (const [length, expected] of [
        [125, row.threadLength.upTo125], [125.5, row.threadLength.upTo200], [200, row.threadLength.upTo200],
        [200.5, row.threadLength.over200], [300, row.threadLength.over200],
      ] as const) {
        const document = buildStandardPartFromSource(
          createStandardPartSource('hexBolt', row.nominal, mainCoarse(String(length))));
        const shape = boltShape(document);
        expect(shape.length).toBe(length);
        expect(shape.thread).toBe(Math.min(expected, length));
        expect(shape.length - shape.thread).toBeGreaterThanOrEqual(0);
        expect(document === null ? [] : liveBodyIds(document)).toHaveLength(1);
      }
    }
  });

  it('新しい版は六角ボルトにだけ付き、ほかの部品の保存版としては組まない', () => {
    for (const catalog of ['hexNut', 'plainWasher', 'socketHeadCapScrew'] as const) {
      const source = createStandardPartSource(catalog, 'M8', { length: '150', dimensionSeries: 'main' });
      expect(source.generatorRevision).toBe(STANDARD_PART_GENERATOR_REVISION);
      expect(buildStandardPartFromSource({ ...source, generatorRevision: HEX_BOLT_LENGTH_THREAD_GENERATOR_REVISION }))
        .toBeNull();
    }
  });
});


describe('inner cylindrical weld public standard source', () => {
  it('pairs explicit interior side with version 4 and adds the independent circular segment', () => {
    const options = { length: '25', weldId: 'weld-1', weldSegment: '0', weldStation: '0', contactLength: '100',
      weldParts: 'a,b', weldCylinderRadius: '10', weldCylinderSide: 'interior' };
    const source = createStandardPartSource('filletWeld', '2x3', options);
    expect(source.generatorRevision).toBe('fillet-weld-4');
    expect(buildStandardPartFromSource(source)).not.toBeNull();
    const expected = (30 * Math.sin(0.2) + 100 * (0.2 - Math.sin(0.2))) * 25 / 2;
    expect(standardPartNominalVolume('filletWeld', '2x3', options)).toBeCloseTo(expected, 10);
    expect(expected).toBeGreaterThan(75 * Math.sin(0.2) / 0.2);
    for (const generatorRevision of ['fillet-weld-1', 'fillet-weld-2', 'fillet-weld-3']) {
      expect(buildStandardPartFromSource({ ...source, generatorRevision })).toBeNull();
    }
    for (const value of ['unknown', 'exterior', '']) {
      const invalid = { ...options, weldCylinderSide: value };
      expect(buildStandardPartFromSource(createStandardPartSource('filletWeld', '2x3', invalid))).toBeNull();
      expect(standardPartNominalVolume('filletWeld', '2x3', invalid)).toBeNull();
    }
    const { weldCylinderRadius: removed, ...withoutRadius } = options;
    expect(removed).toBe('10');
    expect(buildStandardPartFromSource(createStandardPartSource('filletWeld', '2x3', withoutRadius))).toBeNull();
    expect(standardPartNominalVolume('filletWeld', '2x3', withoutRadius)).toBeNull();
    expect(standardPartNominalVolume('filletWeld', '2x20', options)).toBeNull();
    expect(buildStandardPartFromSource({ ...source, size: '2x20' })).toBeNull();
  });
});
