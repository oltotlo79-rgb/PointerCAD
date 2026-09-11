/** 立体履歴の保存上の識別子。種類別の寸法・参照は各契約が持つ。 */
export interface SolidFeatureBase {
  /**
   * フィーチャーの id。同時にこのフィーチャーが作るボディの id でもある(§0.a-0.5)。
   * 他のフィーチャー(ブーリアン)から参照されるので、文書の中で重ならない。
   */
  readonly id: string;
  /** フィーチャーツリーの表示名(FR-501)。 */
  readonly name: string;
  /** 抑制(FR-503)。true なら再計算で飛ばし、ボディを作らない。 */
  readonly suppressed: boolean;
}
