/**
 * 立体の表示層のうち、ボディの面と稜線の責務(FR-105、FR-106、FR-1106〜1109、NFR-PF-1)。
 *
 * ボディごとの部品(面のメッシュと稜線)の数を組み立て結果に合わせ、形と外観(まとまりと材質の配列)を
 * 流し込み、表示スタイルと強調を材質へ写し、当たり判定の的を持つ。**毎フレーム作り直さない**:
 * 同じ並び(同一参照)なら入れ物を触らず、外観が同じならまとまりも材質も作り直さない。外観を 1 つも
 * 割り当てていない立体は長さ 1 の材質の配列・まとまり 1 つなので、ドローコールも絵も外観の無い時と変わらない。
 */
import type { AppearanceSpec, Vec3 } from '@pointercad/model';
import * as THREE from 'three';

import type { FaceGroup } from '../appearance/buildFaceGroups.js';
import { themedAppearance, type createAppearanceMaterialStore } from '../appearance/createAppearanceMaterial.js';
import type { DisplayStyle } from '../store/viewSlice.js';
import type { SolidDrawEntry, SolidEmphasis } from './buildSolidGeometry.js';
import { borrowedGeometryRelease, geometryAttributeBytes, setGeometryAttributes, setVectorAttribute } from './solidLayerBuffers.js';
import type { PrintabilityPlan } from './solidLayerPrintability.js';
import { SOLID_EDGE_RENDER_ORDER, SOLID_RENDER_ORDER } from './solidLayerRenderOrder.js';
import type { ThemeColors } from './themeColors.js';

/**
 * 面の材質は**ボディごとの配列**(FR-1106)。まとまり(`geometry.addGroup`)の
 * `materialIndex` がこの配列を指す。
 */
type SolidMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial[]>;
type SolidEdges = THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;

/** ボディ 1 つぶんの部品。並びは前回と同じかどうかを参照で見分けられるよう控えておく。 */
export interface BodyDraw {
  featureId: string;
  positions: Float32Array | null;
  normals: Float32Array | null;
  uv: Float32Array | null;
  indices: Uint32Array | null;
  edgePositions: Float32Array | null;
  /** 前回反映したまとまり(中身で比べる)。 */
  groups: readonly FaceGroup[] | null;
  /** 前回反映した外観の一覧(参照で比べる)。 */
  appearances: readonly AppearanceSpec[] | null;
  readonly mesh: SolidMesh;
  readonly edges: SolidEdges;
}

interface SolidBodyDrawOptions {
  readonly group: THREE.Group;
  /** ボディの部品の並び。断面のつまみの大きさと断面表示の材質の配り先も同じ並びを読む。 */
  readonly draws: BodyDraw[];
  /** 稜線の材質は強調の度合いごとに 1 つずつ(ボディが増えても 3 つのまま)。 */
  readonly edgeMaterials: Readonly<Record<SolidEmphasis, THREE.LineBasicMaterial>>;
  readonly materialStore: ReturnType<typeof createAppearanceMaterialStore>;
  /** 点検の色を出している立体の、外観の代わりの割り当て(`solidLayerPrintability.ts`)。 */
  readonly planFor: (entry: SolidDrawEntry) => PrintabilityPlan | null;
  readonly getColors: () => ThemeColors;
}

/** まとまりが前回と同じか(中身で比べる。組み立てのたびに新しい配列が来るため)。 */
function sameGroups(previous: readonly FaceGroup[] | null, next: readonly FaceGroup[]): boolean {
  if (previous === null || previous.length !== next.length) {
    return false;
  }
  return previous.every(
    (group, position) =>
      group.start === next[position].start &&
      group.count === next[position].count &&
      group.materialIndex === next[position].materialIndex,
  );
}

/**
 * 使う外観の一覧が前回と同じか。**外観そのものは文書の値をそのまま指している**ので、
 * 参照で比べれば足りる(中身の比較は材質の鍵づくりで行う)。
 */
function sameAppearances(
  previous: readonly AppearanceSpec[] | null,
  next: readonly AppearanceSpec[],
): boolean {
  if (previous === null || previous.length !== next.length) {
    return false;
  }
  return previous.every((spec, position) => spec === next[position]);
}

/** Retain each retired draw and its individual release operations until cleanup succeeds. */
function createSolidDrawRetirement(group: THREE.Group, draws: BodyDraw[]) {
  let retiringDraw: BodyDraw | null = null;
  const releases = new WeakMap<THREE.BufferGeometry, () => void>();
  function geometryRelease(geometry: THREE.BufferGeometry): () => void {
    let release = releases.get(geometry);
    if (release === undefined) {
      release = borrowedGeometryRelease(geometry);
      releases.set(geometry, release);
    }
    return release;
  }
  function resize(count: number, createDraw: () => BodyDraw): void {
    while (draws.length > count || retiringDraw !== null) {
      const draw = draws[draws.length - 1];
      if (draw === undefined) throw new Error('Retiring solid draw is missing');
      retiringDraw = draw;
      group.remove(draw.mesh);
      group.remove(draw.edges);
      geometryRelease(draw.mesh.geometry)();
      geometryRelease(draw.edges.geometry)();
      draw.positions = null;
      draw.normals = null;
      draw.uv = null;
      draw.indices = null;
      draw.edgePositions = null;
      draws.pop();
      retiringDraw = null;
    }
    while (draws.length < count) draws.push(createDraw());
  }
  return { resize, geometryRelease, get pending(): boolean { return retiringDraw !== null; } };
}

/**
 * いま描いているボディが平面の原点(`center`)からどこまで届くか(mm)。包む球
 * (`computeBoundingSphere` で取り直してある)の「原点からいちばん遠い点までの距離」の最大。
 * ボディが 1 つも無ければ 0。断面表示のつまみの四角の大きさに使う。
 */
export function bodyReach(draws: readonly BodyDraw[], center: Vec3): number {
  let reach = 0;
  for (const draw of draws) {
    const sphere = draw.mesh.geometry.boundingSphere;
    if (sphere !== null) {
      // Measured from the handle's own plane origin (double), so far-away bodies and planes
      // keep the size of the shape instead of mixing in their distance from world zero.
      reach = Math.max(reach, Math.hypot(
        (draw.mesh.position.x - center[0]) + sphere.center.x,
        (draw.mesh.position.y - center[1]) + sphere.center.y,
        (draw.mesh.position.z - center[2]) + sphere.center.z,
      ) + sphere.radius);
    }
  }
  return reach;
}

/** ボディ 1 つぶんの形を反映する。前回と同じ並びなら何もしない。 */
function applyGeometry(draw: BodyDraw, entry: SolidDrawEntry): void {
  const origin = entry.coordinateFrame?.origin ?? [0, 0, 0];
  if (
    draw.featureId === entry.featureId &&
    draw.positions === entry.positions &&
    draw.normals === entry.normals &&
    draw.uv === entry.uv &&
    draw.indices === entry.indices &&
    draw.edgePositions === entry.edgePositions &&
    draw.mesh.position.x === origin[0] &&
    draw.mesh.position.y === origin[1] &&
    draw.mesh.position.z === origin[2]
  ) {
    return;
  }
  // Both objects use the same local arrays and double-precision world origin.
  // Three multiplies camera inverse and object world matrix before uploading modelView.
  draw.mesh.position.set(origin[0], origin[1], origin[2]);
  draw.edges.position.set(origin[0], origin[1], origin[2]);
  // 柄(FR-1108)を貼るための箱投影 UV。**同じ並び(同一参照)なら触らない**
  // ので、ホバーや選択が変わっただけの組み立て直しでは GPU へ送り直さない。
  setGeometryAttributes(draw.mesh.geometry, [
    { name: 'position', values: entry.positions },
    { name: 'normal', values: entry.normals },
    { name: 'uv', values: entry.uv, itemSize: 2 },
  ], entry.indices);
  // 位置が変われば包む球も変わるので、視錐台の外と誤判定されないよう作り直す。
  // 当たり判定(Raycaster)もこの球で粗く絞るため、必ず取り直す。
  draw.mesh.geometry.computeBoundingSphere();
  setVectorAttribute(draw.edges.geometry, 'position', entry.edgePositions);
  draw.edges.geometry.computeBoundingSphere();
  draw.featureId = entry.featureId;
  draw.positions = entry.positions;
  draw.normals = entry.normals;
  draw.uv = entry.uv;
  draw.indices = entry.indices;
  draw.edgePositions = entry.edgePositions;
}

/** 1 つの層のボディの部品。返す関数はどれも層の持ち主(`createSolidLayer`)だけが呼ぶ。 */
export function createSolidBodyDraws(options: SolidBodyDrawOptions) {
  const { group, draws, edgeMaterials, materialStore, planFor, getColors } = options;
  const drawRetirement = createSolidDrawRetirement(group, draws);
  /** 当たり判定にかける面。`draws` と同じ順に並ぶ。 */
  const pickTargets: THREE.Object3D[] = [];
  /** 当たった面 → ボディの id。userData は型が any になるので Map で持つ。 */
  const idByObject = new Map<THREE.Object3D, string>();
  /** いま材質へ入れている環境マップ(FR-1107)。鏡・ガラスが無ければ null。 */
  let environment: THREE.Texture | null = null;
  /**
   * 材質を作り直す必要があるか(テーマの色が変わった・環境マップが入れ替わった・点検の色が変わった)。
   * **毎コマは触らない**(常時の描画ループを作らない)。
   */
  let appearanceDirty = true;
  /** いまの表示スタイル。テーマが変わったとき、稜線の色をどちらへ塗るかの判断に使う。 */
  let lastDisplayStyle: DisplayStyle = 'shadedWithEdges';

  function createDraw(): BodyDraw {
    // 材質はまだ決まっていない(最初の反映で外観から作る)。空の配列で始める。
    const mesh: SolidMesh = new THREE.Mesh(new THREE.BufferGeometry(), []);
    mesh.renderOrder = SOLID_RENDER_ORDER;
    const edges: SolidEdges = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      edgeMaterials.none,
    );
    edges.renderOrder = SOLID_EDGE_RENDER_ORDER;
    group.add(mesh);
    group.add(edges);
    return {
      featureId: '',
      positions: null,
      normals: null,
      uv: null,
      indices: null,
      edgePositions: null,
      groups: null,
      appearances: null,
      mesh,
      edges,
    };
  }

  /**
   * ボディ 1 つぶんの外観(まとまりと材質の配列)を反映する(FR-1106)。
   *
   * **前回と同じまとまり・同じ外観で、材質を作り直す理由も無いときは何もしない。**
   * `clearGroups` / `addGroup` と `mesh.material` の入れ替えは、three.js に材質の
   * 束ね直しをさせるので、ホバーが動くたびに行うと 60fps(NFR-PF-1)を脅かす。
   * 点検を出しているあいだは、外観の割り当てを一時的に**差し替える**(上書きではないので、
   * 点検を閉じれば元の外観がそのまま戻る)。
   */
  function applyAppearance(draw: BodyDraw, entry: SolidDrawEntry): void {
    const plan = planFor(entry);
    const groups = plan === null ? entry.groups : plan.groups;
    const appearances = plan === null ? entry.appearances : plan.appearances;
    if (
      !appearanceDirty &&
      sameGroups(draw.groups, groups) &&
      sameAppearances(draw.appearances, appearances)
    ) {
      return;
    }
    const materials = appearances.map((spec) =>
      materialStore.materialFor(themedAppearance(spec, getColors().solid), environment),
    );
    const geometry = draw.mesh.geometry;
    geometry.clearGroups();
    for (const faceGroup of groups) {
      geometry.addGroup(faceGroup.start, faceGroup.count, faceGroup.materialIndex);
    }
    draw.mesh.material = materials;
    draw.groups = groups;
    draw.appearances = appearances;
  }

  /**
   * いま画面に出ている外観で使っていない材質を捨てる。
   * テーマの色を当てた後の外観で数えないと、テーマを切り替えた直後に**使っている材質を
   * 捨ててしまう**ので、`applyAppearance` と同じ `themedAppearance` を通す。点検の間は赤と橙が
   * 「使っている材質」なので、同じ選び方で数える(外観のほうだけを数えると、いま画面に出ている
   * 赤・橙をその場で捨ててしまう)。
   */
  function collectMaterials(entries: readonly SolidDrawEntry[]): void {
    const used: AppearanceSpec[] = [];
    for (const entry of entries) {
      const plan = planFor(entry);
      for (const spec of plan === null ? entry.appearances : plan.appearances) {
        used.push(themedAppearance(spec, getColors().solid));
      }
    }
    materialStore.collect(used);
  }

  /** 現在の BodyDraw から pick の的と ID を同時に作り直す。旧IDを残さない。 */
  function rebuildPickTargets(entries: readonly SolidDrawEntry[]): void {
    pickTargets.length = 0;
    idByObject.clear();
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.featureId, (counts.get(entry.featureId) ?? 0) + 1);
    for (let position = 0; position < entries.length; position += 1) {
      const draw = draws[position];
      const entry = entries[position];
      applyGeometry(draw, entry);
      applyAppearance(draw, entry);
      if (counts.get(entry.featureId) === 1) {
        pickTargets.push(draw.mesh);
        idByObject.set(draw.mesh, entry.featureId);
      }
    }
    // A pointer may arrive before the renderer's next frame. Raycaster needs the
    // translated mesh matrix immediately, including after a same-array frame change.
    group.updateMatrixWorld(true);
  }

  /** 光線に当たった的を、近い順に ID の分かるものから返す。 */
  function firstHit<T>(raycaster: THREE.Raycaster, pick: (featureId: string, hit: THREE.Intersection) => T | null): T | null {
    const hits = raycaster.intersectObjects(pickTargets, false);
    for (const hit of hits) {
      const featureId = idByObject.get(hit.object);
      if (featureId === undefined) continue;
      const picked = pick(featureId, hit);
      if (picked !== null) return picked;
    }
    return null;
  }

  return {
    get pending(): boolean { return drawRetirement.pending; },
    get appearanceDirty(): boolean { return appearanceDirty; },
    geometryRelease: drawRetirement.geometryRelease,
    /** 環境マップ(FR-1107)を差し替える。入れ替わったら材質を作り直す。 */
    setEnvironment(next: THREE.Texture | null): void {
      if (next !== environment) {
        environment = next;
        appearanceDirty = true;
      }
    },
    /** 材質の割り当てが変わる(点検の色を出す・消す)。次の反映で作り直す。 */
    markAppearanceDirty(): void { appearanceDirty = true; },
    /** 部品の数をボディの数に合わせ、形と外観を流し込み、使わない材質を捨てる。 */
    sync(entries: readonly SolidDrawEntry[]): void {
      drawRetirement.resize(entries.length, createDraw);
      rebuildPickTargets(entries);
      collectMaterials(entries);
      appearanceDirty = false;
    },
    /**
     * 表示スタイルと強調を材質へ写す(FR-105、FR-106)。
     *
     * シェーディング = 面のみ / シェーディング+エッジ = 面と稜線 / ワイヤーフレーム = 稜線のみ。
     * ただし**ホバー中・選択中のボディの稜線は、面のみの表示でも出す**。稜線でしか強調を
     * 示さない決まり(「面の色は変えない」)なので、面のみの表示で稜線を全部消すと
     * 何を選んでいるのか分からなくなるため(NFR-UX-7)。
     */
    applyStyle(entries: readonly SolidDrawEntry[], displayStyle: DisplayStyle): void {
      lastDisplayStyle = displayStyle;
      const colors = getColors();
      const showFaces = displayStyle !== 'wireframe';
      const showEdges = displayStyle !== 'shaded';
      edgeMaterials.none.color.setHex(
        displayStyle === 'wireframe' ? colors.solidEdgeWireframe : colors.solidEdgeOverSolid,
      );
      for (let position = 0; position < entries.length; position += 1) {
        const draw = draws[position];
        const entry = entries[position];
        draw.mesh.visible = showFaces && entry.triangleCount > 0;
        draw.edges.visible =
          (showEdges || entry.emphasis !== 'none') && entry.edgeCount > 0;
        draw.edges.material = edgeMaterials[entry.emphasis];
      }
    },
    /**
     * テーマの色(FR-908)。稜線の材質は色だけを塗り替える。面の材質は材質の入れ物が鍵で使い回すので、
     * 色を直に書き換えると鍵と中身が食い違う。次の反映で作り直す。
     */
    applyTheme(colors: ThemeColors): void {
      appearanceDirty = true;
      edgeMaterials.none.color.setHex(
        lastDisplayStyle === 'wireframe' ? colors.solidEdgeWireframe : colors.solidEdgeOverSolid,
      );
      edgeMaterials.hovered.color.setHex(colors.hovered);
      edgeMaterials.selected.color.setHex(colors.selected);
    },
    /**
     * 光線に当たったボディの featureId(FR-106)。近い順に並ぶので先頭が手前のボディ。表示スタイルで
     * 面を隠していても当たる(three.js の Raycaster は visible を見ない)ため、ワイヤーフレーム表示でも選べる。
     */
    pickBody(raycaster: THREE.Raycaster): string | null {
      return firstHit(raycaster, (featureId) => featureId);
    },
    /** 光線に当たった面。faceIndex は three.js が「当たった三角形の通し番号」として添える。 */
    pickFace(raycaster: THREE.Raycaster): { readonly featureId: string; readonly triangleIndex: number } | null {
      return firstHit(raycaster, (featureId, hit) =>
        typeof hit.faceIndex === 'number' ? { featureId, triangleIndex: hit.faceIndex } : null);
    },
    /** ボディの面と稜線の属性と索引のバイト数(1 属性 = GPU の入れ物 1 つ)。 */
    meshBytes(): number {
      let bytes = 0;
      for (const draw of draws) {
        bytes += geometryAttributeBytes(draw.mesh.geometry) + geometryAttributeBytes(draw.edges.geometry);
      }
      return bytes;
    },
    /** 破棄の始まりに、当たり判定の的を空にする(破棄の後に古い ID を返さない)。 */
    clearPickTargets(): void {
      pickTargets.length = 0;
      idByObject.clear();
    },
    /** 破棄の終わりに、部品と控えを空にする。 */
    reset(): void {
      draws.length = 0;
      environment = null;
      appearanceDirty = true;
    },
  };
}
