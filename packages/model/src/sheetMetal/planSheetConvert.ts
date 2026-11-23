/**
 * 部品の履歴との境界(M-08 の変換の行)。認識の答えがまだ無ければ依頼を返し、答えがあれば板金と組み直しの計画を返す。
 * 失敗は理由の符号で返し、文は画面の側の文言の表(鍵 partError.sheetConvert.<理由>)が作る。
 */
import type { SheetMetalRecognitionReason } from '@pointercad/kernel';
import type { FailureText } from '../failureText.js';
import type { SheetRecognitionReply, SheetRecognitionRequestItem } from '../kernelBridge/sheetRecognition.js';
import { sheetBoundaryEdges } from './panelGeometry.js';
import { resolveSheetConvert, type SheetConvertFailure } from './resolveSheetConvert.js';
import type { ResolvedSheetBody, SheetBodyPlan } from './resolveSheetGeometry.js';
import type { SheetConvertOrigins } from './sheetConvertIdentity.js';
import type { SheetConvertFeature, SheetMetalFeature, SheetPanelBoundaryRef } from './types.js';

/** 認識の答えと、その形の面・辺の起源(板・縁の鍵に使う)。 */
export interface SheetConvertAnswer {
  readonly reply: SheetRecognitionReply;
  readonly origins: SheetConvertOrigins;
}
/** 依頼で答えを引く。元の段の鍵か基準の面が違う依頼には、古い答えを返さない。 */
export type SheetConvertLookup = (request: SheetRecognitionRequestItem) => SheetConvertAnswer | undefined;

export type SheetConvertReason = SheetMetalRecognitionReason | SheetConvertFailure
  | 'consumed' | 'missingSource' | 'pending' | 'missingBody' | 'workerBroken' | 'rpcFailed';
export type SheetConvertOutcome = { readonly ok: true; readonly plan: SheetBodyPlan; readonly body: ResolvedSheetBody; readonly request: SheetRecognitionRequestItem; readonly answer: SheetConvertAnswer }
  | { readonly ok: false; readonly reason: SheetConvertReason; readonly request?: SheetRecognitionRequestItem };

export function planSheetConvert(feature: SheetConvertFeature, bodyKeys: ReadonlyMap<string, string>, consumed: ReadonlySet<string>,
  lookup: SheetConvertLookup | undefined): SheetConvertOutcome {
  if (consumed.has(feature.sourceFeatureId)) return { ok: false, reason: 'consumed' };
  const bodyKey = bodyKeys.get(feature.sourceFeatureId);
  if (bodyKey === undefined) return { ok: false, reason: 'missingSource' };
  const request: SheetRecognitionRequestItem = { id: feature.id, bodyKey, face: feature.referenceFace };
  const answer = lookup?.(request);
  if (answer === undefined) return { ok: false, reason: 'pending', request };
  if (answer.reply.kind === 'unavailable') return { ok: false, reason: answer.reply.code };
  if (!answer.reply.recognition.ok) return { ok: false, reason: answer.reply.recognition.reason };
  const resolved = resolveSheetConvert(feature, answer.reply.recognition, answer.origins);
  return resolved.ok ? { ...resolved, request, answer } : resolved;
}

export function sheetConvertFailureText(reason: SheetConvertReason): FailureText {
  return { key: `partError.sheetConvert.${reason}`, parameters: {} };
}

function boundaryLost(body: ResolvedSheetBody, reference: { readonly panelId: string; readonly boundaryId: string | null }): boolean {
  const panel = body.panels.find(item => item.id === reference.panelId);
  if (panel === undefined) return true;
  if (reference.boundaryId === null) return false;
  const edges = sheetBoundaryEdges(panel);
  return !edges.ok || !edges.value.some(edge => edge.id === reference.boundaryId);
}

/**
 * 変換した板金を元にする後段の加工が、今の板・縁に無い参照を持つか。元の立体を編集して対応が取れなくなった参照は、
 * 黙って別の板・縁へ付け替えずに sourceChanged で断る(統括の決定 2026-11-22)。変換していない板金では常に false。
 */
export function convertedReferenceLost(feature: Exclude<SheetMetalFeature, { kind: 'sheetBase' | 'sheetConvert' }>,
  body: ResolvedSheetBody | undefined): boolean {
  if (body?.converted !== true) return false;
  const references: readonly (SheetPanelBoundaryRef | { readonly panelId: string; readonly boundaryId: null })[] =
    feature.kind === 'sheetFlange' ? feature.edges : feature.kind === 'sheetRelief' ? [feature.boundary] : [{ panelId: feature.panelId, boundaryId: null }];
  return references.some(reference => boundaryLost(body, reference));
}
