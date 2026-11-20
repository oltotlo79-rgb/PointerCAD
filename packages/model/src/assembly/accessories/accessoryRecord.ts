/**
 * 付属の組の記録(設計 wip/auto-accessory-design.md §4。統括の決定 2026-11-19 02:08: Q1 記録を保存する・Q2 版 23。Q-A4a: ボルトの座金とナットの組の
 * 役目と欄も最初の版で決める)。置いた本体に、どの組のどの付属の部品を、どの指定で付けたかを持つ。形・位置・寸法は持たず、今の部品と族の表から
 * 作り直す(rules/04)。文書の `AssemblyDocument.accessorySets` に保存する。欄が無い文書は記録が空(古いファイルはそのまま開ける)。
 * 型だけのファイル(文書の型 `types.ts` が、実行の読み込みの輪を作らずに読む。frameJointRecord.ts と同じ形)。
 */

/**
 * 組の id(保存される。版の中で変えない)。'frame-end-caps' フレームの端のキャップ、'bolt-washer-nut' ボルトの座金とナット(A4)、
 * 'bearing-shaft-rings'・'bearing-bore-rings' 軸受の軸用・穴用の C 形止め輪(A6)、'pipe-end-fittings' 鋼管の端の継手(K-28 束 3)。
 */
export type AccessorySetId = 'frame-end-caps' | 'bolt-washer-nut' | 'bearing-shaft-rings' | 'bearing-bore-rings' | 'pipe-end-fittings';

/**
 * 付属の部品の役目。端のキャップは startCap・endCap、ボルトの組は headWasher・nutWasher・springWasher・nut、軸受の止め輪は startRing・endRing、
 * 鋼管の端の継手は startFitting・endFitting(分割・統合では端のキャップと同じに扱う)。
 */
export type AccessoryRole = 'startCap' | 'endCap' | 'headWasher' | 'nutWasher' | 'springWasher' | 'nut' | 'startRing' | 'endRing'
  | 'startFitting' | 'endFitting';

/** エルボ・チーズの枝の向き: 管の軸のまわりの 90° の回しの数。 */
export type AccessoryTurn = 0 | 1 | 2 | 3;

/** キャップを付ける端(ボルトの組は 'both')。 */
export type AccessoryEnds = 'both' | 'start' | 'end';

/** 線の端の意味: 全長(付属を含む。本体を付属の厚さだけ縮める)か、本体の長さ(付属は外へ出る)。ボルトの組は 'member'。 */
export type AccessoryEndReference = 'overall' | 'member';

export interface AccessorySetRecord {
  /** 文書の中で一意(`accessory-<n>`)。 */
  readonly id: string;
  readonly setId: AccessorySetId;
  readonly hostComponentId: string;
  readonly accessories: readonly { readonly componentId: string; readonly role: AccessoryRole }[];
  /**
   * 作り直しに使う、利用者が選んだ値。itemKey は付属の行の鍵(キャップは族の行、ボルトの組は座金とナットの呼び)。
   * gripMm(締め付ける厚さ、mm)と springWasher(ばね座金の有無)はボルトの組だけが持つ。
   * familyId(継手の族。候補が複数の族にまたがるので行の鍵と対で持つ)と turn(エルボ・チーズの枝の向き)は鋼管の端の継手の組だけが持つ
   * (turn はエルボ・チーズの時だけ)。ほかの組の記録は持たない(保存の形は前のまま)。
   */
  readonly choices: {
    readonly ends: AccessoryEnds;
    readonly endReference: AccessoryEndReference;
    readonly itemKey: string;
    readonly gripMm?: number;
    readonly springWasher?: boolean;
    readonly familyId?: string;
    readonly turn?: AccessoryTurn;
  };
}
