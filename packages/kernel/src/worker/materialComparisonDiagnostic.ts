export const MAX_MATERIAL_COMPARISON_SOLIDS_PER_SIDE = 1024;

// 旧読取側も message を読める。内部例外の原文はここに入れない。
const legacyMessages = {
  invalidRequest: '比較するソリッドの指定が正しくありません。',
  solidLimit: '比較するソリッドが多すぎます。部品を分けて比較してください。',
  triangleLimit: '比較する形が大きすぎます。部品を分けて比較してください。',
  expired: '比較するソリッドが見つかりません。形を再計算してください。',
  requiresSolid: '形の比較は閉じたソリッドを対象にしています。',
  internal: '形の比較結果を確認できませんでした。再度お試しください。',
};

export type MaterialComparisonDiagnostic = keyof typeof legacyMessages;
export interface MaterialComparisonFailure {
  readonly kind: 'failed';
  readonly message: string;
  readonly diagnostic?: MaterialComparisonDiagnostic;
}

export function materialComparisonFailure(diagnostic: MaterialComparisonDiagnostic): MaterialComparisonFailure {
  return { kind: 'failed', diagnostic, message: legacyMessages[diagnostic] };
}

export class MaterialComparisonRejection extends Error {
  constructor(readonly diagnostic: 'solidLimit' | 'requiresSolid') {
    super(diagnostic);
  }
}

export interface MaterialComparisonFault {
  readonly stage: string;
  readonly cause: unknown;
}

export type ReportMaterialComparisonFaults = (faults: readonly MaterialComparisonFault[], preceding: string) => void;

export const reportMaterialComparisonFaults: ReportMaterialComparisonFaults = (faults, preceding) => {
  console.error('PointerCAD material comparison', preceding, faults);
};
