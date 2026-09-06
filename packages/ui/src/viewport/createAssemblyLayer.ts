/**
 * 配置した部品の表示層(計画書 docs/plans/P7-アセンブリ.md タスク10、§2.14)。
 *
 * 対応要件: FR-605(組図の色分け・表示/非表示)、FR-106(ホバー・選択・当たり判定)、
 * NFR-PF-1(60fps)。
 *
 * **形(ジオメトリ)は部品の鍵ごとに 1 つだけ作って共有する**(§0.a-0.4)。同じ部品を
 * 50 個置いても `BufferGeometry` は 1 組で、置いた数だけ作るのは three の `Object3D`
 * (`position` + `quaternion`)だけになる。**行列を毎コマ作り直さない**——配置は
 * 四元数と位置のまま `Object3D` に載せ、three が 1 回だけ行列へ直す(§2.4)。
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

import { appearanceKeyText } from '../appearance/buildFaceGroups.js';
import {
  createAppearanceMaterialStore,
  type PatternTextureSource,
} from '../appearance/createAppearanceMaterial.js';
import type { DisplayStyle } from '../store/viewSlice.js';
import { buildSolidGeometry, solidEmphasisOf, type SolidEmphasis } from './buildSolidGeometry.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';

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
  /** 組図での色分け(FR-605)。割り当てが無ければ既定の外観。 */
  readonly appearance: AppearanceSpec;
}

/** 層へ渡す一式。**形は鍵ごとに 1 つ**、配置は置いた数だけ。 */
export interface AssemblyGeometryBundle {
  readonly parts: readonly AssemblyPartShape[];
  readonly instances: readonly AssemblyInstanceDraw[];
}

/** 何も置いていないとき。アセンブリを開いていない間の値にも使う。 */
export const EMPTY_ASSEMBLY_GEOMETRY: AssemblyGeometryBundle = { parts: [], instances: [] };

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
  /** ホバー中のインスタンスの id(ストアの `hoveredElementId` をそのまま渡してよい)。 */
  readonly hoveredComponentId: string | null;
  /** 選択中の id(ストアの `selection` をそのまま渡してよい)。 */
  readonly selectedComponentIds: readonly string[];
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
      parts.push({ partKey, bodies });
    }
    instances.push({
      componentId: component.id,
      partKey,
      placement,
      visible: component.visible,
      // 強調の決め方は立体と同じ(選択がホバーより強い)。判定を 2 通りに割らない。
      emphasis: solidEmphasisOf(component.id, input.hoveredComponentId, selected),
      appearance: component.appearance ?? DEFAULT_APPEARANCE,
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

/** 既定の外観の鍵。テーマの色を当てる相手かどうかの判定に使う(下の `themedAppearance`)。 */
const DEFAULT_APPEARANCE_KEY = appearanceKeyText(DEFAULT_APPEARANCE);

/** 0xrrggbb を `#rrggbb` の文字にする(外観の色は文字で持つため)。 */
function hexColorText(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

/**
 * 既定の外観の色だけを、いまのテーマの立体の色(`--pcad-solid`)へ差し替える(FR-908)。
 *
 * **色分けを割り当てた部品は 1 つも触らない**(利用者が選んだ色をテーマで塗り替えない)。
 * 規則は `createSolidLayer.ts` の同名の関数とまったく同じにしてある——部品を開いたときと
 * アセンブリの中とで「色を決めていない部品の色」が食い違うと、同じ形が別物に見えるため。
 * (その関数は層の内側に閉じており、この層はタスク10 の欄のファイルだけを触る決めなので、
 * いまは同じ判定をここにも置いてある。両方の層を触るタスクが来たら 1 か所へ寄せてよい。)
 */
function themedAppearance(spec: AppearanceSpec, solidColor: number): AppearanceSpec {
  if (appearanceKeyText(spec) !== DEFAULT_APPEARANCE_KEY) {
    return spec;
  }
  const color = hexColorText(solidColor);
  return color === spec.color ? spec : { ...spec, color };
}

/**
 * 部品 1 種類ぶんの共有の形。**ボディごとに面 1 つ・稜線 1 つ**の `BufferGeometry` を持つ。
 *
 * `generation` は形を作り直した回数で、インスタンス側が「自分がぶら下げている形が
 * 作り直されたか」を数の比較 1 回で見分けるための札。
 */
interface PartShapeEntry {
  bodies: readonly SolidBody[];
  generation: number;
  readonly meshGeometries: THREE.BufferGeometry[];
  readonly edgeGeometries: THREE.BufferGeometry[];
}

type AssemblyMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
type AssemblyEdges = THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;

/** 置いた部品 1 つぶんの入れ物。**形は持たない**(共有の形を指すだけ)。 */
interface InstanceEntry {
  /** 配置(位置 + 四元数)を載せる入れ物。シーンにはこれが置いた数だけ並ぶ。 */
  readonly object: THREE.Group;
  partKey: string;
  /** ぶら下げている形の版(`PartShapeEntry.generation`)。 */
  generation: number;
  readonly meshes: AssemblyMesh[];
  readonly edges: AssemblyEdges[];
}

export interface AssemblyLayer {
  /** シーンへ足す入れ物。 */
  readonly group: THREE.Group;
  /**
   * 置いた部品を差し替える(FR-605)。**同じ一式(同一参照)を渡し直したときは、
   * 表示スタイルの入切だけで済ませる**(NFR-PF-1)。
   */
  update(bundle: AssemblyGeometryBundle, displayStyle: DisplayStyle): void;
  /**
   * 表示テーマの色を反映する(FR-908)。**形は 1 つも作り直さない**——色を決めていない
   * 部品の材質だけが次の `update` で作り直される。
   */
  setThemeColors(colors: ThemeColors): void;
  /**
   * 光線に当たった部品(インスタンス)の id。当たらなければ null(FR-106)。
   *
   * **非表示の部品には当たらない。** three.js の `Raycaster` は `visible` を見ない
   * (`createSolidLayer.ts` の `pickBody` の注釈)ので、ここで表示中のものだけを的にする。
   * 消してある部品を掴めてしまうと、画面に無いものが選ばれることになるため。
   */
  pickComponent(raycaster: THREE.Raycaster): string | null;
  dispose(): void;
}

/** 共有の形を 1 部品ぶん作る。**組み立ては立体と同じ純関数**(`buildSolidGeometry`)を通す。 */
function fillGeometries(entry: PartShapeEntry, bodies: readonly SolidBody[]): void {
  /*
    強調も外観もここでは要らない(強調はインスタンスごと、色分けは部品ごとに後から当てる)
    ので、ホバー無し・選択無し・外観無しで組み立てる。**立体になっていないボディを外す
    判定と、柄のための箱投影 UV の控え**をそのまま使えるのが、この関数を通す理由である。
  */
  const bundle = buildSolidGeometry(bodies, null, []);
  for (const draw of bundle.entries) {
    const mesh = new THREE.BufferGeometry();
    mesh.setAttribute('position', new THREE.BufferAttribute(draw.positions, 3));
    mesh.setAttribute('normal', new THREE.BufferAttribute(draw.normals, 3));
    // 柄(FR-1108)を貼るための箱投影 UV。控えから返るので作り直しは起きない。
    mesh.setAttribute('uv', new THREE.BufferAttribute(draw.uv, 2));
    mesh.setIndex(new THREE.BufferAttribute(draw.indices, 1));
    // 包む球は視錐台の絞り込みと当たり判定の粗い絞りに使う。必ず取る。
    mesh.computeBoundingSphere();
    entry.meshGeometries.push(mesh);

    const edges = new THREE.BufferGeometry();
    edges.setAttribute('position', new THREE.BufferAttribute(draw.edgePositions, 3));
    edges.computeBoundingSphere();
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
  entry.edgeGeometries.length = 0;
}

/**
 * アセンブリの層を作る。
 *
 * `patterns` は柄のテクスチャの出どころ(FR-1108)。既定は実物で、canvas の無い Node の
 * 検査からは偽物を渡せる(`createSolidLayer` と同じ約束)。
 */
export function createAssemblyLayer(patterns?: PatternTextureSource): AssemblyLayer {
  const group = new THREE.Group();

  /** いま効いているテーマの色。`setThemeColors` が来るまでは既定(ダーク)。 */
  let colors: ThemeColors = DEFAULT_THEME_COLORS;

  /** いまの表示スタイル。テーマが変わったとき、稜線の色をどちらへ塗るかの判断に使う。 */
  let lastDisplayStyle: DisplayStyle = 'shadedWithEdges';

  /**
   * 面の材質の入れ物。**見え方(`appearanceKeyText`)が同じなら同じ材質**を返すので、
   * 同じ部品を 50 個置いても材質は 1 つで済む(P5 タスク9)。使われなくなった材質は
   * `collect` が捨てる(WebGL の資源は GC で戻らない)。
   *
   * **映り込み(FR-1107)の環境マップは渡さない。** 作る・捨てるの判断はレンダラを持つ
   * `createViewportScene.ts` が立体の層のために行っており、アセンブリの部品にも配るのは
   * 鏡・ガラスの部品を置けるようになってからでよい(いまは映り込みの無い材質になる)。
   */
  const materialStore = createAppearanceMaterialStore(patterns);

  /**
   * 稜線の材質は強調の度合いごとに 1 つずつ。部品ごとには作らず、どれを使うかだけを
   * 切り替える(部品が 50 個あっても材質は 3 つのまま)。
   */
  const edgeMaterials: Readonly<Record<SolidEmphasis, THREE.LineBasicMaterial>> = {
    none: new THREE.LineBasicMaterial({ color: DEFAULT_THEME_COLORS.solidEdgeOverSolid }),
    hovered: new THREE.LineBasicMaterial({ color: DEFAULT_THEME_COLORS.hovered }),
    selected: new THREE.LineBasicMaterial({ color: DEFAULT_THEME_COLORS.selected }),
  };

  /** 部品の鍵 → 共有の形。 */
  const partShapes = new Map<string, PartShapeEntry>();
  /** インスタンスの id → 入れ物。 */
  const instances = new Map<string, InstanceEntry>();

  /** 当たり判定にかける面(表示中のものだけ)。 */
  const pickTargets: THREE.Object3D[] = [];
  /** 当たった面 → インスタンスの id。 */
  const idByObject = new Map<THREE.Object3D, string>();

  let lastBundle: AssemblyGeometryBundle | null = null;
  /** 材質を作り直す必要があるか(テーマの色が変わった)。**毎コマは触らない。** */
  let appearanceDirty = true;

  /** 共有の形を、渡された一式に合わせる。**同じ並びなら作り直さない。** */
  function syncPartShapes(parts: readonly AssemblyPartShape[]): void {
    const alive = new Set<string>();
    for (const part of parts) {
      alive.add(part.partKey);
      const entry = partShapes.get(part.partKey);
      if (entry === undefined) {
        const created: PartShapeEntry = {
          bodies: part.bodies,
          generation: 1,
          meshGeometries: [],
          edgeGeometries: [],
        };
        fillGeometries(created, part.bodies);
        partShapes.set(part.partKey, created);
        continue;
      }
      if (entry.bodies === part.bodies) {
        // 配置だけが変わった(形は同じ並び)。**1 バイトも触らない**(NFR-PF-1)。
        continue;
      }
      // 部品を計算し直した。古い形を捨ててから作り直し、版を進めて子の組み直しを促す。
      disposeGeometries(entry);
      fillGeometries(entry, part.bodies);
      entry.bodies = part.bodies;
      entry.generation += 1;
    }
    for (const [partKey, entry] of partShapes) {
      if (alive.has(partKey)) {
        continue;
      }
      // その鍵を使うインスタンスが 1 つも無くなった。ここで初めて形を捨てる(P5 §7.3)。
      disposeGeometries(entry);
      partShapes.delete(partKey);
    }
  }

  /** 入れ物の子(面と稜線)を、共有の形の数に合わせて組み直す。**形は捨てない。** */
  function rebuildChildren(
    entry: InstanceEntry,
    shape: PartShapeEntry,
    material: THREE.MeshStandardMaterial,
  ): void {
    for (const mesh of entry.meshes) {
      entry.object.remove(mesh);
    }
    for (const edges of entry.edges) {
      entry.object.remove(edges);
    }
    entry.meshes.length = 0;
    entry.edges.length = 0;
    for (let index = 0; index < shape.meshGeometries.length; index += 1) {
      const mesh: AssemblyMesh = new THREE.Mesh(shape.meshGeometries[index], material);
      mesh.renderOrder = ASSEMBLY_RENDER_ORDER;
      entry.object.add(mesh);
      entry.meshes.push(mesh);

      const edges: AssemblyEdges = new THREE.LineSegments(
        shape.edgeGeometries[index],
        edgeMaterials.none,
      );
      edges.renderOrder = ASSEMBLY_EDGE_RENDER_ORDER;
      entry.object.add(edges);
      entry.edges.push(edges);
    }
  }

  /** 置いた部品 1 つを反映する。形を共有したまま、配置・色・強調だけを載せる。 */
  function applyInstance(draw: AssemblyInstanceDraw): void {
    const shape = partShapes.get(draw.partKey);
    if (shape === undefined) {
      return;
    }
    let entry = instances.get(draw.componentId);
    if (entry === undefined) {
      const object = new THREE.Group();
      group.add(object);
      entry = { object, partKey: '', generation: 0, meshes: [], edges: [] };
      instances.set(draw.componentId, entry);
    }
    const material = materialStore.materialFor(
      themedAppearance(draw.appearance, colors.solid),
      null,
    );
    if (entry.partKey !== draw.partKey || entry.generation !== shape.generation) {
      rebuildChildren(entry, shape, material);
      entry.partKey = draw.partKey;
      entry.generation = shape.generation;
    }

    /*
      配置は**位置と四元数のまま**載せる(§2.4、§0.a-0.5)。行列を自分で作らないので、
      置き直しの費用は 7 個の数の書き込みだけで済む。世界行列はここで 1 回だけ取り直す
      ——描く前に当たり判定が呼ばれても、動かした後の位置で当たる(FR-106)。
    */
    entry.object.position.set(
      draw.placement.position[0],
      draw.placement.position[1],
      draw.placement.position[2],
    );
    entry.object.quaternion.set(
      draw.placement.rotation[0],
      draw.placement.rotation[1],
      draw.placement.rotation[2],
      draw.placement.rotation[3],
    );
    entry.object.visible = draw.visible;
    entry.object.updateMatrixWorld();

    for (const mesh of entry.meshes) {
      mesh.material = material;
    }
    for (const edges of entry.edges) {
      edges.material = edgeMaterials[draw.emphasis];
    }
  }

  /** インスタンスを 1 つ片付ける。**形は共有なので捨てない**(材質も入れ物が持つ)。 */
  function removeInstance(componentId: string, entry: InstanceEntry): void {
    group.remove(entry.object);
    entry.object.clear();
    entry.meshes.length = 0;
    entry.edges.length = 0;
    instances.delete(componentId);
  }

  /** 一式を丸ごと反映する(形 → インスタンス → 使われなくなった材質の順)。 */
  function syncBundle(bundle: AssemblyGeometryBundle): void {
    syncPartShapes(bundle.parts);

    const alive = new Set<string>();
    for (const draw of bundle.instances) {
      alive.add(draw.componentId);
      applyInstance(draw);
    }
    for (const [componentId, entry] of [...instances]) {
      if (!alive.has(componentId)) {
        removeInstance(componentId, entry);
      }
    }

    // いま画面に出ている色だけを残す(テーマの色を当てた後の外観で数える)。
    materialStore.collect(
      bundle.instances.map((draw) => themedAppearance(draw.appearance, colors.solid)),
    );
    appearanceDirty = false;
  }

  /**
   * 表示スタイルと強調を反映する(FR-105、FR-106)。**ホバー中・選択中の部品の稜線は
   * 面のみの表示でも出す**(強調を稜線でしか示さないため。立体の層と同じ決め)。
   */
  function applyStyle(bundle: AssemblyGeometryBundle, displayStyle: DisplayStyle): void {
    lastDisplayStyle = displayStyle;
    const showFaces = displayStyle !== 'wireframe';
    const showEdges = displayStyle !== 'shaded';
    edgeMaterials.none.color.setHex(
      displayStyle === 'wireframe' ? colors.solidEdgeWireframe : colors.solidEdgeOverSolid,
    );
    pickTargets.length = 0;
    idByObject.clear();
    for (const draw of bundle.instances) {
      const entry = instances.get(draw.componentId);
      if (entry === undefined) {
        continue;
      }
      for (const mesh of entry.meshes) {
        mesh.visible = showFaces;
        if (draw.visible) {
          // 表示中の部品だけを的にする(消してある部品は掴めない)。
          pickTargets.push(mesh);
          idByObject.set(mesh, draw.componentId);
        }
      }
      for (const edges of entry.edges) {
        edges.visible = showEdges || draw.emphasis !== 'none';
      }
    }
  }

  return {
    group,

    update(bundle, displayStyle): void {
      if (bundle !== lastBundle || appearanceDirty) {
        lastBundle = bundle;
        syncBundle(bundle);
      }
      applyStyle(bundle, displayStyle);
    },

    setThemeColors(next): void {
      colors = next;
      // 色を決めていない部品の材質は次の `update` で作り直す(材質は鍵で使い回すので、
      // 色を直に書き換えると鍵と中身が食い違う)。稜線はその場で塗り替えてよい。
      appearanceDirty = true;
      edgeMaterials.none.color.setHex(
        lastDisplayStyle === 'wireframe' ? colors.solidEdgeWireframe : colors.solidEdgeOverSolid,
      );
      edgeMaterials.hovered.color.setHex(colors.hovered);
      edgeMaterials.selected.color.setHex(colors.selected);
    },

    pickComponent(raycaster): string | null {
      // 近い順に並ぶので先頭が手前の部品。
      const hits = raycaster.intersectObjects(pickTargets, false);
      for (const hit of hits) {
        const componentId = idByObject.get(hit.object);
        if (componentId !== undefined) {
          return componentId;
        }
      }
      return null;
    },

    dispose(): void {
      for (const [componentId, entry] of [...instances]) {
        removeInstance(componentId, entry);
      }
      for (const entry of partShapes.values()) {
        disposeGeometries(entry);
      }
      partShapes.clear();
      // 材質の入れ物は、貯めた材質と柄のテクスチャの表をまとめて捨てる。
      materialStore.dispose();
      edgeMaterials.none.dispose();
      edgeMaterials.hovered.dispose();
      edgeMaterials.selected.dispose();
      pickTargets.length = 0;
      idByObject.clear();
      lastBundle = null;
      appearanceDirty = true;
    },
  };
}
