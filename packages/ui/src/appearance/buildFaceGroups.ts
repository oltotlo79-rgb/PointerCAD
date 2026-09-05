/**
 * 面のまとまり(描画グループ)を作る純関数(計画書
 * docs/plans/P5-高度なソリッド・外観と測定.md §2.5.2、タスク7)。
 *
 * 対応要件: FR-1106(立体ごと・面ごとの色)、NFR-PF-1(60fps)。
 *
 * three.js にも DOM にもストアにも触れない(Node のまま検査できる)。
 * `THREE.BufferGeometry.addGroup(start, count, materialIndex)` へそのまま渡せる形を作り、
 * 実際に three を触るのは `viewport/createSolidLayer.ts`(タスク10)だけにする。
 *
 * **ドローコールの数は材質の種類ではなく「まとまりの数」で決まる**(§2.5.2)。
 * 面は通し番号の順に並び、同じ材質の面が索引の上で隣り合っていれば 1 つのまとまりへ
 * 畳める。畳めるだけ畳むことが NFR-PF-1 の要である。
 *
 * **`triangleCount === 0` の面が実在する**(三角形が付かなかった面。
 * `docs/報告記録.md` 2026-09-03 21:50 の③と同じ事情が面にもある)。
 * 0 枚の面はまとまりを作らない。空の `addGroup` は描画の役に立たないうえ、
 * 「隣り合う同じ材質」の判定を分断してドローコールを増やすため。
 */

import type { AppearancePattern, AppearanceSpec } from '@pointercad/model';

import type { SolidFaceEntry } from '../solid/subShapeSelection.js';

/**
 * 描画のまとまり 1 つ。`geometry.addGroup(start, count, materialIndex)` の引数そのもの。
 * 単位は**索引の個数**(三角形の枚数ではない)なので、面の範囲表からは 3 倍して作る。
 */
export interface FaceGroup {
  /** indices の何番目から。 */
  readonly start: number;
  /** 何個ぶんか(三角形の枚数 × 3)。 */
  readonly count: number;
  /** `appearances` の何番目の外観で描くか。 */
  readonly materialIndex: number;
}

/** 1 ボディぶんのまとまりの計画。 */
export interface FaceGroupPlan {
  readonly groups: readonly FaceGroup[];
  /**
   * `materialIndex` の順に並んだ、このボディで使う外観の一覧。
   *
   * **0 番は必ずこのボディの既定**(立体全体の割り当てがあればそれ、無ければ文書の既定)
   * とする。面ごとの割り当てが 1 つも無いときに `appearances.length === 1` になり、
   * P2 と 1 ドットも変わらない絵が出る(§0.a-0.12)ための決めである。
   */
  readonly appearances: readonly AppearanceSpec[];
}

/** 1 ボディで使える材質の種類の上限(§0.a-0.11。既定 1 + 割り当て 7)。 */
export const MAX_MATERIALS_PER_BODY = 8;

/** 1 ボディのまとまりの数の上限(§2.5.2。= ボディ 1 つのドローコールの上限)。 */
export const MAX_GROUPS_PER_BODY = 32;

/** 数値を鍵の一部にする。`-0` と `0` を同じ文字にするため `String` を通す。 */
function numberKeyText(value: number): string {
  return String(value);
}

/** 柄を鍵の一部にする(繰り返しの間隔は評価値だけを見る)。 */
function patternKeyText(pattern: AppearancePattern): string {
  switch (pattern.kind) {
    case 'none':
      return 'none';
    case 'expandedMetal':
    case 'checkerPlate':
      return `${pattern.kind}:${numberKeyText(pattern.spacing.value)}`;
    case 'woodGrain':
      return `woodGrain:${numberKeyText(pattern.spacing.value)}:${pattern.species}`;
  }
}

/**
 * 外観を「見え方」で表す鍵(§2.5.3 の `fingerprintKeyText` と同じ発想)。
 *
 * 見るのは three.js の材質へ写る値だけにする。すなわち
 * **プリセットの id と、式の文字(`source` / `display`)は鍵に入れない**。
 * `'10'` と `'5+5'`、プリセットの鉄板と同じ値の「自分で決める」は同じ絵になるので、
 * 材質を 2 つ作るとドローコールとメモリを無駄に増やすだけになるため(NFR-PF-1)。
 */
export function appearanceKeyText(appearance: AppearanceSpec): string {
  return [
    appearance.color,
    numberKeyText(appearance.transmission.value),
    numberKeyText(appearance.gloss.value),
    numberKeyText(appearance.roughness.value),
    patternKeyText(appearance.pattern),
  ].join('|');
}

/**
 * 面ごとの外観から、描画のまとまりを作る。
 *
 * 優先順位は `model` の `resolveAppearanceFor` と同じ 3 段(§2.2.2)で、
 * ここでは「面の割り当て」だけを表(`appearanceByFaceIndex`)で受け取り、
 * 残る 2 段(立体の割り当て → 文書の既定)は `bodyAppearance ?? defaultAppearance` で表す。
 *
 * **面の順序は変えない。** カーネルが返す面の通し番号の順がそのまま索引の順であり、
 * 並べ替えると `SolidFaceEntry.triangleOffset` との対応が崩れるため。
 *
 * 上限(§0.a-0.11 の材質 8 種、§2.5.2 のまとまり 32 個)を超えたときは
 * **例外を投げずに `null` を返す**。断りの文言を出すのは呼び出し側の役目とし、
 * 純関数は「作れなかった」ことだけを返す(NFR-UX-5 の実行前の赤表示はコマンド側)。
 */
export function buildFaceGroups(
  faces: readonly SolidFaceEntry[],
  appearanceByFaceIndex: ReadonlyMap<number, AppearanceSpec>,
  bodyAppearance: AppearanceSpec | null,
  defaultAppearance: AppearanceSpec,
): FaceGroupPlan | null {
  const base = bodyAppearance ?? defaultAppearance;
  const appearances: AppearanceSpec[] = [base];
  const indexByKey = new Map<string, number>([[appearanceKeyText(base), 0]]);
  const groups: FaceGroup[] = [];

  for (const face of faces) {
    // 三角形が付かなかった面(0 枚)はまとまりを作らない。NaN も同じ扱いになるよう
    // 「0 より大きいか」で書く。
    if (!(face.triangleCount > 0)) {
      continue;
    }
    const specified = appearanceByFaceIndex.get(face.index);
    const appearance = specified ?? base;
    const key = appearanceKeyText(appearance);
    let materialIndex = indexByKey.get(key);
    if (materialIndex === undefined) {
      materialIndex = appearances.length;
      appearances.push(appearance);
      indexByKey.set(key, materialIndex);
      if (appearances.length > MAX_MATERIALS_PER_BODY) {
        return null;
      }
    }

    const start = face.triangleOffset * 3;
    const count = face.triangleCount * 3;
    const last = groups.length > 0 ? groups[groups.length - 1] : undefined;
    // 直前のまとまりと材質が同じで、索引の上でも隙間なく続いているときだけ畳む。
    // 隙間があるまま畳むと、間の索引まで別の材質で塗ってしまうため。
    if (last !== undefined && last.materialIndex === materialIndex && last.start + last.count === start) {
      groups[groups.length - 1] = { start: last.start, count: last.count + count, materialIndex };
      continue;
    }
    groups.push({ start, count, materialIndex });
    if (groups.length > MAX_GROUPS_PER_BODY) {
      return null;
    }
  }

  return { groups, appearances };
}
