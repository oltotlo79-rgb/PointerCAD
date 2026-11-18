/**
 * フレームどうしの接続の記録(E-07 締結部品の自動判別。統括の決定 2026-11-18 12:3x の 1: 記録を残す)。どの部材が、どの形で、どの板と
 * どの溝用のナット・ボルトでつながっているかを持つ。E-13(結合の入れ替えと伸縮)が板を入れ替える・部材の長さに追従する時と、E-09(接合チェック)が
 * 留めたかを判定する時に読む。文書(`AssemblyDocument.frameJoints`)に保存する。欄が無い文書は記録が空(古いファイルはそのまま開ける)。
 * 型だけのファイル(文書の型 `types.ts` が、実行の読み込みの輪を作らずに読む)。
 */

/** 断面の外の面(局所 +Y が上、+X が右)。 */
export type FrameJointFace = 'top' | 'left' | 'bottom' | 'right';

export interface FrameJointRecord {
  /** 文書の中で一意。 */
  readonly id: string;
  readonly kind: 'L' | 'T' | 'butt';
  /** 接続の部材(当たる所: 始点の端・終点の端・途中)。 */
  readonly members: readonly { readonly componentId: string; readonly part: 'start' | 'end' | 'side' }[];
  /** 板の部品と、その向き(L 形は a の脚を当たられる面か当てる部材の面に、平板は 'plate')と、板が乗る面。 */
  readonly bracket: {
    readonly componentId: string;
    readonly orientation: 'aOnBase' | 'aOnButting' | 'plate';
    readonly faces: readonly { readonly componentId: string; readonly face: FrameJointFace }[];
  };
  /** この接続のために足した溝用のナットとボルトの部品。 */
  readonly fastenerIds: readonly string[];
  /** 作り直しに使う、利用者が選んだ値。 */
  readonly choices: { readonly nominal: string; readonly nutEntry: string; readonly nutMaterial: string };
}
