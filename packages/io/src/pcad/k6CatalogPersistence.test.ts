/**
 * アルミフレームの族(E-03 の汎用の T スロットフレーム)の部品を置いたアセンブリの保存と開き直し(JSON と ZIP)。
 * 開き直しても出どころが同じバイトで残り、開き直した文書から同じ形が組める事を確かめる。
 */
import {
  addComponent, buildStandardPartFromSource, createAssemblyDocument, createComponentFor, createStandardPartSource,
  PRODUCT_CATALOG_REGISTRY, resolveAssembly, type AssemblyDocument,
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
    expect(series).toHaveLength(6);
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
      expect(resolved.parts.size).toBe(12);
    }
  });

  it('資料 1 の溝つきフレームの 3 族と形材の 5 族の全部の行を置いた文書は、JSON と ZIP で開き直しても同じで、全部組める', async () => {
    const families = ['t-slot-frame-s6', 't-slot-frame-s8', 't-slot-frame-s10', 'aluminum-channel', 'aluminum-square-pipe', 'aluminum-round-bar',
      'aluminum-flat-bar', 'aluminum-angle'];
    await PRODUCT_CATALOG_REGISTRY.ensure(families);
    const sources = families.flatMap((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.map((row) => createStandardPartSource(
      'catalogItem', row.size, { family, item: row.key, length: '300' })) ?? []);
    expect(sources.length).toBe(families.reduce((sum, family) => sum + (PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.length ?? 0), 0));
    expect(sources.length).toBeGreaterThan(0);
    let document: AssemblyDocument = createAssemblyDocument('資料 1 のフレームの保存');
    for (const source of sources) document = addComponent(document, createComponentFor(document, source));
    const text = writeAssemblyDocument(document, SAVE_OPTIONS);
    const bytes = await writePcadaFile(document, SAVE_OPTIONS);
    const json = readAssemblyDocument(text);
    const zip = await readPcadaFile(bytes);
    if (!json.ok || !zip.ok) throw new Error('reopen failed');
    for (const reopened of [json.document, zip.document]) {
      expect(reopened).toEqual(document);
      expect(writeAssemblyDocument(reopened, SAVE_OPTIONS)).toBe(text);
      const resolved = resolveAssembly(reopened, { standardPart: buildStandardPartFromSource });
      expect(resolved.errors).toEqual([]);
      expect(resolved.parts.size).toBe(sources.length);
    }
  });

  it('資料 1 の部品の 9 族(ナットの素材・ナット・丸ナット・端のキャップ・平板のブラケット・平板の L・T・十字・L 形のブラケット・ベースの板・アジャスター)の全部の行を置いた文書は、JSON と ZIP で開き直しても同じで、全部組める', async () => {
    const families = ['t-slot-nut-bar', 't-slot-nut', 't-slot-round-nut', 't-slot-frame-cap', 't-slot-flat-plate', 't-slot-shaped-plate',
      't-slot-angle-bracket', 't-slot-foot-base', 't-slot-adjuster'];
    await PRODUCT_CATALOG_REGISTRY.ensure(families);
    // 長さの欄はナットの素材(棒材)だけが持つ。ほかの族は保存の形に長さを書かない。
    const sources = families.flatMap((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.map((row) => createStandardPartSource(
      'catalogItem', row.size, family === 't-slot-nut-bar' ? { family, item: row.key, length: '120' } : { family, item: row.key })) ?? []);
    expect(families.map((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.length)).toEqual([12, 132, 4, 56, 11, 15, 65, 78, 55]);
    let document: AssemblyDocument = createAssemblyDocument('資料 1 の部品の保存');
    for (const source of sources) document = addComponent(document, createComponentFor(document, source));
    const text = writeAssemblyDocument(document, SAVE_OPTIONS);
    const bytes = await writePcadaFile(document, SAVE_OPTIONS);
    const json = readAssemblyDocument(text);
    const zip = await readPcadaFile(bytes);
    if (!json.ok || !zip.ok) throw new Error('reopen failed');
    for (const reopened of [json.document, zip.document]) {
      expect(reopened).toEqual(document);
      expect(writeAssemblyDocument(reopened, SAVE_OPTIONS)).toBe(text);
      const resolved = resolveAssembly(reopened, { standardPart: buildStandardPartFromSource });
      expect(resolved.errors).toEqual([]);
      expect(resolved.parts.size).toBe(sources.length);
    }
  });

  it('資料 1 の板の 2 族(定尺・幅と高さを入れる)の全部の行を置いて保存し、開き直しても同じで、組み立てで形ができる(注文の寸法は幅と高さを書く)', async () => {
    const families = ['panel-board-fixed', 'panel-board-order'];
    await PRODUCT_CATALOG_REGISTRY.ensure(families);
    // 幅 100 × 高さ 50 は、どの行のサイズの上限にも収まる(上限の最も小さい行は 500 × 100)。
    const sources = families.flatMap((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.map((row) => createStandardPartSource(
      'catalogItem', row.size, family === 'panel-board-order' ? { family, item: row.key, width: '100', height: '50' } : { family, item: row.key })) ?? []);
    expect(families.map((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.length)).toEqual([8, 66]);
    let document: AssemblyDocument = createAssemblyDocument('資料 1 の板の保存');
    for (const source of sources) document = addComponent(document, createComponentFor(document, source));
    const text = writeAssemblyDocument(document, SAVE_OPTIONS);
    const bytes = await writePcadaFile(document, SAVE_OPTIONS);
    const json = readAssemblyDocument(text);
    const zip = await readPcadaFile(bytes);
    if (!json.ok || !zip.ok) throw new Error('reopen failed');
    for (const reopened of [json.document, zip.document]) {
      expect(reopened).toEqual(document);
      expect(writeAssemblyDocument(reopened, SAVE_OPTIONS)).toBe(text);
      const resolved = resolveAssembly(reopened, { standardPart: buildStandardPartFromSource });
      expect(resolved.errors).toEqual([]);
      expect(resolved.parts.size).toBe(sources.length);
    }
  });

  it('資料 2 のパネル扉の部品・パネル用のフレーム・コネクタ・キャップと足の部品・可動の部品・アクセサリ(外形を包む形)の全部の行を置いて保存し、開き直しても同じで、組み立てで形ができる', async () => {
    const families = ['panel-part-box', 'panel-cover-frame', 'connector-box', 'cap-foot-box', 'movable-part-box', 'accessory-box'];
    await PRODUCT_CATALOG_REGISTRY.ensure(families);
    // 長さの欄はフレームだけが持つ。部品とコネクタは保存の形に長さを書かない。
    const sources = families.flatMap((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.map((row) => createStandardPartSource(
      'catalogItem', row.size, family === 'panel-cover-frame' ? { family, item: row.key, length: '500' } : { family, item: row.key })) ?? []);
    expect(families.map((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.length)).toEqual([7, 9, 74, 8, 12, 5]);
    let document: AssemblyDocument = createAssemblyDocument('資料 2 のパネル扉の部品の保存');
    for (const source of sources) document = addComponent(document, createComponentFor(document, source));
    const text = writeAssemblyDocument(document, SAVE_OPTIONS);
    const bytes = await writePcadaFile(document, SAVE_OPTIONS);
    const json = readAssemblyDocument(text);
    const zip = await readPcadaFile(bytes);
    if (!json.ok || !zip.ok) throw new Error('reopen failed');
    for (const reopened of [json.document, zip.document]) {
      expect(reopened).toEqual(document);
      expect(writeAssemblyDocument(reopened, SAVE_OPTIONS)).toBe(text);
      const resolved = resolveAssembly(reopened, { standardPart: buildStandardPartFromSource });
      expect(resolved.errors).toEqual([]);
      expect(resolved.parts.size).toBe(sources.length);
    }
  });

  it('資料 1 の小さい部品の 3 族と長物の族の全部の行を置いた文書は、JSON と ZIP で開き直しても同じで、全部組める', async () => {
    const families = [
      'slider-box', 'cap-accessory-box', 'foot-part-box', 'slot-long-part'];
    await PRODUCT_CATALOG_REGISTRY.ensure(families);
    // 長さの欄は slot-long-part だけが持つ(行の長さの上限より短い 300)。ほかの族は保存の形に長さを書かない。
    const sources = families.flatMap((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.map((row) => createStandardPartSource(
      'catalogItem', row.size, family === 'slot-long-part' ? { family, item: row.key, length: '300' } : { family, item: row.key })) ?? []);
    expect(families.map((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.length)).toEqual([4, 5, 7, 21]);
    let document: AssemblyDocument = createAssemblyDocument('資料 1 の小さい部品と長物の保存');
    for (const source of sources) document = addComponent(document, createComponentFor(document, source));
    const text = writeAssemblyDocument(document, SAVE_OPTIONS);
    const bytes = await writePcadaFile(document, SAVE_OPTIONS);
    const json = readAssemblyDocument(text);
    const zip = await readPcadaFile(bytes);
    if (!json.ok || !zip.ok) throw new Error('reopen failed');
    for (const reopened of [json.document, zip.document]) {
      expect(reopened).toEqual(document);
      expect(writeAssemblyDocument(reopened, SAVE_OPTIONS)).toBe(text);
      const resolved = resolveAssembly(reopened, { standardPart: buildStandardPartFromSource });
      expect(resolved.errors).toEqual([]);
      expect(resolved.parts.size).toBe(sources.length);
    }
  });

  it('資料 1 の扉の部品の族の全部の行を置いた文書は、JSON と ZIP で開き直しても同じで、全部組める', async () => {
    const families = [
      'door-part-box'];
    await PRODUCT_CATALOG_REGISTRY.ensure(families);
    // 足した族はどれも長さの欄を持たない(保存の形に長さを書かない)。
    const sources = families.flatMap((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.map((row) => createStandardPartSource(
      'catalogItem', row.size, { family, item: row.key })) ?? []);
    expect(families.map((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.length)).toEqual([17]);
    let document: AssemblyDocument = createAssemblyDocument('資料 1 の扉の部品の保存');
    for (const source of sources) document = addComponent(document, createComponentFor(document, source));
    const text = writeAssemblyDocument(document, SAVE_OPTIONS);
    const bytes = await writePcadaFile(document, SAVE_OPTIONS);
    const json = readAssemblyDocument(text);
    const zip = await readPcadaFile(bytes);
    if (!json.ok || !zip.ok) throw new Error('reopen failed');
    for (const reopened of [json.document, zip.document]) {
      expect(reopened).toEqual(document);
      expect(writeAssemblyDocument(reopened, SAVE_OPTIONS)).toBe(text);
      const resolved = resolveAssembly(reopened, { standardPart: buildStandardPartFromSource });
      expect(resolved.errors).toEqual([]);
      expect(resolved.parts.size).toBe(sources.length);
    }
  });

  it('キャスターの族の全部の行を置いて保存し、開き直しても同じで、組み立てで形ができる', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(['t-slot-caster']);
    const family = 't-slot-caster';
    const sources = PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.map((row) => createStandardPartSource('catalogItem', row.size,
      { family, item: row.key })) ?? [];
    expect(sources.length).toBe(229);
    let document: AssemblyDocument = createAssemblyDocument('キャスターの保存');
    for (const source of sources) document = addComponent(document, createComponentFor(document, source));
    const text = writeAssemblyDocument(document, SAVE_OPTIONS);
    const bytes = await writePcadaFile(document, SAVE_OPTIONS);
    const json = readAssemblyDocument(text);
    const zip = await readPcadaFile(bytes);
    if (!json.ok || !zip.ok) throw new Error('reopen failed');
    for (const reopened of [json.document, zip.document]) {
      expect(reopened).toEqual(document);
      expect(writeAssemblyDocument(reopened, SAVE_OPTIONS)).toBe(text);
      const resolved = resolveAssembly(reopened, { standardPart: buildStandardPartFromSource });
      expect(resolved.errors).toEqual([]);
      expect(resolved.parts.size).toBe(sources.length);
    }
  });

  it('資料 2 のパイプ形のフレームの 3 族(1 本・溝つき・2 本つなぎ)の全部の行を置いて保存し、開き直しても同じで、組み立てで形ができる', async () => {
    const families = ['pipe-frame', 'pipe-frame-slotted', 'pipe-frame-twin'];
    await PRODUCT_CATALOG_REGISTRY.ensure(families);
    const sources = families.flatMap((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.map((row) => createStandardPartSource(
      'catalogItem', row.size, { family, item: row.key, length: '500' })) ?? []);
    expect(families.map((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.length)).toEqual([18, 3, 10]);
    let document: AssemblyDocument = createAssemblyDocument('資料 2 のパイプ形のフレームの保存');
    for (const source of sources) document = addComponent(document, createComponentFor(document, source));
    const text = writeAssemblyDocument(document, SAVE_OPTIONS);
    const bytes = await writePcadaFile(document, SAVE_OPTIONS);
    const json = readAssemblyDocument(text);
    const zip = await readPcadaFile(bytes);
    if (!json.ok || !zip.ok) throw new Error('reopen failed');
    for (const reopened of [json.document, zip.document]) {
      expect(reopened).toEqual(document);
      expect(writeAssemblyDocument(reopened, SAVE_OPTIONS)).toBe(text);
      const resolved = resolveAssembly(reopened, { standardPart: buildStandardPartFromSource });
      expect(resolved.errors).toEqual([]);
      expect(resolved.parts.size).toBe(sources.length);
    }
  });

  it('資料 1 の溝に入れる小物の 3 族(ジョイントバー・スタッド・ローレットナット)の全部の行を置いて保存し、開き直しても同じで、組み立てで形ができる', async () => {
    const families = ['t-slot-joint-bar', 't-slot-stud', 't-slot-knurled-nut'];
    await PRODUCT_CATALOG_REGISTRY.ensure(families);
    // どれも 1 個ずつ数える族で、保存の形に長さを書かない。
    const sources = families.flatMap((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.map((row) => createStandardPartSource(
      'catalogItem', row.size, { family, item: row.key })) ?? []);
    expect(families.map((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.length)).toEqual([6, 2, 1]);
    let document: AssemblyDocument = createAssemblyDocument('資料 1 の溝に入れる小物の保存');
    for (const source of sources) document = addComponent(document, createComponentFor(document, source));
    const text = writeAssemblyDocument(document, SAVE_OPTIONS);
    const bytes = await writePcadaFile(document, SAVE_OPTIONS);
    const json = readAssemblyDocument(text);
    const zip = await readPcadaFile(bytes);
    if (!json.ok || !zip.ok) throw new Error('reopen failed');
    for (const reopened of [json.document, zip.document]) {
      expect(reopened).toEqual(document);
      expect(writeAssemblyDocument(reopened, SAVE_OPTIONS)).toBe(text);
      const resolved = resolveAssembly(reopened, { standardPart: buildStandardPartFromSource });
      expect(resolved.errors).toEqual([]);
      expect(resolved.parts.size).toBe(sources.length);
    }
  });

  it('資料 2 のパイプ形のフレームのキャップとフットの 2 族の全部の行を置いて保存し、開き直しても同じで、組み立てで形ができる', async () => {
    const families = ['pipe-frame-cap', 'pipe-frame-foot'];
    await PRODUCT_CATALOG_REGISTRY.ensure(families);
    // どちらも 1 個ずつ数える族で、保存の形に長さを書かない。密度の材質を持たない行(LDPE など)も同じ形で保存する。
    const sources = families.flatMap((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.map((row) => createStandardPartSource(
      'catalogItem', row.size, { family, item: row.key })) ?? []);
    expect(families.map((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.length)).toEqual([18, 15]);
    let document: AssemblyDocument = createAssemblyDocument('資料 2 のキャップとフットの保存');
    for (const source of sources) document = addComponent(document, createComponentFor(document, source));
    const text = writeAssemblyDocument(document, SAVE_OPTIONS);
    const bytes = await writePcadaFile(document, SAVE_OPTIONS);
    const json = readAssemblyDocument(text);
    const zip = await readPcadaFile(bytes);
    if (!json.ok || !zip.ok) throw new Error('reopen failed');
    for (const reopened of [json.document, zip.document]) {
      expect(reopened).toEqual(document);
      expect(writeAssemblyDocument(reopened, SAVE_OPTIONS)).toBe(text);
      const resolved = resolveAssembly(reopened, { standardPart: buildStandardPartFromSource });
      expect(resolved.errors).toEqual([]);
      expect(resolved.parts.size).toBe(sources.length);
    }
  });

  it('資料 1 の小さい溝つきフレーム・端のキャップ・ブラケット素材の 3 族の全部の行を置いて保存し、開き直しても同じで、組み立てで形ができる', async () => {
    const families = ['t-slot-frame-small', 't-slot-frame-cap-small', 'bracket-stock'];
    await PRODUCT_CATALOG_REGISTRY.ensure(families);
    // 長さの欄は小さい溝つきフレームとブラケット素材だけが持つ。キャップは保存の形に長さを書かない。
    const sources = families.flatMap((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.map((row) => createStandardPartSource(
      'catalogItem', row.size, family === 't-slot-frame-cap-small' ? { family, item: row.key } : { family, item: row.key, length: '400' })) ?? []);
    expect(families.map((family) => PRODUCT_CATALOG_REGISTRY.loaded(family)?.rows.length)).toEqual([14, 6, 2]);
    let document: AssemblyDocument = createAssemblyDocument('資料 1 の小さい溝つきフレームの保存');
    for (const source of sources) document = addComponent(document, createComponentFor(document, source));
    const text = writeAssemblyDocument(document, SAVE_OPTIONS);
    const bytes = await writePcadaFile(document, SAVE_OPTIONS);
    const json = readAssemblyDocument(text);
    const zip = await readPcadaFile(bytes);
    if (!json.ok || !zip.ok) throw new Error('reopen failed');
    for (const reopened of [json.document, zip.document]) {
      expect(reopened).toEqual(document);
      expect(writeAssemblyDocument(reopened, SAVE_OPTIONS)).toBe(text);
      const resolved = resolveAssembly(reopened, { standardPart: buildStandardPartFromSource });
      expect(resolved.errors).toEqual([]);
      expect(resolved.parts.size).toBe(sources.length);
    }
  });
});
