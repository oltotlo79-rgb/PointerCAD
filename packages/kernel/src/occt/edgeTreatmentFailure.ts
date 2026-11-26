import { KernelStepError } from './kernelStepError.js';

/** フィレット・面取りが返す理由。参照が見つからない場合は既存の KernelStepError を使う。 */
export type EdgeTreatmentFailureCode =
  | 'fillet-radius'
  | 'variable-fillet-no-target'
  | 'fillet-faulty-contours'
  | 'fillet-build'
  | 'fillet-result'
  | 'chamfer-distance'
  | 'chamfer-angle'
  | 'chamfer-reference-face'
  | 'chamfer-build'
  | 'chamfer-result'
  | 'edge-treatment-kernel-unavailable'
  | 'edge-treatment-internal';

export class EdgeTreatmentFailure extends Error {
  readonly parameters: Readonly<Record<string, string>> | undefined;

  constructor(readonly code: EdgeTreatmentFailureCode, message: string,
    options?: ErrorOptions & { readonly parameters?: Readonly<Record<string, string>> }) {
    super(message, options);
    this.name = 'EdgeTreatmentFailure';
    this.parameters = options?.parameters;
  }
}

export function faultyFilletContours(count: number): EdgeTreatmentFailure {
  return new EdgeTreatmentFailure(
    'fillet-faulty-contours',
    `丸められない辺が ${count} 本ありました。半径を小さくしてください。`,
    { parameters: { count: String(count) } },
  );
}

/** すでに理由を持つ失敗を保持し、想定外の例外の原因を開発用に残す。 */
export function unexpectedEdgeTreatmentFailure(error: unknown): EdgeTreatmentFailure | KernelStepError {
  if (error instanceof EdgeTreatmentFailure || error instanceof KernelStepError) return error;
  return new EdgeTreatmentFailure('edge-treatment-internal', '幾何カーネルの内部で失敗しました。値を見直して、もう一度お試しください。',
    { cause: error });
}
