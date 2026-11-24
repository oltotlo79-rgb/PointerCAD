/**
 * 立体を板金へ変える行(M-08)の認識の覚え書き。再計算の巡の間で計算部へ頼み、答えを覚える。
 * 覚えは文書が替わるまで持ち回る(再計算・測定・書き出し・画面の確かめが同じ答えで同じ段の鍵を作る。offsets・projections・
 * subShapes と同じ扱い。文書が替わったら呼ぶ側が clear する)。答えは依頼(行の id・元の段の鍵・基準の面)で引くので、
 * 元の形が変わると鍵が変わり、古い答えを別の形に使わない。
 * 1 巡目は元の立体がまだ消費されていないので、元の段の形(面・辺の起源つき)が返る。その形の起源を答えと一緒に覚え、
 * 2 巡目で変換の行を解く。変換の段ができた巡で、元の立体と組み直した板金の両方向の差の体積(元にだけある・組み直しにだけある)を
 * 計算部で確かめ、公差を超えた・確かめられない時は答えを差し替えて、もう 1 巡まわす(設計 §7。体積の合計だけでは欠けと余分を分けられない)。
 */
import type { CurrentOriginIndex } from '../geometry/subShapeOrigin.js';
import { fingerprintKeyText } from '../geometry/subShapeRef.js';
import type { KernelBridge } from '../kernelBridge/bridgeContracts.js';
import type { MaterialComparisonBridge, MaterialComparisonResult } from '../kernelBridge/materialComparisonContracts.js';
import { unavailableSheetReplies, type SheetRecognitionReply, type SheetRecognitionRequestItem } from '../kernelBridge/sheetRecognition.js';
import type { PartCancelToken, SolidBody } from '../kernelBridge/solidContracts.js';
import { exceedsMagnitude } from '../numericTolerance.js';
import type { SheetConvertAnswer, SheetConvertLookup } from '../sheetMetal/planSheetConvert.js';
import type { SheetConvertOrigins } from '../sheetMetal/sheetConvertIdentity.js';
import type { ResolvedPart } from './resolvePart.js';

/** 頼む口(再計算の橋が持つ物のうち、認識と体積の比べ)。比べる口(compareMaterials)の無い橋では、変換を確かめられないので断る。 */
type SheetRecognitionBridge = Pick<KernelBridge, 'recognizeSheetMetal'> & Partial<MaterialComparisonBridge>;

export interface SheetRecognitionPass {
  readonly lookup: SheetConvertLookup;
  /**
   * 答えの無い依頼を頼み、この巡でできた変換の段を確かめる。答えを覚えた・差し替えた時は true(呼び出し側はもう 1 巡まわす)。
   * 取消や文書切替で失効した巡は null。橋は認識と体積の比べだけを使う。
   */
  fill(bridge: Pick<KernelBridge, 'recognizeSheetMetal'> & Partial<MaterialComparisonBridge>, resolved: ResolvedPart, bodies: readonly SolidBody[],
    settled: Set<string>, shouldCancel?: PartCancelToken): Promise<boolean | null>;
  /** 覚えを全部捨てる(文書が替わった時。新規・開く・復元・取り消し・やり直し)。 */
  clear(): void;
}

/** 覚える答えの数の上限。超えたら古い物から捨てる(捨てた答えは次に要る時に頼み直す)。 */
const MAX_REMEMBERED = 256;
/** 両方向の差の体積の公差: 元の体積の相対 1e-6、ただし 1e-6 mm³ を下回らない。 */
const DIFFERENCE_RELATIVE = 1e-6;
const DIFFERENCE_FLOOR_MM3 = 1e-6;

interface Entry {
  readonly answer: SheetConvertAnswer;
  /** 確かめ済みの組み直しの段の鍵(この鍵の段とは比べ終えた)。 */
  readonly verifiedKey?: string;
}

const NO_ORIGINS: SheetConvertOrigins = { face: () => null, edge: () => null };

/** 起源の表から、面・辺の通し番号 → 起源の文字(一意に結び付いている物だけ)。 */
export function sheetConvertOrigins(origins: CurrentOriginIndex | undefined): SheetConvertOrigins {
  if (origins?.state !== 'tracked') return NO_ORIGINS;
  const table = new Map<string, string | null>();
  for (const binding of origins.bindings) {
    if (binding.state !== 'unique') continue;
    const address = `${binding.current.kind}:${binding.current.index}`, text = JSON.stringify(binding.origin.identity);
    table.set(address, table.has(address) && table.get(address) !== text ? null : text);
  }
  return { face: index => table.get(`face:${index}`) ?? null, edge: index => table.get(`edge:${index}`) ?? null };
}

function keyOf(request: SheetRecognitionRequestItem): string {
  return JSON.stringify([request.id, request.bodyKey, fingerprintKeyText(request.face)]);
}

/** 答えを覚えの形へ。答えの無い 1 件は、頼んだのなら呼び出しの失敗(rpcFailed)、元の段が無くて頼まなかったのなら missingBody。 */
function asAnswer(reply: SheetRecognitionReply | undefined, id: string, asked: boolean): SheetConvertAnswer['reply'] {
  if (reply !== undefined) return reply;
  return { id, kind: 'unavailable', code: asked ? 'rpcFailed' : 'missingBody' };
}

/**
 * 比べた結果から、差し替える答え(公差の内なら undefined)。比べられなかった(組み直しの段が計算部で作れなかった時も含む)・
 * 差が公差を超えた時は、元の輪郭を板金として再現できない(unsupportedBoundary)。比べる口の無い橋は答えられない(rpcFailed)。
 */
function verdict(id: string, comparison: Exclude<MaterialComparisonResult, { kind: 'cancelled' }> | undefined): SheetConvertAnswer['reply'] | undefined {
  const notReproduced = { id, kind: 'recognized', recognition: { ok: false, reason: 'unsupportedBoundary' } } as const;
  if (comparison === undefined) return { id, kind: 'unavailable', code: 'rpcFailed' };
  if (comparison.kind !== 'compared') return notReproduced;
  const { beforeVolume, removed, added } = comparison.result;
  const tolerance = Math.max(DIFFERENCE_FLOOR_MM3, beforeVolume * DIFFERENCE_RELATIVE);
  const reproduced = [beforeVolume, removed.volume, added.volume].every(Number.isFinite)
    && !exceedsMagnitude(removed.volume, tolerance) && !exceedsMagnitude(added.volume, tolerance);
  return reproduced ? undefined : notReproduced;
}

export function createSheetRecognitionPass(): SheetRecognitionPass {
  const entries = new Map<string, Entry>();
  let documentGeneration = 0;
  const remember = (key: string, entry: Entry): void => {
    entries.delete(key); entries.set(key, entry);
    for (const oldest of entries.keys()) { if (entries.size <= MAX_REMEMBERED) break; entries.delete(oldest); }
  };

  /** 答えの無い依頼を頼む。元の段が作れなかった依頼には、頼まずに missingBody で答える。 */
  async function ask(bridge: SheetRecognitionBridge, resolved: ResolvedPart, bodies: readonly SolidBody[],
    settled: Set<string>, cancelled: PartCancelToken): Promise<boolean | null> {
    const requests = resolved.sheetRecognitionRequests ?? [];
    if (requests.length === 0) return false;
    const pending = requests.filter(request => !entries.has(keyOf(request)));
    const sourceOf = (request: SheetRecognitionRequestItem): SolidBody | undefined => {
      // 同じ形の鍵の段が 2 つある時は、基準の面を選んだ立体の段を先に見る。
      const step = resolved.steps.find(item => item.key === request.bodyKey && item.featureId === request.face.bodyFeatureId)
        ?? resolved.steps.find(item => item.key === request.bodyKey);
      return step === undefined ? undefined : bodies.find(body => body.featureId === step.featureId);
    };
    const ready = pending.filter(request => sourceOf(request) !== undefined);
    if (cancelled()) return null;
    const replies = ready.length === 0 ? [] : await bridge.recognizeSheetMetal?.(ready) ?? unavailableSheetReplies(ready, 'rpcFailed');
    if (cancelled()) return null;
    for (const request of pending) {
      const key = keyOf(request);
      if (entries.has(key)) continue;
      const reply = asAnswer(replies.find(item => item.id === request.id), request.id, ready.includes(request));
      remember(key, { answer: { reply, origins: sheetConvertOrigins(sourceOf(request)?.origins) } });
    }
    // 同じ鍵を待っていた別の巡が先に答えを入れても、この巡の暫定結果を解き直す。
    for (const request of requests) settled.add(JSON.stringify(['sheetRecognition', keyOf(request)]));
    return true;
  }

  /** この巡の解決で答えを使い、段を作った変換を、元の立体と比べて確かめる(後段に消費されて見えない段も比べる)。差し替えた時は true。 */
  async function verify(bridge: SheetRecognitionBridge, resolved: ResolvedPart, settled: Set<string>,
    cancelled: PartCancelToken): Promise<boolean | null> {
    let replaced = false;
    for (const { request, answer, rebuiltKey } of resolved.sheetRecognitionComparisons ?? []) {
      if (cancelled()) return null;
      const key = keyOf(request), entry = entries.get(key);
      if (entry === undefined || entry.answer !== answer || answer.reply.kind !== 'recognized' || !answer.reply.recognition.ok) return null;
      if (entry.verifiedKey === rebuiltKey) continue;
      const comparison = await bridge.compareMaterials?.([request.bodyKey], [rebuiltKey], cancelled);
      if (cancelled() || comparison?.kind === 'cancelled') return null;
      const current = entries.get(key);
      if (current !== entry) {
        // 同じ答えと段を先に確かめた別の巡がいれば、後から届いた比較は捨てる。
        if (current !== undefined && current.answer === answer && current.verifiedKey === rebuiltKey) continue;
        return null;
      }
      const reply = verdict(request.id, comparison);
      remember(key, { ...entry, verifiedKey: rebuiltKey, ...(reply === undefined ? {} : { answer: { ...entry.answer, reply } }) });
      if (reply === undefined) continue;
      settled.add(JSON.stringify(['sheetRecognitionVerified', key, rebuiltKey]));
      replaced = true;
    }
    return replaced;
  }

  return {
    lookup: request => entries.get(keyOf(request))?.answer,
    async fill(bridge, resolved, bodies, settled, shouldCancel) {
      const startedGeneration = documentGeneration;
      const cancelled = () => startedGeneration !== documentGeneration || shouldCancel?.() === true;
      if (cancelled()) return null;
      try {
        const replaced = await verify(bridge, resolved, settled, cancelled);
        if (replaced === null || cancelled()) return null;
        const asked = await ask(bridge, resolved, bodies, settled, cancelled);
        return asked === null || cancelled() ? null : asked || replaced;
      } catch (error) {
        if (cancelled()) return null;
        throw error;
      }
    },
    clear: () => { documentGeneration += 1; entries.clear(); },
  };
}
