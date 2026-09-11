/** 履歴が参照するスケッチ要素の安定ID。保存形式と板金が共有する中立契約。 */
export interface SketchFaceRef {
  readonly sketchId: string;
  readonly faceFeatureId: string;
}

export interface SketchCurveRef {
  readonly sketchId: string;
  /** 曲線フィーチャー(線分・円弧・スプライン等)の id。1 つ以上。並びが意味を持つ。 */
  readonly curveIds: readonly string[];
}

export interface SketchLineRef {
  readonly sketchId: string;
  readonly lineFeatureId: string;
}

export interface SketchPointRef {
  readonly sketchId: string;
  /** 点フィーチャー(kind: 'point')または点列フィーチャー(kind: 'pointArray')の id。 */
  readonly pointFeatureId: string;
}
