/**
 * 材質の作り分け(`createAppearanceMaterial.ts`)の検査(計画書
 * docs/plans/P5-高度なソリッド・外観と測定.md タスク9 の検証表、§2.5.3、§2.6)。
 *
 * 期待値は担当が自分で計算した値を書く(計画書の表の丸写しにしない):
 * - 光沢 100 → `metalness` 1、光沢 5 → 0.05、光沢 0 → 0
 * - 粗さ 55 → `roughness` 0.55、粗さ 42 → 0.42、粗さ 2 → 0.02
 * - 透過率 92 → `transmission` 0.92
 * - 柄の間隔 20mm → `repeat` 1/20 = 0.05(UV は mm の座標そのもの。§0.a-0.7)
 *
 * three.js の材質は WebGL 無しでも作れるので Node のまま検査できる。canvas は無いので、
 * 柄のテクスチャは偽の出どころ(`PatternTextureSource`)を渡す。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  appearanceFromPreset,
  MATERIAL_PRESETS,
  WOOD_SPECIES,
  type AppearanceSpec,
} from '@pointercad/model';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  anyNeedsEnvironment,
  createAppearanceMaterialStore,
  GLASS_IOR,
  GLASS_THICKNESS,
  needsEnvironment,
  PATTERN_ALPHA_TEST,
  themedAppearance,
  type PatternTextureSource,
} from './createAppearanceMaterial.js';
import type { PatternCreateOptions, PatternKind } from './patternTexture.js';

/**
 * `createSolidLayer.ts` の現行の面の材質(2026-09-05 実測)。既定の外観がこれと
 * 1 つも違わないことを確かめるために、値をここへ書き写して固定する(§0.a-0.12)。
 */
const CURRENT_SOLID_COLOR = 0xb8bfcc;
const CURRENT_SOLID_ROUGHNESS = 0.55;
const CURRENT_SOLID_METALNESS = 0.05;

interface FakePatternSource {
  readonly source: PatternTextureSource;
  readonly calls: ReadonlyArray<{ readonly kind: PatternKind; readonly options: PatternCreateOptions }>;
  readonly created: readonly THREE.Texture[];
  disposeAllCount(): number;
}

/** 柄のテクスチャの偽の出どころ。canvas が要らないので Node で使える。 */
function createFakePatternSource(): FakePatternSource {
  const calls: Array<{ kind: PatternKind; options: PatternCreateOptions }> = [];
  const created: THREE.Texture[] = [];
  let disposeAllCount = 0;
  const source: PatternTextureSource = {
    create(kind, options) {
      calls.push({ kind, options });
      const texture = new THREE.Texture();
      created.push(texture);
      if (kind !== 'expandedMetal') {
        return { texture, alphaTexture: null };
      }
      const alphaTexture = new THREE.Texture();
      created.push(alphaTexture);
      return { texture, alphaTexture };
    },
    disposeAll() {
      disposeAllCount += 1;
    },
  };
  return { source, calls, created, disposeAllCount: () => disposeAllCount };
}

/** 材質が `dispose()` された回数を数える。 */
function countMaterialDisposals(material: THREE.Material): () => number {
  let count = 0;
  material.addEventListener('dispose', () => {
    count += 1;
  });
  return () => count;
}

/** テクスチャが `dispose()` された回数を数える。 */
function countTextureDisposals(texture: THREE.Texture): () => number {
  let count = 0;
  texture.addEventListener('dispose', () => {
    count += 1;
  });
  return () => count;
}

/** 柄の繰り返しの間隔(mm)を差し替えた外観。 */
function withSpacing(spec: AppearanceSpec, spacingMm: number): AppearanceSpec {
  if (spec.pattern.kind === 'none') {
    return spec;
  }
  return { ...spec, pattern: { ...spec.pattern, spacing: expressionValueFromNumber(spacingMm) } };
}

/** 数値の欄だけを差し替えた外観(FR-1109 の個別調整に相当)。 */
function withNumbers(
  spec: AppearanceSpec,
  values: { readonly gloss?: number; readonly roughness?: number; readonly transmission?: number },
): AppearanceSpec {
  return {
    ...spec,
    gloss: values.gloss === undefined ? spec.gloss : expressionValueFromNumber(values.gloss),
    roughness: values.roughness === undefined ? spec.roughness : expressionValueFromNumber(values.roughness),
    transmission:
      values.transmission === undefined ? spec.transmission : expressionValueFromNumber(values.transmission),
  };
}

describe('createAppearanceMaterialStore(FR-1107、FR-1109、§2.5.3)', () => {
  it('既定の外観は、いまの立体の材質と同じ値になる(§0.a-0.12)', () => {
    const store = createAppearanceMaterialStore(createFakePatternSource().source);
    const material = store.materialFor(appearanceFromPreset('default'), null);

    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(material).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(material.color.equals(new THREE.Color(CURRENT_SOLID_COLOR))).toBe(true);
    expect(material.metalness).toBe(CURRENT_SOLID_METALNESS);
    expect(material.roughness).toBe(CURRENT_SOLID_ROUGHNESS);
    expect(material.side).toBe(THREE.FrontSide);
    expect(material.polygonOffset).toBe(true);
    expect(material.polygonOffsetFactor).toBe(1);
    expect(material.polygonOffsetUnits).toBe(1);
    expect(material.map).toBeNull();
    expect(material.alphaMap).toBeNull();
    expect(material.alphaTest).toBe(0);
    store.dispose();
  });

  it('百分率 0〜100 を three.js の 0〜1 へ写す(光沢 100 → 1、粗さ 42 → 0.42)', () => {
    const store = createAppearanceMaterialStore(createFakePatternSource().source);
    const steel = store.materialFor(appearanceFromPreset('steel'), null);

    expect(steel.metalness).toBe(1);
    expect(steel.roughness).toBe(0.42);
    expect(steel.envMapIntensity).toBe(1);
    store.dispose();
  });

  it('範囲の外の百分率は 0〜1 に収める(-10 → 0、130 → 1)', () => {
    const store = createAppearanceMaterialStore(createFakePatternSource().source);
    const material = store.materialFor(
      withNumbers(appearanceFromPreset('custom'), { gloss: 130, roughness: -10 }),
      null,
    );

    expect(material.metalness).toBe(1);
    expect(material.roughness).toBe(0);
    store.dispose();
  });

  it('内容が同じ外観では同じ材質を返す(別のオブジェクトでも)', () => {
    const store = createAppearanceMaterialStore(createFakePatternSource().source);
    const first = store.materialFor(appearanceFromPreset('default'), null);
    const second = store.materialFor(appearanceFromPreset('default'), null);

    expect(second).toBe(first);
    store.dispose();
  });

  it('色だけ違う外観では別の材質を作る', () => {
    const store = createAppearanceMaterialStore(createFakePatternSource().source);
    const red = store.materialFor(appearanceFromPreset('custom', '#ff0000'), null);
    const blue = store.materialFor(appearanceFromPreset('custom', '#0000ff'), null);

    expect(blue).not.toBe(red);
    expect(red.color.equals(new THREE.Color('#ff0000'))).toBe(true);
    expect(blue.color.equals(new THREE.Color('#0000ff'))).toBe(true);
    store.dispose();
  });

  it('ガラス(透過率 92)は MeshPhysicalMaterial になり、透過率・屈折率・厚みが入る', () => {
    const store = createAppearanceMaterialStore(createFakePatternSource().source);
    const glass = store.materialFor(appearanceFromPreset('glass'), null);

    expect(glass).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    if (!(glass instanceof THREE.MeshPhysicalMaterial)) {
      throw new Error('ガラスは MeshPhysicalMaterial のはず');
    }
    expect(glass.transmission).toBe(0.92);
    expect(glass.ior).toBe(GLASS_IOR);
    expect(glass.thickness).toBe(GLASS_THICKNESS);
    expect(glass.transparent).toBe(false);
    store.dispose();
  });

  it('透過率 0 のときは MeshPhysicalMaterial にしない(余分な描画を起こさない。§2.6)', () => {
    const store = createAppearanceMaterialStore(createFakePatternSource().source);
    const plastic = store.materialFor(appearanceFromPreset('plastic'), null);

    expect(plastic).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(plastic.metalness).toBe(0);
    expect(plastic.roughness).toBe(0.4);
    store.dispose();
  });

  it('鏡(光沢 100・粗さ 2)は metalness 1・roughness 0.02・envMapIntensity 1 になる', () => {
    const store = createAppearanceMaterialStore(createFakePatternSource().source);
    const mirror = store.materialFor(appearanceFromPreset('mirror'), null);

    expect(mirror.metalness).toBe(1);
    expect(mirror.roughness).toBe(0.02);
    expect(mirror.envMapIntensity).toBe(1);
    expect(mirror).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
    store.dispose();
  });

  it('エキスパンドメタルは抜き(alphaMap)と両面描きになる(§0.a-0.8)', () => {
    const patterns = createFakePatternSource();
    const store = createAppearanceMaterialStore(patterns.source);
    const material = store.materialFor(appearanceFromPreset('expandedMetal'), null);

    expect(material.map).not.toBeNull();
    expect(material.alphaMap).not.toBeNull();
    expect(material.alphaTest).toBe(PATTERN_ALPHA_TEST);
    expect(material.side).toBe(THREE.DoubleSide);
    expect(patterns.calls.map((call) => call.kind)).toEqual(['expandedMetal']);
    store.dispose();
  });

  it('縞鋼板は柄だけで、抜きも両面描きも付かない', () => {
    const patterns = createFakePatternSource();
    const store = createAppearanceMaterialStore(patterns.source);
    const material = store.materialFor(appearanceFromPreset('checkerPlate'), null);

    expect(material.map).not.toBeNull();
    expect(material.alphaMap).toBeNull();
    expect(material.alphaTest).toBe(0);
    expect(material.side).toBe(THREE.FrontSide);
    store.dispose();
  });

  it('柄の間隔 20mm は repeat 0.05 になる(タイル 1 枚 = 20mm。§0.a-0.7)', () => {
    const patterns = createFakePatternSource();
    const store = createAppearanceMaterialStore(patterns.source);
    const material = store.materialFor(withSpacing(appearanceFromPreset('checkerPlate'), 20), null);

    expect(material.map).not.toBeNull();
    expect(material.map?.repeat.x).toBe(0.05);
    expect(material.map?.repeat.y).toBe(0.05);
    // 元のテクスチャ(柄ごとに 1 枚)は触らない。間隔は複製した側だけを変える(§2.4.3)。
    expect(material.map).not.toBe(patterns.created[0]);
    expect(patterns.created[0].repeat.x).toBe(1);
    store.dispose();
  });

  it('柄の間隔が 0 以下でも repeat に NaN や Infinity を入れない', () => {
    const store = createAppearanceMaterialStore(createFakePatternSource().source);
    const material = store.materialFor(withSpacing(appearanceFromPreset('checkerPlate'), 0), null);

    expect(Number.isFinite(material.map?.repeat.x)).toBe(true);
    expect(material.map?.repeat.x).toBe(1);
    store.dispose();
  });

  it('木材は樹種の色を柄へ渡し、材質の色は白にして掛け合わせで暗くしない', () => {
    const patterns = createFakePatternSource();
    const store = createAppearanceMaterialStore(patterns.source);
    const hinoki = WOOD_SPECIES.find((species) => species.id === 'hinoki');
    if (hinoki === undefined) {
      throw new Error('ヒノキが WOOD_SPECIES に無い');
    }
    const material = store.materialFor(appearanceFromPreset('wood'), null);

    expect(patterns.calls).toEqual([
      { kind: 'woodGrain', options: { baseColor: hinoki.baseColor, grainColor: hinoki.grainColor } },
    ]);
    expect(material.map).not.toBeNull();
    expect(material.color.equals(new THREE.Color(0xffffff))).toBe(true);
    store.dispose();
  });

  it('樹種が違えば別の材質になる', () => {
    const patterns = createFakePatternSource();
    const store = createAppearanceMaterialStore(patterns.source);
    const hinoki = appearanceFromPreset('wood');
    if (hinoki.pattern.kind !== 'woodGrain') {
      throw new Error('木材の柄は woodGrain のはず');
    }
    const walnut: AppearanceSpec = { ...hinoki, pattern: { ...hinoki.pattern, species: 'walnut' } };

    const first = store.materialFor(hinoki, null);
    const second = store.materialFor(walnut, null);

    expect(second).not.toBe(first);
    expect(patterns.calls.map((call) => call.options.baseColor)).toEqual(['#e6cfa5', '#6b4a33']);
    store.dispose();
  });

  it('どのプリセットの材質も transparent は false のまま(§2.6)', () => {
    const store = createAppearanceMaterialStore(createFakePatternSource().source);
    for (const preset of MATERIAL_PRESETS) {
      const material = store.materialFor(appearanceFromPreset(preset.id), null);
      expect(material.transparent).toBe(false);
    }
    store.dispose();
  });

  it('環境マップを渡すと材質へ入り、外すと外れる', () => {
    const store = createAppearanceMaterialStore(createFakePatternSource().source);
    const environment = new THREE.Texture();
    const spec = appearanceFromPreset('mirror');

    const withEnvironment = store.materialFor(spec, environment);
    expect(withEnvironment.envMap).toBe(environment);

    const withoutEnvironment = store.materialFor(spec, null);
    expect(withoutEnvironment).toBe(withEnvironment);
    expect(withoutEnvironment.envMap).toBeNull();
    store.dispose();
  });

  it('collect は使われなくなった材質だけを捨て、次に呼ぶと作り直す', () => {
    const store = createAppearanceMaterialStore(createFakePatternSource().source);
    const kept = appearanceFromPreset('default');
    const dropped = appearanceFromPreset('steel');
    const keptMaterial = store.materialFor(kept, null);
    const droppedMaterial = store.materialFor(dropped, null);
    const keptDisposals = countMaterialDisposals(keptMaterial);
    const droppedDisposals = countMaterialDisposals(droppedMaterial);

    store.collect([kept]);

    expect(keptDisposals()).toBe(0);
    expect(droppedDisposals()).toBe(1);
    expect(store.materialFor(kept, null)).toBe(keptMaterial);
    expect(store.materialFor(dropped, null)).not.toBe(droppedMaterial);
    store.dispose();
  });

  it('collect は複製したテクスチャも捨てる', () => {
    const store = createAppearanceMaterialStore(createFakePatternSource().source);
    const material = store.materialFor(appearanceFromPreset('expandedMetal'), null);
    const map = material.map;
    const alphaMap = material.alphaMap;
    if (map === null || alphaMap === null) {
      throw new Error('エキスパンドメタルは map と alphaMap を持つはず');
    }
    const mapDisposals = countTextureDisposals(map);
    const alphaDisposals = countTextureDisposals(alphaMap);

    store.collect([]);

    expect(mapDisposals()).toBe(1);
    expect(alphaDisposals()).toBe(1);
    store.dispose();
  });

  it('dispose はすべての材質と、柄のテクスチャの表を捨てる', () => {
    const patterns = createFakePatternSource();
    const store = createAppearanceMaterialStore(patterns.source);
    const first = countMaterialDisposals(store.materialFor(appearanceFromPreset('default'), null));
    const second = countMaterialDisposals(store.materialFor(appearanceFromPreset('glass'), null));

    store.dispose();

    expect(first()).toBe(1);
    expect(second()).toBe(1);
    expect(patterns.disposeAllCount()).toBe(1);
  });

  it('dispose の後に呼ぶと材質を作り直す', () => {
    const store = createAppearanceMaterialStore(createFakePatternSource().source);
    const before = store.materialFor(appearanceFromPreset('default'), null);
    store.dispose();
    const after = store.materialFor(appearanceFromPreset('default'), null);

    expect(after).not.toBe(before);
    store.dispose();
  });
});

describe('themedAppearance(部品とアセンブリの共通テーマ規則)', () => {
  it('既定の外観だけをテーマ色へ差し替える', () => {
    expect(themedAppearance(appearanceFromPreset('default'), 0x112233).color).toBe('#112233');
  });

  it('利用者が決めた外観は変更しない', () => {
    const custom = appearanceFromPreset('custom', '#abcdef');
    expect(themedAppearance(custom, 0x112233)).toBe(custom);
  });
});

/*
 * 境目は 2026-09-05 のタスク10 の実測で「光沢(metalness)だけを見る」へ変えた。
 * three.js の metalness = 1 の面は拡散反射を持たず、映り込みが無いと**ほぼ真っ黒**に
 * 見える(実測のスクリーンショット: shots/p5-t10/after3-steel.png)。当初は「映り込みが
 * 形として読めるのは鏡だけ」として粗さの上限も見ていたが、問題は見え方ではなく明るさ
 * だったため、統括の決定(2026-09-05)で金属(光沢 50 以上)まで広げた。
 */
describe('needsEnvironment(§0.a-0.9、2026-09-05 の実測で金属まで広げた)', () => {
  it('既定・プラスチック・木材のように光沢の低い外観は環境マップが要らない', () => {
    expect(needsEnvironment(appearanceFromPreset('default'))).toBe(false);
    expect(needsEnvironment(appearanceFromPreset('plastic'))).toBe(false);
    expect(needsEnvironment(appearanceFromPreset('wood'))).toBe(false);
  });

  it('金属(鉄板・ステンレス・アルミ)は環境マップが要る(無いと真っ黒になる)', () => {
    expect(needsEnvironment(appearanceFromPreset('steel'))).toBe(true);
    expect(needsEnvironment(appearanceFromPreset('stainless'))).toBe(true);
    expect(needsEnvironment(appearanceFromPreset('aluminum'))).toBe(true);
  });

  it('鏡とガラスは環境マップが要る', () => {
    expect(needsEnvironment(appearanceFromPreset('mirror'))).toBe(true);
    expect(needsEnvironment(appearanceFromPreset('glass'))).toBe(true);
  });

  it('自分で決めた値が鏡同然なら環境マップが要る(FR-1109)', () => {
    const mirrorLike = withNumbers(appearanceFromPreset('custom'), { gloss: 100, roughness: 1 });
    expect(needsEnvironment(mirrorLike)).toBe(true);
  });

  it('anyNeedsEnvironment は 1 つでも要るときだけ真になる', () => {
    const plain = [appearanceFromPreset('default'), appearanceFromPreset('plastic')];
    expect(anyNeedsEnvironment([])).toBe(false);
    expect(anyNeedsEnvironment(plain)).toBe(false);
    expect(anyNeedsEnvironment([...plain, appearanceFromPreset('glass')])).toBe(true);
  });
});
