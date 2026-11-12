import type { createThumbnailCaptureReasonJournal } from '../file/thumbnail.js';
import { useAppStore } from '../store/useAppStore.js';
import { currentAssemblyMeshAdmission } from './assemblyMeshAdmission.js';
import type { ViewportScene } from './createViewportScene.js';
import type { ViewportAssemblyInput } from './viewportCanvasAssemblyInput.js';
import { assemblyBundleOf } from './viewportCanvasStoreViews.js';
import type { ViewportLifetime } from './viewportLifetime.js';

/*
 * ViewportCanvas の保存・印刷の 1 コマの作り手(FR-801・FR-810)。3D 表示部は後から読み込まれるので、用意できる
 * までは口が空(サムネイルなし・印刷は断り)。組立の受領を取り直している間の保存は、同じ公開の取り直しを待ち、
 * 待っている間に表示の公開が変わった時は古い絵を借りずに null を返す。
 */

/** 作り手が借りるもの。 */
interface ViewportCaptureDependencies {
  readonly scene: Pick<ViewportScene, 'captureThumbnail' | 'capturePrintFrame'>;
  readonly lifetime: ViewportLifetime;
  readonly isAlive: () => boolean;
  readonly assemblyInput: Pick<ViewportAssemblyInput, 'assemblyReady' | 'pendingRefresh'>;
  readonly thumbnailReasons: ReturnType<typeof createThumbnailCaptureReasonJournal>;
}

/** 保存と印刷の作り手をストアへ差し出し、外す時は自分の作り手の時だけ空へ戻す。 */
export function publishCaptureProducers(deps: ViewportCaptureDependencies) {
  const { scene, lifetime, isAlive, assemblyInput, thumbnailReasons } = deps;
  let thumbnailPublicationGeneration = 0;
  // 保存のときに呼ばれるサムネイルの作り手を差し出す(FR-801)。
  // 3D 表示部は後から読み込まれるので、それまでは口が空でサムネイルなしになる。
  const captureThumbnail = (): Uint8Array | null | Promise<Uint8Array | null> => {
    if (!isAlive()) { thumbnailReasons.record('consumer:not-alive'); return null; }
    const owner = useAppStore.getState().assemblyView?.meshOwnership;
    const capture = (): Uint8Array | null => {
      thumbnailReasons.record('consumer:admitted');
      return scene.captureThumbnail(undefined, thumbnailReasons.record);
    };
    if (assemblyInput.assemblyReady()) return capture();
    const pending = owner === undefined ? undefined : assemblyInput.pendingRefresh(owner);
    if (pending === undefined) { thumbnailReasons.record('consumer:admission'); return null; }
    const capturedGeneration = thumbnailPublicationGeneration;
    thumbnailReasons.record('consumer:admission-wait');
    return pending.then(ready => {
      if (!isAlive() || !ready || capturedGeneration !== thumbnailPublicationGeneration) {
        thumbnailReasons.record('consumer:admission-obsolete'); return null;
      }
      const state = useAppStore.getState(), fresh = state.assemblyView?.meshOwnership;
      if (fresh === undefined || !currentAssemblyMeshAdmission({ bundle: assemblyBundleOf(state), ownership: fresh, state }, state)) {
        thumbnailReasons.record('consumer:admission'); return null;
      }
      return capture();
    }).catch(() => { thumbnailReasons.record('consumer:admission'); return null; });
  };
  lifetime.register('thumbnail producer', () => {
    if (useAppStore.getState().captureThumbnail === captureThumbnail) useAppStore.getState().setCaptureThumbnail(null);
  });
  useAppStore.getState().setCaptureThumbnail(captureThumbnail);
  // 印刷のときに呼ばれる 1 コマの作り手も同じように差し出す(FR-810)。
  // 用意できるまでは口が空で、印刷は「印刷する絵を作れませんでした。」で断られる。
  const capturePrintFrame = (): string | null => isAlive() && assemblyInput.assemblyReady() ? scene.capturePrintFrame() : null;
  lifetime.register('print producer', () => {
    if (useAppStore.getState().capturePrintFrame === capturePrintFrame) useAppStore.getState().setCapturePrintFrame(null);
  });
  useAppStore.getState().setCapturePrintFrame(capturePrintFrame);
  return {
    /** 表示の公開が変わった(受領の取り直しを待っている保存の結果を古いとして捨てる)。 */
    invalidatePublication: (): void => { thumbnailPublicationGeneration++; },
  };
}
