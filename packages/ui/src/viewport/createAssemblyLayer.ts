/**
 * 配置した部品の表示層(計画書 docs/plans/P7-アセンブリ.md タスク10、§2.14)。
 *
 * 対応要件: FR-605(組図の色分け・表示/非表示)、FR-106(ホバー・選択・当たり判定)、
 * NFR-PF-1(60fps)。
 *
 * **形(ジオメトリ)は部品の鍵ごとに 1 つだけ作って共有する**(§0.a-0.4)。同じ部品を
 * 50 個置いても面と稜線をそれぞれ 1 回の instanced draw で描く。配置の行列は
 * 位置・四元数が変わったときだけ three に作らせ、カメラの再描画では更新しない。
 * 透過材質と、Float32 の相対配置では幾何公差を保てない部品は個別に描く。
 *
 * **カーネルの形(B-rep)は Comlink を越えない**(タスク6・8 の申し送り)。ここへ届くのは
 * 部品ごとに 1 回だけ再計算した結果(`SolidBody`)と、インスタンスごとの配置
 * (`RigidPlacement`)の 2 つだけである。
 *
 * **前半は three.js に触れない純関数**(Node で検査できる)。`resolveAssembly` が返した
 * `placements`(componentId → 配置)と `partKeys`(componentId → 部品の鍵)から、
 * 「鍵ごとに 1 つの形」と「置いた数だけの配置」に仕分ける。**後半が three.js の層**で、
 * 仕分けた結果を入れ物へ流し込む。
 *
 * **形・材質は必ず `dispose()` する**(P5 §7.3、P5 §4)。共有している形は、その鍵を使う
 * インスタンスが 1 つも無くなったときにだけ捨てる(誰かが使っている形は捨てない)。
 */

import {
  DEFAULT_APPEARANCE,
  type AppearanceSpec,
  type AssemblyComponent,
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
import { buildSolidGeometry, solidEmphasisOf, type AppearanceInput, type SolidEmphasis } from './buildSolidGeometry.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';
import { faceIndexOfTriangle } from '../solid/pickSubShape.js';
import { parseAssemblyTargetId } from '../assembly/mateCommands.js';
import { buildSubShapeGeometry, type SubShapeEmphasis } from './buildSubShapeGeometry.js';

// ---------------------------------------------------------------------------
// 仕分け(純関数。three.js に触れない)
// ---------------------------------------------------------------------------

/**
 * 部品 1 種類ぶんの形。**鍵(`partKeyOf` が作る `partRef` や規格部品の呼び寸法)ごとに
 * 1 つだけ**で、同じ鍵を指すインスタンスは全員この形を共有する(§0.a-0.4)。
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
}

/** 層へ渡す一式。**形は鍵ごとに 1 つ**、配置は置いた数だけ。 */
export interface AssemblyGeometryBundle {
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

/** 仕分けの材料。`resolveAssembly` の結果と、部品ごとに 1 回だけ計算した形を並べる。 */
export interface AssemblyGeometryInput {
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
}

/**
 * 文書と解決結果から、描くための一式を組み立てる(three.js に触れない純関数)。
 *
 * **同じ鍵は 1 回だけ `parts` へ入る**(§0.a-0.4)。抑制された部品(`placements` に無い)、
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
    instances.push({
      componentId: component.id,
      partKey,
      placement,
      visible: component.visible,
      // 強調の決め方は立体と同じ(選択がホバーより強い)。判定を 2 通りに割らない。
      emphasis: solidEmphasisOf(component.id, input.hoveredComponentId, selected),
      appearance: component.appearance,
      ...(subSelected.length > 0 || subHovered !== null ? { subShapes: { hovered: subHovered, selected: subSelected } } : {}),
    });
  }

  return { parts, instances };
}

// ---------------------------------------------------------------------------
// three.js の表示層
// ---------------------------------------------------------------------------

/**
 * 描く順。**部品の立体と同じ層**に置く(`createSolidLayer.ts` の `SOLID_RENDER_ORDER`)。
 *
 * 1 つの窓で開く文書は 1 つだけ(§0.a-0.10)なので、部品の立体とアセンブリの部品が
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
  /** GPU の相対配置を原点近傍に保つ。CPU の当たり判定は元の double 配置を使う。 */
  origin: THREE.Vector3 | null;
  readonly extent: THREE.Vector3;
}

type FaceMaterial = THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[];
type AssemblyMesh = THREE.Mesh<THREE.BufferGeometry, FaceMaterial>;
type AssemblyEdges = THREE.LineSegments<THREE.InstancedBufferGeometry, THREE.LineBasicMaterial>;

/** 配置だけの控え。描画する Object3D を部品の数だけ増やさない。 */
interface InstanceEntry {
  readonly matrix: THREE.Matrix4;
  version: number;
  draw: AssemblyInstanceDraw;
  /** 最新の判定だけを保持し、部品の削除時は entry ごと破棄する。 */
  precision?: {
    readonly shape: PartShapeEntry;
    readonly placementVersion: number;
    readonly originX: number;
    readonly originY: number;
    readonly originZ: number;
    readonly result: boolean;
  };
}

/**
 * GPU 用 Float32 行列を CPU pick に逆輸入しない。旧 Mesh.raycast と同じ double の
 * 世界行列で各面を調べ、native InstancedMesh と同じ instanceId を付けて返す。
 */
class AssemblyInstancedMesh extends THREE.InstancedMesh<THREE.BufferGeometry, FaceMaterial> {
  placements: readonly THREE.Matrix4[] = [];
  private readonly pickMesh: AssemblyMesh;
  private readonly pickHits: THREE.Intersection[] = [];

  constructor(geometry: THREE.BufferGeometry, material: FaceMaterial, capacity: number, private readonly root: THREE.Group) {
    super(geometry, material, capacity);
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
  readonly members: InstanceEntry[];
}

interface EdgePlan {
  readonly partKey: string;
  readonly geometry: THREE.BufferGeometry;
  readonly origin: THREE.Vector3;
  readonly members: InstanceEntry[];
}

export interface AssemblyLayer {
  /** シーンへ足す入れ物。 */
  readonly group: THREE.Group;
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
}

/** 共有の形を 1 部品ぶん作る。**組み立ては立体と同じ純関数**(`buildSolidGeometry`)を通す。 */
function fillGeometries(entry: PartShapeEntry, bodies: readonly SolidBody[]): void {
  /*
    強調はインスタンスごと。部品の外観は共有形の面グループに反映する。**立体になっていないボディを外す
    判定と、柄のための箱投影 UV の控え**をそのまま使えるのが、この関数を通す理由である。
  */
  const bundle = buildSolidGeometry(bodies, null, [], entry.appearances);
  for (const draw of bundle.entries) {
    const mesh = new THREE.BufferGeometry();
    mesh.setAttribute('position', new THREE.BufferAttribute(draw.positions, 3));
    mesh.setAttribute('normal', new THREE.BufferAttribute(draw.normals, 3));
    // 柄(FR-1108)を貼るための箱投影 UV。控えから返るので作り直しは起きない。
    mesh.setAttribute('uv', new THREE.BufferAttribute(draw.uv, 2));
    mesh.setIndex(new THREE.BufferAttribute(draw.indices, 1));
    for (const group of draw.groups) mesh.addGroup(group.start, group.count, group.materialIndex);
    entry.meshAppearances.push(draw.appearances);
    entry.meshSubShapes.push({ bodyFeatureId: draw.featureId, faces: draw.faces });
    // 包む球は視錐台の絞り込みと当たり判定の粗い絞りに使う。必ず取る。
    mesh.computeBoundingSphere();
    mesh.computeBoundingBox();
    if (mesh.boundingBox !== null) {
      entry.extent.max(mesh.boundingBox.min.clone().multiplyScalar(-1));
      entry.extent.max(mesh.boundingBox.max);
    }
    entry.meshGeometries.push(mesh);

    const edges = new THREE.BufferGeometry();
    edges.setAttribute('position', new THREE.BufferAttribute(draw.edgePositions, 3));
    edges.computeBoundingSphere();
    edges.computeBoundingBox();
    if (edges.boundingBox !== null) {
      entry.extent.max(edges.boundingBox.min.clone().multiplyScalar(-1));
      entry.extent.max(edges.boundingBox.max);
    }
    entry.edgeGeometries.push(edges);
  }
}

/** 共有の形を捨てる(その鍵を使うインスタンスが 1 つも無くなったときだけ呼ぶ)。 */
function disposeGeometries(entry: PartShapeEntry): void {
  for (const geometry of entry.meshGeometries) {
    geometry.dispose();
  }
  for (const geometry of entry.edgeGeometries) {
    geometry.dispose();
  }
  entry.meshGeometries.length = 0;
  entry.meshSubShapes.length = 0;
  entry.meshAppearances.length = 0;
  entry.edgeGeometries.length = 0;
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
function float32DotError(products: readonly number[], lower: Float64Array, upper: Float64Array): number {
  const terms = products.filter((value) => value !== 0);
  if (terms.length === 0) return 0;
  let exactLower = 0;
  let exactUpper = 0;
  for (let index = 0; index < terms.length; index += 1) {
    const term = terms[index];
    const rounded = Math.fround(term);
    if (!Number.isFinite(rounded)) return Infinity;
    lower[1 << index] = Math.min(term, rounded);
    upper[1 << index] = Math.max(term, rounded);
    exactLower = sumBound(exactLower, term, false);
    exactUpper = sumBound(exactUpper, term, true);
  }
  const full = (1 << terms.length) - 1;
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

/**
 * アセンブリの層を作る。
 *
 * `patterns` は柄のテクスチャの出どころ(FR-1108)。既定は実物で、canvas の無い Node の
 * 検査からは偽物を渡せる(`createSolidLayer` と同じ約束)。
 */
export function createAssemblyLayer(patterns?: PatternTextureSource): AssemblyLayer {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  let colors: ThemeColors = DEFAULT_THEME_COLORS;
  let lastDisplayStyle: DisplayStyle = 'shadedWithEdges';
  const materialStore = createAppearanceMaterialStore(patterns);
  const sectionPlanes: THREE.Plane[] = [];
  let environment: THREE.Texture | null = null;
  /*
    LineSegments + InstancedBufferGeometry は Three の LINES / renderInstances 経路を通る。
    USE_INSTANCING は標準 project_vertex の instanceMatrix 変換を有効にする。color は
    divisor=1 の属性なので、標準 LineBasicMaterial の色・深度・tone mapping を保てる。
  */
  const edgeMaterial = Object.assign(new THREE.LineBasicMaterial({ color: 0xffffff, vertexColors: true }), {
    defines: { USE_INSTANCING: '' },
  });
  const individualEdgeMaterials: Readonly<Record<SolidEmphasis, THREE.LineBasicMaterial>> = {
    none: new THREE.LineBasicMaterial(),
    hovered: new THREE.LineBasicMaterial(),
    selected: new THREE.LineBasicMaterial(),
  };
  edgeMaterial.clippingPlanes = sectionPlanes;
  for (const material of Object.values(individualEdgeMaterials)) material.clippingPlanes = sectionPlanes;
  const partShapes = new Map<string, PartShapeEntry>();
  const instances = new Map<string, InstanceEntry>();
  const faceBatches = new Map<string, FaceBatch>();
  const edgeBatches = new Map<string, EdgeBatch>();
  const individualFaces = new Map<string, AssemblyMesh>();
  const individualEdges = new Map<string, THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>>();
  const pickTargets: THREE.Object3D[] = [];
  const idsByObject = new Map<THREE.Object3D, readonly string[]>();
  const shapeByObject = new Map<THREE.Object3D, { readonly partKey: string; readonly bodyFeatureId: string;
    readonly faces: SolidBody['faces'] }>();
  const pickOrder = new Map<string, number>();
  const highlights = new Map<string, {
    readonly object: THREE.Group;
    readonly geometries: THREE.BufferGeometry[];
    readonly materials: { readonly material: THREE.MeshBasicMaterial | THREE.LineBasicMaterial | THREE.PointsMaterial; readonly emphasis: SubShapeEmphasis }[];
    readonly bodies: readonly SolidBody[];
    readonly key: string;
  }>();
  let lastBundle: AssemblyGeometryBundle | null = null;
  let appearanceDirty = true;
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const relativeMatrix = new THREE.Matrix4();
  const dotLower = new Float64Array(16);
  const dotUpper = new Float64Array(16);
  const edgeColor = new THREE.Color();
  const sphere = new THREE.Sphere();

  function removeHighlight(id: string): void {
    const overlay = highlights.get(id);
    if (overlay === undefined) return;
    group.remove(overlay.object);
    for (const geometry of overlay.geometries) geometry.dispose();
    for (const { material } of overlay.materials) material.dispose();
    highlights.delete(id);
  }

  /** 局所座標の強調だけを小さな独立overlayへ作る。共有形・batchを組み替えない。 */
  function syncHighlights(bundle: AssemblyGeometryBundle): void {
    const alive = new Set<string>();
    for (const draw of bundle.instances) {
      if (!draw.visible || draw.subShapes === undefined) continue;
      const bodies = partShapes.get(draw.partKey)?.bodies;
      if (bodies === undefined) continue;
      alive.add(draw.componentId);
      const key = JSON.stringify(draw.subShapes);
      let overlay = highlights.get(draw.componentId);
      if (overlay?.key !== key || overlay.bodies !== bodies) {
        removeHighlight(draw.componentId);
        const object = new THREE.Group();
        object.name = `assembly-mate-highlight:${draw.componentId}`;
        object.matrixAutoUpdate = false;
        const geometries: THREE.BufferGeometry[] = [];
        const materials: { material: THREE.MeshBasicMaterial | THREE.LineBasicMaterial | THREE.PointsMaterial; emphasis: SubShapeEmphasis }[] = [];
        const built = buildSubShapeGeometry(bodies, draw.subShapes.hovered, draw.subShapes.selected);
        for (const highlight of [built.hovered, built.selected]) {
          for (const kind of ['face', 'edge', 'vertex'] as const) {
            const positions = kind === 'face' ? highlight.facePositions : kind === 'edge' ? highlight.edgePositions : highlight.vertexPositions;
            if (positions.length === 0) continue;
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometries.push(geometry);
            const color = colors[highlight.emphasis];
            if (kind === 'face') {
              geometry.setIndex(new THREE.BufferAttribute(highlight.faceIndices, 1));
              const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.3, depthTest: false, depthWrite: false });
              material.clippingPlanes = sectionPlanes;
              const mesh = new THREE.Mesh(geometry, material);
              mesh.renderOrder = ASSEMBLY_EDGE_RENDER_ORDER + 1;
              object.add(mesh); materials.push({ material, emphasis: highlight.emphasis });
            } else if (kind === 'edge') {
              const material = new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false });
              material.clippingPlanes = sectionPlanes;
              const lines = new THREE.LineSegments(geometry, material);
              lines.renderOrder = ASSEMBLY_EDGE_RENDER_ORDER + 1;
              object.add(lines); materials.push({ material, emphasis: highlight.emphasis });
            } else {
              const material = new THREE.PointsMaterial({ color, size: 7, sizeAttenuation: false, depthTest: false, depthWrite: false });
              material.clippingPlanes = sectionPlanes;
              const points = new THREE.Points(geometry, material);
              points.renderOrder = ASSEMBLY_EDGE_RENDER_ORDER + 1;
              object.add(points); materials.push({ material, emphasis: highlight.emphasis });
            }
          }
        }
        overlay = { object, geometries, materials, bodies, key };
        highlights.set(draw.componentId, overlay);
        group.add(object);
      }
      // modelView行列でカメラからの差をdoubleで求める、個別描画と同じ精度契約。
      overlay.object.matrix.compose(position.fromArray(draw.placement.position), rotation.fromArray(draw.placement.rotation), scale);
      overlay.object.matrixWorldNeedsUpdate = true;
      for (const { material, emphasis } of overlay.materials) material.color.setHex(colors[emphasis]);
    }
    for (const id of highlights.keys()) if (!alive.has(id)) removeHighlight(id);
  }

  function removeFaceBatch(key: string, batch: FaceBatch): void {
    group.remove(batch.object);
    // InstancedMesh.dispose が instanceMatrix の GPU 資源を返す。共有形と材質は捨てない。
    batch.object.dispose();
    faceBatches.delete(key);
  }

  function removeEdgeBatch(key: string, batch: EdgeBatch): void {
    group.remove(batch.object);
    batch.object.geometry.dispose();
    edgeBatches.delete(key);
  }

  function releaseShape(partKey: string, shape: PartShapeEntry): void {
    for (const [key, batch] of faceBatches) {
      if (batch.partKey === partKey) removeFaceBatch(key, batch);
    }
    for (const [key, batch] of edgeBatches) {
      if (batch.partKey === partKey) removeEdgeBatch(key, batch);
    }
    disposeGeometries(shape);
  }

  function syncPartShapes(parts: readonly AssemblyPartShape[]): void {
    const alive = new Set<string>();
    for (const part of parts) {
      alive.add(part.partKey);
      const previous = partShapes.get(part.partKey);
      if (previous?.bodies === part.bodies && previous.appearances === part.appearances) continue;
      if (previous !== undefined) releaseShape(part.partKey, previous);
      const shape: PartShapeEntry = {
        bodies: part.bodies, appearances: part.appearances, meshAppearances: [],
        generation: (previous?.generation ?? 0) + 1, meshGeometries: [], edgeGeometries: [], origin: null,
        extent: new THREE.Vector3(), meshSubShapes: [],
      };
      fillGeometries(shape, part.bodies);
      partShapes.set(part.partKey, shape);
    }
    for (const [partKey, shape] of partShapes) {
      if (!alive.has(partKey)) {
        releaseShape(partKey, shape);
        partShapes.delete(partKey);
      }
    }
  }

  function syncPlacement(draw: AssemblyInstanceDraw): InstanceEntry {
    let entry = instances.get(draw.componentId);
    const previous = entry?.draw;
    const changed = previous === undefined
      || draw.placement.position.some((value, index) => value !== previous.placement.position[index])
      || draw.placement.rotation.some((value, index) => value !== previous.placement.rotation[index]);
    if (entry === undefined) {
      entry = { matrix: new THREE.Matrix4(), version: 0, draw };
      instances.set(draw.componentId, entry);
    }
    if (changed) {
      position.fromArray(draw.placement.position);
      rotation.fromArray(draw.placement.rotation);
      entry.matrix.compose(position, rotation, scale);
      entry.version += 1;
    }
    entry.draw = draw;
    return entry;
  }

  function materialFor(draw: AssemblyInstanceDraw, shape: PartShapeEntry, body: number): FaceMaterial {
    const appearances = shape.meshAppearances[body];
    const found = draw.appearance !== undefined || appearances.length === 1
      ? materialStore.materialFor(themedAppearance(draw.appearance ?? appearances[0], colors.solid), environment)
      : appearances.map((spec) => materialStore.materialFor(themedAppearance(spec, colors.solid), environment));
    for (const material of Array.isArray(found) ? found : [found]) material.clippingPlanes = sectionPlanes;
    return found;
  }

  function relativePlacement(entry: InstanceEntry, origin: THREE.Vector3): THREE.Matrix4 {
    relativeMatrix.copy(entry.matrix);
    relativeMatrix.setPosition(
      entry.matrix.elements[12] - origin.x,
      entry.matrix.elements[13] - origin.y,
      entry.matrix.elements[14] - origin.z,
    );
    return relativeMatrix;
  }

  function canInstance(entry: InstanceEntry, shape: PartShapeEntry, origin: THREE.Vector3): boolean {
    const previous = entry.precision;
    if (previous?.shape === shape && previous.placementVersion === entry.version
      && previous.originX === origin.x && previous.originY === origin.y && previous.originZ === origin.z) {
      return previous.result;
    }
    const result = hasPreciseInstanceVertices(entry, shape, origin);
    // Matrix4 と origin は可変なので参照だけを鍵にしない。配置の版と原点の値を控える。
    // shape の参照は再構築時に変わる。履歴を蓄積せず、最新の形・配置の判定だけ残す。
    entry.precision = { shape, placementVersion: entry.version, originX: origin.x, originY: origin.y, originZ: origin.z, result };
    return result;
  }

  function hasPreciseInstanceVertices(entry: InstanceEntry, shape: PartShapeEntry, origin: THREE.Vector3): boolean {
    // NFR-RE-3 の基準 1e-7 mm。回転の丸めは形の座標範囲を掛けて位置誤差へ直す。
    const values = relativePlacement(entry, origin).elements;
    const extent = shape.extent;
    const error = (index: number): number => Math.abs(Math.fround(values[index]) - values[index]);
    const axes = [0, 1, 2].map((row) => error(12 + row)
      + error(row) * extent.x + error(4 + row) * extent.y + error(8 + row) * extent.z);
    if (!(Math.hypot(...axes) <= 1e-7)) return false;
    const rounded = values.map(Math.fround);
    // project_vertex は instanceMatrix * vertex の後に modelViewMatrix を掛ける。
    // 係数が正確でも 1e8 + 10 が 1e8 + 8 になるため、面・稜線の実頂点も検査する。
    // syncBundle からだけ呼び、カメラのみの再描画ではこの計算を増やさない。
    for (const geometry of [...shape.meshGeometries, ...shape.edgeGeometries]) {
      const positions = geometry.getAttribute('position');
      for (let vertex = 0; vertex < positions.count; vertex += 1) {
        const x = positions.getX(vertex);
        const y = positions.getY(vertex);
        const z = positions.getZ(vertex);
        const vertexErrors = axes.map((coefficientError, row) => coefficientError + float32DotError([
          rounded[row] * x, rounded[4 + row] * y, rounded[8 + row] * z, rounded[12 + row],
        ], dotLower, dotUpper));
        if (!(Math.hypot(...vertexErrors) <= 1e-7)) return false;
      }
    }
    return true;
  }

  function edgeHex(emphasis: SolidEmphasis, style: DisplayStyle): number {
    if (emphasis !== 'none') return colors[emphasis];
    return style === 'wireframe' ? colors.solidEdgeWireframe : colors.solidEdgeOverSolid;
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

  function placeBatch(object: THREE.Object3D, origin: THREE.Vector3, renderOrder: number): void {
    object.matrixAutoUpdate = false;
    object.matrix.setPosition(origin);
    object.renderOrder = renderOrder;
    group.add(object);
    object.updateMatrixWorld(true);
  }

  function syncFaces(plans: ReadonlyMap<string, FacePlan>, style: DisplayStyle): void {
    for (const [key, batch] of faceBatches) {
      if (!plans.has(key)) removeFaceBatch(key, batch);
    }
    for (const [key, plan] of plans) {
      let batch = faceBatches.get(key);
      if (batch !== undefined && batch.capacity < plan.members.length) {
        removeFaceBatch(key, batch);
        batch = undefined;
      }
      if (batch === undefined) {
        const capacity = capacityFor(plan.members.length);
        const object = new AssemblyInstancedMesh(plan.geometry, plan.material, capacity, group);
        object.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        object.count = 0;
        placeBatch(object, plan.origin, ASSEMBLY_RENDER_ORDER);
        batch = { partKey: plan.partKey, object, capacity, members: [], versions: [] };
        faceBatches.set(key, batch);
      }
      const object = batch.object;
      if (slotsChanged(batch, plan.members)) {
        object.count = plan.members.length;
        plan.members.forEach((entry, slot) => object.setMatrixAt(slot, relativePlacement(entry, plan.origin)));
        object.instanceMatrix.needsUpdate = true;
        object.placements = plan.members.map((entry) => entry.matrix);
        object.computeBoundingSphere();
        // Box3.setFromObject 等の外部利用でも、以前の配置の包囲箱を残さない。
        object.computeBoundingBox();
        rememberSlots(batch, plan.members);
      }
      object.visible = object.count > 0 && style !== 'wireframe';
      if (object.count > 0) {
        pickTargets.push(object);
        idsByObject.set(object, plan.members.map((entry) => entry.draw.componentId));
        const body = partShapes.get(plan.partKey)?.meshGeometries.indexOf(plan.geometry) ?? -1;
        const subShapes = partShapes.get(plan.partKey)?.meshSubShapes[body];
        if (subShapes !== undefined) shapeByObject.set(object, { partKey: plan.partKey, ...subShapes });
      }
    }
  }

  function syncEdges(plans: ReadonlyMap<string, EdgePlan>, style: DisplayStyle): void {
    for (const [key, batch] of edgeBatches) {
      if (!plans.has(key)) removeEdgeBatch(key, batch);
    }
    for (const [key, plan] of plans) {
      let batch = edgeBatches.get(key);
      if (batch !== undefined && batch.capacity < plan.members.length) {
        // 属性の容量を変えると Three の _maxInstanceCount の控えも古くなるため形ごと交換。
        removeEdgeBatch(key, batch);
        batch = undefined;
      }
      if (batch === undefined) {
        const capacity = capacityFor(plan.members.length);
        const geometry = new THREE.InstancedBufferGeometry();
        const source = plan.geometry.getAttribute('position');
        // 同じ BufferAttribute を別の geometry と共有しない。片方の dispose が他方の
        // GPU buffer を消すため。読み取り専用の typed array だけは共有できる。
        geometry.setAttribute('position', new THREE.BufferAttribute(source.array, source.itemSize, source.normalized));
        const matrices = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 16), 16).setUsage(THREE.DynamicDrawUsage);
        const instanceColors = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('instanceMatrix', matrices);
        geometry.setAttribute('color', instanceColors);
        geometry.instanceCount = 0;
        geometry.boundingSphere = new THREE.Sphere();
        geometry.boundingBox = new THREE.Box3();
        const object: AssemblyEdges = new THREE.LineSegments(geometry, edgeMaterial);
        placeBatch(object, plan.origin, ASSEMBLY_EDGE_RENDER_ORDER);
        batch = { partKey: plan.partKey, object, capacity, matrices, colors: instanceColors, members: [], versions: [], colorValues: [] };
        edgeBatches.set(key, batch);
      }
      const geometry = batch.object.geometry;
      if (slotsChanged(batch, plan.members)) {
        geometry.instanceCount = plan.members.length;
        const bounds = new THREE.Sphere();
        const box = new THREE.Box3();
        const sourceBox = new THREE.Box3();
        plan.members.forEach((entry, slot) => {
          relativePlacement(entry, plan.origin).toArray(batch.matrices.array, slot * 16);
          // 包囲球は実際に GPU へ送る Float32 行列から取る(視錐台で欠けない)。
          relativeMatrix.fromArray(batch.matrices.array, slot * 16);
          if (plan.geometry.boundingSphere !== null) bounds.union(sphere.copy(plan.geometry.boundingSphere).applyMatrix4(relativeMatrix));
          if (plan.geometry.boundingBox !== null) box.union(sourceBox.copy(plan.geometry.boundingBox).applyMatrix4(relativeMatrix));
        });
        geometry.boundingSphere = bounds;
        geometry.boundingBox = box;
        batch.matrices.needsUpdate = true;
        rememberSlots(batch, plan.members);
      }
      const colorValues = plan.members.map((entry) => edgeHex(entry.draw.emphasis, style));
      if (batch.colorValues.length !== colorValues.length || colorValues.some((value, slot) => value !== batch.colorValues[slot])) {
        colorValues.forEach((hex, slot) => {
          edgeColor.setHex(hex);
          batch.colors.setXYZ(slot, edgeColor.r, edgeColor.g, edgeColor.b);
        });
        batch.colors.needsUpdate = true;
        batch.colorValues = colorValues;
      }
      batch.object.visible = geometry.instanceCount > 0;
    }
  }

  function syncBundle(bundle: AssemblyGeometryBundle, style: DisplayStyle): void {
    syncPartShapes(bundle.parts);
    pickTargets.length = 0;
    idsByObject.clear();
    shapeByObject.clear();
    pickOrder.clear();
    const facePlans = new Map<string, FacePlan>();
    const edgePlans = new Map<string, EdgePlan>();
    const alive = new Set<string>();
    const aliveFaces = new Set<string>();
    const aliveEdges = new Set<string>();
    for (const emphasis of ['none', 'hovered', 'selected'] as const) {
      individualEdgeMaterials[emphasis].color.setHex(edgeHex(emphasis, style));
    }
    for (const draw of bundle.instances) {
      const shape = partShapes.get(draw.partKey);
      if (shape === undefined) continue;
      alive.add(draw.componentId);
      pickOrder.set(draw.componentId, pickOrder.size);
      const entry = syncPlacement(draw);
      shape.origin ??= new THREE.Vector3().fromArray(draw.placement.position);
      const precise = canInstance(entry, shape, shape.origin);
      const showEdges = draw.visible && (style !== 'shaded' || draw.emphasis !== 'none');
      for (let body = 0; body < shape.meshGeometries.length; body += 1) {
        const material = materialFor(draw, shape, body);
        const materials = Array.isArray(material) ? material : [material];
        const transparent = materials.some((value) => value.transparent
          || (value instanceof THREE.MeshPhysicalMaterial && value.transmission > 0));
        const individualKey = JSON.stringify([draw.componentId, body]);
        if (transparent || !precise) {
          aliveFaces.add(individualKey);
          let object = individualFaces.get(individualKey);
          if (object === undefined) {
            object = new THREE.Mesh(shape.meshGeometries[body], material);
            object.matrixAutoUpdate = false;
            object.renderOrder = ASSEMBLY_RENDER_ORDER;
            group.add(object);
            individualFaces.set(individualKey, object);
          }
          object.geometry = shape.meshGeometries[body];
          object.material = material;
          if (!object.matrix.equals(entry.matrix)) object.matrixWorldNeedsUpdate = true;
          object.matrix.copy(entry.matrix);
          object.updateMatrixWorld();
          object.visible = draw.visible && style !== 'wireframe';
          if (draw.visible) {
            pickTargets.push(object);
            idsByObject.set(object, [draw.componentId]);
            const subShapes = shape.meshSubShapes[body];
            if (subShapes !== undefined) shapeByObject.set(object, { partKey: draw.partKey, ...subShapes });
          }
        } else {
          const key = JSON.stringify([draw.partKey, shape.generation, body, materials.map((value) => value.uuid)]);
          let plan = facePlans.get(key);
          if (plan === undefined) {
            plan = { partKey: draw.partKey, geometry: shape.meshGeometries[body], material, origin: shape.origin, members: [] };
            facePlans.set(key, plan);
          }
          if (draw.visible) plan.members.push(entry);
        }
        if (!precise) {
          aliveEdges.add(individualKey);
          let object = individualEdges.get(individualKey);
          if (object === undefined) {
            object = new THREE.LineSegments(shape.edgeGeometries[body], individualEdgeMaterials[draw.emphasis]);
            object.matrixAutoUpdate = false;
            object.renderOrder = ASSEMBLY_EDGE_RENDER_ORDER;
            group.add(object);
            individualEdges.set(individualKey, object);
          }
          object.geometry = shape.edgeGeometries[body];
          object.material = individualEdgeMaterials[draw.emphasis];
          if (!object.matrix.equals(entry.matrix)) object.matrixWorldNeedsUpdate = true;
          object.matrix.copy(entry.matrix);
          object.updateMatrixWorld();
          object.visible = showEdges;
        } else {
          const key = JSON.stringify([draw.partKey, shape.generation, body]);
          let plan = edgePlans.get(key);
          if (plan === undefined) {
            plan = { partKey: draw.partKey, geometry: shape.edgeGeometries[body], origin: shape.origin, members: [] };
            edgePlans.set(key, plan);
          }
          if (showEdges) plan.members.push(entry);
        }
      }
    }
    for (const id of instances.keys()) if (!alive.has(id)) instances.delete(id);
    for (const [key, object] of individualFaces) {
      if (!aliveFaces.has(key)) { group.remove(object); individualFaces.delete(key); }
    }
    for (const [key, object] of individualEdges) {
      if (!aliveEdges.has(key)) { group.remove(object); individualEdges.delete(key); }
    }
    syncFaces(facePlans, style);
    syncEdges(edgePlans, style);
    // 所有する側だけが材質を捨てる。バッチの参照を差し替えた後に回収する。
    materialStore.collect(bundle.instances.flatMap((draw) => {
      const inherited = partShapes.get(draw.partKey)?.meshAppearances.flat() ?? [DEFAULT_APPEARANCE];
      return (draw.appearance === undefined ? inherited : [draw.appearance]).map((spec) => themedAppearance(spec, colors.solid));
    }));
    appearanceDirty = false;
  }

  return {
    group,
    update(bundle, displayStyle, nextEnvironment = null): void {
      if (environment !== nextEnvironment) {
        environment = nextEnvironment;
        appearanceDirty = true;
      }
      if (bundle !== lastBundle || appearanceDirty || displayStyle !== lastDisplayStyle) {
        syncBundle(bundle, displayStyle);
        syncHighlights(bundle);
        lastBundle = bundle;
        lastDisplayStyle = displayStyle;
      }
    },
    setThemeColors(next): void {
      colors = next;
      appearanceDirty = true;
    },
    setSectionPlanes(planes): void {
      const countChanged = sectionPlanes.length !== planes.length;
      sectionPlanes.splice(0, sectionPlanes.length, ...planes);
      group.traverse((object) => {
        const value: unknown = 'material' in object ? object.material : undefined;
        const materials = value instanceof THREE.Material ? [value] : isMaterialArray(value) ? value : [];
        for (const material of materials) {
          material.clippingPlanes = sectionPlanes;
          if (countChanged) material.needsUpdate = true;
        }
      });
      edgeMaterial.clippingPlanes = sectionPlanes;
      for (const material of Object.values(individualEdgeMaterials)) {
        material.clippingPlanes = sectionPlanes;
        if (countChanged) material.needsUpdate = true;
      }
    },
    pickComponent(raycaster): string | null {
      let nearest: string | null = null;
      let distance = Infinity;
      for (const hit of raycaster.intersectObjects(pickTargets, false)) {
        if (hit.distance > distance) break;
        const componentId = idsByObject.get(hit.object)?.[hit.instanceId ?? 0];
        if (componentId !== undefined && (nearest === null
          || (pickOrder.get(componentId) ?? Infinity) < (pickOrder.get(nearest) ?? Infinity))) {
          nearest = componentId;
          distance = hit.distance;
        }
      }
      return nearest;
    },
    pickMateFace(raycaster): AssemblyMateFaceHit | null {
      let nearest: AssemblyMateFaceHit | null = null;
      let distance = Infinity;
      for (const hit of raycaster.intersectObjects(pickTargets, false)) {
        if (hit.distance > distance) break;
        const componentId = idsByObject.get(hit.object)?.[hit.instanceId ?? 0];
        const shape = shapeByObject.get(hit.object);
        if (componentId === undefined || shape === undefined || hit.faceIndex === undefined || hit.faceIndex === null) continue;
        const faceIndex = faceIndexOfTriangle(shape.faces, hit.faceIndex);
        if (faceIndex !== null && (nearest === null || (pickOrder.get(componentId) ?? Infinity) < (pickOrder.get(nearest.componentId) ?? Infinity))) {
          nearest = { componentId, partKey: shape.partKey, bodyFeatureId: shape.bodyFeatureId, faceIndex };
          distance = hit.distance;
        }
      }
      return nearest;
    },
    dispose(): void {
      for (const id of highlights.keys()) removeHighlight(id);
      for (const [key, batch] of faceBatches) removeFaceBatch(key, batch);
      for (const [key, batch] of edgeBatches) removeEdgeBatch(key, batch);
      for (const shape of partShapes.values()) disposeGeometries(shape);
      partShapes.clear();
      instances.clear();
      individualFaces.clear();
      individualEdges.clear();
      group.clear();
      materialStore.dispose();
      edgeMaterial.dispose();
      for (const material of Object.values(individualEdgeMaterials)) material.dispose();
      pickTargets.length = 0;
      idsByObject.clear();
      shapeByObject.clear();
      pickOrder.clear();
      lastBundle = null;
      environment = null;
      appearanceDirty = true;
    },
  };
}
