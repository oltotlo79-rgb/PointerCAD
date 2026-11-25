/**
 * 配置した部品の表示層。
 *
 * 対応要件: FR-605(組図の色分け・表示/非表示)、FR-106(ホバー・選択・当たり判定)、
 * NFR-PF-1(60fps)。
 *
 * **形(ジオメトリ)は部品の鍵ごとに 1 つだけ作って共有する**。同じ部品を
 * 50 個置いても面と稜線をそれぞれ 1 回の instanced draw で描く。配置の行列は
 * 位置・四元数が変わったときだけ three に作らせ、カメラの再描画では更新しない。
 * 透過材質と、Float32 の相対配置では幾何公差を保てない部品は個別に描く。
 *
 * **カーネルの形(B-rep)は Comlink を越えない**。ここへ届くのは
 * 部品ごとに 1 回だけ再計算した結果(`SolidBody`)と、インスタンスごとの配置
 * (`RigidPlacement`)の 2 つだけである。
 *
 * **前半は three.js に触れない純関数**(Node で検査できる)。`resolveAssembly` が返した
 * `placements`(componentId → 配置)と `partKeys`(componentId → 部品の鍵)から、
 * 「鍵ごとに 1 つの形」と「置いた数だけの配置」に仕分ける。**後半が three.js の層**で、
 * 仕分けた結果を入れ物へ流し込む。
 *
 * **形・材質は必ず `dispose()` する**。共有している形は、その鍵を使う
 * インスタンスが 1 つも無くなったときにだけ捨てる(誰かが使っている形は捨てない)。
 */

import {
  composePlacement,
  DEFAULT_APPEARANCE,
  relativePlacement,
  type AppearanceSpec,
  type AssemblyComponent,
  type AssemblyDocument,
  type ResolvedAssembly,
  type RigidPlacement,
  type SolidBody,
} from '@pointercad/model';
import * as THREE from 'three';

import {
  createAppearanceMaterialStore,
  themedAppearance,
  type PatternTextureSource,
} from '../appearance/createAppearanceMaterial.js';
import type { DisplayStyle } from '../store/viewSlice.js';
import { AllocatedBackingRegistrationError, buildSolidGeometry, DisplayCopyCache, solidEmphasisOf, type AppearanceInput, type SolidEmphasis } from './buildSolidGeometry.js';
import type { GpuMeshBudget } from './solidMeshAdmission.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';
import { faceIndexOfTriangle } from '../solid/pickSubShape.js';
import { parseAssemblyTargetId } from '../assembly/mateCommands.js';
import { syncAssemblyHighlights, type AssemblyHighlight } from './assemblyLayerResources.js';
import { createViewportConstructionOwner } from './viewportLifetime.js';
import { assemblyUiBackings, type AssemblyUiBackingLedger } from './assemblyMeshAdmission.js';

// ---------------------------------------------------------------------------
// 仕分け(純関数。three.js に触れない)
// ---------------------------------------------------------------------------

/**
 * 部品 1 種類ぶんの形。**鍵(`partKeyOf` が作る `partRef` や規格部品の呼び寸法)ごとに
 * 1 つだけ**で、同じ鍵を指すインスタンスは全員この形を共有する。
 *
 * `bodies` は部品を 1 回再計算した結果(`recomputePart` の `bodies`)をそのまま指す。
 * **同じ並び(同一参照)を渡し直したときは形を作り直さない**ので、配置を変えただけの
 * 描き直しでは `BufferGeometry` に 1 バイトも触らない(NFR-PF-1)。
 */
export interface AssemblyPartShape {
  readonly partKey: string;
  readonly bodies: readonly SolidBody[];
  readonly appearances?: AppearanceInput;
}

/** 置いた部品 1 つ(インスタンス)の描き方。形は持たず、どの鍵の形を使うかだけを指す。 */
export interface AssemblyInstanceDraw {
  /** `AssemblyComponent.id`(`component-<n>`)。当たり判定はこの id を返す。 */
  readonly componentId: string;
  /** 使う形の鍵。`parts` のどれか 1 つと必ず対応する。 */
  readonly partKey: string;
  /** 世界座標での配置(位置 + 四元数)。`resolveAssembly` が数へ直したもの。 */
  readonly placement: RigidPlacement;
  /** 表示/非表示(FR-605)。**偽でも形は捨てない**(入切のたびに作り直さない)。 */
  readonly visible: boolean;
  readonly emphasis: SolidEmphasis;
  /** 組図での上書き。無ければ部品の面・ボディ外観を継承する。 */
  readonly appearance?: AppearanceSpec;
  readonly subShapes?: { readonly hovered: string | null; readonly selected: readonly string[] };
  /** 根からの配置の経路。入れ子の葉の部品でも、行 ID が別の配置と重ならない時だけ持つ。 */
  readonly occurrencePath?: AssemblyOccurrencePath;
}

/** 層へ渡す一式。**形は鍵ごとに 1 つ**、配置は置いた数だけ。 */
export interface AssemblyGeometryBundle {
  /** Captured by the pure assembly builder; never reconstructed from today's state. */
  readonly sourceDocument?: AssemblyDocument;
  readonly sourceBodies?: ReadonlyMap<string, readonly SolidBody[]>;
  readonly parts: readonly AssemblyPartShape[];
  readonly instances: readonly AssemblyInstanceDraw[];
}

/** 何も置いていないとき。アセンブリを開いていない間の値にも使う。 */
export const EMPTY_ASSEMBLY_GEOMETRY: AssemblyGeometryBundle = { parts: [], instances: [] };

/** `Object3D.traverse` の未知の材質を、Three.js の材質配列へ安全に絞る。 */
function isMaterialArray(value: unknown): value is readonly THREE.Material[] {
  return Array.isArray(value)
    && value.every((candidate: unknown) => candidate instanceof THREE.Material);
}

function isBufferGeometry(value: unknown): value is THREE.BufferGeometry {
  return value instanceof THREE.BufferGeometry;
}

/** 環境マップ要否の判定へ渡す、画面に見えているインスタンスの有効な外観一覧。 */
export function assemblyAppearanceSpecs(bundle: AssemblyGeometryBundle): readonly AppearanceSpec[] {
  const specs: AppearanceSpec[] = [];
  const inheritedPartKeys = new Set<string>();
  for (const instance of bundle.instances) {
    if (!instance.visible) continue;
    if (instance.appearance === undefined) {
      inheritedPartKeys.add(instance.partKey);
    } else {
      specs.push(instance.appearance);
    }
  }
  for (const part of bundle.parts) {
    if (!inheritedPartKeys.has(part.partKey)) continue;
    const input = part.appearances;
    if (input === undefined) {
      specs.push(DEFAULT_APPEARANCE);
      continue;
    }
    for (const body of part.bodies) {
      const assignment = input.byBody.get(body.featureId);
      const faces = assignment?.faceAppearances;
      const everyFaceOverridden = body.faces.length > 0
        && body.faces.every((face) => faces?.has(face.index) === true);
      if (!everyFaceOverridden) specs.push(assignment?.bodyAppearance ?? input.defaultAppearance);
      if (faces !== undefined) specs.push(...faces.values());
    }
  }
  return specs;
}

/**
 * 入れ子の配置の経路(根の文書から葉の部品までの `AssemblyComponent.id` の並び)。表示の行 ID(`/` でつないだもの)は
 * id が `/` を含むと別の配置と同じ文字列になるので識別に使わず、この並びを分けずにそのまま運ぶ。
 */
export type AssemblyOccurrencePath = readonly [string, ...string[]];

/** 仕分けの材料。`resolveAssembly` の結果と、部品ごとに 1 回だけ計算した形を並べる。 */
export interface AssemblyGeometryInput {
  readonly sourceDocument?: AssemblyDocument;
  /** 文書の部品の並び(`AssemblyDocument.components`)。順序はそのまま保つ。 */
  readonly components: readonly AssemblyComponent[];
  /** インスタンスの id → 配置(`ResolvedAssembly.placements`)。抑制された部品は入らない。 */
  readonly placements: ReadonlyMap<string, RigidPlacement>;
  /** インスタンスの id → 部品の鍵(`ResolvedAssembly.partKeys`)。中身を引けたものだけ。 */
  readonly partKeys: ReadonlyMap<string, string>;
  /**
   * 部品の鍵 → その部品を 1 回再計算した結果(`recomputePart` の `bodies`)。
   * **まだ届いていない鍵はここに無い**ので、その部品は描かない(計算中は出ない)。
   */
  readonly bodies: ReadonlyMap<string, readonly SolidBody[]>;
  readonly appearances?: ReadonlyMap<string, AppearanceInput>;
  /** ホバー中のインスタンスの id(ストアの `hoveredElementId` をそのまま渡してよい)。 */
  readonly hoveredComponentId: string | null;
  /** 選択中の id(ストアの `selection` をそのまま渡してよい)。 */
  readonly selectedComponentIds: readonly string[];
  readonly hoveredTargetId?: string | null;
  readonly selectedTargetIds?: readonly string[];
  /**
   * 行 ID → 根からの配置の経路(`flattenAssemblyGeometry` が作る)。行 ID が別の配置の行 ID と同じ文字列になったものは
   * `null`(どちらの配置か決まらないので、経路で選ぶ道具に渡さない)。
   */
  readonly occurrencePaths?: ReadonlyMap<string, AssemblyOccurrencePath | null>;
}

/** 根の子の組を解いた配置(`original`)から差し替えた配置(`preview`)へ動かす差。子孫の世界座標へ1回だけかける。 */
interface RootFrameChange {
  readonly original: RigidPlacement;
  readonly preview: RigidPlacement;
}

/** 差し替えが無いか、値が同じなら差は無い(子孫の配置は解いた値の物そのまま)。 */
function rootFrameChange(original: RigidPlacement | undefined, preview: RigidPlacement | undefined): RootFrameChange | undefined {
  if (original === undefined || preview === undefined || preview === original) return undefined;
  const same = original.position.every((value, axis) => value === preview.position[axis])
    && original.rotation.every((value, axis) => value === preview.rotation[axis]);
  return same ? undefined : { original, preview };
}

/**
 * 子の組へ渡す根の動きの差。外の差(`outer`)と、この組の配置を差し替えた内側の動き(`inner`、子の組の一時的な駆動)が
 * 両方あれば、内側の配置へ外の差をかけた位置への差を1つにまとめる。どちらかを捨てると、親を動かした後で
 * 駆動した入れ子の組の葉が駆動前の位置に残る。片方だけなら従来の差そのまま。
 */
function nestedFrameChange(outer: RootFrameChange | undefined, original: RigidPlacement | undefined,
  inner: RigidPlacement | undefined): RootFrameChange | undefined {
  if (outer === undefined || original === undefined || inner === undefined) return outer ?? rootFrameChange(original, inner);
  return rootFrameChange(original, composePlacement(outer.preview, relativePlacement(outer.original, inner)));
}

/** 入れ子の組を、描画層が扱う葉の部品一覧へ展開する。行IDは親からの経路を含む。 */
export function flattenAssemblyGeometry(
  document: AssemblyDocument,
  resolved: ResolvedAssembly,
  rootPlacements: ReadonlyMap<string, RigidPlacement> = resolved.placements,
  occurrenceOverrides?: ReadonlyMap<string, ReadonlyMap<string, RigidPlacement>>,
): Pick<AssemblyGeometryInput, 'components' | 'placements' | 'partKeys' | 'sourceDocument' | 'occurrencePaths'> {
  const components: AssemblyComponent[] = [];
  const placements = new Map<string, RigidPlacement>();
  const partKeys = new Map<string, string>();
  const occurrencePaths = new Map<string, AssemblyOccurrencePath | null>();

  const visit = (
    assembly: AssemblyDocument,
    current: ResolvedAssembly,
    prefix: string,
    ancestors: AssemblyOccurrencePath | null,
    inheritedVisible: boolean,
    inheritedAppearance: AppearanceSpec | undefined,
    placementOverride?: ReadonlyMap<string, RigidPlacement>,
    rootFrame?: RootFrameChange,
  ): void => {
    for (const component of assembly.components) {
      if (component.suppressed) continue;
      const path = prefix === '' ? component.id : `${prefix}/${component.id}`;
      const occurrence: AssemblyOccurrencePath = ancestors === null ? [component.id] : [...ancestors, component.id];
      const visible = inheritedVisible && component.visible;
      const appearance = component.appearance ?? inheritedAppearance;
      if (component.source.kind === 'subAssembly') {
        const nested = current.subAssemblies?.get(component.id);
        if (nested !== undefined) {
          // 根で引っぱり・動きの配置が差し替わった子の組は、子孫の解いた配置(世界座標)へ根の動きの差だけを1回かける。
          visit(nested.assembly, nested.resolved, path, occurrence, visible, appearance, occurrenceOverrides?.get(JSON.stringify(occurrence)),
            nestedFrameChange(rootFrame, current.placements.get(component.id), placementOverride?.get(component.id)));
        }
        continue;
      }
      const solved = placementOverride?.get(component.id) ?? current.placements.get(component.id);
      const placement = solved === undefined || rootFrame === undefined ? solved
        : composePlacement(rootFrame.preview, relativePlacement(rootFrame.original, solved));
      const partKey = current.partKeys.get(component.id);
      if (placement === undefined || partKey === undefined) continue;
      components.push({ ...component, id: path, visible, ...(appearance === undefined ? {} : { appearance }) });
      placements.set(path, placement);
      partKeys.set(path, partKey);
      // 行 ID が既に別の配置で使われていれば、どちらの経路も選ばせない(表示の文字列から経路を推し量らない)。
      occurrencePaths.set(path, occurrencePaths.has(path) ? null : occurrence);
    }
  };

  visit(document, resolved, '', null, true, undefined, rootPlacements);
  return { components, placements, partKeys, sourceDocument: document, occurrencePaths };
}

/**
 * 文書と解決結果から、描くための一式を組み立てる(three.js に触れない純関数)。
 *
 * **同じ鍵は 1 回だけ `parts` へ入る**。抑制された部品(`placements` に無い)、
 * 中身を引けなかった部品(`partKeys` に無い)、形がまだ届いていない部品(`bodies` に無い)は
 * 描かない。**止めない**——描けないものを黙って外すだけで、理由の表示は木と
 * プロパティ(`resolveAssembly` の `errors`)が受け持つ(FR-504)。
 *
 * **非表示の部品は外さない。** `visible === false` として並びに残し、形は共有したままにする
 * (入切のたびに形を作り直さないため。検証表「非表示の部品」)。
 */
export function buildAssemblyGeometry(input: AssemblyGeometryInput): AssemblyGeometryBundle {
  const selected = new Set(input.selectedComponentIds);
  const hoveredTarget = parseAssemblyTargetId(input.hoveredTargetId ?? '');
  const selectedTargets = (input.selectedTargetIds ?? []).flatMap((id) => {
    const target = parseAssemblyTargetId(id);
    return target === null ? [] : [target];
  });
  const parts: AssemblyPartShape[] = [];
  /** すでに `parts` へ入れた鍵。同じ形を 2 つ作らないための目印。 */
  const placed = new Set<string>();
  const instances: AssemblyInstanceDraw[] = [];

  for (const component of input.components) {
    const placement = input.placements.get(component.id);
    const partKey = input.partKeys.get(component.id);
    if (placement === undefined || partKey === undefined) {
      continue;
    }
    const bodies = input.bodies.get(partKey);
    if (bodies === undefined) {
      continue;
    }
    if (!placed.has(partKey)) {
      placed.add(partKey);
      parts.push({ partKey, bodies, appearances: input.appearances?.get(partKey) });
    }
    const subSelected = selectedTargets.filter((target) => target.componentId === component.id).map((target) => target.elementId);
    const subHovered = hoveredTarget?.componentId === component.id ? hoveredTarget.elementId : null;
    const occurrencePath = input.occurrencePaths?.get(component.id);
    instances.push({
      componentId: component.id,
      partKey,
      placement,
      visible: component.visible,
      // 強調の決め方は立体と同じ(選択がホバーより強い)。判定を 2 通りに割らない。
      emphasis: solidEmphasisOf(component.id, input.hoveredComponentId, selected),
      appearance: component.appearance,
      ...(subSelected.length > 0 || subHovered !== null ? { subShapes: { hovered: subHovered, selected: subSelected } } : {}),
      ...(occurrencePath === undefined || occurrencePath === null ? {} : { occurrencePath }),
    });
  }

  return { parts, instances, ...(input.sourceDocument === undefined ? {} : {
    sourceDocument: input.sourceDocument, sourceBodies: input.bodies,
  }) };
}

// ---------------------------------------------------------------------------
// three.js の表示層
// ---------------------------------------------------------------------------

/**
 * 描く順。**部品の立体と同じ層**に置く(`createSolidLayer.ts` の `SOLID_RENDER_ORDER`)。
 *
 * 1 つの窓で開く文書は 1 つだけなので、部品の立体とアセンブリの部品が
 * 同時に出ることはなく、順序の取り合いは起きない。数直線をそろえておけば、方眼・
 * スケッチ・重ね描きとの前後関係を 1 か所で読み取れる。
 */
const ASSEMBLY_RENDER_ORDER = 1;

/** 稜線は面より後に描く(理由は `createSolidLayer.ts` の `SOLID_EDGE_RENDER_ORDER` と同じ)。 */
const ASSEMBLY_EDGE_RENDER_ORDER = ASSEMBLY_RENDER_ORDER + 0.25;

/**
 * 部品 1 種類ぶんの共有の形。**ボディごとに面 1 つ・稜線 1 つ**の `BufferGeometry` を持つ。
 *
 * `generation` は形を作り直した回数で、インスタンス側が「自分がぶら下げている形が
 * 作り直されたか」を数の比較 1 回で見分けるための札。
 * 形と extent は登録前に埋め、登録後に形を変えるときは必ず新しい entry を作る。
 */
interface PartShapeEntry {
  bodies: readonly SolidBody[];
  appearances: AppearanceInput | undefined;
  readonly meshAppearances: (readonly AppearanceSpec[])[];
  generation: number;
  readonly meshGeometries: THREE.BufferGeometry[];
  readonly meshSubShapes: { readonly bodyFeatureId: string; readonly faces: SolidBody['faces'] }[];
  readonly edgeGeometries: THREE.BufferGeometry[];
  /** Each body keeps its own validated Double origin and local extent. */
  readonly bodyOrigins: THREE.Vector3[];
  readonly bodyExtents: THREE.Vector3[];
  /** The first world translation in each body batch; GPU matrices are relative to it. */
  readonly batchOrigins: (THREE.Vector3 | null)[];
}

type FaceMaterial = THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[];
type AssemblyMesh = THREE.Mesh<THREE.BufferGeometry, FaceMaterial>;
type AssemblyEdges = THREE.LineSegments<THREE.InstancedBufferGeometry, THREE.LineBasicMaterial>;

/** 配置だけの控え。描画する Object3D を部品の数だけ増やさない。 */
interface InstanceEntry {
  readonly matrix: THREE.Matrix4;
  version: number;
  draw: AssemblyInstanceDraw;
  /** One current precision decision per body; clear it when the shared shape changes. */
  precisionShape?: PartShapeEntry;
  readonly precisionByBody: Map<number, {
    readonly shapeGeneration: number;
    readonly placementVersion: number;
    readonly originX: number;
    readonly originY: number;
    readonly originZ: number;
    readonly bodyOriginX: number;
    readonly bodyOriginY: number;
    readonly bodyOriginZ: number;
    readonly result: boolean;
  }>;
}

/**
 * GPU 用 Float32 行列を CPU pick に逆輸入しない。旧 Mesh.raycast と同じ double の
 * 世界行列で各面を調べ、native InstancedMesh と同じ instanceId を付けて返す。
 */
class AssemblyInstancedMesh extends THREE.InstancedMesh<THREE.BufferGeometry, FaceMaterial> {
  placements: readonly THREE.Matrix4[] = [];
  private readonly pickMesh: AssemblyMesh;
  private readonly pickHits: THREE.Intersection[] = [];

  constructor(geometry: THREE.BufferGeometry, material: FaceMaterial, capacity: number, private readonly root: THREE.Group,
    allocated: (buffer: ArrayBufferLike) => void) {
    super(geometry, material, capacity);
    allocated(this.instanceMatrix.array.buffer);
    this.pickMesh = new THREE.Mesh(geometry, material);
    this.pickMesh.matrixAutoUpdate = false;
  }

  override raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
    this.pickMesh.material = this.material;
    for (let slot = 0; slot < this.count; slot += 1) {
      this.pickMesh.matrixWorld.multiplyMatrices(this.root.matrixWorld, this.placements[slot]);
      this.pickMesh.raycast(raycaster, this.pickHits);
      for (const hit of this.pickHits) {
        hit.instanceId = slot;
        hit.object = this;
        intersects.push(hit);
      }
      this.pickHits.length = 0;
    }
  }
}

interface BatchSlots {
  members: readonly InstanceEntry[];
  versions: readonly number[];
}

interface FaceBatch extends BatchSlots {
  readonly partKey: string;
  readonly object: AssemblyInstancedMesh;
  readonly capacity: number;
}

interface EdgeBatch extends BatchSlots {
  readonly partKey: string;
  readonly object: AssemblyEdges;
  readonly capacity: number;
  readonly matrices: THREE.InstancedBufferAttribute;
  readonly colors: THREE.InstancedBufferAttribute;
  colorValues: readonly number[];
}

interface FacePlan {
  readonly partKey: string;
  readonly geometry: THREE.BufferGeometry;
  readonly material: FaceMaterial;
  readonly origin: THREE.Vector3;
  readonly bodyOrigin: THREE.Vector3;
  readonly members: InstanceEntry[];
}

interface EdgePlan {
  readonly partKey: string;
  readonly geometry: THREE.BufferGeometry;
  readonly origin: THREE.Vector3;
  readonly bodyOrigin: THREE.Vector3;
  readonly members: InstanceEntry[];
}

export interface AssemblyMeshReservation {
  readonly sourceBackingBytes: number;
  readonly displayCopyBytes: number;
  readonly instanceBytes: number;
  readonly gpuMeshBytes: number;
  readonly uncovered: readonly string[];
  readonly cleanupStatus: 'complete' | 'pending';
  readonly cleanupReservedCpuBytes: number;
  readonly cleanupErrors: readonly string[];
}

type AssemblyPublishedReservation = Omit<AssemblyMeshReservation, 'cleanupStatus' | 'cleanupReservedCpuBytes' | 'cleanupErrors'>;

export interface AssemblyLayerOptions {
  /** Runtime default is the application union; isolated embedding/tests can supply their own lifetime. */
  readonly uiBackings?: AssemblyUiBackingLedger;
  readonly gpuMeshBudget?: GpuMeshBudget;
  readonly limitBytes?: number;
  /** Final kernel union plus reply clone; sources are already included when provided. */
  readonly baselineBytes?: number;
  readonly isCurrent?: () => boolean;
  /** Both values belong to one fresh, current global backing receipt. */
  readonly readBudget?: () => AssemblyLayerBudget | null | undefined;
}

export interface AssemblyLayerBudget {
  readonly limitBytes: number;
  readonly baselineBytes: number;
  readonly isCurrent: () => boolean;
  readonly sourceUiBackings?: ReadonlySet<ArrayBufferLike>;
}

const ASSEMBLY_UNCOVERED = Object.freeze(['textures', 'pmrem', 'materials', 'jsObjectOverhead', 'native', 'wasm']);
const ASSEMBLY_BUDGET_MESSAGE = 'Assembly mesh buffers exceed the live-byte budget';

/** Whole backing accounting; detached and shared backings remain unknown and are refused. */
function assemblyBackingBytes(buffers: Iterable<ArrayBufferLike>): number {
  let bytes = 0;
  for (const buffer of new Set(buffers)) {
    if (!(buffer instanceof ArrayBuffer)) throw new RangeError('Assembly mesh backing is unknown');
    new Uint8Array(buffer, 0, 0); // Detached buffers throw, including their zero-length views.
    bytes += buffer.byteLength;
    if (!Number.isSafeInteger(bytes)) throw new RangeError(ASSEMBLY_BUDGET_MESSAGE);
  }
  return bytes;
}

function assemblySourceBuffers(parts: readonly AssemblyPartShape[]): ArrayBufferLike[] {
  return parts.flatMap(part => part.bodies.flatMap(body => [body.mesh.positions.buffer,
    body.mesh.normals.buffer, body.mesh.indices.buffer, body.mesh.edgePositions.buffer]));
}

export interface AssemblyLayer {
  /** シーンへ足す入れ物。 */
  readonly group: THREE.Group;
  meshReservation(): AssemblyMeshReservation;
  /**
   * 置いた部品を差し替える(FR-605)。**同じ一式(同一参照)を渡し直したときは、
   * 表示スタイルの入切だけで済ませる**(NFR-PF-1)。
   */
  update(
    bundle: AssemblyGeometryBundle,
    displayStyle: DisplayStyle,
    environment?: THREE.Texture | null,
  ): void;
  /**
   * 表示テーマの色を反映する(FR-908)。**形は 1 つも作り直さない**——色を決めていない
   * 部品の材質だけが次の `update` で作り直される。
   */
  setThemeColors(colors: ThemeColors): void;
  /** 断面表示の平面を、共有材質と個別表示の全材質へ同時に配る。 */
  setSectionPlanes(planes: readonly THREE.Plane[]): void;
  /**
   * 光線に当たった部品(インスタンス)の id。当たらなければ null(FR-106)。
   *
   * **非表示の部品には当たらない。** three.js の `Raycaster` は `visible` を見ない
   * (`createSolidLayer.ts` の `pickBody` の注釈)ので、ここで表示中のものだけを的にする。
   * 消してある部品を掴めてしまうと、画面に無いものが選ばれることになるため。
   */
  pickComponent(raycaster: THREE.Raycaster): string | null;
  /** 面合致に使う、インスタンスと部品内の面。 */
  pickMateFace(raycaster: THREE.Raycaster): AssemblyMateFaceHit | null;
  dispose(): void;
}

export interface AssemblyMateFaceHit {
  readonly componentId: string;
  readonly partKey: string;
  readonly bodyFeatureId: string;
  readonly faceIndex: number;
  /** 当たった配置の根からの経路(描いた一式の配置が持つ時だけ)。表示の行 ID から作り直さない。 */
  readonly occurrencePath?: AssemblyOccurrencePath;
}

/** 共有の形を 1 部品ぶん作る。**組み立ては立体と同じ純関数**(`buildSolidGeometry`)を通す。 */
function fillGeometries(entry: PartShapeEntry, bodies: readonly SolidBody[], copies: DisplayCopyCache,
  budget: { readonly limitBytes: number; readonly baselineBytes: number; readonly retained: Iterable<ArrayBufferLike>;
    readonly sourceBackings?: ReadonlySet<ArrayBufferLike> },
  attribute: (array: Float32Array | Uint32Array, itemSize: number) => THREE.BufferAttribute,
  keepGeometry: (geometry: THREE.BufferGeometry) => THREE.BufferGeometry,
  allocated: (buffer: ArrayBufferLike) => void): void {
  /*
    強調はインスタンスごと。部品の外観は共有形の面グループに反映する。**立体になっていないボディを外す
    判定と、柄のための箱投影 UV の控え**をそのまま使えるのが、この関数を通す理由である。
  */
  for (const body of bodies) {
    const frame = body.coordinateFrame;
    if (frame !== undefined && (frame.space !== 'local'
      || !Array.isArray(frame.origin) || frame.origin.length !== 3
      || ![0, 1, 2].every((axis) => Object.prototype.hasOwnProperty.call(frame.origin, axis)
        && Number.isFinite(frame.origin[axis]))
      || !Number.isFinite(frame.maximumFloat32ErrorMm) || frame.maximumFloat32ErrorMm <= 0)) {
      throw new RangeError('Invalid local assembly coordinate frame');
    }
  }
  const bundle = buildSolidGeometry(bodies, null, [], entry.appearances, undefined,
    { cache: copies, budget, allocated });
  for (const draw of bundle.entries) {
    const extent = new THREE.Vector3();
    const mesh = keepGeometry(new THREE.BufferGeometry());
    entry.meshGeometries.push(mesh);
    mesh.setAttribute('position', attribute(draw.positions, 3));
    mesh.setAttribute('normal', attribute(draw.normals, 3));
    // 柄(FR-1108)を貼るための箱投影 UV。控えから返るので作り直しは起きない。
    mesh.setAttribute('uv', attribute(draw.uv, 2));
    mesh.setIndex(attribute(draw.indices, 1));
    for (const group of draw.groups) mesh.addGroup(group.start, group.count, group.materialIndex);
    entry.meshAppearances.push(draw.appearances);
    entry.meshSubShapes.push({ bodyFeatureId: draw.featureId, faces: draw.faces });
    // 包む球は視錐台の絞り込みと当たり判定の粗い絞りに使う。必ず取る。
    mesh.computeBoundingSphere();
    mesh.computeBoundingBox();
    if (mesh.boundingBox !== null) {
      extent.max(mesh.boundingBox.min.clone().multiplyScalar(-1));
      extent.max(mesh.boundingBox.max);
    }

    const edges = keepGeometry(new THREE.BufferGeometry());
    entry.edgeGeometries.push(edges);
    edges.setAttribute('position', attribute(draw.edgePositions, 3));
    edges.computeBoundingSphere();
    edges.computeBoundingBox();
    if (edges.boundingBox !== null) {
      extent.max(edges.boundingBox.min.clone().multiplyScalar(-1));
      extent.max(edges.boundingBox.max);
    }
    entry.bodyOrigins.push(new THREE.Vector3().fromArray(draw.coordinateFrame?.origin ?? [0, 0, 0]));
    entry.bodyExtents.push(extent);
    entry.batchOrigins.push(null);
  }
}

/** 区間の端を足す。TwoSum で double 自身の丸めを検出し、必要な側だけ外へ広げる。 */
function sumBound(left: number, right: number, upper: boolean): number {
  const sum = left + right;
  const rightPart = sum - left;
  const residual = (left - (sum - rightPart)) + (right - rightPart);
  if (upper ? residual > 0 : residual < 0) {
    const padding = Math.max(Number.MIN_VALUE, Math.abs(sum) * Number.EPSILON);
    return upper ? sum + padding : sum - padding;
  }
  return sum;
}

/**
 * Float32 同士の積は double に正確に入る。その積(最大 4 項)から shader の内積の
 * 誤差上限を求める。全ての項の分割を調べ、加算順序と積和の融合(FMA)の違いを包む。
 * 中間値は「まだ丸めない値」と Float32 に丸めた値の両方を含め、最後は必ず丸める。
 * 整数の正確な積・和に一律の相対誤差を課さないので、通常の箱はバッチに残せる。
 */
function float32DotError(
  product0: number, product1: number, product2: number, product3: number,
  lower: Float64Array, upper: Float64Array,
): number {
  // Every subset sum is an exact Float32 integer in this range, including FMA results.
  // This is a proof for all addition orders, not a tolerance or a skipped vertex check.
  if (Number.isInteger(product0) && Number.isInteger(product1) && Number.isInteger(product2)
    && Number.isInteger(product3)
    && Math.abs(product0) + Math.abs(product1) + Math.abs(product2) + Math.abs(product3) <= 2 ** 24) return 0;
  let count = 0;
  let exactLower = 0;
  let exactUpper = 0;
  for (let index = 0; index < 4; index += 1) {
    const term = index === 0 ? product0 : index === 1 ? product1 : index === 2 ? product2 : product3;
    if (term === 0) continue;
    const rounded = Math.fround(term);
    if (!Number.isFinite(rounded)) return Infinity;
    const bit = 1 << count;
    lower[bit] = Math.min(term, rounded);
    upper[bit] = Math.max(term, rounded);
    exactLower = sumBound(exactLower, term, false);
    exactUpper = sumBound(exactUpper, term, true);
    count += 1;
  }
  if (count === 0) return 0;
  const full = (1 << count) - 1;
  for (let mask = 1; mask <= full; mask += 1) {
    if ((mask & (mask - 1)) === 0) continue;
    let minimum = Infinity;
    let maximum = -Infinity;
    for (let left = (mask - 1) & mask; left > 0; left = (left - 1) & mask) {
      const right = mask ^ left;
      if (left > right) continue;
      const low = sumBound(lower[left], lower[right], false);
      const high = sumBound(upper[left], upper[right], true);
      minimum = Math.min(minimum, low, Math.fround(low));
      maximum = Math.max(maximum, high, Math.fround(high));
    }
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return Infinity;
    lower[mask] = minimum;
    upper[mask] = maximum;
  }
  return Math.max(Math.abs(Math.fround(lower[full]) - exactUpper), Math.abs(Math.fround(upper[full]) - exactLower));
}

function slotsChanged(batch: BatchSlots, members: readonly InstanceEntry[]): boolean {
  return batch.members.length !== members.length || members.some((entry, slot) =>
    batch.members[slot] !== entry || batch.versions[slot] !== entry.version);
}

function rememberSlots(batch: BatchSlots, members: readonly InstanceEntry[]): void {
  batch.members = members;
  batch.versions = members.map((entry) => entry.version);
}

function capacityFor(count: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, count)));
}

/** Owns the draw batches, their backing reservations and the rollback state of one layer. */
class AssemblyLayerRenderSession {
  private readonly group: THREE.Group;
  private colors: ThemeColors;
  private lastDisplayStyle: DisplayStyle;
  private readonly materialStore: ReturnType<typeof createAppearanceMaterialStore>;
  private readonly copies: DisplayCopyCache;
  private readonly rollbackBackings: WeakMap<THREE.BufferAttribute['array'], THREE.BufferAttribute['array']>;
  private readonly gpuOwner: symbol;
  private limitBytes: number;
  private pendingGpuBytes: number;
  private pendingCpuBytes: number;
  private baselineBytes: number;
  private candidateBudget: AssemblyLayerBudget | null;
  private readonly cpuOwner: object;
  private candidateSourceBackings: Set<ArrayBufferLike>;
  private sourceUiBackings: ReadonlySet<ArrayBufferLike>;
  private sharedBaselineExtra: number;
  private currentReservation: AssemblyPublishedReservation;
  private transaction: { readonly geometries: Set<THREE.BufferGeometry>;
    readonly meshes: Set<THREE.InstancedMesh>; readonly materials: Set<THREE.Material>;
    readonly retired: (() => void)[] } | null;
  private cleanupPending: (() => void)[];
  private cleanupErrors: readonly string[];
  private cleanupCpuPeakBytes: number;
  private cleanupGpuPeakBytes: number;
  private layerDisposed: boolean;
  private readonly sectionPlanes: THREE.Plane[];
  private environment: THREE.Texture | null;
  private readonly edgeMaterial: THREE.LineBasicMaterial;
  private readonly individualEdgeMaterials: Readonly<Record<SolidEmphasis, THREE.LineBasicMaterial>>;
  private partShapes: Map<string, PartShapeEntry>;
  private instances: Map<string, InstanceEntry>;
  private faceBatches: Map<string, FaceBatch>;
  private edgeBatches: Map<string, EdgeBatch>;
  private individualFaces: Map<string, AssemblyMesh>;
  private individualEdges: Map<string, THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>>;
  private readonly pickTargets: THREE.Object3D[];
  private readonly idsByObject: Map<THREE.Object3D, readonly string[]>;
  private readonly shapeByObject: Map<THREE.Object3D, { readonly partKey: string; readonly bodyFeatureId: string;
    readonly faces: SolidBody['faces'] }>;
  private readonly pickOrder: Map<string, number>;
  private highlights: Map<string, AssemblyHighlight>;
  private lastBundle: AssemblyGeometryBundle | null;
  private appearanceDirty: boolean;
  private publishedMaterialSpecs: readonly AppearanceSpec[];
  private candidateMaterialSpecs: readonly AppearanceSpec[];
  private readonly position: THREE.Vector3;
  private readonly rotation: THREE.Quaternion;
  private readonly scale: THREE.Vector3;
  private readonly relativeMatrix: THREE.Matrix4;
  private readonly bodyMatrix: THREE.Matrix4;
  private readonly bodyTranslation: THREE.Matrix4;
  private readonly dotLower: Float64Array;
  private readonly dotUpper: Float64Array;
  private readonly edgeColor: THREE.Color;
  private readonly sphere: THREE.Sphere;

  constructor(patterns: PatternTextureSource | undefined, private readonly options: AssemblyLayerOptions,
    private readonly uiBackings: AssemblyUiBackingLedger,
    acquired: <T extends { dispose(): void }>(resource: T) => T) {
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.colors = DEFAULT_THEME_COLORS;
    this.lastDisplayStyle = 'shadedWithEdges';
    // No material has been requested yet; disposing this empty store would release
    // a potentially shared pattern source owned by a different live layer.
    this.materialStore = createAppearanceMaterialStore(patterns);
    this.copies = new DisplayCopyCache();
    // Each actual instance array owns one registered rollback backing for its whole lifetime.
    this.rollbackBackings = new WeakMap<THREE.BufferAttribute['array'], THREE.BufferAttribute['array']>();
    this.gpuOwner = Symbol('assembly-mesh');
    this.limitBytes = options.limitBytes ?? 512 * 1024 * 1024;
    if (!Number.isSafeInteger(this.limitBytes) || this.limitBytes <= 0 || this.limitBytes > 512 * 1024 * 1024) {
      throw new RangeError(ASSEMBLY_BUDGET_MESSAGE);
    }
    this.pendingGpuBytes = 0;
    this.pendingCpuBytes = 0;
    this.baselineBytes = 0;
    this.candidateBudget = null;
    this.cpuOwner = {};
    this.candidateSourceBackings = new Set<ArrayBufferLike>();
    this.sourceUiBackings = new Set();
    this.sharedBaselineExtra = 0;
    this.currentReservation = { sourceBackingBytes: 0, displayCopyBytes: 0,
      instanceBytes: 0, gpuMeshBytes: 0, uncovered: ASSEMBLY_UNCOVERED };
    this.transaction = null;
    this.cleanupPending = [];
    this.cleanupErrors = [];
    this.cleanupCpuPeakBytes = 0;
    this.cleanupGpuPeakBytes = 0;
    this.layerDisposed = false;
    this.sectionPlanes = [];
    this.environment = null;
    /*
      LineSegments + InstancedBufferGeometry は Three の LINES / renderInstances 経路を通る。
      USE_INSTANCING は標準 project_vertex の instanceMatrix 変換を有効にする。color は
      divisor=1 の属性なので、標準 LineBasicMaterial の色・深度・tone mapping を保てる。
    */
    this.edgeMaterial = Object.assign(acquired(new THREE.LineBasicMaterial({ color: 0xffffff, vertexColors: true })), {
      defines: { USE_INSTANCING: '' },
    });
    this.individualEdgeMaterials = {
      none: acquired(new THREE.LineBasicMaterial()),
      hovered: acquired(new THREE.LineBasicMaterial()),
      selected: acquired(new THREE.LineBasicMaterial()),
    };
    this.edgeMaterial.clippingPlanes = this.sectionPlanes;
    for (const material of Object.values(this.individualEdgeMaterials)) material.clippingPlanes = this.sectionPlanes;
    this.partShapes = new Map<string, PartShapeEntry>();
    this.instances = new Map<string, InstanceEntry>();
    this.faceBatches = new Map<string, FaceBatch>();
    this.edgeBatches = new Map<string, EdgeBatch>();
    this.individualFaces = new Map<string, AssemblyMesh>();
    this.individualEdges = new Map<string, THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>>();
    this.pickTargets = [];
    this.idsByObject = new Map<THREE.Object3D, readonly string[]>();
    this.shapeByObject = new Map<THREE.Object3D, { readonly partKey: string; readonly bodyFeatureId: string;
      readonly faces: SolidBody['faces'] }>();
    this.pickOrder = new Map<string, number>();
    this.highlights = new Map<string, AssemblyHighlight>();
    this.lastBundle = null;
    this.appearanceDirty = true;
    this.publishedMaterialSpecs = [];
    this.candidateMaterialSpecs = [];
    this.position = new THREE.Vector3();
    this.rotation = new THREE.Quaternion();
    this.scale = new THREE.Vector3(1, 1, 1);
    this.relativeMatrix = new THREE.Matrix4();
    this.bodyMatrix = new THREE.Matrix4();
    this.bodyTranslation = new THREE.Matrix4();
    this.dotLower = new Float64Array(16);
    this.dotUpper = new Float64Array(16);
    this.edgeColor = new THREE.Color();
    this.sphere = new THREE.Sphere();
  }

  private readonly captureBudget = (): AssemblyLayerBudget | null => {
      if (this.options.readBudget === undefined) return null;
      const receipt = this.options.readBudget();
      // Undefined is the explicit historical world path, whose actual source union is counted below.
      // Null means supplied current-ledger evidence is unknown and must be rejected.
      if (receipt === undefined) return null;
      if (receipt === null) throw new Error('Assembly mesh receipt is unknown');
      const limit = receipt.limitBytes, baseline = receipt.baselineBytes;
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 512 * 1024 * 1024
        || !Number.isSafeInteger(baseline) || baseline < 0 || baseline > limit) {
        throw new RangeError(ASSEMBLY_BUDGET_MESSAGE);
      }
      const current = receipt.isCurrent;
      if (!current()) throw new Error('Assembly display owner changed');
      // Capture scalars once; mutation of an issued receipt is never a new admission.
      return { limitBytes: limit, baselineBytes: baseline, sourceUiBackings: new Set(receipt.sourceUiBackings ?? []), isCurrent: () =>
        current() && receipt.limitBytes === limit && receipt.baselineBytes === baseline };
    };

  private readonly checkCandidateBudget = (): void => {
      if (this.candidateBudget !== null && !this.candidateBudget.isCurrent()) {
        throw new Error('Assembly display owner changed');
      }
    };

  /** A disposer failure cannot abort the other releases or pretend the failed assets are free. */
  private readonly runCleanup = (tasks: readonly (() => void)[], cpuPeak: number, gpuPeak: number): void => {
      const remaining: (() => void)[] = [], errors: string[] = [];
      for (const task of tasks) {
        try { task(); }
        catch (error) { remaining.push(task); errors.push(error instanceof Error ? error.message : String(error)); }
      }
      this.cleanupPending = remaining;
      this.cleanupErrors = errors;
      this.cleanupCpuPeakBytes = remaining.length === 0 ? 0 : Math.max(this.cleanupCpuPeakBytes, cpuPeak);
      this.cleanupGpuPeakBytes = remaining.length === 0 ? 0 : Math.max(this.cleanupGpuPeakBytes, gpuPeak);
      if (remaining.length === 0) {
        if (this.currentReservation.gpuMeshBytes === 0) this.options.gpuMeshBudget?.release(this.gpuOwner);
        else this.options.gpuMeshBudget?.reserve(this.gpuOwner, this.currentReservation.gpuMeshBytes);
      }
    };

  private readonly retryCleanup = (): void => {
      if (this.cleanupPending.length > 0) this.runCleanup(this.cleanupPending, this.cleanupCpuPeakBytes, this.cleanupGpuPeakBytes);
    };

  private readonly cpuPeakBytes = (): number => {
      return this.baselineBytes + this.pendingCpuBytes + this.copyBytes();
    };

  private readonly copyBytes = (): number => {
    return assemblyBackingBytes(this.copies.buffers().filter(buffer => !this.sourceUiBackings.has(buffer)));
  };

  private readonly admitCpu = (bytes: number): void => {
      this.checkCandidateBudget();
      const next = this.pendingCpuBytes + bytes;
      const total = this.baselineBytes + next + this.copyBytes();
      if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(next)
        || !Number.isSafeInteger(total) || total > this.limitBytes) throw new RangeError(ASSEMBLY_BUDGET_MESSAGE);
      this.pendingCpuBytes = next;
    };

  private readonly reserveGpu = (bytes: number): void => {
      this.checkCandidateBudget();
      const next = this.pendingGpuBytes + bytes;
      const total = this.options.gpuMeshBudget === undefined ? next
        : this.options.gpuMeshBudget.reservedBytes() - this.options.gpuMeshBudget.reservedBytes(this.gpuOwner) + next;
      if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(next)
        || !Number.isSafeInteger(total) || total > this.limitBytes || (this.options.gpuMeshBudget !== undefined
          && !this.options.gpuMeshBudget.reserve(this.gpuOwner, next))) throw new RangeError(ASSEMBLY_BUDGET_MESSAGE);
      this.pendingGpuBytes = next;
    };

  private readonly attribute = (array: Float32Array | Uint32Array, itemSize: number): THREE.BufferAttribute => {
      this.reserveGpu(array.byteLength);
      if (!this.candidateSourceBackings.has(array.buffer)) this.uiBackings.adopt([array.buffer]);
      return new THREE.BufferAttribute(array, itemSize);
    };

  private readonly keepGeometry = (geometry: THREE.BufferGeometry): THREE.BufferGeometry => {
      this.transaction?.geometries.add(geometry);
      return geometry;
    };

  private readonly retire = (dispose: () => void): void => {
      if (this.transaction === null) dispose();
      else this.transaction.retired.push(dispose);
    };

  private readonly removeHighlight = (id: string): void => {
      const overlay = this.highlights.get(id);
      if (overlay === undefined) return;
      this.group.remove(overlay.object);
      for (const geometry of overlay.geometries) this.retire(() => geometry.dispose());
      for (const { material } of overlay.materials) this.retire(() => material.dispose());
      this.highlights.delete(id);
    };

  private readonly removeFaceBatch = (key: string, batch: FaceBatch): void => {
      this.group.remove(batch.object);
      // InstancedMesh.dispose が instanceMatrix の GPU 資源を返す。共有形と材質は捨てない。
      this.retire(() => batch.object.dispose());
      this.faceBatches.delete(key);
    };

  private readonly removeEdgeBatch = (key: string, batch: EdgeBatch): void => {
      this.group.remove(batch.object);
      this.retire(() => batch.object.geometry.dispose());
      this.edgeBatches.delete(key);
    };

  private readonly releaseShape = (partKey: string, shape: PartShapeEntry): void => {
      for (const [key, batch] of this.faceBatches) {
        if (batch.partKey === partKey) this.removeFaceBatch(key, batch);
      }
      for (const [key, batch] of this.edgeBatches) {
        if (batch.partKey === partKey) this.removeEdgeBatch(key, batch);
      }
      for (const geometry of [...shape.meshGeometries, ...shape.edgeGeometries]) this.retire(() => geometry.dispose());
    };

  private readonly syncPartShapes = (parts: readonly AssemblyPartShape[]): void => {
      const alive = new Set<string>();
      for (const part of parts) {
        alive.add(part.partKey);
        const previous = this.partShapes.get(part.partKey);
        if (previous?.bodies === part.bodies && previous.appearances === part.appearances) continue;
        if (previous !== undefined) this.releaseShape(part.partKey, previous);
        const shape: PartShapeEntry = {
          bodies: part.bodies, appearances: part.appearances, meshAppearances: [],
          generation: (previous?.generation ?? 0) + 1, meshGeometries: [], edgeGeometries: [],
          bodyOrigins: [], bodyExtents: [], batchOrigins: [], meshSubShapes: [],
        };
        fillGeometries(shape, part.bodies, this.copies, { limitBytes: this.limitBytes, baselineBytes: this.baselineBytes + this.pendingCpuBytes,
          retained: this.copies.buffers(), sourceBackings: this.sourceUiBackings }, this.attribute, this.keepGeometry, buffer => this.uiBackings.allocated(buffer));
        this.partShapes.set(part.partKey, shape);
      }
      for (const [partKey, shape] of this.partShapes) {
        if (!alive.has(partKey)) {
          this.releaseShape(partKey, shape);
          this.partShapes.delete(partKey);
        }
      }
    };

  private readonly syncPlacement = (draw: AssemblyInstanceDraw): InstanceEntry => {
      let entry = this.instances.get(draw.componentId);
      const previous = entry?.draw;
      const changed = previous === undefined
        || draw.placement.position.some((value, index) => value !== previous.placement.position[index])
        || draw.placement.rotation.some((value, index) => value !== previous.placement.rotation[index]);
      if (entry === undefined) {
        entry = { matrix: new THREE.Matrix4(), version: 0, draw, precisionByBody: new Map() };
        this.instances.set(draw.componentId, entry);
      }
      if (changed) {
        this.position.fromArray(draw.placement.position);
        this.rotation.fromArray(draw.placement.rotation);
        entry.matrix.compose(this.position, this.rotation, this.scale);
        entry.version += 1;
      }
      entry.draw = draw;
      return entry;
    };

  private readonly materialFor = (draw: AssemblyInstanceDraw, shape: PartShapeEntry, body: number): FaceMaterial => {
      const appearances = shape.meshAppearances[body];
      const found = draw.appearance !== undefined || appearances.length === 1
        ? this.materialStore.materialFor(themedAppearance(draw.appearance ?? appearances[0], this.colors.solid), this.environment)
        : appearances.map((spec) => this.materialStore.materialFor(themedAppearance(spec, this.colors.solid), this.environment));
      for (const material of Array.isArray(found) ? found : [found]) material.clippingPlanes = this.sectionPlanes;
      return found;
    };

  /** Use the same Double component × body-origin transform for rendering and CPU picking. */
  private readonly worldBodyPlacement = (entry: InstanceEntry, bodyOrigin: THREE.Vector3): THREE.Matrix4 => {
      this.bodyMatrix.copy(entry.matrix);
      if (bodyOrigin.x === 0 && bodyOrigin.y === 0 && bodyOrigin.z === 0) return this.bodyMatrix;
      return this.bodyMatrix.multiply(this.bodyTranslation.makeTranslation(bodyOrigin.x, bodyOrigin.y, bodyOrigin.z));
    };

  private readonly relativePlacement = (entry: InstanceEntry, bodyOrigin: THREE.Vector3, origin: THREE.Vector3): THREE.Matrix4 => {
      const world = this.worldBodyPlacement(entry, bodyOrigin).elements;
      this.relativeMatrix.copy(this.bodyMatrix);
      this.relativeMatrix.setPosition(world[12] - origin.x, world[13] - origin.y, world[14] - origin.z);
      return this.relativeMatrix;
    };

  private readonly canInstance = (entry: InstanceEntry, shape: PartShapeEntry, body: number, origin: THREE.Vector3): boolean => {
      if (entry.precisionShape !== shape) {
        entry.precisionByBody.clear();
        entry.precisionShape = shape;
      }
      const bodyOrigin = shape.bodyOrigins[body];
      const previous = entry.precisionByBody.get(body);
      if (previous?.shapeGeneration === shape.generation && previous.placementVersion === entry.version
        && previous.originX === origin.x && previous.originY === origin.y && previous.originZ === origin.z
        && previous.bodyOriginX === bodyOrigin.x && previous.bodyOriginY === bodyOrigin.y
        && previous.bodyOriginZ === bodyOrigin.z) return previous.result;
      const result = this.hasPreciseInstanceVertices(entry, shape, body, origin);
      entry.precisionByBody.set(body, {
        shapeGeneration: shape.generation, placementVersion: entry.version,
        originX: origin.x, originY: origin.y, originZ: origin.z,
        bodyOriginX: bodyOrigin.x, bodyOriginY: bodyOrigin.y, bodyOriginZ: bodyOrigin.z, result,
      });
      return result;
    };

  private readonly hasPreciseInstanceVertices = (entry: InstanceEntry, shape: PartShapeEntry, body: number, origin: THREE.Vector3): boolean => {
      // NFR-RE-3 の基準 1e-7 mm。回転の丸めは形の座標範囲を掛けて位置誤差へ直す。
      const values = this.relativePlacement(entry, shape.bodyOrigins[body], origin).elements;
      const extent = shape.bodyExtents[body];
      const error = (index: number): number => Math.abs(Math.fround(values[index]) - values[index]);
      const axes = [0, 1, 2].map((row) => error(12 + row)
        + error(row) * extent.x + error(4 + row) * extent.y + error(8 + row) * extent.z);
      if (!(Math.hypot(...axes) <= 1e-7)) return false;
      const rounded = values.map(Math.fround);
      // project_vertex は instanceMatrix * vertex の後に modelViewMatrix を掛ける。
      // 係数が正確でも 1e8 + 10 が 1e8 + 8 になるため、面・稜線の実頂点も検査する。
      // syncBundle からだけ呼び、カメラのみの再描画ではこの計算を増やさない。
      for (const geometry of [shape.meshGeometries[body], shape.edgeGeometries[body]]) {
        const positions = geometry.getAttribute('position');
        for (let vertex = 0; vertex < positions.count; vertex += 1) {
          const x = positions.getX(vertex);
          const y = positions.getY(vertex);
          const z = positions.getZ(vertex);
          const vertexErrors = axes.map((coefficientError, row) => coefficientError + float32DotError(
            rounded[row] * x, rounded[4 + row] * y, rounded[8 + row] * z, rounded[12 + row],
            this.dotLower, this.dotUpper));
          if (!(Math.hypot(...vertexErrors) <= 1e-7)) return false;
        }
      }
      return true;
    };

  private readonly edgeHex = (emphasis: SolidEmphasis, style: DisplayStyle): number => {
      if (emphasis !== 'none') return this.colors[emphasis];
      return style === 'wireframe' ? this.colors.solidEdgeWireframe : this.colors.solidEdgeOverSolid;
    };

  private readonly placeBatch = (object: THREE.Object3D, origin: THREE.Vector3, renderOrder: number): void => {
      object.matrixAutoUpdate = false;
      object.matrix.setPosition(origin);
      object.renderOrder = renderOrder;
      this.group.add(object);
      object.updateMatrixWorld(true);
    };

  private readonly syncFaces = (plans: ReadonlyMap<string, FacePlan>, style: DisplayStyle): void => {
      for (const [key, batch] of this.faceBatches) {
        if (!plans.has(key)) this.removeFaceBatch(key, batch);
      }
      for (const [key, plan] of plans) {
        let batch = this.faceBatches.get(key);
        if (batch !== undefined && batch.capacity < plan.members.length) {
          this.removeFaceBatch(key, batch);
          batch = undefined;
        }
        if (batch === undefined) {
          const capacity = capacityFor(plan.members.length);
          this.admitCpu(capacity * 16 * 4);
          this.reserveGpu(capacity * 16 * 4);
          const object = new AssemblyInstancedMesh(plan.geometry, plan.material, capacity, this.group,
            buffer => this.uiBackings.allocated(buffer));
          this.transaction?.meshes.add(object);
          object.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          object.count = 0;
          this.placeBatch(object, plan.origin, ASSEMBLY_RENDER_ORDER);
          batch = { partKey: plan.partKey, object, capacity, members: [], versions: [] };
          this.faceBatches.set(key, batch);
        }
        const object = batch.object;
        if (slotsChanged(batch, plan.members)) {
          object.count = plan.members.length;
          plan.members.forEach((entry, slot) => object.setMatrixAt(slot, this.relativePlacement(entry, plan.bodyOrigin, plan.origin)));
          object.instanceMatrix.needsUpdate = true;
          object.placements = plan.members.map((entry) => plan.bodyOrigin.x === 0
            && plan.bodyOrigin.y === 0 && plan.bodyOrigin.z === 0
            ? entry.matrix : this.worldBodyPlacement(entry, plan.bodyOrigin).clone());
          object.computeBoundingSphere();
          // Box3.setFromObject 等の外部利用でも、以前の配置の包囲箱を残さない。
          object.computeBoundingBox();
          rememberSlots(batch, plan.members);
        }
        object.visible = object.count > 0 && style !== 'wireframe';
        if (object.count > 0) {
          this.pickTargets.push(object);
          this.idsByObject.set(object, plan.members.map((entry) => entry.draw.componentId));
          const body = this.partShapes.get(plan.partKey)?.meshGeometries.indexOf(plan.geometry) ?? -1;
          const subShapes = this.partShapes.get(plan.partKey)?.meshSubShapes[body];
          if (subShapes !== undefined) this.shapeByObject.set(object, { partKey: plan.partKey, ...subShapes });
        }
      }
    };

  private readonly syncEdges = (plans: ReadonlyMap<string, EdgePlan>, style: DisplayStyle): void => {
      for (const [key, batch] of this.edgeBatches) {
        if (!plans.has(key)) this.removeEdgeBatch(key, batch);
      }
      for (const [key, plan] of plans) {
        let batch = this.edgeBatches.get(key);
        if (batch !== undefined && batch.capacity < plan.members.length) {
          // 属性の容量を変えると Three の _maxInstanceCount の控えも古くなるため形ごと交換。
          this.removeEdgeBatch(key, batch);
          batch = undefined;
        }
        if (batch === undefined) {
          const capacity = capacityFor(plan.members.length);
          const geometry = new THREE.InstancedBufferGeometry();
          this.transaction?.geometries.add(geometry);
          const source = plan.geometry.getAttribute('position');
          // 同じ BufferAttribute を別の geometry と共有しない。片方の dispose が他方の
          // GPU buffer を消すため。読み取り専用の typed array だけは共有できる。
          this.reserveGpu(source.array.byteLength);
          geometry.setAttribute('position', new THREE.BufferAttribute(source.array, source.itemSize, source.normalized));
          this.admitCpu(capacity * (16 + 3) * 4);
          this.reserveGpu(capacity * (16 + 3) * 4);
          const matrixArray = new Float32Array(capacity * 16); this.uiBackings.allocated(matrixArray.buffer);
          const colorArray = new Float32Array(capacity * 3); this.uiBackings.allocated(colorArray.buffer);
          const matrices = new THREE.InstancedBufferAttribute(matrixArray, 16).setUsage(THREE.DynamicDrawUsage);
          const instanceColors = new THREE.InstancedBufferAttribute(colorArray, 3).setUsage(THREE.DynamicDrawUsage);
          geometry.setAttribute('instanceMatrix', matrices);
          geometry.setAttribute('color', instanceColors);
          geometry.instanceCount = 0;
          geometry.boundingSphere = new THREE.Sphere();
          geometry.boundingBox = new THREE.Box3();
          const object: AssemblyEdges = new THREE.LineSegments(geometry, this.edgeMaterial);
          this.placeBatch(object, plan.origin, ASSEMBLY_EDGE_RENDER_ORDER);
          batch = { partKey: plan.partKey, object, capacity, matrices, colors: instanceColors, members: [], versions: [], colorValues: [] };
          this.edgeBatches.set(key, batch);
        }
        const geometry = batch.object.geometry;
        if (slotsChanged(batch, plan.members)) {
          geometry.instanceCount = plan.members.length;
          const bounds = new THREE.Sphere();
          const box = new THREE.Box3();
          const sourceBox = new THREE.Box3();
          plan.members.forEach((entry, slot) => {
            this.relativePlacement(entry, plan.bodyOrigin, plan.origin).toArray(batch.matrices.array, slot * 16);
            // 包囲球は実際に GPU へ送る Float32 行列から取る(視錐台で欠けない)。
            this.relativeMatrix.fromArray(batch.matrices.array, slot * 16);
            if (plan.geometry.boundingSphere !== null) bounds.union(this.sphere.copy(plan.geometry.boundingSphere).applyMatrix4(this.relativeMatrix));
            if (plan.geometry.boundingBox !== null) box.union(sourceBox.copy(plan.geometry.boundingBox).applyMatrix4(this.relativeMatrix));
          });
          geometry.boundingSphere = bounds;
          geometry.boundingBox = box;
          batch.matrices.needsUpdate = true;
          rememberSlots(batch, plan.members);
        }
        const colorValues = plan.members.map((entry) => this.edgeHex(entry.draw.emphasis, style));
        if (batch.colorValues.length !== colorValues.length || colorValues.some((value, slot) => value !== batch.colorValues[slot])) {
          colorValues.forEach((hex, slot) => {
            this.edgeColor.setHex(hex);
            batch.colors.setXYZ(slot, this.edgeColor.r, this.edgeColor.g, this.edgeColor.b);
          });
          batch.colors.needsUpdate = true;
          batch.colorValues = colorValues;
        }
        batch.object.visible = geometry.instanceCount > 0;
      }
    };

  private readonly syncBundle = (bundle: AssemblyGeometryBundle, style: DisplayStyle): void => {
      this.syncPartShapes(bundle.parts);
      this.pickTargets.length = 0;
      this.idsByObject.clear();
      this.shapeByObject.clear();
      this.pickOrder.clear();
      const facePlans = new Map<string, FacePlan>();
      const edgePlans = new Map<string, EdgePlan>();
      const alive = new Set<string>();
      const aliveFaces = new Set<string>();
      const aliveEdges = new Set<string>();
      for (const emphasis of ['none', 'hovered', 'selected'] as const) {
        this.individualEdgeMaterials[emphasis].color.setHex(this.edgeHex(emphasis, style));
      }
      for (const draw of bundle.instances) {
        const shape = this.partShapes.get(draw.partKey);
        if (shape === undefined) continue;
        alive.add(draw.componentId);
        this.pickOrder.set(draw.componentId, this.pickOrder.size);
        const entry = this.syncPlacement(draw);
        const showEdges = draw.visible && (style !== 'shaded' || draw.emphasis !== 'none');
        let preciseForComponent = true;
        for (let body = 0; body < shape.meshGeometries.length; body += 1) {
          const bodyOrigin = shape.bodyOrigins[body];
          let batchOrigin = shape.batchOrigins[body];
          if (batchOrigin === null) {
            batchOrigin = new THREE.Vector3().setFromMatrixPosition(this.worldBodyPlacement(entry, bodyOrigin));
            shape.batchOrigins[body] = batchOrigin;
          }
          if (!this.canInstance(entry, shape, body, batchOrigin)) preciseForComponent = false;
        }
        for (let body = 0; body < shape.meshGeometries.length; body += 1) {
          const bodyOrigin = shape.bodyOrigins[body];
          const batchOrigin = shape.batchOrigins[body];
          if (batchOrigin === null) throw new Error('Assembly batch origin was not initialized');
          const precise = preciseForComponent;
          const material = this.materialFor(draw, shape, body);
          const materials = Array.isArray(material) ? material : [material];
          const transparent = materials.some((value) => value.transparent
            || (value instanceof THREE.MeshPhysicalMaterial && value.transmission > 0));
          const individualKey = JSON.stringify([draw.componentId, body]);
          if (transparent || !precise) {
            aliveFaces.add(individualKey);
            let object = this.individualFaces.get(individualKey);
            if (object === undefined) {
              object = new THREE.Mesh(shape.meshGeometries[body], material);
              object.matrixAutoUpdate = false;
              object.renderOrder = ASSEMBLY_RENDER_ORDER;
              this.group.add(object);
              this.individualFaces.set(individualKey, object);
            }
            object.geometry = shape.meshGeometries[body];
            object.material = material;
            const world = this.worldBodyPlacement(entry, bodyOrigin);
            if (!object.matrix.equals(world)) object.matrixWorldNeedsUpdate = true;
            object.matrix.copy(world);
            object.updateMatrixWorld();
            object.visible = draw.visible && style !== 'wireframe';
            if (draw.visible) {
              this.pickTargets.push(object);
              this.idsByObject.set(object, [draw.componentId]);
              const subShapes = shape.meshSubShapes[body];
              if (subShapes !== undefined) this.shapeByObject.set(object, { partKey: draw.partKey, ...subShapes });
            }
          } else {
            const key = JSON.stringify([draw.partKey, shape.generation, body, materials.map((value) => value.uuid)]);
            let plan = facePlans.get(key);
            if (plan === undefined) {
              plan = { partKey: draw.partKey, geometry: shape.meshGeometries[body], material, origin: batchOrigin, bodyOrigin, members: [] };
              facePlans.set(key, plan);
            }
            if (draw.visible) plan.members.push(entry);
          }
          if (!precise) {
            aliveEdges.add(individualKey);
            let object = this.individualEdges.get(individualKey);
            if (object === undefined) {
              object = new THREE.LineSegments(shape.edgeGeometries[body], this.individualEdgeMaterials[draw.emphasis]);
              object.matrixAutoUpdate = false;
              object.renderOrder = ASSEMBLY_EDGE_RENDER_ORDER;
              this.group.add(object);
              this.individualEdges.set(individualKey, object);
            }
            object.geometry = shape.edgeGeometries[body];
            object.material = this.individualEdgeMaterials[draw.emphasis];
            const world = this.worldBodyPlacement(entry, bodyOrigin);
            if (!object.matrix.equals(world)) object.matrixWorldNeedsUpdate = true;
            object.matrix.copy(world);
            object.updateMatrixWorld();
            object.visible = showEdges;
          } else {
            const key = JSON.stringify([draw.partKey, shape.generation, body]);
            let plan = edgePlans.get(key);
            if (plan === undefined) {
              plan = { partKey: draw.partKey, geometry: shape.edgeGeometries[body], origin: batchOrigin, bodyOrigin, members: [] };
              edgePlans.set(key, plan);
            }
            if (showEdges) plan.members.push(entry);
          }
        }
      }
      for (const id of this.instances.keys()) if (!alive.has(id)) this.instances.delete(id);
      for (const [key, object] of this.individualFaces) {
        if (!aliveFaces.has(key)) { this.group.remove(object); this.individualFaces.delete(key); }
      }
      for (const [key, object] of this.individualEdges) {
        if (!aliveEdges.has(key)) { this.group.remove(object); this.individualEdges.delete(key); }
      }
      this.syncFaces(facePlans, style);
      this.syncEdges(edgePlans, style);
      // 所有する側だけが材質を捨てる。バッチの参照を差し替えた後に回収する。
      const usedSpecs = bundle.instances.flatMap((draw) => {
        const inherited = this.partShapes.get(draw.partKey)?.meshAppearances.flat() ?? [DEFAULT_APPEARANCE];
        return (draw.appearance === undefined ? inherited : [draw.appearance]).map((spec) => themedAppearance(spec, this.colors.solid));
      });
      this.candidateMaterialSpecs = usedSpecs;
      this.retire(() => this.materialStore.collect(usedSpecs));
      this.appearanceDirty = false;
    };

  private readonly ownedAttributes = (): Set<THREE.BufferAttribute | THREE.InterleavedBufferAttribute> => {
      const attributes = new Set<THREE.BufferAttribute | THREE.InterleavedBufferAttribute>();
      const geometries = new Set<THREE.BufferGeometry>();
      for (const shape of this.partShapes.values()) {
        for (const geometry of [...shape.meshGeometries, ...shape.edgeGeometries]) geometries.add(geometry);
      }
      this.group.traverse(object => {
        if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments || object instanceof THREE.Points) {
          const geometry: unknown = object.geometry;
          if (isBufferGeometry(geometry)) geometries.add(geometry);
        }
        if (object instanceof THREE.InstancedMesh) attributes.add(object.instanceMatrix);
      });
      for (const geometry of geometries) {
        for (const name of Object.keys(geometry.attributes)) attributes.add(geometry.getAttribute(name));
        const index = geometry.getIndex();
        if (index !== null) attributes.add(index);
      }
      return attributes;
    };

  private readonly instanceAttributes = (): Set<THREE.BufferAttribute> => {
      const attributes = new Set<THREE.BufferAttribute>();
      for (const batch of this.faceBatches.values()) attributes.add(batch.object.instanceMatrix);
      for (const batch of this.edgeBatches.values()) {
        attributes.add(batch.matrices); attributes.add(batch.colors);
      }
      return attributes;
    };

  private readonly rollbackBacking = (value: THREE.BufferAttribute): THREE.BufferAttribute['array'] => {
      const found = this.rollbackBackings.get(value.array);
      if (found !== undefined) return found;
      this.admitCpu(value.array.byteLength);
      const bytes = value.array.slice();
      // Retain the actual new owner before registration can throw; never erase a live borrower.
      this.rollbackBackings.set(value.array, bytes);
      this.uiBackings.allocated(bytes.buffer);
      return bytes;
    };

  private readonly reading = (bundle: AssemblyGeometryBundle): AssemblyPublishedReservation => {
      const attributes = this.ownedAttributes();
      const instanced = this.instanceAttributes();
      const sourceBuffers = assemblySourceBuffers(bundle.parts);
      const sources = new Set(sourceBuffers);
      const instanceBuffers = new Set([...instanced].map(value => value.array.buffer).filter(buffer => !this.sourceUiBackings.has(buffer)));
      const uiBuffers = [...this.copies.buffers(), ...[...attributes].filter(value =>
        !sources.has(value.array.buffer) && !instanceBuffers.has(value.array.buffer)).map(value => value.array.buffer)];
      let gpuBytes = 0;
      for (const value of attributes) gpuBytes += value.array.byteLength;
      return { sourceBackingBytes: assemblyBackingBytes(sourceBuffers),
        displayCopyBytes: assemblyBackingBytes(uiBuffers.filter(buffer => !this.sourceUiBackings.has(buffer))), instanceBytes: assemblyBackingBytes(instanceBuffers),
        gpuMeshBytes: gpuBytes, uncovered: ASSEMBLY_UNCOVERED };
    };

  /** Clearing must work even after a borrowed source backing was detached or replaced. */
  private readonly clearMeshes = (extraCleanup: readonly (() => void)[] = []): void => {
      const cpuPeak = Math.max(this.cleanupCpuPeakBytes, this.currentReservation.sourceBackingBytes
        + this.currentReservation.displayCopyBytes + this.currentReservation.instanceBytes);
      const gpuPeak = Math.max(this.cleanupGpuPeakBytes, this.currentReservation.gpuMeshBytes);
      const tasks = [...this.cleanupPending];
      for (const overlay of this.highlights.values()) {
        for (const geometry of overlay.geometries) tasks.push(() => geometry.dispose());
        for (const { material } of overlay.materials) tasks.push(() => material.dispose());
      }
      for (const batch of this.faceBatches.values()) tasks.push(() => batch.object.dispose());
      for (const batch of this.edgeBatches.values()) tasks.push(() => batch.object.geometry.dispose());
      for (const shape of this.partShapes.values()) {
        for (const geometry of [...shape.meshGeometries, ...shape.edgeGeometries]) tasks.push(() => geometry.dispose());
      }
      this.highlights.clear(); this.faceBatches.clear(); this.edgeBatches.clear();
      this.partShapes.clear(); this.instances.clear(); this.individualFaces.clear(); this.individualEdges.clear();
      const retiredChildren = [...this.group.children];
      tasks.push(() => {
        this.group.clear();
        if (retiredChildren.some(child => child.parent === this.group)) throw new Error('Assembly child detach incomplete');
      });
      this.pickTargets.length = 0; this.idsByObject.clear(); this.shapeByObject.clear(); this.pickOrder.clear();
      this.copies.clear(); this.publishedMaterialSpecs = [];
      tasks.push(() => this.materialStore.collect([]), ...extraCleanup);
      this.currentReservation = { sourceBackingBytes: 0, displayCopyBytes: 0, instanceBytes: 0,
        gpuMeshBytes: 0, uncovered: ASSEMBLY_UNCOVERED };
      this.runCleanup(tasks, cpuPeak, gpuPeak);
    };

  /** Prepare with old assets alive; failed updates restore every published input and resource. */
  private readonly updateTransaction = (bundle: AssemblyGeometryBundle, displayStyle: DisplayStyle): void => {
      const previousSourceUiBackings = this.sourceUiBackings;
      try {
        this.sourceUiBackings = this.candidateBudget?.sourceUiBackings ?? new Set();
        this.candidateSourceBackings = new Set([...assemblySourceBuffers(this.lastBundle?.parts ?? []), ...assemblySourceBuffers(bundle.parts)]);
        const owned = new Set([...this.copies.buffers(), ...[...this.ownedAttributes()].map(value => value.array.buffer)]
          .filter(buffer => !this.candidateSourceBackings.has(buffer) && !this.sourceUiBackings.has(buffer)));
        this.uiBackings.adopt(owned);
        this.sharedBaselineExtra = assemblyBackingBytes(this.uiBackings.buffers().filter(buffer => !owned.has(buffer) && !this.sourceUiBackings.has(buffer)))
          + this.uiBackings.pending(this.cpuOwner);
        const sourceBaseline = this.candidateBudget?.baselineBytes ?? this.options.baselineBytes ?? assemblyBackingBytes(this.candidateSourceBackings);
        // The synchronous transaction claims the remaining capacity before its first allocation.
        // This is an explicit reservation upper bound, never a reported allocation byte count.
        const overlap = assemblyBackingBytes(this.uiBackings.buffers().filter(buffer => this.sourceUiBackings.has(buffer)));
        this.uiBackings.reserve(this.cpuOwner, this.limitBytes - sourceBaseline - this.uiBackings.bytes() + overlap
          - this.uiBackings.pending(this.cpuOwner), sourceBaseline, this.limitBytes, this.sourceUiBackings);
        this.updateTransactionPrepared(bundle, displayStyle);
      }
      catch (error) {
        this.sourceUiBackings = previousSourceUiBackings;
        if (error instanceof AllocatedBackingRegistrationError) this.uiBackings.retainUnregistered(error.backing);
        throw error;
      }
      finally { this.uiBackings.retire(this.cpuOwner); this.candidateSourceBackings.clear(); this.sharedBaselineExtra = 0; }
    };

  private readonly updateTransactionPrepared = (bundle: AssemblyGeometryBundle, displayStyle: DisplayStyle): void => {
      if (this.options.isCurrent?.() === false) throw new Error('Assembly display owner changed');
      const previousReservation = this.currentReservation;
      const materialState = new Map<THREE.Material, { readonly color: THREE.Color | null;
        readonly environment: THREE.Texture | null }>();
      this.group.traverse(object => {
        const value: unknown = 'material' in object ? object.material : undefined;
        const used = value instanceof THREE.Material ? [value] : isMaterialArray(value) ? value : [];
        for (const material of used) if (!materialState.has(material)) {
          const color = 'color' in material && material.color instanceof THREE.Color ? material.color.clone() : null;
          materialState.set(material, { color, environment: material instanceof THREE.MeshStandardMaterial ? material.envMap : null });
        }
      });
      const oldParts = this.partShapes, oldInstances = this.instances, oldFaces = this.faceBatches, oldEdges = this.edgeBatches;
      const oldIndividualFaces = this.individualFaces, oldIndividualEdges = this.individualEdges, oldHighlights = this.highlights;
      const oldChildren = [...this.group.children];
      const previousPickTargets = [...this.pickTargets];
      const previousIds = new Map(this.idsByObject), previousShapes = new Map(this.shapeByObject), previousOrder = new Map(this.pickOrder);
      const restoreCopies = this.copies.checkpoint();
      const instanceState = [...this.instances.values()].map(entry => ({ entry, draw: entry.draw, version: entry.version,
        matrix: entry.matrix.clone(), precisionShape: entry.precisionShape, precisionByBody: new Map(entry.precisionByBody) }));
      const batchState = [...this.faceBatches.values(), ...this.edgeBatches.values()].map(batch => ({ batch,
        members: batch.members, versions: batch.versions }));
      const edgeColors = [...this.edgeBatches.values()].map(batch => ({ batch, colors: batch.colorValues }));
      this.baselineBytes = this.sharedBaselineExtra + (this.candidateBudget?.baselineBytes ?? this.options.baselineBytes ?? assemblyBackingBytes([
        ...assemblySourceBuffers(this.lastBundle?.parts ?? []), ...assemblySourceBuffers(bundle.parts),
      ]));
      if (!Number.isSafeInteger(this.baselineBytes) || this.baselineBytes < 0 || this.baselineBytes > this.limitBytes) {
        throw new RangeError(ASSEMBLY_BUDGET_MESSAGE);
      }
      this.pendingCpuBytes = assemblyBackingBytes([...this.copies.buffers(), ...[...this.ownedAttributes()].map(value => value.array.buffer)]
        .filter(buffer => !this.candidateSourceBackings.has(buffer) && !this.sourceUiBackings.has(buffer)));
      // Cache-held copies are counted by the shared builder ledger, so remove that overlap here.
      this.pendingCpuBytes -= this.copyBytes();
      this.pendingGpuBytes = previousReservation.gpuMeshBytes;
      const arrays = [...this.instanceAttributes()];
      // Reused scratch is already in the shared backing baseline; admit only actual new buffers.
      if (this.baselineBytes + this.pendingCpuBytes + this.copyBytes() > this.limitBytes) {
        throw new RangeError(ASSEMBLY_BUDGET_MESSAGE);
      }
      const arrayState = arrays.map(value => {
        const bytes = this.rollbackBacking(value); bytes.set(value.array);
        return { value, bytes, version: value.version };
      });
      const objectState = oldChildren.map(object => {
        const geometry: unknown = object instanceof THREE.Mesh || object instanceof THREE.LineSegments ? object.geometry : null;
        const material: unknown = object instanceof THREE.Mesh || object instanceof THREE.LineSegments ? object.material : null;
        return { object, matrix: object.matrix.clone(), visible: object.visible,
        matrixWorld: object.matrixWorld.clone(), matrixWorldNeedsUpdate: object.matrixWorldNeedsUpdate,
        geometry: geometry instanceof THREE.BufferGeometry ? geometry : null,
        material: material instanceof THREE.Material || isMaterialArray(material) ? material : null,
        count: object instanceof THREE.InstancedMesh ? object.count : null,
        placements: object instanceof AssemblyInstancedMesh ? object.placements : null };
      });
      const geometryState = [...new Set([...oldEdges.values()].map(batch => batch.object.geometry))].map(geometry => ({
        geometry, count: geometry.instanceCount, box: geometry.boundingBox?.clone() ?? null,
        sphere: geometry.boundingSphere?.clone() ?? null }));
      const meshBounds = [...oldFaces.values()].map(batch => ({ object: batch.object,
        box: batch.object.boundingBox?.clone() ?? null, sphere: batch.object.boundingSphere?.clone() ?? null }));
      const nextTransaction = { geometries: new Set<THREE.BufferGeometry>(), meshes: new Set<THREE.InstancedMesh>(),
        materials: new Set<THREE.Material>(), retired: [] as (() => void)[] };
      this.transaction = nextTransaction;
      this.partShapes = new Map(this.partShapes); this.instances = new Map(this.instances);
      this.faceBatches = new Map(this.faceBatches); this.edgeBatches = new Map(this.edgeBatches);
      this.individualFaces = new Map(this.individualFaces); this.individualEdges = new Map(this.individualEdges); this.highlights = new Map(this.highlights);
      const previousDirty = this.appearanceDirty;
      let published = false;
      let reservedCpuPeak = 0;
      try {
        this.syncBundle(bundle, displayStyle);
        syncAssemblyHighlights(bundle, { highlights: this.highlights, group: this.group, removeHighlight: this.removeHighlight,
          bodiesFor: key => this.partShapes.get(key)?.bodies, limitBytes: this.limitBytes,
          reservedBytes: () => this.baselineBytes + this.pendingCpuBytes + this.copyBytes(),
          allocated: buffer => this.uiBackings.allocated(buffer), backingBytes: assemblyBackingBytes,
          admitCpu: this.admitCpu, keepGeometry: this.keepGeometry, attribute: this.attribute, colors: this.colors, sectionPlanes: this.sectionPlanes,
          trackMaterial: material => { this.transaction?.materials.add(material); },
          position: this.position, rotation: this.rotation, scale: this.scale, renderOrder: ASSEMBLY_EDGE_RENDER_ORDER + 1 });
        // Acquire rollback storage before first publication, without overwriting this transaction's old snapshots.
        for (const value of this.instanceAttributes()) this.rollbackBacking(value);
        this.checkCandidateBudget();
        if (this.options.isCurrent?.() === false) throw new Error('Assembly display owner changed');
        reservedCpuPeak = Math.max(reservedCpuPeak, this.cpuPeakBytes());
        this.copies.retainBodies(bundle.parts.flatMap(part => part.bodies));
        const next = this.reading(bundle);
        if (this.baselineBytes + next.displayCopyBytes + next.instanceBytes > this.limitBytes) throw new RangeError(ASSEMBLY_BUDGET_MESSAGE);
        // The pool reservation was grown before every added BufferAttribute/instance allocation.
        if (next.gpuMeshBytes > this.pendingGpuBytes) {
          throw new RangeError(ASSEMBLY_BUDGET_MESSAGE);
        }
        this.currentReservation = next;
        this.lastBundle = bundle;
        this.lastDisplayStyle = displayStyle;
        this.publishedMaterialSpecs = this.candidateMaterialSpecs;
        published = true;
      } finally {
        // Capture candidate assets before rollback/disposal removes the actual ownership maps.
        const candidateArrays: ArrayBufferLike[] = [...this.copies.buffers()];
        for (const geometry of nextTransaction.geometries) {
          for (const value of Object.values(geometry.attributes)) candidateArrays.push(value.array.buffer);
          const index = geometry.getIndex(); if (index !== null) candidateArrays.push(index.array.buffer);
        }
        for (const mesh of nextTransaction.meshes) candidateArrays.push(mesh.instanceMatrix.array.buffer);
        const ownedCandidateArrays = candidateArrays.filter(buffer => !this.candidateSourceBackings.has(buffer));
        try { this.uiBackings.adopt(ownedCandidateArrays); }
        catch {
          // A registration failure must not interrupt rollback or turn a completed publication into a rejection.
          // Keep every actually unregistered backing reachable and unknown until registration can retry.
          const registered = new Set(this.uiBackings.buffers());
          for (const buffer of ownedCandidateArrays) if (!registered.has(buffer)) this.uiBackings.retainUnregistered(buffer);
        }
        this.transaction = null;
        if (!published) {
          reservedCpuPeak = Math.max(reservedCpuPeak, this.cpuPeakBytes());
          // Failed publication hooks must not be reentered before returning acquired candidate assets.
          for (const child of this.group.children) if (!oldChildren.includes(child) && child.parent === this.group) child.parent = null;
          this.group.children.splice(0, this.group.children.length, ...oldChildren);
          for (const child of oldChildren) child.parent = this.group;
          this.partShapes = oldParts; this.instances = oldInstances; this.faceBatches = oldFaces; this.edgeBatches = oldEdges;
          this.individualFaces = oldIndividualFaces; this.individualEdges = oldIndividualEdges; this.highlights = oldHighlights;
          for (const state of instanceState) {
            state.entry.draw = state.draw; state.entry.version = state.version; state.entry.matrix.copy(state.matrix);
            state.entry.precisionShape = state.precisionShape;
            state.entry.precisionByBody.clear();
            for (const [body, result] of state.precisionByBody) state.entry.precisionByBody.set(body, result);
          }
          for (const state of batchState) { state.batch.members = state.members; state.batch.versions = state.versions; }
          for (const state of edgeColors) state.batch.colorValues = state.colors;
          for (const state of arrayState) { state.value.array.set(state.bytes); state.value.version = state.version; }
          for (const state of objectState) {
            state.object.matrix.copy(state.matrix); state.object.matrixWorld.copy(state.matrixWorld);
            state.object.visible = state.visible; state.object.matrixWorldNeedsUpdate = state.matrixWorldNeedsUpdate;
            if ((state.object instanceof THREE.Mesh || state.object instanceof THREE.LineSegments)
              && state.geometry !== null && state.material !== null) {
              state.object.geometry = state.geometry; state.object.material = state.material;
            }
            if (state.object instanceof THREE.InstancedMesh && state.count !== null) state.object.count = state.count;
            if (state.object instanceof AssemblyInstancedMesh && state.placements !== null) state.object.placements = state.placements;
          }
          for (const state of geometryState) {
            state.geometry.instanceCount = state.count; state.geometry.boundingBox = state.box; state.geometry.boundingSphere = state.sphere;
          }
          for (const state of meshBounds) { state.object.boundingBox = state.box; state.object.boundingSphere = state.sphere; }
          this.pickTargets.splice(0, this.pickTargets.length, ...previousPickTargets);
          this.idsByObject.clear(); for (const [key, value] of previousIds) this.idsByObject.set(key, value);
          this.shapeByObject.clear(); for (const [key, value] of previousShapes) this.shapeByObject.set(key, value);
          this.pickOrder.clear(); for (const [key, value] of previousOrder) this.pickOrder.set(key, value);
          restoreCopies(); this.currentReservation = previousReservation; this.appearanceDirty = previousDirty;
          for (const [material, state] of materialState) {
            if ('color' in material && material.color instanceof THREE.Color && state.color !== null) material.color.copy(state.color);
            if (material instanceof THREE.MeshStandardMaterial) material.envMap = state.environment;
          }
          this.runCleanup([() => this.materialStore.collect(this.publishedMaterialSpecs),
            ...[...nextTransaction.meshes].map(mesh => () => mesh.dispose()),
            ...[...nextTransaction.geometries].map(geometry => () => geometry.dispose()),
            ...[...nextTransaction.materials].map(material => () => material.dispose())], reservedCpuPeak, this.pendingGpuBytes);
        }
      }
      // Cleanup failures are reported as retained reservations, never as a failed publication.
      this.runCleanup(nextTransaction.retired, reservedCpuPeak, this.pendingGpuBytes);
    };

  buildControls(): AssemblyLayer {
    return {
      group: this.group,
      meshReservation: (): AssemblyMeshReservation => {
        const publishedCpu = this.currentReservation.sourceBackingBytes + this.currentReservation.displayCopyBytes + this.currentReservation.instanceBytes;
        return { ...this.currentReservation, gpuMeshBytes: Math.max(this.currentReservation.gpuMeshBytes, this.cleanupGpuPeakBytes),
          cleanupStatus: this.cleanupPending.length === 0 ? 'complete' : 'pending',
          cleanupReservedCpuBytes: Math.max(0, this.cleanupCpuPeakBytes - publishedCpu), cleanupErrors: this.cleanupErrors,
          uncovered: this.cleanupPending.length === 0 ? ASSEMBLY_UNCOVERED : [...ASSEMBLY_UNCOVERED, 'retiredResources'] };
      },
      update: (bundle, displayStyle, nextEnvironment = null): void => {
        if (this.layerDisposed) return;
        if (bundle.parts.length > 0 || bundle.instances.length > 0) {
          this.retryCleanup();
          if (this.cleanupPending.length > 0) {
            if (bundle === this.lastBundle && !this.appearanceDirty && displayStyle === this.lastDisplayStyle && this.environment === nextEnvironment) return;
            throw new Error('Assembly cleanup is pending; candidate allocation refused');
          }
        }
        if (bundle.parts.length === 0 && bundle.instances.length === 0) {
          if (this.lastBundle !== bundle || this.partShapes.size > 0) this.clearMeshes();
          this.lastBundle = bundle; this.lastDisplayStyle = displayStyle;
          this.environment = nextEnvironment; this.appearanceDirty = false;
          return;
        }
        const nextBudget = this.captureBudget();
        const additionalUiBytes = assemblyBackingBytes(this.uiBackings.buffers().filter(buffer => nextBudget?.sourceUiBackings?.has(buffer) !== true));
        if (nextBudget !== null && (nextBudget.baselineBytes + additionalUiBytes
          + this.uiBackings.pending() > nextBudget.limitBytes
          || this.currentReservation.gpuMeshBytes > nextBudget.limitBytes
          || (this.options.gpuMeshBudget?.reservedBytes() ?? this.currentReservation.gpuMeshBytes) > nextBudget.limitBytes)) {
          throw new RangeError(ASSEMBLY_BUDGET_MESSAGE);
        }
        const previousEnvironment = this.environment;
        const previousDirty = this.appearanceDirty;
        if (this.environment !== nextEnvironment) {
          this.environment = nextEnvironment;
          this.appearanceDirty = true;
        }
        if (bundle !== this.lastBundle || this.appearanceDirty || displayStyle !== this.lastDisplayStyle) {
          const previousLimit = this.limitBytes, previousBaseline = this.baselineBytes;
          this.candidateBudget = nextBudget;
          if (nextBudget !== null) this.limitBytes = nextBudget.limitBytes;
          try { this.updateTransaction(bundle, displayStyle); }
          catch (error) {
            this.environment = previousEnvironment; this.appearanceDirty = previousDirty;
            this.limitBytes = previousLimit; this.baselineBytes = previousBaseline;
            throw error;
          } finally { this.candidateBudget = null; }
        }
      },
      setThemeColors: (next): void => {
        this.colors = next;
        this.appearanceDirty = true;
      },
      setSectionPlanes: (planes): void => {
        const countChanged = this.sectionPlanes.length !== planes.length;
        this.sectionPlanes.splice(0, this.sectionPlanes.length, ...planes);
        this.group.traverse((object) => {
          const value: unknown = 'material' in object ? object.material : undefined;
          const materials = value instanceof THREE.Material ? [value] : isMaterialArray(value) ? value : [];
          for (const material of materials) {
            material.clippingPlanes = this.sectionPlanes;
            if (countChanged) material.needsUpdate = true;
          }
        });
        this.edgeMaterial.clippingPlanes = this.sectionPlanes;
        for (const material of Object.values(this.individualEdgeMaterials)) {
          material.clippingPlanes = this.sectionPlanes;
          if (countChanged) material.needsUpdate = true;
        }
      },
      pickComponent: (raycaster): string | null => {
        let nearest: string | null = null;
        let distance = Infinity;
        for (const hit of raycaster.intersectObjects(this.pickTargets, false)) {
          if (hit.distance > distance) break;
          const componentId = this.idsByObject.get(hit.object)?.[hit.instanceId ?? 0];
          if (componentId !== undefined && (nearest === null
            || (this.pickOrder.get(componentId) ?? Infinity) < (this.pickOrder.get(nearest) ?? Infinity))) {
            nearest = componentId;
            distance = hit.distance;
          }
        }
        return nearest;
      },
      pickMateFace: (raycaster): AssemblyMateFaceHit | null => {
        let nearest: AssemblyMateFaceHit | null = null;
        let distance = Infinity;
        for (const hit of raycaster.intersectObjects(this.pickTargets, false)) {
          if (hit.distance > distance) break;
          const componentId = this.idsByObject.get(hit.object)?.[hit.instanceId ?? 0];
          const shape = this.shapeByObject.get(hit.object);
          if (componentId === undefined || shape === undefined || hit.faceIndex === undefined || hit.faceIndex === null) continue;
          const faceIndex = faceIndexOfTriangle(shape.faces, hit.faceIndex);
          if (faceIndex !== null && (nearest === null || (this.pickOrder.get(componentId) ?? Infinity) < (this.pickOrder.get(nearest.componentId) ?? Infinity))) {
            const occurrencePath = this.lastBundle?.instances.find((instance) => instance.componentId === componentId)?.occurrencePath;
            nearest = { componentId, partKey: shape.partKey, bodyFeatureId: shape.bodyFeatureId, faceIndex,
              ...(occurrencePath === undefined ? {} : { occurrencePath }) };
            distance = hit.distance;
          }
        }
        return nearest;
      },
      dispose: (): void => {
        if (this.layerDisposed) { this.retryCleanup(); return; }
        this.layerDisposed = true;
        this.clearMeshes([() => this.materialStore.dispose(), () => this.edgeMaterial.dispose(),
          ...Object.values(this.individualEdgeMaterials).map(material => () => material.dispose())]);
        this.lastBundle = null;
        this.environment = null;
        this.appearanceDirty = true;
      },
    };
  }
}

/**
 * アセンブリの層を作る。
 *
 * `patterns` は柄のテクスチャの出どころ(FR-1108)。既定は実物で、canvas の無い Node の
 * 検査からは偽物を渡せる(`createSolidLayer` と同じ約束)。
 */
export function createAssemblyLayer(patterns?: PatternTextureSource, options: AssemblyLayerOptions = {}): AssemblyLayer {
  const uiBackings = options.uiBackings ?? assemblyUiBackings;
  const construction = createViewportConstructionOwner();
  function acquired<T extends { dispose(): void }>(resource: T): T {
    return construction.acquire('assembly factory resource', resource, () => { resource.dispose(); });
  }
  try {
    const session = new AssemblyLayerRenderSession(patterns, options, uiBackings, acquired);
    const layer = session.buildControls();
    construction.handoff();
    return layer;
  } catch (error) { throw construction.fail(error); }
}
