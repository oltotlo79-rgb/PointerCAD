import type { SolidBody } from '@pointercad/model';
import type * as THREE from 'three';
import type { DisplayStyle } from '../store/viewSlice.js';
import { anyNeedsEnvironment } from '../appearance/createAppearanceMaterial.js';
import type { AssemblyUiBackingLedger } from './assemblyMeshAdmission.js';
import {
  buildSolidGeometry,
  AllocatedBackingRegistrationError,
  distinctBackingBytes,
  EMPTY_SOLID_GEOMETRY,
  type AppearanceInput,
  type DisplayCopyCache,
  type SolidGeometryBundle,
} from './buildSolidGeometry.js';
import { buildSubShapeGeometry, EMPTY_SUB_SHAPE_HIGHLIGHT, type SubShapeHighlightBundle } from './buildSubShapeGeometry.js';
import { assemblyAppearanceSpecs, type AssemblyGeometryBundle } from './createAssemblyLayer.js';
import type { EnvironmentCandidate, EnvironmentStore } from './createEnvironment.js';
import type { ThreadMarkInfo } from './createSolidLayer.js';
import type { ViewportSceneOptions } from './createViewportScene.js';
import {
  captureSolidMeshAdmission, captureWorldMeshAdmission, displayCopyBaseline, isSolidMeshAdmissionCurrent,
  meshLayoutsUnchanged, type SolidMeshAdmission,
} from './solidMeshAdmission.js';
import type { ViewportMeshOwner } from './viewportMeshObservation.js';
import {
  attributeArrays, attributeBytes, liveDisplayCopies, returnUnpublishedReservations, type ViewportSceneLayers,
} from './viewportSceneResources.js';

/*
 * 立体の表示の公開の手順(FR-105・NFR-PF-1)。候補の並び・部分形状・ねじの印を全て組み立て、表示用の写しと
 * GPU の予約を旧+新で取ってから、受領(readSolidMeshState)が今のままの時だけ層と公開の控えをまとめて差し替える。
 * 途中で受領が変わった・断られた候補は、写しと予約を公開中の分へ戻す。持ち主が古くなった表示は先に隠して片付ける。
 * 窓口(入力の受け付け・当たり・破棄)は viewportSceneSolidDisplay.ts が持つ。
 */

const GPU_MESH_BUDGET_MESSAGE = 'Local display mesh buffers exceed the GPU budget';

/**
 * ねじの印(threadMarks)を持つボディ。`SolidBody` は
 * この欄を必須で持つので、ここでは呼び出し側の型を示すために
 * 同じ欄をそのまま再宣言している(`buildSolidGeometry.ts` の `SolidBodyWithSubShapes` と
 * 同じ考え方、§7)。
 */
interface SolidBodyWithThreadMarks extends SolidBody {
  readonly threadMarks: readonly ThreadMarkInfo[];
}

/** ボディの一覧からねじの印だけを 1 本にまとめる。 */
function collectThreadMarks(
  bodies: readonly SolidBodyWithThreadMarks[],
): readonly ThreadMarkInfo[] {
  return bodies.flatMap((body) => body.threadMarks ?? []);
}

/** ボディ・強調・外観のどれかが変わったときに、描画用の並びを作り直す。 */
export interface SolidInputs {
  readonly bodies: readonly SolidBody[];
  readonly hovered: string | null;
  readonly selected: readonly string[];
  readonly appearance: AppearanceInput | null;
  readonly subHovered: string | null;
  readonly subSelection: readonly string[];
}

/** 公開中の立体の表示と、その写し・予約・観測の控え。公開の手順と、窓口の空の文書の控え・破棄だけが書き換える。 */
interface SolidDisplayState {
  /** ボディの現在値。組み立て直すのは変化したときだけ(NFR-PF-1)。 */
  bodies: readonly SolidBody[];
  hoveredBodyId: string | null;
  selectedBodyIds: readonly string[];
  /** 外観の割り当て(FR-1106)。無ければ既定の外観 1 色になる。 */
  appearanceInput: AppearanceInput | null;
  /** 部分形状(面・辺・頂点)の強調の現在値。 */
  subShapeHoveredElementId: string | null;
  subShapeSelection: readonly string[];
  solidBundle: SolidGeometryBundle;
  subShapeBundle: SubShapeHighlightBundle;
  /** ねじの簡略表示の印。ボディの一覧から導くだけで、別の入力は持たない。 */
  threadMarks: readonly ThreadMarkInfo[];
  solidOwner: SolidMeshAdmission | null;
  /** Mesh attribute arrays and bytes the layer holds for the published bundle and overlays. */
  publishedAttributeArrays: ReadonlySet<ArrayBufferView>;
  publishedGpuBytes: number;
  solidDisplayInvalidated: boolean;
  observedCandidateSequence: number;
  observedPublishedOwner: ViewportMeshOwner | null;
  /** 破棄の途中の表示用の写しの控え。予約を返し終えたら 0 に戻す。 */
  disposalDisplayCopyBytes: number;
  disposalReservationsReleased: boolean;
}

export function createSolidDisplayState(): SolidDisplayState {
  return { bodies: [], hoveredBodyId: null, selectedBodyIds: [], appearanceInput: null, subShapeHoveredElementId: null,
    subShapeSelection: [], solidBundle: EMPTY_SOLID_GEOMETRY, subShapeBundle: EMPTY_SUB_SHAPE_HIGHLIGHT, threadMarks: [],
    solidOwner: null, publishedAttributeArrays: new Set(), publishedGpuBytes: 0, solidDisplayInvalidated: false,
    observedCandidateSequence: 0, observedPublishedOwner: null, disposalDisplayCopyBytes: 0, disposalReservationsReleased: false };
}

/** 公開の手順が使う、表示の控えと Scene の他の持ち主。描画の状態と環境マップは呼ばれた時に読む。 */
export interface SolidPublication {
  readonly state: SolidDisplayState;
  readonly options: ViewportSceneOptions;
  readonly uiBackings: AssemblyUiBackingLedger;
  readonly solidLayer: ViewportSceneLayers['solidLayer'];
  readonly scene: THREE.Scene;
  /** Scene-owned UV and patterned copies; pruned to the published bodies after each adoption. */
  readonly displayCopies: DisplayCopyCache;
  /** One GPU reservation per renderer: this scene and every quad pane it draws. */
  readonly gpuOwner: symbol;
  readonly cpuOwner: object;
  readonly isDisposed: () => boolean;
  /** 最後に描いた表示スタイル。まだ 1 度も描いていなければ undefined。 */
  readonly displayStyle: () => DisplayStyle | undefined;
  readonly environments: () => EnvironmentStore;
  readonly refreshEnvironment: () => void;
  readonly assemblyBundle: () => AssemblyGeometryBundle;
}

type MeshObservationKind = Parameters<NonNullable<ViewportSceneOptions['observation']>['record']>[1];
type MeshObservationReason = Parameters<NonNullable<ViewportSceneOptions['observation']>['record']>[2];

function ownerIsCurrent(publication: SolidPublication, owner: SolidMeshAdmission): boolean {
  return isSolidMeshAdmissionCurrent(owner, publication.options.readSolidMeshState?.());
}

export function releaseMeshReservations(publication: SolidPublication): void {
  const { state } = publication;
  publication.options.gpuMeshBudget?.release(publication.gpuOwner);
  state.publishedAttributeArrays = new Set();
  state.publishedGpuBytes = 0;
  publication.displayCopies.clear();
}

function clearSolidDisplay(publication: SolidPublication): void {
  const { state, solidLayer } = publication;
  // Hide first so a failed resource cleanup cannot leave a pickable old document.
  solidLayer.group.visible = false;
  state.solidDisplayInvalidated = true;
  state.bodies = [];
  state.solidBundle = EMPTY_SOLID_GEOMETRY;
  state.subShapeBundle = EMPTY_SUB_SHAPE_HIGHLIGHT;
  state.threadMarks = [];
  state.solidOwner = null;
  releaseMeshReservations(publication);
  solidLayer.update(state.solidBundle, publication.displayStyle() ?? 'shadedWithEdges', publication.environments().texture);
  solidLayer.updateSubShapes(state.subShapeBundle);
  solidLayer.updateThreadMarks(state.threadMarks);
  solidLayer.setPrintabilityHighlight(null);
  solidLayer.updateCutPreview(null);
  solidLayer.updateSphereGrid(null);
  solidLayer.updateSectionHandle(null);
  publication.refreshEnvironment();
}

/** 公開中の持ち主が今のままなら true。空の文書は空の受領を持ち主にし、古い持ち主の表示は片付けて false。 */
export function ensureCurrentSolidOwner(publication: SolidPublication): boolean {
  const { state, options } = publication;
  if (publication.isDisposed()) return false;
  if (state.solidOwner !== null && ownerIsCurrent(publication, state.solidOwner)) return true;
  if (state.bodies.length === 0 && state.solidOwner === null) {
    const emptyOwner = options.readSolidMeshState === undefined ? captureWorldMeshAdmission(state.bodies)
      : captureSolidMeshAdmission(options.readSolidMeshState());
    if (emptyOwner !== null && emptyOwner.bodies.length === 0) {
      state.bodies = emptyOwner.bodies;
      state.solidOwner = emptyOwner;
      return true;
    }
  }
  clearSolidDisplay(publication);
  return false;
}

function restorePublishedSolidLayers(publication: SolidPublication): void {
  const { state, solidLayer } = publication;
  try {
    const displayStyle = publication.displayStyle();
    if (state.solidOwner !== null && ownerIsCurrent(publication, state.solidOwner) && displayStyle !== undefined) {
      solidLayer.update(state.solidBundle, displayStyle, publication.environments().texture);
      solidLayer.updateSubShapes(state.subShapeBundle);
      solidLayer.updateThreadMarks(state.threadMarks);
      publication.refreshEnvironment();
    } else clearSolidDisplay(publication);
  } catch {
    // A failed restoration must not expose a partially updated pick target.
    clearSolidDisplay(publication);
  }
}

/** 公開中の表示用の写しの大きさ(破棄の途中は破棄を始めた時点の値との大きい方)。 */
export function reportedDisplayCopyBytes(publication: SolidPublication): number {
  const { state } = publication;
  return Math.max(state.disposalDisplayCopyBytes,
    distinctBackingBytes([...liveDisplayCopies(state.solidBundle, state.subShapeBundle), ...publication.displayCopies.buffers()]));
}

export function observeSolidMesh(publication: SolidPublication, owner: ViewportMeshOwner, kind: MeshObservationKind,
  reason: MeshObservationReason = null): void {
  const { options } = publication;
  if (options.observation === undefined) return;
  options.observation?.record(owner, kind, reason, {
    hostDisplayCopyBytes: reportedDisplayCopyBytes(publication),
    hostGpuAttributeBytes: publication.state.publishedGpuBytes,
    hostGpuReservedBytes: publication.state.disposalReservationsReleased ? 0 : null,
  });
}

/** 受領を取り込み、ボディが同じ配列の時だけ候補を作って公開を試みる(それ以外は持ち主の判定だけ)。 */
export function publishSolidCandidate(publication: SolidPublication, next: SolidInputs): void {
  const { state, options } = publication;
  if (publication.isDisposed()) return;
  const owner = options.readSolidMeshState === undefined ? captureWorldMeshAdmission(next.bodies)
    : captureSolidMeshAdmission(options.readSolidMeshState());
  if (owner === null || owner.bodies !== next.bodies) {
    ensureCurrentSolidOwner(publication);
    return;
  }
  // A candidate that is not published returns its copies and its added GPU reservation.
  const sequence = ++state.observedCandidateSequence;
  const observedOwner: ViewportMeshOwner = {
    documentId: owner.state?.activeDocumentId ?? null,
    viewportOwnerId: options.viewportOwnerId ?? 'unobserved',
    resourceOwnerId: `${options.viewportOwnerId ?? 'unobserved'}:solid-host`,
    operationId: `solid-operation-${sequence}`,
    publicationId: `solid-publication-${sequence}`,
    generation: owner.state?.requestedGeneration ?? null, preview: false,
  };
  observeSolidMesh(publication, observedOwner, 'build-start');
  publishAdmittedCandidate(publication, next, owner, observedOwner);
}

/**
 * 候補を組み立てて公開する 1 回の取引。全ての CPU の候補ができるまで公開の控え・層は変えず、旧+新の GPU の予約と
 * 環境マップの準備の後にもう 1 度受領を確かめてから差し替える。公開しなかった時は写しと予約を必ず戻す。
 */
function publishAdmittedCandidate(publication: SolidPublication, next: SolidInputs, owner: SolidMeshAdmission,
  observedOwner: ViewportMeshOwner): void {
  const { state, options, uiBackings, solidLayer, displayCopies, gpuOwner, cpuOwner } = publication;
  const restoreCopies = displayCopies.checkpoint();
  let published = false;
  let environmentCandidate: EnvironmentCandidate | null = null;
  try {
    // No published input, bundle or layer changes until every CPU candidate exists.
    // The published bundle is a pure function of the published bodies and highlights, so an
    // ownership-only change (a new generation or a name-only edit) re-admits it without a
    // rebuild or GPU re-upload, provided the same body array still has its captured layout.
    const reusable = state.solidOwner !== null && meshLayoutsUnchanged(state.solidOwner, next.bodies);
    // A local display's UI copies are bounded on top of the kernel's post-token baseline.
    const issuedBaseline = owner.accounting === null ? null : displayCopyBaseline(owner.accounting);
    const ownedCopies = new Set([...liveDisplayCopies(state.solidBundle, state.subShapeBundle), ...displayCopies.buffers()]);
    uiBackings.adopt(ownedCopies);
    const baseline = issuedBaseline === null ? null : { limitBytes: issuedBaseline.limitBytes,
      baselineBytes: issuedBaseline.baselineBytes
        + distinctBackingBytes(uiBackings.buffers().filter(buffer => !ownedCopies.has(buffer)))
        + uiBackings.pending(cpuOwner) };
    if (owner.accounting !== null && baseline === null) {
      ensureCurrentSolidOwner(publication);
      return;
    }
    if (issuedBaseline !== null) uiBackings.reserve(cpuOwner,
      issuedBaseline.limitBytes - issuedBaseline.baselineBytes - uiBackings.bytes()
        - uiBackings.pending(cpuOwner), issuedBaseline.baselineBytes, issuedBaseline.limitBytes);
    // The published copies stay alive until this candidate replaces them (old plus new).
    const liveCopies = liveDisplayCopies(state.solidBundle, state.subShapeBundle);
    const candidate = next.bodies.length === 0 ? EMPTY_SOLID_GEOMETRY
      : reusable && next.bodies === state.bodies && next.hovered === state.hoveredBodyId
      && next.selected === state.selectedBodyIds && next.appearance === state.appearanceInput ? state.solidBundle
      : buildSolidGeometry(next.bodies, next.hovered, next.selected, next.appearance ?? undefined, undefined,
        { cache: displayCopies, allocated: buffer => uiBackings.allocated(buffer),
          ...(baseline === null ? {} : { budget: { ...baseline, retained: liveCopies } }) });
    uiBackings.adopt([...(candidate.displayCopies ?? []), ...displayCopies.buffers()]);
    const overlayBudget = baseline === null ? undefined : { limitBytes: baseline.limitBytes,
      reservedBytes: baseline.baselineBytes + distinctBackingBytes([...liveCopies,
        ...(candidate.displayCopies ?? []), ...displayCopies.buffers()]) };
    const overlay = next.bodies.length === 0 ? EMPTY_SUB_SHAPE_HIGHLIGHT
      : reusable && next.bodies === state.bodies && next.subHovered === state.subShapeHoveredElementId
      && next.subSelection === state.subShapeSelection ? state.subShapeBundle
      : buildSubShapeGeometry(next.bodies, next.subHovered, next.subSelection, overlayBudget,
        buffer => uiBackings.allocated(buffer));
    uiBackings.adopt(liveDisplayCopies(candidate, overlay));
    const marks = reusable && next.bodies === state.bodies ? state.threadMarks : collectThreadMarks(next.bodies);
    observeSolidMesh(publication, observedOwner, 'build-complete', 'completed');
    if (!ownerIsCurrent(publication, owner)) {
      ensureCurrentSolidOwner(publication);
      return;
    }
    // New attribute arrays get new GPU buffers while the published ones are still alive, so a
    // local display reserves old plus new before the layer changes and refuses on overflow.
    const nextArrays = attributeArrays(candidate, overlay);
    const nextGpuBytes = attributeBytes(candidate, overlay);
    const addedGpuBytes = nextArrays.reduce((sum, array) =>
      state.publishedAttributeArrays.has(array) ? sum : sum + array.byteLength, 0);
    if (baseline !== null && options.gpuMeshBudget !== undefined
      && !options.gpuMeshBudget.reserve(gpuOwner, state.publishedGpuBytes + addedGpuBytes)) {
      throw new RangeError(GPU_MESH_BUDGET_MESSAGE);
    }
    // Reserve old + candidate mesh attributes BEFORE PMREM's output and temporary peak.
    // Preparing does not retire the published environment or mutate scene.environment.
    environmentCandidate = publication.environments().prepareEnvironment(anyNeedsEnvironment([
      ...candidate.entries.flatMap(entry => entry.appearances), ...assemblyAppearanceSpecs(publication.assemblyBundle()),
    ]));
    if (!ownerIsCurrent(publication, owner)) {
      ensureCurrentSolidOwner(publication);
      return;
    }
    observeSolidMesh(publication, observedOwner, 'publish-start');
    const displayStyle = publication.displayStyle();
    if (displayStyle !== undefined) {
      try {
        solidLayer.update(candidate, displayStyle, environmentCandidate.texture);
        solidLayer.updateSubShapes(overlay);
        solidLayer.updateThreadMarks(marks);
      } catch (error) {
        restorePublishedSolidLayers(publication);
        throw error;
      }
    }
    if (!ownerIsCurrent(publication, owner)) {
      restorePublishedSolidLayers(publication);
      return;
    }
    environmentCandidate.commit(publication.scene);
    state.bodies = next.bodies;
    state.hoveredBodyId = next.hovered;
    state.selectedBodyIds = next.selected;
    state.appearanceInput = next.appearance;
    state.subShapeHoveredElementId = next.subHovered;
    state.subShapeSelection = next.subSelection;
    state.solidBundle = candidate;
    state.subShapeBundle = overlay;
    state.threadMarks = marks;
    state.solidOwner = owner;
    state.solidDisplayInvalidated = false;
    solidLayer.group.visible = true;
    // The replaced buffers are released by the layer; keep only the published reservation.
    state.publishedAttributeArrays = new Set(nextArrays);
    state.publishedGpuBytes = nextGpuBytes;
    if (baseline !== null) options.gpuMeshBudget?.reserve(gpuOwner, nextGpuBytes);
    else options.gpuMeshBudget?.release(gpuOwner);
    displayCopies.retainBodies(next.bodies);
    published = true;
    const retiredPublication = state.observedPublishedOwner;
    state.observedPublishedOwner = observedOwner;
    observeSolidMesh(publication, observedOwner, 'publish-complete', 'completed');
    if (retiredPublication !== null) observeSolidMesh(publication, retiredPublication, 'publication-retired', 'superseded');
  } catch (error) {
    if (error instanceof AllocatedBackingRegistrationError) uiBackings.retainUnregistered(error.backing);
    ensureCurrentSolidOwner(publication);
    throw error;
  } finally {
    const returnedCopies = displayCopies.buffers();
    try { uiBackings.adopt(returnedCopies); }
    catch {
      // Preserve the original operation outcome while independently returning candidate reservations.
      // Completed publication stays current; an unregistered backing remains strongly held and unknown.
      const registered = new Set(uiBackings.buffers());
      for (const buffer of returnedCopies) if (!registered.has(buffer)) uiBackings.retainUnregistered(buffer);
    }
    uiBackings.retire(cpuOwner);
    if (!published) {
      try { environmentCandidate?.rollback(); } catch { /* Retain failed cleanup and its reservation for retry. */ }
      observeSolidMesh(publication, observedOwner, 'operation-aborted', 'rejected');
      observeSolidMesh(publication, observedOwner, 'candidate-return-start', 'rejected');
      returnUnpublishedReservations({ owner: state.solidOwner, gpuBytes: state.publishedGpuBytes }, displayCopies,
        options.gpuMeshBudget, gpuOwner, restoreCopies);
      observeSolidMesh(publication, observedOwner, 'candidate-return-complete', 'rejected');
    }
  }
}
