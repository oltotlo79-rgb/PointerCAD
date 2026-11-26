import { plainText, type FailureText } from '../failureText.js';
import type { SolidFailureReason } from './surfaceBodyPlan.js';
import type { SolidStepPlan } from './solidStepPlan.js';

/** 解決できなかった理由の区別(FR-504)。画面は text の鍵と値を文にする。 */
export type PartErrorCode =
  /** 断面の面・回転軸の線分が見つからない(消された、またはスケッチ側で解決できなかった)。 */
  | 'missingProfile'
  /** ブーリアンの対象・相手のボディが無い(未作成・抑制中・上流が失敗)。 */
  | 'missingBody'
  /** 距離・角度・許容量が数でない、または範囲の外。対象と相手が同じ場合も含む。 */
  | 'invalidValue'
  /** 面の枚数が足りないなど、形として成り立たない。 */
  | 'degenerate'
  /** 断面から平面の向きが定まらない。 */
  | 'notPlanar'
  /** そのボディはすでに別のブーリアンが消費している。 */
  | 'consumedTwice'
  /**
   * 加工するもとの面・辺・頂点が見つからない(FR-504)。
   * 指紋の照合はカーネルの中で行うので、**この code を出すのは
   * 「面・辺を1つも指していない」場合(面取り)と、カーネルの失敗を詰め替える
   * kernelBridge / recomputePart**である。文言は
   * 「加工するもとの面(辺)が見つかりません。形が大きく変わったため、選び直してください。」
   */
  | 'missingSubShape'
  /**
   * 基準ジオメトリ(FR-328、FR-329)の指定が循環している。
   * 作業平面 A がスケッチ S の点を使い、S が作業平面 A の上に描かれている、のような場合。
   */
  | 'circularReference'
  /** カーネルが形を作れなかった(このファイルでは使わない)。 */
  | 'kernelFailed'
  /** Worker が壊れて応答しなかった(橋の符号 'workerBroken' を recomputePart が写す。このファイルでは使わない)。 */
  | 'workerBroken';

/** 解決できなかった理由。止めずに持ち回る(FR-504、NFR-RE-1)。 */
export interface PartError {
  readonly featureId: string;
  readonly reason?: SolidFailureReason;
  readonly code: PartErrorCode;
  /** 画面に出す文の鍵と値(0b-3)。文は画面の側(ui の partErrorMessage)が文言の表で作る。計算部の文は plainText で運ぶ。 */
  readonly text: FailureText;
}

export type PlanOutcome =
  | { readonly ok: true; readonly plan: SolidStepPlan }
  | { readonly ok: false; readonly error: PartError };

export function partError(featureId: string, code: PartErrorCode, message: string): PartError {
  return { featureId, code, text: plainText(message) };
}

export function fail(featureId: string, code: PartErrorCode, message: string): PlanOutcome {
  return { ok: false, error: partError(featureId, code, message) };
}

/** 画面の文を鍵と値で持つ誤り(0b-3b から。文は ui の文言の表が鍵ごとに持つ)。 */
export function partErrorWith(featureId: string, code: PartErrorCode, text: FailureText): PartError {
  return { featureId, code, text };
}

export function failWith(featureId: string, code: PartErrorCode, text: FailureText): PlanOutcome {
  return { ok: false, error: partErrorWith(featureId, code, text) };
}

