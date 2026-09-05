/**
 * 映り込み用の環境マップ(計画書 docs/plans/P5-高度なソリッド・外観と測定.md §2.6、
 * §0.a-0.9、タスク9)。
 *
 * 対応要件: FR-1107(鏡・ガラス)、NFR-PF-5(要らないものを作らない)。
 *
 * three.js に同梱の手続き的な部屋(`RoomEnvironment`)を `PMREMGenerator` に通して
 * 1 枚だけ作る。**画像ファイルは 1 つも増えない**(依存の追加も 0 件。§1、§0.a-0.9)。
 *
 * **鏡・ガラスを 1 つも使っていない文書では作らない。** 作るかどうかの判断は
 * `appearance/createAppearanceMaterial.ts` の `anyNeedsEnvironment` が行い、
 * ここは「入になったら作る / 切になったら捨てる」だけを受け持つ(NFR-PF-5)。
 * タスク10 の呼び出し方(申し送り):
 *
 * ```ts
 * const environments = createEnvironmentStore(() => createEnvironmentTarget(renderer));
 * // 外観を差し替えるたび:
 * let environment: THREE.Texture | null = null;
 * if (anyNeedsEnvironment(usedSpecs)) {
 *   environment = environments.ensureEnvironment(scene);
 * } else {
 *   environments.releaseEnvironment(scene);
 * }
 * ```
 *
 * **`scene.environment` に入れる。`scene.background` には入れない**(§2.6)。背景は
 * `alpha: true` の canvas 越しに CSS の縦グラデーションが透ける今の見た目を保つ。
 *
 * **レンダラの設定は触らない**(§0.a-0.12)。足すのは `scene.environment` の 1 行だけで、
 * トーンマッピングや出力の色空間は変えない(既存の全画面の見た目が変わるため)。
 *
 * 計画書との差(理由つき): 計画書は `createEnvironmentTexture(renderer): THREE.Texture` と
 * 書いているが、`PMREMGenerator.fromScene` が返すのは `WebGLRenderTarget` であり、
 * テクスチャだけを取り出すと**レンダーターゲットを捨てる口が無くなる**
 * (§4「three.js で作った材質・テクスチャ・レンダーターゲットは必ず dispose() する」)。
 * そこで `EnvironmentTarget`(テクスチャ + `dispose`)を返す形にした。
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * 部屋を環境マップへ焼くときのぼかし(ラジアン)。§2.6 の値そのまま。
 * 小さくすると部屋の家具の形が鏡へはっきり映り、大きくすると明るさだけが残る。
 */
const ENVIRONMENT_BLUR_SIGMA = 0.04;

/** 環境マップ 1 枚と、その解放の口。 */
export interface EnvironmentTarget {
  readonly texture: THREE.Texture;
  /** レンダーターゲット(付随する深度なども含む)ごと捨てる。 */
  dispose(): void;
}

/**
 * 環境マップを 1 枚作る。**WebGL のレンダラが要る**ので、canvas の無い環境(Node の検査)
 * からは呼べない。呼び出し側の筋道(作る条件・使い回し・捨てる時機)は
 * `createEnvironmentStore` に純粋な形で切り出してあり、そちらだけを Node で検査する。
 */
export function createEnvironmentTarget(renderer: THREE.WebGLRenderer): EnvironmentTarget {
  const generator = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const target = generator.fromScene(room, ENVIRONMENT_BLUR_SIGMA);
  // 部屋そのもの(仮の板と光)と、焼くための道具は、焼き上がれば要らない。
  room.dispose();
  generator.dispose();
  return {
    texture: target.texture,
    dispose: () => {
      target.dispose();
    },
  };
}

/**
 * 環境マップの持ち主。**鏡・ガラスがある間だけ 1 枚を持ち、無くなったら捨てる**
 * (§0.a-0.9、NFR-PF-5)。
 */
export interface EnvironmentStore {
  /** いま持っている環境マップ(無ければ `null`)。材質へ渡す値。 */
  readonly texture: THREE.Texture | null;
  /**
   * 環境マップを用意して `scene.environment` へ入れる。**すでに持っていれば作り直さない**
   * (毎フレーム作り直すと NFR-PF-1 を割る)。
   */
  ensureEnvironment(scene: THREE.Scene): THREE.Texture;
  /** 環境マップを捨て、`scene.environment` を元(なし)へ戻す。 */
  releaseEnvironment(scene: THREE.Scene): void;
  /** シーンに触れずに捨てる(画面ごと閉じるとき。`createSolidLayer.dispose` から)。 */
  dispose(): void;
}

/**
 * 環境マップの持ち主を作る。
 *
 * **レンダラは `create` の中へ閉じ込める**(呼び出し側は
 * `createEnvironmentStore(() => createEnvironmentTarget(renderer))` と書く)。
 * こうすると、この入れ物そのものは WebGL に触れないので「1 枚しか作らない」
 * 「捨てたら作り直す」という筋道を Node の検査で固定できる。レンダラを引数に取る形にすると、
 * 検査で `WebGLRenderer` の偽物を用意するために `as` が要り、規約(rules/02)に反する。
 */
export function createEnvironmentStore(create: () => EnvironmentTarget): EnvironmentStore {
  let current: EnvironmentTarget | null = null;

  function discard(): void {
    if (current === null) {
      return;
    }
    current.dispose();
    current = null;
  }

  return {
    get texture(): THREE.Texture | null {
      return current === null ? null : current.texture;
    },
    ensureEnvironment(scene) {
      if (current === null) {
        current = create();
      }
      scene.environment = current.texture;
      return current.texture;
    },
    releaseEnvironment(scene) {
      scene.environment = null;
      discard();
    },
    dispose() {
      discard();
    },
  };
}
