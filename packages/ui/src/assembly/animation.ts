/** P7 タスク22。単一時間軸の再生と31枚PNGの直列書き出し。 */
import { createPngSequenceZip, PNG_SEQUENCE_FRAME_COUNT } from '@pointercad/io';
import {
  explodedPlacements, presentationJointRequests, solveDrivenJoint,
  type AssemblyDocument, type JointFramePair, type MateResidualTargetPair,
  type ResolvedAssembly, type RigidPlacement,
} from '@pointercad/model';
import { dataUrlToBytes } from '../file/thumbnail.js';

export const ASSEMBLY_ANIMATION_DURATION_MS = 2_000;

export type AssemblyMotionResult =
  | { readonly ok: true; readonly placements: ReadonlyMap<string, RigidPlacement> }
  | { readonly ok: false; readonly reason: string };

/**
 * 共通時間軸の joint driver を先に解き、同じ時刻の分解平行移動を重ねる。
 * 文書・解決結果・入力配置は一切変更せず、画面専用の配置だけを返す。
 */
export function assemblyMotionPlacements(input: {
  readonly document: AssemblyDocument;
  readonly resolved: ResolvedAssembly;
  readonly mateTargets?: ReadonlyMap<string, MateResidualTargetPair>;
  readonly jointFrames?: ReadonlyMap<string, JointFramePair>;
  readonly time: number;
}): AssemblyMotionResult {
  const requests = presentationJointRequests(input.document, input.time);
  if (!requests.ok) return { ok: false, reason: requests.reason };
  let placements: ReadonlyMap<string, RigidPlacement> = input.resolved.placements;
  for (const request of requests.value) {
    const driven = solveDrivenJoint(
      input.document,
      input.mateTargets ?? new Map(),
      placements,
      request,
      { jointFrames: input.jointFrames ?? new Map() },
    );
    if (!driven.ok) return { ok: false, reason: driven.reason };
    placements = driven.placements;
  }
  const exploded = explodedPlacements(input.document, input.resolved, placements, input.time);
  return exploded.ok ? exploded : { ok: false, reason: exploded.reason };
}

export interface AnimationClock {
  readonly now: () => number;
  readonly requestFrame: (callback: (now: number) => void) => number;
  readonly cancelFrame: (handle: number) => void;
}

export interface AnimationPlayer {
  readonly start: () => void;
  readonly stop: () => void;
  readonly running: () => boolean;
}

export function normalizedAnimationTime(
  from: number,
  elapsedMs: number,
  durationMs = ASSEMBLY_ANIMATION_DURATION_MS,
): number | null {
  if (!Number.isFinite(from) || from < 0 || from > 1 || !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  const progress = Math.min(1, elapsedMs / durationMs);
  const value = from + (1 - from) * progress;
  return value === 0 ? 0 : value;
}

/** 自分で立てた requestAnimationFrame は完了・取消・例外の全経路で必ず止める。 */
export function createAnimationPlayer(options: {
  readonly from?: number;
  readonly durationMs?: number;
  readonly clock?: AnimationClock;
  readonly onFrame: (t: number) => void;
  readonly onStopped?: (reason: 'completed' | 'cancelled' | 'failed') => void;
}): AnimationPlayer {
  const clock = options.clock ?? {
    now: () => performance.now(),
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
  };
  const from = options.from ?? 0;
  const duration = options.durationMs ?? ASSEMBLY_ANIMATION_DURATION_MS;
  let handle: number | null = null;
  let startedAt = 0;
  let active = false;

  const finish = (reason: 'completed' | 'cancelled' | 'failed'): void => {
    if (!active) return;
    active = false;
    if (handle !== null) clock.cancelFrame(handle);
    handle = null;
    options.onStopped?.(reason);
  };
  const tick = (now: number): void => {
    if (!active) return;
    handle = null;
    const t = normalizedAnimationTime(from, now - startedAt, duration);
    if (t === null) {
      finish('failed');
      return;
    }
    try {
      options.onFrame(t);
    } catch (error) {
      finish('failed');
      throw error;
    }
    if (t >= 1) {
      finish('completed');
      return;
    }
    handle = clock.requestFrame(tick);
  };
  return {
    start: () => {
      finish('cancelled');
      const valid = normalizedAnimationTime(from, 0, duration);
      if (valid === null) {
        options.onStopped?.('failed');
        return;
      }
      active = true;
      startedAt = clock.now();
      try {
        options.onFrame(valid);
      } catch (error) {
        finish('failed');
        throw error;
      }
      if (valid >= 1) finish('completed');
      else handle = clock.requestFrame(tick);
    },
    stop: () => { finish('cancelled'); },
    running: () => active,
  };
}

export type AnimationExportResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'renderFailed' | 'captureFailed' | 'archiveFailed' | 'cancelled' | 'saveFailed' };

/**
 * 各時刻を「反映完了→撮影」の順で直列処理する。途中失敗でも `restoreFrame` を必ず待ち、
 * 31枚が揃う前には保存を呼ばない。
 */
export async function exportAnimationPngSequence(options: {
  readonly renderFrame: (t: number) => void | Promise<void>;
  readonly captureFrame: () => string | null;
  readonly restoreFrame: () => void | Promise<void>;
  readonly save: (bytes: Uint8Array) => boolean | Promise<boolean>;
}): Promise<AnimationExportResult> {
  const frames: Uint8Array[] = [];
  let failure: AnimationExportResult | null = null;
  try {
    for (let frame = 0; frame < PNG_SEQUENCE_FRAME_COUNT; frame += 1) {
      try {
        await options.renderFrame(frame / (PNG_SEQUENCE_FRAME_COUNT - 1));
      } catch {
        failure = { ok: false, reason: 'renderFailed' };
        break;
      }
      const image = options.captureFrame();
      const bytes = image === null ? null : dataUrlToBytes(image);
      if (bytes === null) {
        failure = { ok: false, reason: 'captureFailed' };
        break;
      }
      frames.push(bytes);
    }
  } finally {
    try {
      await options.restoreFrame();
    } catch {
      failure = { ok: false, reason: 'renderFailed' };
    }
  }
  if (failure !== null) return failure;
  const archive = createPngSequenceZip(frames);
  if (!archive.ok) return { ok: false, reason: 'archiveFailed' };
  try {
    const saved = await options.save(archive.bytes);
    return saved ? { ok: true, bytes: archive.bytes } : { ok: false, reason: 'cancelled' };
  } catch {
    return { ok: false, reason: 'saveFailed' };
  }
}
