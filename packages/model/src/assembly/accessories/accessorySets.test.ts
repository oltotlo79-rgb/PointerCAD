import { expressionValueFromNumber } from '@pointercad/expression';
import { beforeAll, describe, expect, it } from 'vitest';

import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import { PRODUCT_CATALOG_REGISTRY } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import { quaternionFromAxisAngle, type Quaternion } from '../placementMath.js';
import type { AssemblyDocument } from '../types.js';
import { accessoryCandidates, applyAccessorySet } from './accessorySets.js';

/** 記録を使った文書の保存形式の版(frameJoints・穴つきの面と同じ版 23)。 */
const ACCESSORY_SETS_SCHEMA_VERSION = 23;

const registry = PRODUCT_CATALOG_REGISTRY;
const FRAME = 't-slot-frame-s6';
const FRAME_ROW = 's6-20x20';

beforeAll(async () => {
  await registry.ensure([FRAME, 't-slot-frame-s8', 't-slot-frame-s10', 't-slot-frame-cap', 't-slot-frame-small', 't-slot-frame-cap-small',
    'aluminum-square-pipe']);
});

/** 族の行を 1 本置いた文書(位置 100・200・300、向きは指定)。 */
function placed(familyId: string, itemKey: string, length: string, rotation: Quaternion = [0, 0, 0, 1]):
{ readonly document: AssemblyDocument; readonly id: string } {
  const family = registry.loaded(familyId);
  const row = family?.rows.find((candidate) => candidate.key === itemKey) ?? family?.rows[0];
  if (family === undefined || row === undefined) throw new Error(`${familyId} not loaded`);
  const empty = createAssemblyDocument('accessories');
  const component = createComponentFor(empty, createCatalogItemSource(family, row, { length }), { partName: 'host',
    placement: { position: [expressionValueFromNumber(100), expressionValueFromNumber(200), expressionValueFromNumber(300)], rotation } });
  return { document: addComponent(empty, component), id: component.id };
}

const positions = (document: AssemblyDocument): number[][] => document.components.map((component) => component.placement.position.map((value) => value.value));

describe('付属の組: フレームの端のキャップ', () => {
  it('溝の呼びと外形が合うキャップの行を候補にし、ロック式も別の候補にする', () => {
    const { document, id } = placed(FRAME, FRAME_ROW, '1000');
    const candidates = accessoryCandidates(document, id, 'frame-end-caps', registry);
    expect(candidates.ok && candidates.value.map((item) => [item.itemKey, item.thicknessMm, item.quarterTurn]))
      .toEqual([['s6-20x20', 3, 0], ['s6-20x20-lock', 3, 0]]);
  });

  it('L 形のフレームには腕の幅の同じ L 形のキャップだけを向きを変えずに候補にし、長方形のフレームには L 形のキャップを出さない', () => {
    // フレームの行の鍵は、L 形の端のキャップの行と同じ書き方(族が違うので重ならない)。
    const cases = [['t-slot-frame-s6', 's6-l40x40-a20', 's6-l40x40-a20'], ['t-slot-frame-s8', 's8-l60x60-a30', 's8-l60x60-a30'],
      ['t-slot-frame-s10', 's10-l80x80-a40', 's10-l80x80-a40'], ['t-slot-frame-s10', 's10-l90x90-a45', 's10-l90x90-a45']] as const;
    for (const [familyId, frameKey, capKey] of cases) {
      const { document, id } = placed(familyId, frameKey, '1000');
      const candidates = accessoryCandidates(document, id, 'frame-end-caps', registry);
      expect(candidates.ok && candidates.value.map((item) => [item.itemKey, item.quarterTurn]), frameKey).toEqual([[capKey, 0]]);
    }
    const { document, id } = placed(FRAME, 's6-40x40', '1000');
    const square = accessoryCandidates(document, id, 'frame-end-caps', registry);
    expect(square.ok && square.value.map((item) => item.itemKey)).toContain('s6-40x40');
    expect(square.ok && square.value.map((item) => item.itemKey)).not.toContain('s6-l40x40-a20');
  });

  it('1 つの角の大きな丸みの行(外周が長方形でない 5 行)には、同じ外形の四角のキャップを出さず、合うフレームの鍵を持つ R 形のキャップ 1 つだけを向きを変えずに出す', () => {
    const cases = [['t-slot-frame-s6', 's6-20x20-r15'], ['t-slot-frame-s8', 's8-30x30-r22'], ['t-slot-frame-s8', 's8-60x60-r48'],
      ['t-slot-frame-s10', 's10-40x40-r32'], ['t-slot-frame-s10', 's10-45x45-r35']] as const;
    for (const [familyId, frameKey] of cases) {
      expect(registry.loaded(familyId)?.rows.some((row) => row.key === frameKey), frameKey).toBe(true);
      const { document, id } = placed(familyId, frameKey, '1000');
      const result = accessoryCandidates(document, id, 'frame-end-caps', registry);
      // R 形のキャップの行の鍵は合うフレームの行の鍵と同じ(行の fitsFrameKeys で照らす)。
      expect(result.ok ? result.value.map((item) => [item.itemKey, item.quarterTurn]) : result.reason, frameKey).toEqual([[frameKey, 0]]);
    }
  });

  it('全長・両端: 1000 の線で本体 994 を +Z へ 3 ずらし、キャップ 2 個を線の両端に置き、組・記録・版 23 を足す', () => {
    const { document, id } = placed(FRAME, FRAME_ROW, '1000');
    const result = applyAccessorySet(document, id, 'frame-end-caps', { ends: 'both', endReference: 'overall', itemKey: 's6-20x20' }, registry);
    if (!result.ok) throw new Error(result.reason);
    const next = result.value.document;
    expect(next.components.map((component) => component.source.kind === 'standardPart' ? component.source.options.length ?? null : null))
      .toEqual(['994', null, null]);
    expect(positions(next)).toEqual([[100, 200, 303], [100, 200, 300], [100, 200, 1297]]);
    expect(new Set(next.components.map((component) => component.rigidGroupId)).size).toBe(1);
    expect(next.accessorySets).toEqual([{ id: 'accessory-1', setId: 'frame-end-caps', hostComponentId: id,
      accessories: [{ componentId: result.value.componentIds[0], role: 'startCap' }, { componentId: result.value.componentIds[1], role: 'endCap' }],
      choices: { ends: 'both', endReference: 'overall', itemKey: 's6-20x20' } }]);
    expect(next.schemaVersion).toBe(Math.max(document.schemaVersion, ACCESSORY_SETS_SCHEMA_VERSION));
    expect(document.components).toHaveLength(1);
  });

  it('本体の長さ・終点だけ: 本体は変えず、キャップを線の外(1300〜1303)へ置く', () => {
    const { document, id } = placed(FRAME, FRAME_ROW, '1000');
    const result = applyAccessorySet(document, id, 'frame-end-caps', { ends: 'end', endReference: 'member', itemKey: 's6-20x20' }, registry);
    if (!result.ok) throw new Error(result.reason);
    expect(positions(result.value.document)).toEqual([[100, 200, 300], [100, 200, 1300]]);
  });

  it('向きを回した本体(長さが +X)でも、キャップは線の端に付く', () => {
    const { document, id } = placed(FRAME, FRAME_ROW, '1000', quaternionFromAxisAngle([0, 1, 0], Math.PI / 2));
    const result = applyAccessorySet(document, id, 'frame-end-caps', { ends: 'both', endReference: 'overall', itemKey: 's6-20x20' }, registry);
    if (!result.ok) throw new Error(result.reason);
    expect(positions(result.value.document).map((point) => point.map((value) => Math.round(value * 1e6) / 1e6)))
      .toEqual([[103, 200, 300], [100, 200, 300], [1097, 200, 300]]);
  });

  it('溝の無い族・小形のフレーム・候補に無い行・縮めて長さが 0 以下は、何も変えずに理由を返す', () => {
    const pipe = placed('aluminum-square-pipe', registry.loaded('aluminum-square-pipe')?.rows[0]?.key ?? '', '500');
    expect(accessoryCandidates(pipe.document, pipe.id, 'frame-end-caps', registry)).toEqual({ ok: false, reason: 'notFrame' });
    const smallRows = registry.loaded('t-slot-frame-small')?.rows ?? [];
    const noCap = placed('t-slot-frame-small', smallRows[0]?.key ?? '', '300');
    expect(accessoryCandidates(noCap.document, noCap.id, 'frame-end-caps', registry)).toEqual({ ok: false, reason: 'noMatchingCap' });
    const { document, id } = placed(FRAME, FRAME_ROW, '1000');
    expect(applyAccessorySet(document, id, 'frame-end-caps', { ends: 'both', endReference: 'overall', itemKey: 'nothing' }, registry))
      .toEqual({ ok: false, reason: 'unknownItem' });
    const short = placed(FRAME, FRAME_ROW, '6');
    expect(applyAccessorySet(short.document, short.id, 'frame-end-caps', { ends: 'both', endReference: 'overall', itemKey: 's6-20x20' }, registry).ok)
      .toBe(false);
    expect(accessoryCandidates(document, 'component-9', 'frame-end-caps', registry)).toEqual({ ok: false, reason: 'noHost' });
  });

  it('小形のフレームは、キャップの行の合うフレームの鍵(fitsFrameKeys)だけで照らし、外形が同じで溝の違うキャップを出さない', () => {
    const rows = registry.loaded('t-slot-frame-small')?.rows ?? [];
    const caps = registry.loaded('t-slot-frame-cap-small')?.rows ?? [];
    for (const row of rows) {
      const { document, id } = placed('t-slot-frame-small', row.key, '300');
      const result = accessoryCandidates(document, id, 'frame-end-caps', registry);
      const expected = caps.filter((cap) => cap.fitsFrameKeys?.includes(row.key) === true).map((cap) => cap.key);
      expect(result.ok ? result.value.map((item) => item.itemKey) : []).toEqual(expected);
    }
    expect(caps.filter((cap) => cap.fitsFrameKeys !== undefined).length).toBeGreaterThan(0);
  });

  it('溝幅 6・8・10 の族の全部の行で、候補の行は溝の呼びと外形(入れ替えを含む)が合う物だけ', () => {
    for (const familyId of [FRAME, 't-slot-frame-s8', 't-slot-frame-s10']) {
      for (const row of registry.loaded(familyId)?.rows ?? []) {
        const { document, id } = placed(familyId, row.key, '1000');
        const result = accessoryCandidates(document, id, 'frame-end-caps', registry);
        if (!result.ok) { expect(result.reason).toBe('noMatchingCap'); continue; }
        for (const item of result.value) {
          const cap = registry.loaded('t-slot-frame-cap')?.rows.find((candidate) => candidate.key === item.itemKey);
          const [w, h] = item.quarterTurn === 0 ? [row.dims.width, row.dims.height] : [row.dims.height, row.dims.width];
          expect([cap?.dims.width, cap?.dims.height]).toEqual([w, h]);
        }
      }
    }
  });
});
