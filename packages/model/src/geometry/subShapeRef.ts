/**
 * 部分形状(面・辺・頂点)への参照と、幾何の指紋(計画書 docs/plans/P3-加工フィーチャー.md
 * §2.2、§0.a-0.3、§0.a-0.4、タスク12。置き場の組み替えは
 * docs/plans/P4-スケッチ拡張.md §0.a-0.7、§2.6、タスク3)。
 *
 * B-rep の面・辺には名前が無く `TopExp` の並び順しか手がかりが無いため、上流のフィーチャー
 * を変えると並びがずれる(トポロジカルネーミング問題)。この対策として、文書には並び順の
 * かわりに「指紋」(種類・軸の向き・大きさ・位置・通し番号)を保存し、再計算のたびにカーネル
 * (Worker 側、タスク5 `matchSubShape.ts`)が指紋と最も点の高い部分形状を選び直す。
 * このファイルは指紋そのものと、文書側で使う純粋な道具(種類の判定・同一判定・重複除去・
 * 鍵の材料への文字列化)だけを持つ。**採点(何点で一致とみなすか)は kernel 側の責務であり、
 * ここには置かない**(計画書 §2.2.4「選び直しはカーネルの中で行う」)。
 *
 * 型の置き場について: これらの型は `.pcad` に保存される値であり、当初は保存形をまとめる
 * `part/types.ts` に置いていた(P3 タスク13)。P4 では 3D スケッチ(FR-330)の点が立体の頂点
 * (部分形状の参照)を指す必要があり、`sketch` 側もこの型を import しなければならなくなった。
 * `part/types.ts` は `sketch/types.ts` を import しているため(`part → sketch` の一方向)、
 * 型を `part/types.ts` に置いたままでは `sketch` からの import が循環してしまう。そこで
 * `part` にも `sketch` にも依存しない中立の置き場としてこの `geometry/` を新設し、
 * 両方がここを import する形にした(P4 計画書 §0.a-0.7)。`part/types.ts` と
 * `part/subShapeRef.ts` は、既存コードの import 文を変えずに済ませるためこのファイルからの
 * re-export だけを残す。
 *
 * 依存方向について: `@pointercad/kernel` は import しない。model から kernel への import は
 * `kernelBridge.ts` だけに閉じる約束(同ファイル冒頭のコメント)になっており、
 * `packages/kernel/src/types.ts` に構造の似た `SubShapeKind` 等があっても、model 側で
 * 型を定義して合わせる(P2 の `kernelBridge.ts` と同じ流儀)。
 */

import { keyNumber } from '../part/cacheKey.js';
import type { Vec3 } from '../sketch/vec3.js';

/** 部分形状の種類(P3 計画書 §2.2.2)。 */
export type SubShapeKind = 'face' | 'edge' | 'vertex';

/** 面の曲面の種類。 */
export type FaceSurfaceKind = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'other';

/** 辺の曲線の種類。 */
export type EdgeCurveKind = 'line' | 'circle' | 'ellipse' | 'other';

/**
 * 部分形状の指紋(P3 計画書 §2.2.2)。保存される。
 * 「形が同じなら必ず同じ値になるもの」だけを持つ。三角形の数・色・隣接する面の一覧は
 * 形が変わると壊れやすく費用も高いため入れない(§2.2.2「入れないもの」)。
 */
export type SubShapeFingerprint =
  | {
      readonly kind: 'face';
      readonly surfaceKind: FaceSurfaceKind;
      /** 面積(mm²)。 */
      readonly area: number;
      /** 重心(mm)。 */
      readonly position: Vec3;
      /** 平面は法線、円柱・円錐は軸。軸が無い形(自由曲面)は null。 */
      readonly axis: Vec3 | null;
      /** 円柱・円錐・球のみ。それ以外は null。 */
      readonly radius: number | null;
    }
  | {
      readonly kind: 'edge';
      readonly curveKind: EdgeCurveKind;
      /** 長さ(mm)。 */
      readonly length: number;
      /** 中点(mm)。 */
      readonly position: Vec3;
      /** 円は軸、直線は向き。それ以外(楕円・その他)は null。 */
      readonly axis: Vec3 | null;
      /** 円のみ。それ以外は null。 */
      readonly radius: number | null;
    }
  | { readonly kind: 'vertex'; readonly position: Vec3 };

/**
 * ボディの部分形状(面・辺・頂点)への参照(P3 計画書 §2.2.2)。保存される。
 *
 * B-rep の面・辺には名前が無く並び順しか手がかりが無いので(トポロジカルネーミング問題)、
 * 選んだ瞬間の指紋をそのまま保存し、再計算のたびにカーネルが `bodyFeatureId` の指すボディの
 * 中から指紋に最も近い部分形状を選び直す。見つからなければ理由を出して断る(FR-504)。
 * 指紋を使う道具(種類の判定・同一判定・重複除去・鍵の材料への文字列化)はこのファイルにある。
 */
export interface SubShapeRef {
  /** そのボディを作ったフィーチャーの id。 */
  readonly bodyFeatureId: string;
  /** 選んだときの通し番号(`TopExp.MapShapes_2` の順で数えた 0 始まりの番号)。 */
  readonly index: number;
  readonly fingerprint: SubShapeFingerprint;
}

/** 参照の種類。fingerprint.kind をそのまま返す薄い口(呼び出し側の見通しのため)。 */
export function subShapeKindOf(reference: SubShapeRef): SubShapeKind {
  return reference.fingerprint.kind;
}

/**
 * 同じ部分形状を指しているか。
 * ボディ・種類・通し番号が一致すれば同一とみなし、**指紋の中身(大きさ・位置・軸)は見ない**。
 * 選び直しの結果として指紋がわずかに変わっていても、同じ参照を指し続けているかどうかは
 * 「どのボディの何番目か」だけで判定するのが自然なため(値の近さで比べると、しきい値の
 * 選び方が要る別の問題になる)。
 */
export function isSameSubShape(a: SubShapeRef, b: SubShapeRef): boolean {
  return (
    a.bodyFeatureId === b.bodyFeatureId &&
    a.fingerprint.kind === b.fingerprint.kind &&
    a.index === b.index
  );
}

/**
 * 一覧から重複を取り除く(先に出たほうを残す)。
 * `fillet` / `chamfer` が同じ辺を 2 回指していても 1 回だけ処理する(§2.6.2 手順3)ための
 * model 側の道具。O(n²) だが、1 フィーチャーが指す部分形状の数は多くても数十個程度で
 * 費用は無視できる。
 */
export function dedupeSubShapeRefs(refs: readonly SubShapeRef[]): readonly SubShapeRef[] {
  const kept: SubShapeRef[] = [];
  for (const ref of refs) {
    const alreadyKept = kept.some((existing) => isSameSubShape(existing, ref));
    if (!alreadyKept) {
      kept.push(ref);
    }
  }
  return kept;
}

/** ベクトルを鍵の材料の文字列にする。各成分は `keyNumber`(9桁丸め、-0 は 0 へ)で揃える。 */
function keyVec3Text(vector: Vec3): string {
  return `${keyNumber(vector[0])},${keyNumber(vector[1])},${keyNumber(vector[2])}`;
}

/** 無い(null)ことがある向きベクトルを鍵の材料の文字列にする。 */
function keyOptionalVec3Text(vector: Vec3 | null): string {
  return vector === null ? 'none' : keyVec3Text(vector);
}

/** 無い(null)ことがある数値を鍵の材料の文字列にする。 */
function keyOptionalNumberText(value: number | null): string {
  return value === null ? 'none' : keyNumber(value);
}

/**
 * 参照を鍵の材料の文字列にする(タスク14が `cacheKeyFor` の材料へ混ぜるときに使う)。
 * 同じ参照からは常に同じ文字列が出る(決定性)。座標・大きさは `cacheKey.ts` の `keyNumber`
 * で丸め、丸めの規則を2か所に書かない(`KEY_DECIMALS = 9`、-0 は 0 と同一視)。
 * `bodyFeatureId` と `index` も混ぜるので、同じ形の指紋でもボディや通し番号が違えば
 * 別の文字列になる(取り違えを鍵の段階で防ぐ)。
 */
export function fingerprintKeyText(reference: SubShapeRef): string {
  const { bodyFeatureId, index, fingerprint } = reference;
  const head = `body=${bodyFeatureId};index=${index}`;
  switch (fingerprint.kind) {
    case 'face':
      return (
        `face{${head}` +
        `;surfaceKind=${fingerprint.surfaceKind}` +
        `;area=${keyNumber(fingerprint.area)}` +
        `;position=${keyVec3Text(fingerprint.position)}` +
        `;axis=${keyOptionalVec3Text(fingerprint.axis)}` +
        `;radius=${keyOptionalNumberText(fingerprint.radius)}}`
      );
    case 'edge':
      return (
        `edge{${head}` +
        `;curveKind=${fingerprint.curveKind}` +
        `;length=${keyNumber(fingerprint.length)}` +
        `;position=${keyVec3Text(fingerprint.position)}` +
        `;axis=${keyOptionalVec3Text(fingerprint.axis)}` +
        `;radius=${keyOptionalNumberText(fingerprint.radius)}}`
      );
    case 'vertex':
      return `vertex{${head};position=${keyVec3Text(fingerprint.position)}}`;
  }
}
