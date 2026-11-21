import type { BeamAnalysisResult } from './analysisModel.js';

import type { SavedSolidPayload } from './savedSolidResult.js';

/** 保存した文書と解析の種類に結び付いた結果。 */
interface SavedIdentity {
  readonly analysisId: string;
  readonly analysisRevision: number;
  readonly bindingSha256: string;
  readonly appVersion: string;
}

export type SavedAnalysisResult = SavedIdentity & (SavedSolidPayload
  | { readonly kind: BeamAnalysisResult['kind']; readonly result: BeamAnalysisResult });
