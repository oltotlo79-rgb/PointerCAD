import type { AssemblyDocument } from '@pointercad/model';
import type * as THREE from 'three';
import type { DisplayStyle } from '../store/viewSlice.js';
import { anyNeedsEnvironment } from '../appearance/createAppearanceMaterial.js';
import { assemblyMeshBudget, type AssemblyUiBackingLedger } from './assemblyMeshAdmission.js';
import type { SolidGeometryBundle } from './buildSolidGeometry.js';
import {
  assemblyAppearanceSpecs,
  createAssemblyLayer,
  EMPTY_ASSEMBLY_GEOMETRY,
  type AssemblyGeometryBundle,
  type AssemblyLayer,
  type AssemblyMateFaceHit,
} from './createAssemblyLayer.js';
import type { EnvironmentCandidate, EnvironmentStore } from './createEnvironment.js';
import type {
  AssemblyComponentPickObservation, AssemblyFacePickObservation, ViewportScene, ViewportSceneOptions,
} from './createViewportScene.js';
import type { ScenePointer } from './viewportScenePointer.js';
import {
  assemblyOwnerStaleReason, createAssemblyOwnerCapture, isAssemblyOwnerCurrent, type AssemblyOwner,
  type AssemblyOwnerStaleReason, type createSceneConstruction,
} from './viewportSceneResources.js';

/*
 * createViewportScene の配置した部品の表示(FR-605・FR-606・FR-106)。一式ごとに表示の持ち主
 * (取り込んだ時の状態とメッシュの受け入れ)を 1 回だけ判定し、今のままの時だけ層へ公開する。
 * 失効した持ち主は表示を片付けて印を立て、作り直すまでの拾いは null を返す(片付いた空の層に
 * 当てただけの null を「何も無い所」と取り違えないため)。部品と合致面の拾いもこの判定を通す。
 */

/** 押した時点の表示の持ち主の有無・失効・部品数を、持ち主の判定の前に観測へ写す(拾いの null の理由を見分けるため)。 */
function observePickOwnerState(observation: AssemblyFacePickObservation | AssemblyComponentPickObservation | undefined,
  owner: AssemblyOwner | null, displayInvalidated: boolean, bundle: AssemblyGeometryBundle): void {
  if (observation === undefined) return;
  observation.ownerPresent = owner !== null;
  observation.displayInvalidated = displayInvalidated;
  observation.partCount = bundle.parts.length;
}

/** 部品pickの 1 回の持ち主の判定を観測へ写し、受け入れたかを返す(断った時だけ最初に外れた理由を書く)。 */
function observeComponentOwnerVerdict(observation: AssemblyComponentPickObservation | undefined,
  refusal: AssemblyOwnerStaleReason | 'no-owner' | null): boolean {
  const ownerAccepted = refusal === null;
  if (observation !== undefined) observation.ownerAccepted = ownerAccepted;
  if (observation !== undefined && refusal !== null) observation.ownerStaleReason = refusal;
  return ownerAccepted;
}

type AssemblyDisplayMethods = Pick<ViewportScene, 'setAssembly' | 'assemblyDisplayInvalidated' | 'pickComponent'
  | 'pickAssemblyFace'>;

/** 部品の表示が scene の他の持ち主から借りるもの。描画の状態と環境マップは呼ばれた時に読む。 */
interface SceneAssemblyDisplayDependencies {
  readonly options: ViewportSceneOptions;
  readonly uiBackings: AssemblyUiBackingLedger;
  readonly acquired: ReturnType<typeof createSceneConstruction>['acquired'];
  readonly scene: THREE.Scene;
  readonly isDisposed: () => boolean;
  /** 最後に描いた表示スタイル。まだ 1 度も描いていなければ undefined。 */
  readonly displayStyle: () => DisplayStyle | undefined;
  readonly environments: () => EnvironmentStore;
  readonly refreshEnvironment: () => void;
  readonly solidBundle: () => SolidGeometryBundle;
  readonly pointer: () => ScenePointer;
}

export function createSceneAssemblyDisplay(deps: SceneAssemblyDisplayDependencies) {
  const { options, uiBackings, scene } = deps;
  /**
   * 配置した部品(FR-605)。アセンブリを開いていないあいだは空のまま
   * (形も入れ物も 1 つも作らないので費用はゼロ)。
   */
  let assemblyBundle: AssemblyGeometryBundle = EMPTY_ASSEMBLY_GEOMETRY;
  let assemblyOwner: AssemblyOwner | null = null;
  let assemblyCandidateOwner: AssemblyOwner | null = null;
  let assemblyDisplayInvalidated = false;
  let createdLayer: AssemblyLayer | null = null;

  function assemblyOwnerCurrent(owner: AssemblyOwner): boolean {
    return isAssemblyOwnerCurrent(owner, deps.isDisposed(), options);
  }
  const captureAssemblyOwner = createAssemblyOwnerCapture(options, assemblyOwnerCurrent);

  /** 層は scene の構築の途中(createSceneLayers)で 1 回だけ作るので、それより後にだけ読む。 */
  function layer(): AssemblyLayer {
    if (createdLayer === null) throw new Error('Assembly layer is used before the Scene creates it');
    return createdLayer;
  }

  /*
    配置した部品(FR-605)。**部品の立体とは別の層**にする——1 つの窓で開く
    文書は 1 つだけなので同時には出ないが、形の持ち方が違う(立体は
    フィーチャーごとに 1 つ、アセンブリは**部品の鍵ごとに 1 つを全インスタンスで共有**)
    ため、同じ入れ物に混ぜると共有の判断が 2 通りに割れる。
    断面表示のクリッピング平面(FR-111)は、独立した干渉層と同時に配る。
  */
  function createLayer(): AssemblyLayer {
    const assemblyLayer = createAssemblyLayer(undefined, { gpuMeshBudget: options.gpuMeshBudget, uiBackings,
      isCurrent: () => assemblyCandidateOwner === null || assemblyOwnerCurrent(assemblyCandidateOwner),
      readBudget: () => {
        const owner = assemblyCandidateOwner ?? assemblyOwner;
        if (owner?.admission === null || owner === null) return undefined;
        const state = options.readSolidMeshState?.();
        if (state === undefined) return null;
        const budget = assemblyMeshBudget(owner.admission, state);
        if (budget === null) return null;
        return { limitBytes: budget.limitBytes, baselineBytes: budget.baselineBytes, sourceUiBackings: budget.sourceUiBackings,
          isCurrent: () => assemblyOwnerCurrent(owner) };
      } });
    deps.acquired('assembly layer', assemblyLayer, () => {
      assemblyLayer.dispose();
      if (assemblyLayer.meshReservation().cleanupStatus === 'pending') throw new Error('Assembly resources remain pending');
    });
    createdLayer = assemblyLayer;
    return assemblyLayer;
  }

  function clearAssemblyDisplay(): void {
    assemblyDisplayInvalidated = true;
    layer().group.visible = false;
    assemblyOwner = null; assemblyCandidateOwner = null;
    assemblyBundle = EMPTY_ASSEMBLY_GEOMETRY;
    layer().update(EMPTY_ASSEMBLY_GEOMETRY, deps.displayStyle() ?? 'shadedWithEdges', deps.environments().texture);
    deps.refreshEnvironment();
  }

  /**
   * 表示の持ち主を 1 回だけ判定する。受け入れたら null、断ったら最初に外れた理由(古い持ち主はここで消す)。
   * 判定の回数・順・副作用は観測の有無で変えない(理由は同じ 1 回の判定から返す)。
   */
  function verifyCurrentAssemblyOwner(): AssemblyOwnerStaleReason | 'no-owner' | null {
    if (deps.isDisposed()) return 'disposed';
    if (assemblyOwner === null) return assemblyBundle.parts.length === 0 ? null : 'no-owner';
    const staleReason = assemblyOwnerStaleReason(assemblyOwner, deps.isDisposed(), options);
    if (staleReason === null) return null;
    clearAssemblyDisplay();
    return staleReason;
  }

  function ensureCurrentAssemblyOwner(): boolean {
    return verifyCurrentAssemblyOwner() === null;
  }

  function rebuildAssembly(bundle: AssemblyGeometryBundle): void {
    if (deps.isDisposed()) return;
    const owner = captureAssemblyOwner(bundle);
    if (owner === null) {
      ensureCurrentAssemblyOwner();
      throw new RangeError('Assembly mesh owner or final accounting is unknown');
    }
    assemblyCandidateOwner = owner;
    const previousBundle = assemblyBundle;
    let environmentCandidate: EnvironmentCandidate | null = null;
    try {
      if (!assemblyOwnerCurrent(owner)) return;
      // Environment preparation sees candidate appearances without exposing candidate mesh geometry.
      const environmentSpecs = [...deps.solidBundle().entries.flatMap(entry => entry.appearances),
        ...assemblyAppearanceSpecs(bundle)];
      environmentCandidate = deps.environments().prepareEnvironment(anyNeedsEnvironment(environmentSpecs));
      if (!assemblyOwnerCurrent(owner)) { ensureCurrentAssemblyOwner(); return; }
      layer().update(bundle, deps.displayStyle() ?? 'shadedWithEdges', environmentCandidate.texture);
      if (!assemblyOwnerCurrent(owner)) { clearAssemblyDisplay(); return; }
      environmentCandidate.commit(scene);
      assemblyBundle = bundle; assemblyOwner = owner; layer().group.visible = true;
      assemblyDisplayInvalidated = false;
    } catch (error) {
      assemblyBundle = previousBundle;
      deps.refreshEnvironment(); ensureCurrentAssemblyOwner();
      throw error;
    } finally {
      assemblyCandidateOwner = null;
      try { environmentCandidate?.rollback(); } catch { /* Failed cleanup stays reserved by the environment store. */ }
    }
    deps.refreshEnvironment();
  }

  const methods: AssemblyDisplayMethods = {
    setAssembly: rebuildAssembly,
    assemblyDisplayInvalidated: () => assemblyDisplayInvalidated,

    pickComponent(screenX, screenY, observation): string | null {
      try {
        observePickOwnerState(observation, assemblyOwner, assemblyDisplayInvalidated, assemblyBundle);
        // One owner verdict per pick, observed or not; the recorded reason is that verdict's own result.
        const ownerAccepted = observeComponentOwnerVerdict(observation, verifyCurrentAssemblyOwner());
        if (!ownerAccepted) return null;
        const pointer = deps.pointer();
        const cameraReady = pointer.prepareCameraRay(screenX, screenY);
        if (observation !== undefined) observation.cameraReady = cameraReady;
        if (!cameraReady) return null;
        const hit = layer().pickComponent(pointer.raycaster);
        if (observation !== undefined) observation.hitComponentId = hit;
        return hit;
      } catch (error) {
        if (observation !== undefined) observation.failed = true;
        throw error;
      }
    },

    pickAssemblyFace(screenX, screenY, observation): AssemblyMateFaceHit | null {
      observePickOwnerState(observation, assemblyOwner, assemblyDisplayInvalidated, assemblyBundle);
      const ownerAccepted = ensureCurrentAssemblyOwner();
      if (observation !== undefined) observation.ownerAccepted = ownerAccepted;
      if (!ownerAccepted) return null;
      const pointer = deps.pointer();
      const cameraReady = pointer.prepareCameraRay(screenX, screenY);
      if (observation !== undefined) observation.cameraReady = cameraReady;
      if (!cameraReady) return null;
      return layer().pickMateFace(pointer.raycaster);
    },
  };

  return {
    methods,
    createLayer,
    ensureCurrentOwner: ensureCurrentAssemblyOwner,
    bundle: () => assemblyBundle,
    displayInvalidated: () => assemblyDisplayInvalidated,
    /** 表示中の部品が、この組立文書から作った一式か(途中の空の表示は今の組立の絵の証拠にならない)。 */
    showsSource: (document: AssemblyDocument): boolean => assemblyOwner !== null && assemblyBundle.sourceDocument === document,

    /** 描画の前に、公開中の一式を層へ渡す(同じ一式なら層は並びを触らない)。 */
    syncLayer(displayStyle: DisplayStyle): void {
      layer().update(assemblyBundle, displayStyle, deps.environments().texture);
    },

    /** 破棄の始まり。持ち主と一式を手放す(層そのものは Scene の破棄の登録が返す)。 */
    retire(): void {
      assemblyOwner = null; assemblyCandidateOwner = null; assemblyBundle = EMPTY_ASSEMBLY_GEOMETRY;
    },
  };
}
