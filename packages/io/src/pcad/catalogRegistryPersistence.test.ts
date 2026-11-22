/**
 * 登録の表(PRODUCT_CATALOG_REGISTRY)の全部の族の全部の行を、族ごとに 1 つのアセンブリに置いて保存し(JSON と ZIP)、開き直しても同じで、
 * 書き直した文字とバイトが一致し、組めて誤りが 0 で、部品の数が行の数と同じ事を確かめる(P2。族ごとの保存の検査を 1 つにした)。
 * 族と行の数は登録の表から導く。族を足しても、この検査は直さなくてよい。欄の値は製品の既定(行ごとの既定を含む)で、
 * 今までの族ごとの検査が既定でない値を渡していた族だけ、その値を渡す(EXPLICIT_VALUES)。
 * 選ぶ窓に出さない行(listed: false)と、前の呼び(formerSizes)で保存した部品(前の版で保存したファイルの形)も、同じ書き手と読み手で開き直せる事を見る。
 */
import {
  addComponent, buildStandardPartFromSource, createAssemblyDocument, createComponentFor, createStandardPartSource,
  PRODUCT_CATALOG_REGISTRY, resolveAssembly, type AssemblyDocument, type StandardPartSource,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { readPcadaFile, writePcadaFile } from './pcadFile.js';

const SAVE_OPTIONS = { savedAt: '2026-11-20T00:00:00.000Z' };
const FRAME_LENGTH = { length: '300' };
const PIPE_FRAME_LENGTH = { length: '500' };
const SMALL_FRAME_LENGTH = { length: '400' };
/**
 * 既定でない値を渡す族。値は今までの族ごとの保存の検査(k4b・k6)が渡していた物のまま。式の文字が保存に残る事も一緒に見る。
 * ここに無い族は製品の既定の値で置く(新しい族は、既定の値で全部の行が置ける事をここで確かめる)。
 */
const EXPLICIT_VALUES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'parallel-pin': { length: '12*2' },
  'compression-spring': { wireDiameter: '1.6', meanDiameter: '12', freeLength: '40', totalCoils: '7.5' },
  't-slot-frame-series': { length: '750' },
  't-slot-frame-s6': FRAME_LENGTH, 't-slot-frame-s8': FRAME_LENGTH, 't-slot-frame-s10': FRAME_LENGTH,
  'aluminum-channel': FRAME_LENGTH, 'aluminum-square-pipe': FRAME_LENGTH, 'aluminum-round-bar': FRAME_LENGTH,
  'aluminum-flat-bar': FRAME_LENGTH, 'aluminum-angle': FRAME_LENGTH,
  't-slot-nut-bar': { length: '120' },
  'panel-cover-frame': PIPE_FRAME_LENGTH,
  'slot-long-part': FRAME_LENGTH,
  'pipe-frame': PIPE_FRAME_LENGTH, 'pipe-frame-slotted': PIPE_FRAME_LENGTH, 'pipe-frame-twin': PIPE_FRAME_LENGTH,
  't-slot-frame-small': SMALL_FRAME_LENGTH, 'bracket-stock': SMALL_FRAME_LENGTH,
  // 板の注文の寸法: 今までの k6 の板の検査が渡していた幅 100 × 高さ 50(どの行のサイズの上限にも収まる)。
  'panel-board-order': { width: '100', height: '50' },
};
const FAMILY_IDS = PRODUCT_CATALOG_REGISTRY.entries.map((entry) => entry.id);

function assemblyOf(name: string, sources: readonly StandardPartSource[]): AssemblyDocument {
  let document = createAssemblyDocument(name);
  for (const source of sources) document = addComponent(document, createComponentFor(document, source));
  return document;
}

describe('登録の表の全部の族の部品の保存と開き直し', () => {
  it('値を渡す族は登録の表にあり、登録の表の族の id は重ならない', () => {
    const ids = PRODUCT_CATALOG_REGISTRY.entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(EXPLICIT_VALUES).filter((id) => !ids.includes(id))).toEqual([]);
    expect(FAMILY_IDS.length).toBeGreaterThan(0);
  });

  it.each(FAMILY_IDS)('%s の全部の行を置いた文書は、JSON と ZIP で開き直しても同じで、書き直した文字とバイトが一致し、全部組める', async (id) => {
    await PRODUCT_CATALOG_REGISTRY.ensure([id]);
    const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
    if (family === undefined) throw new Error(`family not loaded: ${id}`);
    expect(family.rows.length).toBeGreaterThan(0);
    const values = EXPLICIT_VALUES[id] ?? {};
    const sources = family.rows.map((row) => createStandardPartSource('catalogItem', row.size, { family: id, item: row.key, ...values }));
    expect(sources.every((source) => source.catalogRevision !== '' && source.generatorRevision !== '')).toBe(true);
    for (const [key, value] of Object.entries(values)) expect(sources.every((source) => source.options[key] === value), key).toBe(true);
    const document = assemblyOf(`${id} の保存`, sources);
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
      expect(resolved.parts.size).toBe(sources.length);
    }
  });

  it('選ぶ窓に出さない行と、前の呼びで保存した部品は、JSON と ZIP で開き直しても同じで、保存の欄の食い違いにならずに組め、今の呼びの部品も今どおり', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(FAMILY_IDS);
    const sources: StandardPartSource[] = [];
    const counts = { unlisted: 0, former: 0 };
    for (const id of FAMILY_IDS) {
      for (const row of PRODUCT_CATALOG_REGISTRY.loaded(id)?.rows.filter((item) => item.listed === false || item.formerSizes !== undefined) ?? []) {
        const options = { family: id, item: row.key, ...(EXPLICIT_VALUES[id] ?? {}) };
        const current = createStandardPartSource('catalogItem', row.size, options);
        // 前の版で保存した形: 鍵・欄・版は今と同じで、呼びだけが前の呼び。前の呼びから作り直すと今の呼びの形になる。
        const former = (row.formerSizes ?? []).map((size) => ({ ...current, size }));
        for (const saved of former) expect(createStandardPartSource('catalogItem', saved.size, options), row.key).toEqual(current);
        sources.push(current, ...former);
        counts.former += former.length;
        if (row.listed === false) counts.unlisted += 1;
      }
    }
    expect(counts.unlisted > 0 && counts.former > 0, JSON.stringify(counts)).toBe(true);
    const document = assemblyOf('選ぶ窓に出さない行と前の呼びの保存', sources);
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
      expect(resolved.parts.size).toBe(sources.length);
    }
  });
});
