import { selectSubShape, type KernelBridge, type SolidRecomputeOptions } from '../kernelBridge.js';
import type { PartDocument } from '../part/types.js';
import type { ResolvedPart } from '../part/resolvePart.js';
import { buildHoleSchedule, type HoleScheduleFrame, type HoleScheduleResult } from './holeSchedule.js';

export type ResolvedHoleScheduleResult = HoleScheduleResult
  | { readonly ok: false; readonly reason: 'cancelled' }
  | { readonly ok: false; readonly reason: 'kernelFailed'; readonly message?: string };

/**
 * 消費済みの加工対象も形状キャッシュから取り出し、現在の面へ中心を投影する。
 * 表示用の文書・ストア・visibleの元配列を変更しない。
 */
export async function resolveHoleSchedule(
  document: PartDocument, resolved: ResolvedPart, kernel: Pick<KernelBridge, 'recomputeSolids'>,
  frame: HoleScheduleFrame, options: SolidRecomputeOptions,
): Promise<ResolvedHoleScheduleResult> {
  if (options.shouldCancel?.() === true) return { ok: false, reason: 'cancelled' };
  const targets = new Set(document.solids.flatMap((feature) =>
    !feature.suppressed && (feature.kind === 'hole' || feature.kind === 'threadHole') ? [feature.targetFeatureId] : []));
  if (targets.size === 0) return buildHoleSchedule(document, { sketches: resolved.sketches, frame, resolvePlane: () => null });
  const steps = resolved.steps.map((step) => ({ ...step, visible: targets.has(step.featureId) }));
  const result = await kernel.recomputeSolids(steps, options);
  if (result.cancelled || options.shouldCancel?.() === true) return { ok: false, reason: 'cancelled' };
  if (result.failures.length > 0) return { ok: false, reason: 'kernelFailed', message: result.failures[0].message };
  const bodies = new Map(result.bodies.map((body) => [body.featureId, body]));
  return buildHoleSchedule(document, { sketches: resolved.sketches, frame, resolvePlane: (targetId, face) => {
    const body = bodies.get(targetId);
    if (body === undefined) return null;
    const selected = selectSubShape(body, face);
    return selected?.kind === 'face' && selected.surfaceKind === 'plane' && selected.axis !== null
      ? { origin: selected.position, normal: selected.axis } : null;
  } });
}
