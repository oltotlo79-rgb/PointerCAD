/**
 * 外観(`AppearanceSpec`)から three.js の材質を作り分け、使い回す入れ物(計画書
 * docs/plans/P5-高度なソリッド・外観と測定.md §2.5.3、§2.6、タスク9)。
 *
 * 対応要件: FR-1107(材質プリセット)、FR-1109(透過率・光沢・粗さ・色の個別調整)。
 *
 * **利用者に見せる単位は 0〜100 の百分率**(`packages/model/src/appearance/materialPresets.ts`)
 * で、three.js の 0〜1 へ写すのはこのファイルの責務である(model 側は換算を持たない)。
 * 光沢 → `metalness`、粗さ → `roughness`、透過率 → `transmission` の 3 本を 100 で割る。
 *
 * **既定の外観は P2 の単色と 1 ドットも変わらない**(§0.a-0.12)。
 * `createSolidLayer.ts` の `faceMaterial`(2026-09-05 実測: 色 `DEFAULT_THEME_COLORS.solid`
 * = `0xb8bfcc`、`SOLID_ROUGHNESS = 0.55`、`SOLID_METALNESS = 0.05`、`side = FrontSide`、
 * `polygonOffset = true` / `polygonOffsetFactor = 1` / `polygonOffsetUnits = 1`)と
 * 同じ値になることを `createAppearanceMaterial.test.ts` が固定する。
 *
 * **`transparent: true` は 1 か所も使わない**(§2.6)。ガラスは `MeshPhysicalMaterial` の
 * `transmission`(three が背後を描き直す)、エキスパンドメタルの穴は `alphaTest`(不透明扱いの
 * 切り抜き)で表すので、どちらも描く順に依存しない。
 *
 * **材質は「見え方」で使い回す。** 鍵は `buildFaceGroups.ts`(タスク7)の `appearanceKeyText`
 * を共有する。まとまりの `materialIndex` と材質の使い回しが同じ鍵で決まっていないと、
 * 「まとまりは 1 つなのに材質は 2 つ」といった食い違いが起きるため、鍵を 2 か所に持たない。
 * (計画書のタスク9 は `appearanceKeyText` をこのファイルに置く形で書かれているが、
 * タスク7 が先に `buildFaceGroups.ts` へ実装済みだったので、そちらを唯一の正本として使う。)
 *
 * **使われなくなった材質は必ず `dispose()` する**(§4。WebGL の資源は GC で戻らない)。
 * 呼び出し側(タスク10 の `createSolidLayer`)は、外観を差し替えるたびに `collect` を呼ぶ。
 *
 * 柄のテクスチャ(タスク8 の `patternTexture.ts`)は `PatternTextureSource` として外から
 * 受け取る。既定は実物(`createPatternTexture` / `disposePatternTextures`)だが、
 * canvas の無い Node の検査では偽物を渡して `map` / `alphaMap` / `repeat` を確かめる
 * (この ui パッケージには jsdom を入れない方針。`themeColors.ts` 冒頭の注釈)。
 */

import { DEFAULT_APPEARANCE, WOOD_SPECIES, type AppearancePattern, type AppearanceSpec, type WoodSpecies } from '@pointercad/model';
import * as THREE from 'three';

import { appearanceKeyText } from './buildFaceGroups.js';
import {
  createPatternTexture,
  disposePatternTextures,
  patternRepeatFor,
  type PatternCreateOptions,
  type PatternKind,
} from './patternTexture.js';

/** 百分率(0〜100)の満量。three.js の 0〜1 へ写すときの割る数。 */
const PERCENT_FULL = 100;

const DEFAULT_APPEARANCE_KEY = appearanceKeyText(DEFAULT_APPEARANCE);

/** 既定の外観だけを現在のテーマ色へ合わせる。部品層とアセンブリ層の共通規則。 */
export function themedAppearance(spec: AppearanceSpec, solidColor: number): AppearanceSpec {
  if (appearanceKeyText(spec) !== DEFAULT_APPEARANCE_KEY) return spec;
  const color = `#${solidColor.toString(16).padStart(6, '0')}`;
  return color === spec.color ? spec : { ...spec, color };
}

/** ガラスの屈折率(§2.5.3、§0.a-0.10)。three.js の既定も 1.5 だが、意図として明示する。 */
export const GLASS_IOR = 1.5;

/** ガラスの厚み(mm 相当、§2.5.3、§0.a-0.10)。three.js の既定は 0 なので必ず入れる。 */
export const GLASS_THICKNESS = 2;

/** 柄の抜き(エキスパンドメタルの穴)のしきい値(§0.a-0.8)。 */
export const PATTERN_ALPHA_TEST = 0.5;

/**
 * 環境マップ(映り込み)が要ると見なす境目(§0.a-0.9「鏡・ガラスを 1 つも使わない文書では
 * 環境マップを作らない」)。
 *
 * **プリセットの id ではなく値で判定する。** FR-1109 で光沢と粗さを個別に調整して
 * 鏡同然にした「自分で決める」も拾いたいのと、`appearanceKeyText` が id を鍵に含めない
 * (同じ値なら同じ絵)方針に合わせるため。
 *
 * **金属(光沢が高いもの)も含める**(2026-09-05、タスク10 の実測と統括の決定)。
 * three.js の `metalness = 1` の面は拡散反射を持たず、映り込みが無いと**ほぼ真っ黒**に
 * 見える(実測: 鉄板・縞鋼板・エキスパンドメタルの立方体 20 個が、いまの 2 灯だけでは
 * 階調 10 前後の黒い塊になった。スクリーンショット
 * `shots/p5-t10/after3-steel.png` / `after3-checker-plate.png`)。当初の案は
 * 「映り込みが形として読めるのは鏡だけ」として粗さの上限で絞っていたが、**問題は
 * 映り込みの見え方ではなく明るさ**だったので、光沢(metalness)だけで判定する。
 * 鏡(光沢 100・粗さ 2)も鉄板(光沢 100・粗さ 42)もここに入る。
 *
 * 既定(光沢 5)・プラスチック(0)・木材(0)は入らないので、**外観を割り当てていない
 * 文書では環境マップを作らない**という NFR-PF-5 の条件は変わらない。
 */
const METAL_GLOSS_MIN = 50;

/** 柄のテクスチャ 1 組(色と、エキスパンドメタルだけの抜き)。 */
export interface PatternTextures {
  readonly texture: THREE.Texture;
  /** エキスパンドメタルだけ非 `null`(§0.a-0.8)。 */
  readonly alphaTexture: THREE.Texture | null;
}

/**
 * 柄のテクスチャの出どころ。既定は `patternTexture.ts`(タスク8)の実物。
 * `create` は canvas の無い環境では `null` を返す(例外は投げない)。
 */
export interface PatternTextureSource {
  create(kind: PatternKind, options: PatternCreateOptions): PatternTextures | null;
  disposeAll(): void;
}

/** 既定の出どころ(実物)。 */
const DEFAULT_PATTERN_TEXTURE_SOURCE: PatternTextureSource = {
  create: (kind, options) => createPatternTexture(kind, options),
  disposeAll: () => {
    disposePatternTextures();
  },
};

export interface AppearanceMaterialStore {
  /**
   * 外観に対応する材質を返す。**内容(`appearanceKeyText`)が同じなら同じ材質**を返す。
   * `environment` は映り込みに使う環境マップ(無ければ `null`)。
   */
  materialFor(spec: AppearanceSpec, environment: THREE.Texture | null): THREE.MeshStandardMaterial;
  /** いま使われていない材質を捨てる。外観を差し替えるたびに呼ぶ。 */
  collect(usedSpecs: readonly AppearanceSpec[]): void;
  /** 材質・複製したテクスチャ・柄のテクスチャの表をすべて捨てる。 */
  dispose(): void;
}

/**
 * 材質 1 つと、その材質だけが持っているテクスチャ。
 *
 * 柄のテクスチャの実体(絵)は柄の種類ごとに 1 枚で使い回す(§2.4.3)が、**繰り返しの間隔
 * (`repeat`)は外観ごとに違う**ので、材質ごとに `clone()` して間隔だけを変える
 * (`clone` は絵(`source`)を共有し、`repeat` / `offset` だけを別に持つ)。
 * 複製したぶんはこの材質のものなので、捨てるときに一緒に `dispose()` する。
 */
interface MaterialEntry {
  readonly material: THREE.MeshStandardMaterial;
  readonly clonedTextures: readonly THREE.Texture[];
}

/** 百分率(0〜100)を three.js の 0〜1 へ。範囲外と非数は 0〜1 に収める。 */
function percentToUnit(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.min(1, Math.max(0, percent / PERCENT_FULL));
}

/** 樹種から木目の色(地・木目)を引く。見つからなければ色を渡さない(タスク8 の後退値が効く)。 */
function woodColors(species: WoodSpecies): PatternCreateOptions {
  const info = WOOD_SPECIES.find((candidate) => candidate.id === species);
  if (info === undefined) {
    return {};
  }
  return { baseColor: info.baseColor, grainColor: info.grainColor };
}

/** 柄のテクスチャを作るときの設定(木目だけ樹種の色が要る)。 */
function patternCreateOptions(pattern: AppearancePattern): PatternCreateOptions {
  return pattern.kind === 'woodGrain' ? woodColors(pattern.species) : {};
}

/** 柄の繰り返しの間隔(mm)。柄なしは `null`。 */
function patternSpacingMm(pattern: AppearancePattern): number | null {
  return pattern.kind === 'none' ? null : pattern.spacing.value;
}

/**
 * 柄のテクスチャを複製し、繰り返しの間隔(mm)を `repeat` へ写す。
 *
 * UV は箱投影で mm の座標そのもの(§0.a-0.7)なので、`repeat = 1 / 間隔` にすると
 * タイル 1 枚がちょうど「間隔」mm になる(間隔 20mm → `repeat` は 0.05)。
 * 間隔が正の有限値でないときは `repeat` を触らない(1 のまま)。断りを出すのは
 * コマンド側の役目で(NFR-UX-5)、ここで `NaN` を three へ流し込まないことだけを守る。
 */
function cloneWithRepeat(texture: THREE.Texture, spacingMm: number | null): THREE.Texture {
  const clone = texture.clone();
  if (spacingMm !== null && Number.isFinite(spacingMm) && spacingMm > 0) {
    const repeat = patternRepeatFor(spacingMm);
    clone.repeat.set(repeat, repeat);
  }
  clone.needsUpdate = true;
  return clone;
}

/**
 * その外観に環境マップ(映り込み)が要るか。
 *
 * ガラス(透過率 > 0)は背後を描き直すときに周りの明るさが要り、鏡と金属(光沢が高い)は
 * 映り込みが無いとほぼ真っ黒に見えるため。既定・プラスチック・木材のような光沢の低い
 * 面は要らない(§0.a-0.9、NFR-PF-5)。
 */
export function needsEnvironment(spec: AppearanceSpec): boolean {
  if (spec.transmission.value > 0) {
    return true;
  }
  return spec.gloss.value >= METAL_GLOSS_MIN;
}

/** 外観の一覧のうち 1 つでも環境マップが要るか(§0.a-0.9 の「1 つでもあるときだけ作る」)。 */
export function anyNeedsEnvironment(specs: readonly AppearanceSpec[]): boolean {
  return specs.some((spec) => needsEnvironment(spec));
}

/**
 * 材質の色。
 *
 * 木目のテクスチャは樹種の色(地・木目)をそのまま持っている(タスク8)ので、材質の色は
 * 白にして掛け合わせで暗くならないようにする。エキスパンドメタルと縞鋼板のテクスチャは
 * 逆に無彩色の陰影として描かれており(`patternTexture.ts` 冒頭の注釈)、材質の色へ
 * 掛けて色を付ける前提なので、そちらは外観の色をそのまま使う。
 * 柄のテクスチャが作れなかったとき(canvas の無い環境)は、白い立体にならないよう
 * 木目でも外観の色をそのまま使う。
 */
function materialColor(spec: AppearanceSpec, map: THREE.Texture | null): THREE.Color {
  if (spec.pattern.kind === 'woodGrain' && map !== null) {
    return new THREE.Color(0xffffff);
  }
  return new THREE.Color(spec.color);
}

/**
 * 外観から材質を作る(§2.5.3 の対応表そのまま)。
 *
 * `transmission > 0` のときだけ `MeshPhysicalMaterial` にする。ガラスを使っていない文書で
 * `transmission` の経路(three がシーンを実質 2 回描く)を起こさないため(§2.6)。
 */
function createMaterialEntry(spec: AppearanceSpec, patterns: PatternTextureSource): MaterialEntry {
  const gloss = percentToUnit(spec.gloss.value);
  const roughness = percentToUnit(spec.roughness.value);
  const transmission = percentToUnit(spec.transmission.value);

  const kind: PatternKind = spec.pattern.kind;
  const spacingMm = patternSpacingMm(spec.pattern);
  const textures = kind === 'none' ? null : patterns.create(kind, patternCreateOptions(spec.pattern));

  const clonedTextures: THREE.Texture[] = [];
  let map: THREE.Texture | null = null;
  let alphaMap: THREE.Texture | null = null;
  if (textures !== null) {
    map = cloneWithRepeat(textures.texture, spacingMm);
    clonedTextures.push(map);
    if (textures.alphaTexture !== null) {
      alphaMap = cloneWithRepeat(textures.alphaTexture, spacingMm);
      clonedTextures.push(alphaMap);
    }
  }

  const parameters: THREE.MeshStandardMaterialParameters = {
    color: materialColor(spec, map),
    metalness: gloss,
    roughness,
    // 映り込みの強さは光沢に合わせる。既定の外観(光沢 5)ではほとんど映り込まないので、
    // 外観を割り当てていない文書の見た目は変わらない(§0.a-0.12)。
    envMapIntensity: gloss,
    map,
    alphaMap,
    // 穴は「透ける」のではなく「無い」ものとして扱う(描く順に依らない。§0.a-0.8)。
    alphaTest: alphaMap === null ? 0 : PATTERN_ALPHA_TEST,
    // 穴の空いた板は裏側も見えるので両面。閉じた立体は裏面が見えないので片面のまま。
    side: alphaMap === null ? THREE.FrontSide : THREE.DoubleSide,
    // §2.6「P5 では transparent: true を 1 か所も使わない」。
    transparent: false,
    // 面と稜線を同時に出すとき、稜線が面に埋もれてちらつくのを防ぐ(FR-105)。
    // 現行の `createSolidLayer.ts` の `faceMaterial` と同じ値。
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  };

  if (transmission > 0) {
    return {
      material: new THREE.MeshPhysicalMaterial({
        ...parameters,
        transmission,
        ior: GLASS_IOR,
        thickness: GLASS_THICKNESS,
      }),
      clonedTextures,
    };
  }
  return { material: new THREE.MeshStandardMaterial(parameters), clonedTextures };
}

/** 材質と、その材質だけが持つテクスチャを捨てる。 */
function disposeEntry(entry: MaterialEntry): void {
  entry.material.dispose();
  for (const texture of entry.clonedTextures) {
    texture.dispose();
  }
}

/**
 * 材質の入れ物を作る。
 *
 * `patterns` は柄のテクスチャの出どころ(既定は `patternTexture.ts` の実物)。
 * **`dispose()` は柄のテクスチャの表も捨てる**ので、入れ物は画面(ビューポート)に
 * 1 つだけ作る(`createSolidLayer` が持つ。タスク10)。
 */
export function createAppearanceMaterialStore(
  patterns: PatternTextureSource = DEFAULT_PATTERN_TEXTURE_SOURCE,
): AppearanceMaterialStore {
  const entries = new Map<string, MaterialEntry>();

  /**
   * 環境マップを材質へ入れる。`envMap` の有無はシェーダーの作り直しを伴うので、
   * 変わったときだけ `needsUpdate` を立てる(毎フレーム作り直さない。NFR-PF-1)。
   */
  function applyEnvironment(material: THREE.MeshStandardMaterial, environment: THREE.Texture | null): void {
    if (material.envMap === environment) {
      return;
    }
    material.envMap = environment;
    material.needsUpdate = true;
  }

  return {
    materialFor(spec, environment) {
      const key = appearanceKeyText(spec);
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = createMaterialEntry(spec, patterns);
        entries.set(key, entry);
      }
      applyEnvironment(entry.material, environment);
      return entry.material;
    },
    collect(usedSpecs) {
      const keep = new Set<string>();
      for (const spec of usedSpecs) {
        keep.add(appearanceKeyText(spec));
      }
      for (const [key, entry] of entries) {
        if (keep.has(key)) {
          continue;
        }
        disposeEntry(entry);
        entries.delete(key);
      }
    },
    dispose() {
      for (const entry of entries.values()) {
        disposeEntry(entry);
      }
      entries.clear();
      patterns.disposeAll();
    },
  };
}
