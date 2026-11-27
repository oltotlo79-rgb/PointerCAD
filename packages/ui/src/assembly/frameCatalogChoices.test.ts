/**
 * 資料 1 のフレームの族(溝幅ごとの 3 族・形材の 5 族)と部品の 4 族の、選ぶ画面の行の文字と説明の 1 行。
 * 寸法の線図はまだ描かない(後の包み)ので、足した線図の種類 flatBar・roundBar は図なしの扱い(行の文字は呼び、説明は長さの欄の 1 行)になる事を確かめる。
 */
import { buildStandardPartFromSource, createCatalogItemSource, PRODUCT_CATALOG_REGISTRY } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { familyFigurePart } from './dimensionTable.js';
import { catalogFamilyEntries, catalogRowLabel, familyHintKey, familyKindKey, messageKeyOr } from './catalogFamilyChoices.js';

const T_SLOT = ['t-slot-frame-s6', 't-slot-frame-s8', 't-slot-frame-s10'];
const SECTIONS = ['aluminum-channel', 'aluminum-square-pipe', 'aluminum-round-bar', 'aluminum-flat-bar', 'aluminum-angle'];

/**
 * ids の族がアルミフレームの分類にあり、登録の表でこの並びにある事(間にほかの族があってもよい)。
 * 末尾から数える位置の番号では引かない(族を足しても、この検査を直さなくてよい)。
 */
function expectRegisteredInOrder(ids: readonly string[]): void {
  expect(catalogFamilyEntries('aluminumFrame').map((entry) => entry.id).filter((id) => ids.includes(id))).toEqual([...ids]);
}

describe('資料 1 のフレームの族の選ぶ画面の文字', () => {
  it('登録の表の行が持つ説明の鍵は、どれも i18n にある(族ごとの説明の表を ui に持たないので、型検査の代わりにここで確かめる)', () => {
    const hinted = PRODUCT_CATALOG_REGISTRY.entries.filter((entry) => entry.hint !== undefined);
    expect(hinted.length).toBeGreaterThan(0);
    for (const entry of hinted) expect(messageKeyOr(entry.hint?.key ?? '', 'catalog.mechanical.kind'), entry.id).toBe(entry.hint?.key);
  });

  it('8 族はアルミフレームの分類に並び、種類の名前は i18n にあり、内部の鍵を出さない', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure([...T_SLOT, ...SECTIONS]);
    const entries = catalogFamilyEntries('aluminumFrame').filter((entry) => [...T_SLOT, ...SECTIONS].includes(entry.id));
    expect(entries.map((entry) => entry.id)).toEqual([...T_SLOT, ...SECTIONS]);
    for (const entry of entries) {
      expect(familyKindKey(entry.kindKey)).toBe(entry.kindKey);
      expect(t(familyKindKey(entry.kindKey))).not.toBe(entry.kindKey);
    }
  });

  it('溝つきの行は呼び・溝の口・中の幅・単位質量を出し、説明は製造元の寸法に合わせた系列の 1 行', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(T_SLOT);
    for (const id of T_SLOT) {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
      if (family === undefined) throw new Error(`${id} is not loaded`);
      expect(familyHintKey(family)).toBe('catalog.frame.series.hint');
      for (const row of family.rows) {
        expect(catalogRowLabel(family, row)).toBe(t('catalog.frame.row.series').replace('{size}', row.size)
          .replace('{opening}', String(row.dims.slotOpening)).replace('{inner}', String(row.dims.slotInnerWidth))
          .replace('{mass}', String(row.dims.unitMassKgPerM)));
      }
    }
  });

  it('形材の行は呼びだけを出し(線図の種類 flatBar・roundBar も図なしで落ちない)、説明は長さを自由に入れる 1 行', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(SECTIONS);
    for (const id of SECTIONS) {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
      if (family === undefined) throw new Error(`${id} is not loaded`);
      expect(familyHintKey(family)).toBe('catalog.mechanical.freeLengthPlain');
      expect(family.rows.length).toBeGreaterThan(0);
      for (const row of family.rows) expect(catalogRowLabel(family, row)).toBe(row.size);
    }
    expect(SECTIONS.map((id) => PRODUCT_CATALOG_REGISTRY.loaded(id)?.diagram)).toEqual(['channel', 'rectTube', 'roundBar', 'flatBar', 'angle']);
  });
});

describe('資料 1 の部品の族(ナットの素材・ナット・丸ナット・端のキャップ)の選ぶ画面の文字', () => {
  const PARTS = [['t-slot-nut-bar', 'catalog.frame.nutBar.hint'], ['t-slot-nut', 'catalog.frame.catalogNut.hint'],
    ['t-slot-round-nut', 'catalog.frame.roundNut.hint'], ['t-slot-frame-cap', 'catalog.frame.cap.hint']] as const;

  it('平板のブラケットは部品の 4 族の後に並び、説明は板と穴の 1 行、行の文字は呼びだけ(資料の寸法どおりで簡略の印が無い)', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(['t-slot-flat-plate']);
    expectRegisteredInOrder(['t-slot-flat-plate']);
    const family = PRODUCT_CATALOG_REGISTRY.loaded('t-slot-flat-plate');
    if (family === undefined) throw new Error('t-slot-flat-plate is not loaded');
    expect(familyHintKey(family)).toBe('catalog.frame.flatPlate.hint');
    expect(family.rows.length).toBeGreaterThan(0);
    for (const row of family.rows) {
      expect(row.simplified, row.key).toEqual([]);
      expect(catalogRowLabel(family, row)).toBe(row.size);
    }
  });

  it('4 族はアルミフレームの分類で平板のブラケットの前に並び、説明は族ごとの簡略の形の 1 行、行の文字は呼びに簡略の印を添える', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(PARTS.map(([id]) => id));
    expectRegisteredInOrder(PARTS.map(([id]) => id));
    for (const [id, hint] of PARTS) {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
      if (family === undefined) throw new Error(`${id} is not loaded`);
      expect(familyHintKey(family)).toBe(hint);
      expect(t(familyKindKey(family.kindKey))).not.toBe(family.kindKey);
      expect(family.rows.length).toBeGreaterThan(0);
      for (const row of family.rows) {
        expect(row.simplified?.length, row.key).toBeGreaterThan(0);
        expect(catalogRowLabel(family, row)).toBe(`${row.size}（簡略: ${row.simplified?.join('・') ?? ''}）`);
      }
    }
  });

  it('checks the exact cap simplifications and the documented N4040 lock bolt only', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(['t-slot-frame-cap']);
    const family = PRODUCT_CATALOG_REGISTRY.loaded('t-slot-frame-cap');
    if (family === undefined) throw new Error('t-slot-frame-cap is not loaded');
    const boltDimensions: (readonly [string, number | undefined, number | undefined])[] = [];
    for (const row of family.rows) {
      // SF201-1 PDF 148 gives 4-R2 for 50x50. PDF 244 gives the N4040 lock bolt M5x16.
      const expected = ['取付けの脚と穴'];
      if (row.key !== 's8-50x50') expected.push('角の形');
      if (row.key === 's10-40x40-lock') expected.push('付属のロックボルト');
      expect(row.simplified, row.key).toEqual(expected);
      const { capLockBoltDiameter, capLockBoltLength } = row.dims;
      if (capLockBoltDiameter !== undefined || capLockBoltLength !== undefined) {
        boltDimensions.push([row.key, capLockBoltDiameter, capLockBoltLength]);
      }
    }
    expect(boltDimensions).toEqual([['s10-40x40-lock', 5, 16]]);
  });
});

describe('資料 1 の読み直しで足した 4 族の選ぶ画面の文字', () => {
  const ADDED = [['t-slot-shaped-plate', 'catalog.frame.shapedPlate.hint'], ['t-slot-angle-bracket', 'catalog.frame.angleBracketCatalog.hint'],
    ['t-slot-foot-base', 'catalog.frame.footBase.hint'], ['t-slot-adjuster', 'catalog.frame.adjuster.hint']] as const;

  it('4 族はアルミフレームの分類の最後に並び、説明は族ごとの 1 行、簡略の印のある行は呼びに印を添え、無い行は呼びだけ', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(ADDED.map(([id]) => id));
    expectRegisteredInOrder(ADDED.map(([id]) => id));
    for (const [id, hint] of ADDED) {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
      if (family === undefined) throw new Error(`${id} is not loaded`);
      expect(familyHintKey(family)).toBe(hint);
      expect(t(familyKindKey(family.kindKey))).not.toBe(family.kindKey);
      expect(family.rows.length).toBeGreaterThan(0);
      for (const row of family.rows) {
        const marks = row.simplified ?? [];
        expect(catalogRowLabel(family, row)).toBe(marks.length > 0 ? `${row.size}（簡略: ${marks.join('・')}）` : row.size);
      }
    }
  });
});

describe('資料 1 の溝に入れる小物の 3 族(ジョイントバー・スタッド・ローレットナット)の選ぶ画面の文字', () => {
  const FITTINGS = [['t-slot-joint-bar', 'catalog.frame.jointBar.hint'], ['t-slot-stud', 'catalog.frame.tSlotStud.hint'],
    ['t-slot-knurled-nut', 'catalog.frame.knurledNut.hint']] as const;

  it('3 族はアルミフレームの分類でアジャスターの後に並び、説明は族ごとの 1 行、どの行も呼びに簡略の印を添える', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(FITTINGS.map(([id]) => id));
    expectRegisteredInOrder(FITTINGS.map(([id]) => id));
    for (const [id, hint] of FITTINGS) {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
      if (family === undefined) throw new Error(`${id} is not loaded`);
      expect(familyHintKey(family)).toBe(hint);
      expect(t(hint)).not.toBe(hint);
      expect(t(familyKindKey(family.kindKey))).not.toBe(family.kindKey);
      expect(family.rows.length).toBeGreaterThan(0);
      for (const row of family.rows) {
        const marks = row.simplified ?? [];
        expect(marks.length, row.key).toBeGreaterThan(0);
        expect(catalogRowLabel(family, row), row.key).toBe(`${row.size}（簡略: ${marks.join('・')}）`);
      }
    }
  });
});

describe('資料 2 のパイプ形のフレームの 3 族の選ぶ画面の文字', () => {
  const PIPES = [['pipe-frame', 'catalog.frame.pipeFrame.hint'], ['pipe-frame-slotted', 'catalog.frame.pipeFrameSlotted.hint'],
    ['pipe-frame-twin', 'catalog.frame.pipeFrameTwin.hint']] as const;

  it('3 族はアルミフレームの分類で資料 1 の小さい溝つきフレームの 3 族の前に並び、説明は族ごとの 1 行、どの行も呼びに簡略の印を添える', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(PIPES.map(([id]) => id));
    expectRegisteredInOrder(PIPES.map(([id]) => id));
    for (const [id, hint] of PIPES) {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
      if (family === undefined) throw new Error(`${id} is not loaded`);
      expect(familyHintKey(family)).toBe(hint);
      expect(t(hint)).not.toBe(hint);
      expect(t(familyKindKey(family.kindKey))).not.toBe(family.kindKey);
      for (const row of family.rows) {
        expect(row.simplified?.length ?? 0, row.key).toBeGreaterThan(0);
        expect(catalogRowLabel(family, row)).toBe(`${row.size}（簡略: ${row.simplified?.join('・') ?? ''}）`);
      }
    }
  });
});

describe('資料 1 の小さい溝つきフレーム・端のキャップ・ブラケット素材の選ぶ画面の文字', () => {
  const SMALL = [['t-slot-frame-small', 'catalog.frame.smallFrame.hint'], ['t-slot-frame-cap-small', 'catalog.frame.smallFrameCap.hint'],
    ['bracket-stock', 'catalog.frame.bracketStock.hint']] as const;

  it('3 族はアルミフレームの分類の 2 冊目のキャップとフットの前に並び、説明は族ごとの 1 行、行の名前は呼びに簡略の印(作っていない溝を含む)を添える', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(SMALL.map(([id]) => id));
    expectRegisteredInOrder(SMALL.map(([id]) => id));
    for (const [id, hint] of SMALL) {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
      if (family === undefined) throw new Error(`${id} is not loaded`);
      expect(familyHintKey(family)).toBe(hint);
      expect(t(hint)).not.toBe(hint);
      expect(t(familyKindKey(family.kindKey))).not.toBe(family.kindKey);
      for (const row of family.rows) {
        expect(catalogRowLabel(family, row)).toBe(`${row.size}（簡略: ${row.simplified?.join('・') ?? ''}）`);
      }
    }
    // 作っていない溝は、選ぶ画面の行の名前に出る(その溝には部品を付けられない事が分かる)。
    const small = PRODUCT_CATALOG_REGISTRY.loaded('t-slot-frame-small');
    const wide = small?.rows.find((row) => row.dims.width === 180);
    expect(wide === undefined || small === undefined ? '' : catalogRowLabel(small, wide)).toContain('下の面の溝（寸法の記入が無いため作っていない）');
  });
});

describe('資料 2 のパイプ形のフレームのキャップとフットの選ぶ画面の文字', () => {
  const STACKED = [['pipe-frame-cap', 'catalog.frame.pipeFrameCap.hint'], ['pipe-frame-foot', 'catalog.frame.pipeFrameFoot.hint']] as const;

  it('2 族はアルミフレームの分類で板の 2 族の前に並び、説明は族ごとの 1 行、行の名前は呼びに簡略の印(作っていない差し込みなど)を添える', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(STACKED.map(([id]) => id));
    expectRegisteredInOrder(STACKED.map(([id]) => id));
    for (const [id, hint] of STACKED) {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
      if (family === undefined) throw new Error(`${id} is not loaded`);
      expect(familyHintKey(family)).toBe(hint);
      expect(t(hint)).not.toBe(hint);
      expect(t(familyKindKey(family.kindKey))).not.toBe(family.kindKey);
      for (const row of family.rows) {
        const marks = row.simplified ?? [];
        expect(catalogRowLabel(family, row), row.key).toBe(marks.length > 0 ? `${row.size}（簡略: ${marks.join('・')}）` : row.size);
      }
    }
  });
});

describe('資料 1 の板の 2 族(定尺の寸法・幅と高さを入れる)の選ぶ画面の文字', () => {
  const BOARDS = [['panel-board-fixed', 'catalog.board.fixed.hint'], ['panel-board-order', 'catalog.board.order.hint']] as const;

  it('2 族はアルミフレームの分類でパネル扉の部品の 2 族の前に並び、説明は族ごとの 1 行、幅と高さの欄の名前を持ち、行の名前は呼びに簡略の印を添える', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(BOARDS.map(([id]) => id));
    expectRegisteredInOrder(BOARDS.map(([id]) => id));
    for (const [id, hint] of BOARDS) {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
      if (family === undefined) throw new Error(`${id} is not loaded`);
      expect(familyHintKey(family)).toBe(hint);
      expect(t(hint)).not.toBe(hint);
      expect(t(familyKindKey(family.kindKey))).not.toBe(family.kindKey);
      for (const row of family.rows) {
        const marks = row.simplified ?? [];
        expect(catalogRowLabel(family, row), row.key).toBe(marks.length > 0 ? `${row.size}（簡略: ${marks.join('・')}）` : row.size);
      }
    }
    // 注文の寸法の族の欄は幅と高さで、選ぶ画面は欄の名前を自分の鍵で出す(長さの名前に落ちない)。定尺の族は欄を持たない。
    const order = PRODUCT_CATALOG_REGISTRY.loaded('panel-board-order');
    expect(order?.options.map((spec) => [spec.key, t(messageKeyOr(spec.labelKey, 'catalog.mechanical.length'))]))
      .toEqual([['width', t('catalog.board.option.width')], ['height', t('catalog.board.option.height')],
        ['holeDiameter', t('catalog.framePanel.holeDiameter')], ['holeX', t('catalog.framePanel.holeX')], ['holeY', t('catalog.framePanel.holeY')]]);
    expect(order?.options.filter((spec) => spec.optional).map((spec) => spec.key)).toEqual(['holeDiameter', 'holeX', 'holeY']);
    expect([t('catalog.board.option.width'), t('catalog.board.option.height')]).not.toContain(t('catalog.mechanical.length'));
    expect(PRODUCT_CATALOG_REGISTRY.loaded('panel-board-fixed')?.options).toEqual([]);
  });
});

describe('資料 2 のパネル扉の部品・パネル用のフレーム・コネクタ・キャップと足の部品・可動の部品・アクセサリの 6 族(外形を包む形)の選ぶ画面の文字', () => {
  const ENVELOPE = '外形を包む形で、細部は作っていない';
  // 族ごとに、行の名前に添える簡略の印の並び(可動の部品だけ「動く仕組みは作っていない」を続ける)。
  const ENVELOPES = [['panel-part-box', 'catalog.board.partBox.hint', [ENVELOPE]],
    ['panel-cover-frame', 'catalog.board.coverFrame.hint', [ENVELOPE]], ['connector-box', 'catalog.frame.connectorBox.hint', [ENVELOPE]],
    ['cap-foot-box', 'catalog.frame.capFootBox.hint', [ENVELOPE]],
    ['movable-part-box', 'catalog.frame.movableBox.hint', [ENVELOPE, '動く仕組みは作っていない']],
    ['accessory-box', 'catalog.frame.accessoryBox.hint', [ENVELOPE]]] as const;

  it('6 族はアルミフレームの分類でキャスターの族の前に並び、説明は族ごとの 1 行、行の名前は呼びに「外形を包む形で、細部は作っていない」の印を添える', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(ENVELOPES.map(([id]) => id));
    expectRegisteredInOrder(ENVELOPES.map(([id]) => id));
    for (const [id, hint, marks] of ENVELOPES) {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
      if (family === undefined) throw new Error(`${id} is not loaded`);
      expect(familyHintKey(family)).toBe(hint);
      expect(t(hint)).not.toBe(hint);
      expect(t(familyKindKey(family.kindKey))).not.toBe(family.kindKey);
      for (const row of family.rows) {
        expect(catalogRowLabel(family, row), row.key).toBe(`${row.size}（簡略: ${marks.join('・')}）`);
      }
    }
  });
});

describe('資料 1 の小さい部品の 3 族と長物の族の選ぶ画面の文字', () => {
  // 族ごとの説明の 1 行の鍵。行の名前に添える簡略の印は、行の simplified の並び。
  const BOOK1_FAMILIES = [
    ['slider-box', 'catalog.frame.sliderBox.hint'], ['cap-accessory-box', 'catalog.frame.capAccessoryBox.hint'],
    ['foot-part-box', 'catalog.frame.footPartBox.hint'], ['slot-long-part', 'catalog.frame.slotLongPart.hint'],
  ] as const;

  it('4 族はアクセサリの族の後・扉の部品の族の前に並び、説明は族ごとの 1 行、行の名前は呼びに行の簡略の印を添える', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(BOOK1_FAMILIES.map(([id]) => id));
    expectRegisteredInOrder(BOOK1_FAMILIES.map(([id]) => id));
    for (const [id, hint] of BOOK1_FAMILIES) {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
      if (family === undefined) throw new Error(`${id} is not loaded`);
      expect(familyHintKey(family)).toBe(hint);
      expect(t(hint)).not.toBe(hint);
      expect(t(familyKindKey(family.kindKey))).not.toBe(family.kindKey);
      expect(family.rows.length, id).toBeGreaterThan(0);
      for (const row of family.rows) {
        const marks = row.simplified ?? [];
        expect(catalogRowLabel(family, row), row.key).toBe(marks.length > 0 ? `${row.size}（簡略: ${marks.join('・')}）` : row.size);
      }
    }
  });
});

describe('資料 1 の扉の部品の族の選ぶ画面の文字', () => {
  // 族ごとの説明の 1 行の鍵。行の名前に添える簡略の印は、行の simplified の並び。
  const DOOR_FAMILIES = [
    ['door-part-box', 'catalog.frame.doorPartBox.hint'],
  ] as const;

  it('扉の部品の族は資料 1 の長物の族の後・引出の部品の族の前に並び、説明は 1 行、行の名前は呼びに行の簡略の印を添える', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(DOOR_FAMILIES.map(([id]) => id));
    expectRegisteredInOrder(DOOR_FAMILIES.map(([id]) => id));
    for (const [id, hint] of DOOR_FAMILIES) {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
      if (family === undefined) throw new Error(`${id} is not loaded`);
      expect(familyHintKey(family)).toBe(hint);
      expect(t(hint)).not.toBe(hint);
      expect(t(familyKindKey(family.kindKey))).not.toBe(family.kindKey);
      expect(family.rows.length, id).toBeGreaterThan(0);
      for (const row of family.rows) {
        const marks = row.simplified ?? [];
        expect(catalogRowLabel(family, row), row.key).toBe(marks.length > 0 ? `${row.size}（簡略: ${marks.join('・')}）` : row.size);
      }
    }
  });
});

describe('資料 1 の引出の部品の族の選ぶ画面の文字', () => {
  // 族ごとの説明の 1 行の鍵。行の名前に添える簡略の印は、行の simplified の並び。
  const DRAWER_FAMILIES = [
    ['drawer-part-box', 'catalog.frame.drawerPartBox.hint'],
  ] as const;

  it('引出の部品の族は扉の部品の族の後・ブラケットのそのほかの族の前に並び、説明は 1 行、行の名前は呼びに行の簡略の印を添える', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(DRAWER_FAMILIES.map(([id]) => id));
    expectRegisteredInOrder(['door-part-box', ...DRAWER_FAMILIES.map(([id]) => id), 'bracket-part-box']);
    for (const [id, hint] of DRAWER_FAMILIES) {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
      if (family === undefined) throw new Error(`${id} is not loaded`);
      expect(familyHintKey(family)).toBe(hint);
      expect(t(hint)).not.toBe(hint);
      expect(t(familyKindKey(family.kindKey))).not.toBe(family.kindKey);
      expect(family.rows.length, id).toBeGreaterThan(0);
      for (const row of family.rows) {
        const marks = row.simplified ?? [];
        expect(catalogRowLabel(family, row), row.key).toBe(marks.length > 0 ? `${row.size}（簡略: ${marks.join('・')}）` : row.size);
      }
    }
  });
});

describe('資料 1 のブラケットのそのほかの族の選ぶ画面の文字', () => {
  it('引出の部品の族の後・キャスターの族の前に並び、説明は 1 行、行の名前は呼びに行の簡略の印を添える', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(['bracket-part-box']);
    expectRegisteredInOrder(['drawer-part-box', 'bracket-part-box', 't-slot-caster']);
    const family = PRODUCT_CATALOG_REGISTRY.loaded('bracket-part-box');
    if (family === undefined) throw new Error('bracket-part-box is not loaded');
    expect(familyHintKey(family)).toBe('catalog.frame.bracketPartBox.hint');
    expect(t('catalog.frame.bracketPartBox.hint')).not.toBe('catalog.frame.bracketPartBox.hint');
    expect(t(familyKindKey(family.kindKey))).not.toBe(family.kindKey);
    expect(family.rows.length).toBeGreaterThan(0);
    for (const row of family.rows) {
      const marks = row.simplified ?? [];
      expect(catalogRowLabel(family, row), row.key).toBe(marks.length > 0 ? `${row.size}（簡略: ${marks.join('・')}）` : row.size);
    }
  });
});

describe('キャスターの族の選ぶ画面の文字', () => {
  it('アルミフレームの分類の最後に並び、説明は 1 行、行の名前は呼びに簡略の印(フォーク・旋回と止め・車輪の溝)を添える', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(['t-slot-caster']);
    expectRegisteredInOrder(['t-slot-caster']);
    const family = PRODUCT_CATALOG_REGISTRY.loaded('t-slot-caster');
    if (family === undefined) throw new Error('t-slot-caster is not loaded');
    expect(familyHintKey(family)).toBe('catalog.frame.caster.hint');
    expect(t('catalog.frame.caster.hint')).not.toBe('catalog.frame.caster.hint');
    expect(t(familyKindKey(family.kindKey))).not.toBe(family.kindKey);
    for (const row of family.rows) {
      const marks = row.simplified ?? [];
      expect(marks.length, row.key).toBeGreaterThan(0);
      expect(catalogRowLabel(family, row), row.key).toBe(`${row.size}（簡略: ${marks.join('・')}）`);
    }
  });
});

describe('資料 1 のブロック形のブラケットの族の選ぶ画面の文字', () => {
  it('アルミフレームの分類でアジャスターのすぐ後に並び、説明は形の 1 行、行の文字は呼び(簡略の印のある行は印を添える)', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(['t-slot-block-bracket']);
    expectRegisteredInOrder(['t-slot-block-bracket']);
    const family = PRODUCT_CATALOG_REGISTRY.loaded('t-slot-block-bracket');
    if (family === undefined) throw new Error('t-slot-block-bracket is not loaded');
    expect(familyHintKey(family)).toBe('catalog.frame.blockBracket.hint');
    expect(t('catalog.frame.blockBracket.hint')).not.toBe('catalog.frame.blockBracket.hint');
    expect(t(familyKindKey(family.kindKey))).not.toBe(family.kindKey);
    expect(family.rows.length).toBeGreaterThan(0);
    for (const row of family.rows) {
      const marks = row.simplified ?? [];
      expect(catalogRowLabel(family, row), row.key).toBe(marks.length > 0 ? `${row.size}（簡略: ${marks.join('・')}）` : row.size);
    }
  });
});

describe('アジャスター取付板の寸法表', () => {
  it('従来の行を保存復元でき、均一径の５行だけに穴径を mm で出す', async () => {
    const id = 't-slot-foot-base';
    await PRODUCT_CATALOG_REGISTRY.ensure([id]);
    const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
    if (family === undefined) throw new Error('アジャスターベースの族がない');
    const cases = [
      ['adjuster-166x125x9-h8-d7-steel', '166×125×9（取付け穴 8・φ7・鋼）', 8, 7],
      ['adjuster-150x150x12-h10-d9-steel', '150×150×12（取付け穴 10・φ9・鋼）', 10, 9],
      ['adjuster-150x150x12-h10-d9-stainless', '150×150×12（取付け穴 10・φ9・ステンレス）', 10, 9],
      ['adjuster-165x165x12-h10-d9-steel', '165×165×12（取付け穴 10・φ9・鋼）', 10, 9],
      ['adjuster-165x165x12-h10-d9-stainless', '165×165×12（取付け穴 10・φ9・ステンレス）', 10, 9],
      ['adjuster-166x125x9-h5-d14-9-steel', '166×125×9（取付け穴 5・φ14・φ9・鋼）', 5, undefined],
      ['adjuster-166x125x9-h5-d14-9-stainless', '166×125×9（取付け穴 5・φ14・φ9・ステンレス）', 5, undefined],
    ] as const;
    for (const [key, size, count, diameter] of cases) {
      const row = family.rows.find((candidate) => candidate.key === key);
      if (row === undefined) throw new Error(`アジャスター取付板の行がない: ${key}`);
      const saved = {
        kind: 'standardPart', catalog: 'catalogItem',
        size: `アジャスターベース（キャスターも付けられる板） ${size}`,
        options: { family: id, item: key },
        catalogRevision: 't-slot-foot-base-2026-11-r1', generatorRevision: 'frame-part-1',
      } as const;
      expect(createCatalogItemSource(family, row), key).toEqual(saved);
      const figure = familyFigurePart(family, row, {});
      const restored = buildStandardPartFromSource(saved);
      expect(restored?.name, key).toBe(saved.size);
      expect(figure.build(), key).toEqual(restored);
      expect(figure.rows.find((dimension) => dimension.key === 'holeCount'), key)
        .toEqual({ key: 'holeCount', label: 'catalog.dimension.holeCount', value: count, unit: '' });
      expect(figure.rows.find((dimension) => dimension.key === 'holeDiameter'), key)
        .toEqual(diameter === undefined ? undefined : { key: 'holeDiameter', label: 'catalog.dimension.holeDiameter', value: diameter, unit: 'mm' });
    }
  });
});
