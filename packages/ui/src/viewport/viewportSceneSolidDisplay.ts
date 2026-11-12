import type * as THREE from 'three';
import { faceIndexOfTriangle } from '../solid/pickSubShape.js';
import type { DisplayStyle } from '../store/viewSlice.js';
import type { AssemblyUiBackingLedger } from './assemblyMeshAdmission.js';
import { DisplayCopyCache, distinctBackingBytes, EMPTY_SOLID_GEOMETRY } from './buildSolidGeometry.js';
import { EMPTY_SUB_SHAPE_HIGHLIGHT } from './buildSubShapeGeometry.js';
import type { AssemblyGeometryBundle } from './createAssemblyLayer.js';
import type { EnvironmentStore } from './createEnvironment.js';
import type { ViewportScene, ViewportSceneOptions } from './createViewportScene.js';
import type { ScenePointer } from './viewportScenePointer.js';
import { liveDisplayCopies, type ViewportSceneLayers } from './viewportSceneResources.js';
import {
  createSolidDisplayState, ensureCurrentSolidOwner, observeSolidMesh, publishSolidCandidate, releaseMeshReservations,
  reportedDisplayCopyBytes, type SolidInputs, type SolidPublication,
} from './viewportSceneSolidPublication.js';

/*
 * createViewportScene の立体の表示の窓口(FR-105・FR-106・FR-1106)。ボディ・強調・外観・点検の色の入力を受けて
 * 公開の手順(viewportSceneSolidPublication.ts)へ渡し、立体の当たり(ボディ・面)と診断の「全体が視野に入っている
 * ボディ」を、受領が今のままの公開にだけ答える。破棄では写しの大きさを控え、層の破棄が済んでから予約を返す。
 */

type SolidDisplayMethods = Pick<ViewportScene, 'setBodies' | 'setBodyHighlight' | 'setAppearance' | 'setSubShapeHighlight'
  | 'setPrintability' | 'pickBody' | 'pickFaceAt' | 'fullyFramedBodyIds'>;

/** 立体の表示が scene の他の持ち主から借りるもの。描画の状態・環境マップ・視点は呼ばれた時に読む。 */
interface SceneSolidDisplayDependencies {
  readonly options: ViewportSceneOptions;
  readonly uiBackings: AssemblyUiBackingLedger;
  readonly solidLayer: ViewportSceneLayers['solidLayer'];
  readonly scene: THREE.Scene;
  readonly isDisposed: () => boolean;
  /** 最後に描いた表示スタイル。まだ 1 度も描いていなければ undefined。 */
  readonly displayStyle: () => DisplayStyle | undefined;
  readonly environments: () => EnvironmentStore;
  readonly refreshEnvironment: () => void;
  readonly assemblyBundle: () => AssemblyGeometryBundle;
  readonly pointer: () => ScenePointer;
}

export function createSceneSolidDisplay(deps: SceneSolidDisplayDependencies) {
  const { solidLayer } = deps;
  const state = createSolidDisplayState();
  const publication: SolidPublication = { state, options: deps.options, uiBackings: deps.uiBackings, solidLayer,
    scene: deps.scene, displayCopies: new DisplayCopyCache(), gpuOwner: Symbol('viewport-renderer'), cpuOwner: {},
    isDisposed: deps.isDisposed, displayStyle: deps.displayStyle, environments: deps.environments,
    refreshEnvironment: deps.refreshEnvironment, assemblyBundle: deps.assemblyBundle };
  const ensureCurrentOwner = (): boolean => ensureCurrentSolidOwner(publication);

  function solidInputs(): SolidInputs {
    return { bodies: state.bodies, hovered: state.hoveredBodyId, selected: state.selectedBodyIds,
      appearance: state.appearanceInput, subHovered: state.subShapeHoveredElementId, subSelection: state.subShapeSelection };
  }

  /**
   * 押し出しの仮の形(段階計算の受け入れ)を描いている間は、立体・面の当たり判定を返さない。
   * 仮の形のボディは文書のフィーチャーではないので、その id を選択・ホバーへ渡さない(表示だけ)。
   */
  function stagedPreviewDisplayed(): boolean {
    return state.solidOwner !== null && state.solidOwner.state !== null && state.solidOwner.state.stagedSolid !== null;
  }

  /** 空の文書の間は強調と外観を控えるだけにし、ボディが届いた時の組み立てで使う。 */
  function emptyDisplayPending(): boolean {
    return state.bodies.length === 0 && state.solidOwner === null;
  }

  /** 立体の当たりは、受領が今のままの公開にだけ、最後に描いたカメラの光線で問う。 */
  function preparePointerRay(screenX: number, screenY: number): boolean {
    const pointer = deps.pointer();
    if (deps.isDisposed() || pointer.camera() === null) return false;
    if (!ensureCurrentOwner()) return false;
    return pointer.prepareCameraRay(screenX, screenY);
  }

  const methods: SolidDisplayMethods = {
    setBodies(nextBodies): void {
      publishSolidCandidate(publication, { ...solidInputs(), bodies: nextBodies });
    },

    setBodyHighlight(nextHovered, nextSelected): void {
      if (deps.isDisposed()) return;
      ensureCurrentOwner();
      if (emptyDisplayPending()) {
        state.hoveredBodyId = nextHovered;
        state.selectedBodyIds = nextSelected;
        return;
      }
      publishSolidCandidate(publication, { ...solidInputs(), hovered: nextHovered, selected: nextSelected });
    },

    setAppearance(appearance): void {
      if (deps.isDisposed()) return;
      ensureCurrentOwner();
      if (emptyDisplayPending()) {
        state.appearanceInput = appearance;
        return;
      }
      publishSolidCandidate(publication, { ...solidInputs(), appearance });
    },

    setSubShapeHighlight(hoveredElementId, selection): void {
      if (deps.isDisposed()) return;
      ensureCurrentOwner();
      if (emptyDisplayPending()) {
        state.subShapeHoveredElementId = hoveredElementId;
        state.subShapeSelection = selection;
        return;
      }
      publishSolidCandidate(publication, { ...solidInputs(), subHovered: hoveredElementId, subSelection: selection });
    },

    setPrintability(highlight): void {
      if (deps.isDisposed()) return;
      solidLayer.setPrintabilityHighlight(ensureCurrentOwner() ? highlight : null);
    },

    pickBody(screenX, screenY): string | null {
      if (stagedPreviewDisplayed() || !preparePointerRay(screenX, screenY)) return null;
      return solidLayer.pickBody(deps.pointer().raycaster);
    },

    pickFaceAt(screenX, screenY): { readonly featureId: string; readonly faceIndex: number } | null {
      if (stagedPreviewDisplayed() || !preparePointerRay(screenX, screenY)) return null;
      const hit = solidLayer.pickFace(deps.pointer().raycaster);
      if (hit === null) {
        return null;
      }
      // 当たった三角形の通し番号を、そのボディの面ごとの範囲表で面の通し番号へ直す。
      const entry = state.solidBundle.index.get(hit.featureId);
      if (entry === undefined) {
        return null;
      }
      const faceIndex = faceIndexOfTriangle(entry.faces, hit.triangleIndex);
      return faceIndex === null ? null : { featureId: hit.featureId, faceIndex };
    },

    fullyFramedBodyIds(): readonly string[] {
      const pointer = deps.pointer();
      const camera = pointer.camera();
      if (camera === null || !ensureCurrentOwner()) return [];
      return pointer.fullyFramed(state.bodies, camera);
    },
  };

  return {
    methods,
    ensureCurrentOwner,
    bundle: () => state.solidBundle,
    isInvalidated: () => state.solidDisplayInvalidated,
    publishedGpuBytes: () => state.publishedGpuBytes,
    reportedDisplayCopyBytes: () => reportedDisplayCopyBytes(publication),

    /** 描画の前に、公開中の並び・部分形状・ねじの印を層へ渡す(同じ並びなら層は触らない)。 */
    syncLayer(displayStyle: DisplayStyle, currentSolid: boolean): void {
      solidLayer.update(state.solidBundle, displayStyle, deps.environments().texture);
      solidLayer.updateSubShapes(state.subShapeBundle);
      solidLayer.updateThreadMarks(currentSolid ? state.threadMarks : []);
    },

    /** 破棄の始まり。表示用の写しの大きさを控えてから、公開の入力と並びを手放す。 */
    retire(): void {
      state.disposalDisplayCopyBytes = distinctBackingBytes([...liveDisplayCopies(state.solidBundle, state.subShapeBundle),
        ...publication.displayCopies.buffers()]);
      state.solidOwner = null;
      state.bodies = [];
      state.solidBundle = EMPTY_SOLID_GEOMETRY;
      state.subShapeBundle = EMPTY_SUB_SHAPE_HIGHLIGHT;
      state.threadMarks = [];
      state.appearanceInput = null;
    },

    /** 層の破棄を登録する前に、公開中の持ち主の解放の始まりを観測へ書く。 */
    observeReleaseStart(): void {
      if (state.observedPublishedOwner !== null) {
        observeSolidMesh(publication, state.observedPublishedOwner, 'release-start', 'disposed');
      }
    },

    /** 層の破棄が全て済んだ時だけ、1 回だけ予約を返して解放の終わりを観測へ書く。 */
    releaseAfterCleanup(pendingCount: number): void {
      if (pendingCount === 0 && !state.disposalReservationsReleased) {
        releaseMeshReservations(publication);
        state.disposalDisplayCopyBytes = 0;
        state.disposalReservationsReleased = true;
        if (state.observedPublishedOwner !== null) {
          observeSolidMesh(publication, state.observedPublishedOwner, 'release-complete', 'disposed');
        }
      }
    },
  };
}
