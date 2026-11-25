/**
 * アルミフレームの族(E-03 の汎用の T スロットフレーム)の部品を、初めの値と指定の値で置いたアセンブリの保存と開き直し(JSON と ZIP)。
 * 開き直しても出どころが同じバイトで残り、開き直した文書から同じ形が組める事を確かめる。
 * 族ごとに全部の行を置く保存と開き直しは、登録の表から回す catalogRegistryPersistence.test.ts が見る(P2。板の 2 族を含む)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, buildStandardPartFromSource, createAssemblyDocument, createComponentFor, createStandardPartSource,
  frameSlotCandidates, planFrameMembers, planMemberStretch, PRODUCT_CATALOG_REGISTRY, resolveAssembly, type AssemblyDocument,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { readPcadaFile, writePcadaFile } from './pcadFile.js';

const SAVE_OPTIONS = { savedAt: '2026-11-16T00:00:00.000Z' };
const FAMILY = 't-slot-frame-specified';
/** E-04 の汎用の部品(ブラケット・つなぎ板・T 溝用のナット)。 */
const PARTS = ['angle-bracket-specified', 'join-plate-specified', 'slot-nut-specified'];
/** 製造元の寸法に合わせたフレームの系列(仮の id)。 */
const SERIES = 't-slot-frame-series';

describe('アルミフレームの族の部品の保存と開き直し', () => {
  it('汎用の T スロットフレームと汎用の部品 3 つを初めの値と指定の値で置いた文書は、JSON と ZIP で開き直しても同じで、組める', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure([FAMILY]);
    expect(PRODUCT_CATALOG_REGISTRY.entry(FAMILY)?.group).toBe('aluminumFrame');
    const sources = [
      createStandardPartSource('catalogItem', '寸法指定', { family: FAMILY, item: 'specified' }),
      createStandardPartSource('catalogItem', '寸法指定', { family: FAMILY, item: 'specified', width: '30', slotOpening: '6',
        shoulder: '3', slotInnerWidth: '13', slotDepth: '5', centerHole: '5', cornerRadius: '1.5', length: '600*2' }),
    ];
    expect(sources.map((source) => source.options.length)).toEqual(['1000', '600*2']);
    await PRODUCT_CATALOG_REGISTRY.ensure([...PARTS, SERIES]);
    const series = PRODUCT_CATALOG_REGISTRY.loaded(SERIES)?.rows.map((row) => createStandardPartSource('catalogItem', row.size,
      { family: SERIES, item: row.key, length: '750' })) ?? [];
    expect(series.length).toBeGreaterThan(0);
    const parts = [
      ...PARTS.map((family) => createStandardPartSource('catalogItem', '寸法指定', { family, item: 'specified' })),
      createStandardPartSource('catalogItem', '寸法指定', { family: 'slot-nut-specified', item: 'specified', thread: 'M6',
        neckWidth: '8', neckHeight: '3' }),
    ];
    expect(parts.map((source) => source.catalogRevision)).toEqual([...PARTS.map((family) => `${family}-2026-11-r1`),
      'slot-nut-specified-2026-11-r1']);
    let document: AssemblyDocument = createAssemblyDocument('アルミフレームの保存');
    for (const source of [...sources, ...parts, ...series]) document = addComponent(document, createComponentFor(document, source));
    const text = writeAssemblyDocument(document, SAVE_OPTIONS);
    const bytes = await writePcadaFile(document, SAVE_OPTIONS);
    const json = readAssemblyDocument(text);
    const zip = await readPcadaFile(bytes);
    if (!json.ok || !zip.ok) throw new Error('reopen failed');
    for (const reopened of [json.document, zip.document]) {
      expect(reopened).toEqual(document);
      expect(writeAssemblyDocument(reopened, SAVE_OPTIONS)).toBe(text);
      expect(await writePcadaFile(reopened, SAVE_OPTIONS)).toEqual(bytes);
      const resolved = resolveAssembly(reopened, { standardPart: buildStandardPartFromSource });
      expect(resolved.errors).toEqual([]);
      expect(resolved.parts.size).toBe(sources.length + parts.length + series.length);
    }
  });
});

describe('外周指定のフレームの配置・伸縮・読み戻し', () => {
  it.each([
    ['t-slot-frame-s6', 's6-40x60-t2s3', 6, 40, 60, 10, [10, 50, 20]],
    ['t-slot-frame-s8', 's8-50x100-t2s4', 8, 50, 100, 12, [10, 70, 20]],
    ['t-slot-frame-s10', 's10-45x60-t1s1', 10, 45, 60, 4, [10, 50, 30]],
  ] as const)('%s/%s の溝は断面を回して置き、伸縮して保存しても同じ面にある',
    async (familyId, itemKey, nominal, width, height, count, mouth) => {
      await PRODUCT_CATALOG_REGISTRY.ensure([familyId]);
      const family = PRODUCT_CATALOG_REGISTRY.loaded(familyId);
      const row = family?.rows.find((item) => item.key === itemKey);
      if (family === undefined || row === undefined) throw new Error(itemKey);
      const values = { length: '300' };
      const bounds = family.sectionBounds?.(row, values);
      if (bounds === null || bounds === undefined) throw new Error(itemKey);
      const plan = planFrameMembers([{ start: [10, 20, 30], end: [310, 20, 30] }],
        { section: bounds, up: [0, 0, 1], quarterTurns: 1, startExtension: 0, endExtension: 0, corners: 'none' });
      if (!plan.ok || plan.members[0] === undefined) throw new Error(itemKey);
      const { placement } = plan.members[0];
      const [x, y, z] = placement.position;
      const source = createStandardPartSource('catalogItem', row.size, { family: familyId, item: itemKey, ...values });
      expect([source.catalogRevision, source.generatorRevision]).toEqual([`${familyId}-2026-11-r1`, 't-slot-2']);
      const empty = createAssemblyDocument('外周指定');
      const component = createComponentFor(empty, source, {
        placement: { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)],
          rotation: placement.rotation },
      });
      const document = addComponent(empty, component);
      const placements = new Map([[component.id, placement]]);
      const original = frameSlotCandidates(document, placements)[0];
      expect(original?.slotWidth).toBe(nominal);
      expect(original?.lines).toHaveLength(count);
      expect(original?.lines.map((item) => item.nominalWidth)).toEqual(Array.from({ length: count }, () => nominal));
      const box = { min: [10, 20 - height / 2, 30 - width / 2], max: [310, 20 + height / 2, 30 + width / 2] } as const;
      const extended = planMemberStretch(document, { direction: '+x', plane: 160, amount: 50 }, new Map([[component.id, box]]));
      if (!extended.ok) throw new Error(extended.reason);
      const reopened = readAssemblyDocument(writeAssemblyDocument(extended.document, SAVE_OPTIONS));
      if (!reopened.ok) throw new Error('reopen failed');
      expect(reopened.document.components[0]?.source).toEqual({ ...source, options: { ...source.options, length: '350' } });
      expect(reopened.document.components[0]?.placement).toEqual(component.placement);
      const resolved = resolveAssembly(reopened.document, { standardPart: buildStandardPartFromSource });
      expect(resolved.errors).toEqual([]);
      expect(resolved.parts.size).toBe(1);
      const frame = frameSlotCandidates(reopened.document, placements)[0];
      const line = frame?.lines.find((item) => item.face === 'bottom');
      const round = (vector: readonly number[] | undefined): number[] | undefined =>
        vector?.map((coordinate) => Math.round(coordinate * 1e6) / 1e6 + 0);
      expect([frame?.slotWidth, frame?.slotPositionSimplified, frame?.lines.length, line?.nominalWidth]).toEqual([nominal, true, count, nominal]);
      expect([round(line?.start), round(line?.end), round(line?.inward), round(line?.across)])
        .toEqual([mouth, [360, mouth[1], mouth[2]], [0, -1, 0], [0, 0, 1]]);
    });
});
