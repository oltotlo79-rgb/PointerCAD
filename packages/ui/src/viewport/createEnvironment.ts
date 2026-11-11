/**
 * 映り込み用の環境マップ(計画書 docs/plans/P5-高度なソリッド・外観と測定.md §2.6、
 * §0.a-0.9、タスク9)。
 *
 * 対応要件: FR-1107(鏡・ガラス)、NFR-PF-5(要らないものを作らない)。
 *
 * three.js に同梱の手続き的な部屋(`RoomEnvironment`)を `PMREMGenerator` に通して
 * 1 枚だけ作る。**画像ファイルは 1 つも増えない**(依存の追加も 0 件。§1、§0.a-0.9)。
 *
 * **鏡・ガラスを 1 つも使っていない文書では作らない。** 作るかどうかの判断は
 * `appearance/createAppearanceMaterial.ts` の `anyNeedsEnvironment` が行い、
 * ここは「入になったら作る / 切になったら捨てる」だけを受け持つ(NFR-PF-5)。
 * タスク10 の呼び出し方(申し送り):
 *
 * ```ts
 * const environments = createEnvironmentStore(() => createEnvironmentTarget(renderer));
 * // 外観を差し替えるたび:
 * let environment: THREE.Texture | null = null;
 * if (anyNeedsEnvironment(usedSpecs)) {
 *   environment = environments.ensureEnvironment(scene);
 * } else {
 *   environments.releaseEnvironment(scene);
 * }
 * ```
 *
 * **`scene.environment` に入れる。`scene.background` には入れない**(§2.6)。背景は
 * `alpha: true` の canvas 越しに CSS の縦グラデーションが透ける今の見た目を保つ。
 *
 * **レンダラの設定は触らない**(§0.a-0.12)。足すのは `scene.environment` の 1 行だけで、
 * トーンマッピングや出力の色空間は変えない(既存の全画面の見た目が変わるため)。
 *
 * 計画書との差(理由つき): 計画書は `createEnvironmentTexture(renderer): THREE.Texture` と
 * 書いているが、`PMREMGenerator.fromScene` が返すのは `WebGLRenderTarget` であり、
 * テクスチャだけを取り出すと**レンダーターゲットを捨てる口が無くなる**
 * (§4「three.js で作った材質・テクスチャ・レンダーターゲットは必ず dispose() する」)。
 * そこで `EnvironmentTarget`(テクスチャ + `dispose`)を返す形にした。
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { assertEnvironmentTarget, environmentReservation, ENVIRONMENT_BUDGET_MESSAGE,
  UNKNOWN_ENVIRONMENT_MESSAGE, type EnvironmentRenderTarget, type EnvironmentReservation } from './environmentReservation.js';
import { LOCAL_DISPLAY_GPU_MESH_BUDGET, type GpuMeshBudget } from './solidMeshAdmission.js';
import { createViewportLifetime, type ViewportLifetime } from './viewportLifetime.js';

/**
 * 部屋を環境マップへ焼くときのぼかし(ラジアン)。§2.6 の値そのまま。
 * 小さくすると部屋の家具の形が鏡へはっきり映り、大きくすると明るさだけが残る。
 */
const ENVIRONMENT_BLUR_SIGMA = 0.04;

/** 環境マップ 1 枚と、その解放の口。 */
export interface EnvironmentTarget {
  readonly texture: THREE.Texture;
  /** レンダーターゲット(付随する深度なども含む)ごと捨てる。 */
  dispose(): void;
}

/** The caller must keep the peak reservation until this cleanup actually succeeds. */
export class EnvironmentCreationFailure extends Error {
  constructor(cause: unknown, readonly cleanup: () => void) {
    super('Environment creation left resources awaiting cleanup', { cause });
    this.name = 'EnvironmentCreationFailure';
  }
}

function finishCleanup(cleanup: ViewportLifetime): void {
  cleanup.dispose();
  if (cleanup.pendingCount !== 0) throw new Error(cleanup.errors.join('; '));
}

/**
 * 環境マップを 1 枚作る。製品では WebGL レンダラを使う。Node の検査では
 * GPU を確保しないレンダラ境界で実際の PMREM/Room オブジェクトの所有を検査する。
 */
export function createEnvironmentTarget(renderer: THREE.WebGLRenderer): EnvironmentTarget {
  if (environmentReservation() === null) throw new RangeError(UNKNOWN_ENVIRONMENT_MESSAGE);
  const temporary = createViewportLifetime(), output = createViewportLifetime();
  const previous = renderer.getRenderTarget(), face = renderer.getActiveCubeFace();
  const mip = renderer.getActiveMipmapLevel(), xr = renderer.xr.enabled;
  const toneMapping = renderer.toneMapping, autoClear = renderer.autoClear;
  const setTarget = renderer.setRenderTarget.bind(renderer);
  const descriptor = Object.getOwnPropertyDescriptor(renderer, 'setRenderTarget');
  const seen = new Set<EnvironmentRenderTarget>();
  let target: THREE.WebGLRenderTarget | null = null;
  let failure: unknown;
  let failed = false;
  try {
    const generator = new THREE.PMREMGenerator(renderer);
    temporary.register('PMREM temporary resources', () => { generator.dispose(); });
    const room = new RoomEnvironment();
    temporary.register('room geometry and materials', () => { room.dispose(); });
    room.traverse(object => {
      if (object instanceof THREE.InstancedMesh) {
        temporary.register('room instance attributes', () => { object.dispose(); });
      }
    });
    renderer.setRenderTarget = function (next, activeFace, activeMip): void {
      if (next !== null && next !== previous) {
        if (!seen.has(next)) {
          seen.add(next);
          // fromScene owns its output only in a local variable. Capture it BEFORE allocation,
          // so an exception in setRenderTarget/render cannot make that target unreachable.
          if (next.depthBuffer) output.register('PMREM output', () => { next.dispose(); });
        }
        assertEnvironmentTarget(next);
        if (seen.size > 2) throw new RangeError(UNKNOWN_ENVIRONMENT_MESSAGE);
      }
      setTarget(next, activeFace, activeMip);
    };
    target = generator.fromScene(room, ENVIRONMENT_BLUR_SIGMA, 0.1, 100, { size: 256 });
    if (!seen.has(target) || !target.depthBuffer) throw new RangeError(UNKNOWN_ENVIRONMENT_MESSAGE);
    assertEnvironmentTarget(target);
  } catch (error) {
    failed = true; failure = error;
  } finally {
    // Restore the exact method, including an inherited method's original descriptor shape.
    if (descriptor === undefined) Reflect.deleteProperty(renderer, 'setRenderTarget');
    else Object.defineProperty(renderer, 'setRenderTarget', descriptor);
    renderer.xr.enabled = xr;
    renderer.toneMapping = toneMapping;
    renderer.autoClear = autoClear;
    temporary.register('previous render target', () => { setTarget(previous, face, mip); });
  }
  temporary.dispose();
  if (failed || temporary.pendingCount !== 0 || target === null) {
    output.dispose();
    const cleanup = (): void => {
      temporary.dispose(); output.dispose();
      if (temporary.pendingCount + output.pendingCount !== 0) {
        throw new Error([...temporary.errors, ...output.errors].join('; '));
      }
    };
    if (temporary.pendingCount + output.pendingCount !== 0) throw new EnvironmentCreationFailure(failure, cleanup);
    throw failure instanceof Error ? failure : new Error('Environment generation failed', { cause: failure });
  }
  return { texture: target.texture, dispose: () => { finishCleanup(output); } };
}

export interface EnvironmentCandidate {
  readonly texture: THREE.Texture | null;
  commit(scene: THREE.Scene): void;
  rollback(): void;
}

/**
 * 環境マップの持ち主。**鏡・ガラスがある間だけ 1 枚を持ち、無くなったら捨てる**
 * (§0.a-0.9、NFR-PF-5)。
 */
export interface EnvironmentStore {
  /** いま持っている環境マップ(無ければ `null`)。材質へ渡す値。 */
  readonly texture: THREE.Texture | null;
  /** Separate known environment payload, including candidates and failed cleanup. */
  readonly reservedBytes: number;
  readonly cleanupPending: boolean;
  prepareEnvironment(needed: boolean): EnvironmentCandidate;
  /**
   * 環境マップを用意して `scene.environment` へ入れる。**すでに持っていれば作り直さない**
   * (毎フレーム作り直すと NFR-PF-1 を割る)。
   */
  ensureEnvironment(scene: THREE.Scene): THREE.Texture;
  /** 環境マップを捨て、`scene.environment` を元(なし)へ戻す。 */
  releaseEnvironment(scene: THREE.Scene): void;
  /** シーンに触れずに捨てる(画面ごと閉じるとき。`createSolidLayer.dispose` から)。 */
  dispose(): void;
}

/**
 * 環境マップの持ち主を作る。
 *
 * **レンダラは `create` の中へ閉じ込める**(呼び出し側は
 * `createEnvironmentStore(() => createEnvironmentTarget(renderer))` と書く)。
 * こうすると、この入れ物そのものは WebGL に触れないので「1 枚しか作らない」
 * 「捨てたら作り直す」という筋道を Node の検査で固定できる。レンダラを引数に取る形にすると、
 * 検査で `WebGLRenderer` の偽物を用意するために `as` が要り、規約(rules/02)に反する。
 */
export function createEnvironmentStore(create: () => EnvironmentTarget,
  budget: GpuMeshBudget = LOCAL_DISPLAY_GPU_MESH_BUDGET,
  reservation: EnvironmentReservation | null = environmentReservation()): EnvironmentStore {
  interface Owned {
    readonly owner: symbol;
    target: EnvironmentTarget | null;
    cleanup: (() => void) | null;
    retired: boolean;
  }
  const owned = new Set<Owned>();
  let current: Owned | null = null;
  let closed = false;

  function discard(entry: Owned): void {
    if (!owned.has(entry)) return;
    entry.retired = true;
    if (entry.cleanup === null) return; // Reentrant disposal during the synchronous factory.
    entry.cleanup();
    budget.releaseEnvironment(entry.owner);
    owned.delete(entry);
  }

  function retryRetired(): void {
    const errors: unknown[] = [];
    for (const entry of owned) {
      if (entry.retired) {
        try { discard(entry); } catch (error) { errors.push(error); }
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Environment cleanup is pending');
  }

  function prepareEnvironment(needed: boolean): EnvironmentCandidate {
    if (closed) throw new Error('Environment owner is disposed');
    try { retryRetired(); } catch { /* Pending resources remain charged; an existing map can still be used. */ }
    let candidate = needed ? current : null;
    const previous = current;
    if (needed && candidate === null) {
      const audited = environmentReservation();
      if (reservation === null || audited === null || reservation.peakBytes !== audited.peakBytes
        || reservation.retainedBytes !== audited.retainedBytes) throw new RangeError(UNKNOWN_ENVIRONMENT_MESSAGE);
      const entry: Owned = { owner: Symbol('environment'), target: null, cleanup: null, retired: false };
      if (!budget.reserveEnvironment(entry.owner, reservation.peakBytes)) throw new RangeError(ENVIRONMENT_BUDGET_MESSAGE);
      owned.add(entry);
      try {
        const target = create();
        entry.target = target; entry.cleanup = () => { target.dispose(); };
        if (closed || entry.retired) throw new Error('Environment owner changed during creation');
        if (!budget.reserveEnvironment(entry.owner, reservation.retainedBytes)) throw new RangeError(ENVIRONMENT_BUDGET_MESSAGE);
        candidate = entry;
      } catch (error) {
        if (error instanceof EnvironmentCreationFailure) {
          entry.cleanup = error.cleanup; entry.retired = true;
        } else {
          entry.cleanup ??= () => { /* Factory failed after returning all of its resources. */ };
          try { discard(entry); } catch { /* Keep the owner and peak reservation for a later retry. */ }
        }
        throw error;
      }
    }
    let settled = false;
    return {
      texture: candidate?.target?.texture ?? null,
      commit(scene): void {
        if (settled) return;
        if (closed || current !== previous) throw new Error('Environment publication owner changed');
        settled = true;
        current = candidate;
        scene.environment = candidate?.target?.texture ?? null;
        if (previous !== null && previous !== candidate) {
          try { discard(previous); } catch { /* Publication is complete; retired cleanup remains owned. */ }
        }
      },
      rollback(): void {
        if (settled) return;
        settled = true;
        if (candidate !== null && candidate !== previous) discard(candidate);
      },
    };
  }

  return {
    get texture(): THREE.Texture | null {
      return current?.target?.texture ?? null;
    },
    get reservedBytes(): number {
      return [...owned].reduce((sum, entry) => sum + budget.environmentReservedBytes(entry.owner), 0);
    },
    get cleanupPending(): boolean { return [...owned].some(entry => entry.retired); },
    prepareEnvironment,
    ensureEnvironment(scene) {
      const candidate = prepareEnvironment(true);
      if (candidate.texture === null) throw new Error('Environment texture is missing');
      try { candidate.commit(scene); }
      catch (error) {
        try { candidate.rollback(); } catch { /* Retryable candidate cleanup remains accounted. */ }
        throw error;
      }
      return candidate.texture;
    },
    releaseEnvironment(scene) {
      scene.environment = null;
      const previous = current; current = null;
      if (previous !== null) discard(previous);
      retryRetired();
    },
    dispose() {
      closed = true; current = null;
      for (const entry of owned) entry.retired = true;
      retryRetired();
    },
  };
}
