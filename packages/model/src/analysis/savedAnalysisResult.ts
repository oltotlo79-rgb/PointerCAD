import type { BeamAnalysisResult } from './analysisModel.js';

/** 保存時の入力に紐づく解析結果。段 2 以降は解析の種類に応じた判別可能な和へ広げる。 */
export interface SavedAnalysisResult {
  readonly analysisId: string;
  readonly kind: BeamAnalysisResult['kind'];
  readonly analysisRevision: number;
  readonly bindingSha256: string;
  readonly appVersion: string;
  readonly result: BeamAnalysisResult;
}
