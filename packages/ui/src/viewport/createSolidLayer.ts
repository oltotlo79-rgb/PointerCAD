/**
 * ソリッド(立体)の表示層(計画書 docs/plans/P2-ソリッド基礎.md タスク20 手順3)。
 *
 * 対応要件: FR-105(表示スタイル)、FR-106(ホバー・選択・当たり判定)、NFR-PF-1(60fps)。
 *
 * `buildSolidGeometry` が組み立てた並びを three.js の部品へ流し込む。**毎フレーム
 * 作り直さない**。同じ組み立て結果を渡し直したときは何もせず、ボディの並びが同じ
 * (同じ Float32Array)なら入れ物も触らない。個数が同じで中身だけ変わったときは
 * 並びの中身を書き写す。常時の描画ループはここにも作らない
 * (docs/報告記録.md 2026-09-02 15:42)。
 *
 * 色は画面の配色(packages/ui/src/shell/appShell.css の --pcad-* トークン)と同じ値を
 * 16 進の定数として持つ。CSS 変数は three.js から読めないため。
 */

import { addVec3, crossVec3, normalizeVec3, scaleVec3, type Vec3 } from '@pointercad/model';
import * as THREE from 'three';

import type { DisplayStyle } from '../store/useAppStore.js';
import type { SolidDrawEntry, SolidEmphasis, SolidGeometryBundle } from './buildSolidGeometry.js';
import type { SubShapeEmphasis, SubShapeHighlight, SubShapeHighlightBundle } from './buildSubShapeGeometry.js';

/**
 * 立体の色味。艶を抑えた樹脂のような明るい灰にして、面の向きの差を読み取りやすくする。
 * P2 のボディは既定の 1 色(§0.a-0.21)。面ごと・ボディごとの色指定は P3 の「外観」で足す。
 */
const SOLID_COLOR = 0xb8bfcc;
const SOLID_ROUGHNESS = 0.55;
const SOLID_METALNESS = 0.05;

/** 面の上に重ねる稜線は暗く、稜線だけのときは背景から浮くよう明るくする(FR-105)。 */
const EDGE_COLOR_OVER_SOLID = 0x0f1115;
const EDGE_COLOR_WIREFRAME = 0xd6dae2;

/**
 * ホバーと選択の色(§0.a-0.23-⑩)。以前は --pcad-accent(0x4f8cff)と --pcad-accent-hover
 * (0x6b9eff)の色差だけで示していたが、実機の目視で見分けにくいと分かった
 * (`docs/報告記録.md` 2026-09-03 20:40 の②)。ホバーを明るい水色 `0x8ec5ff` にして
 * 明度差を広げる(選択は --pcad-accent の `0x4f8cff` のまま据え置く)。
 *
 * 選択の色を濃い青 `0x2f6fe0` へ変える案は、背景 --pcad-surface(#1e2128)に対する
 * コントラストが約 3.43:1 となり、既存の `0x4f8cff`(約 5.02:1)を下回って基準の 4.5:1 も
 * 割るため統括の判断で不採用にした(2026-09-03)。ホバー `0x8ec5ff` は約 8.88:1 で基準を
 * 満たす。ホバーと選択は同系色+明度差、加えて選択した辺の端点表示(§0.a-0.23-⑩)で見分ける。
 * **`createSketchLayer.ts` の同名の定数も同じ値に揃える**
 * (スケッチと立体で強調の色が違うと、同じ「選んでいる」が 2 通りに見えるため)。
 */
const SELECTED_COLOR = 0x4f8cff;
const HOVERED_COLOR = 0x8ec5ff;

/**
 * 描く順。スケッチの作図面 -1 → 面 0 → **立体 1** → 面の縁 2 → 線 3 → 点 4 の間に入れる。
 *
 * 立体の面と稜線は不透明なので、three.js は半透明のもの(方眼・作図面・スケッチの面・
 * 線・点)より**先に**描く。そのうえでスケッチの線と点は `depthTest: false` なので、
 * 立体の奥にあっても隠れずに前面へ出る(docs/報告記録.md 2026-09-03 00:06 の (b))。
 * renderOrder は不透明どうしの順序を決めるだけだが、層の前後関係を 1 箇所で
 * 読み取れるようにスケッチと同じ数直線の上へ置いておく。
 */
const SOLID_RENDER_ORDER = 1;

/** 部分形状の強調(重ね描き)の面の不透明度(§0.a-0.7)。 */
const SUB_SHAPE_FACE_OPACITY = 0.35;
/** 部分形状の面の強調は、立体の面(SOLID_RENDER_ORDER)のすぐ後ろに描く。 */
const SUB_SHAPE_FACE_RENDER_ORDER = SOLID_RENDER_ORDER + 0.5;
/**
 * 部分形状の辺・頂点の強調は、スケッチの面の縁(`createSketchLayer.ts` の
 * `FACE_OUTLINE_RENDER_ORDER`)と同じ層に置く。裏側の辺・頂点も選べる(§0.a-0.27)ので、
 * `depthTest: false` にして立体の奥にあっても隠れないようにする。
 */
const SUB_SHAPE_LINE_RENDER_ORDER = 2;
/** 部分形状の頂点の点の大きさ(px)。画面上の大きさを一定にする。 */
const SUB_SHAPE_POINT_SIZE = 8;

/**
 * ねじの簡略表示の印(§0.a-0.15、計画書タスク23)。B-rep には現れない、描画だけのための情報。
 *
 * **置き場について:** 本来は kernel の `ThreadMarkInfo`(`SolidBodyMesh.threadMarks`)が
 * model の `SolidBody` に添って届くが、それはタスク17(橋渡しの拡張)で、このタスクの
 * 着手時点ではまだ届いていない。`ui` は `kernel` へ直接依存できない
 * (`apps → ui → model → kernel/expression` の一方向、rules/04-設計の規律.md)ので、
 * 欄の形だけをここに書く。タスク17 が model からこの形の値を返すようになったら、
 * この定義は import に差し替えてよい(`buildSolidGeometry.ts` の `SolidBodyWithSubShapes`
 * と同じ橋渡しの考え方)。
 */
export interface ThreadMarkInfo {
  /** ねじ部の始まり(mm)。 */
  readonly origin: Vec3;
  /** 軸の向き。長さ 0(退化)の印は描かない。 */
  readonly direction: Vec3;
  /** 外径 d(mm)。円の半径は d/2。 */
  readonly majorDiameter: number;
  /** ねじ部の長さ(mm)。 */
  readonly length: number;
}

/** ねじの印の線の色(細実線。JIS の簡略図示に倣う)。 */
const THREAD_MARK_COLOR = 0x8a93a6;
/** ねじの印を描く円の分割数。 */
const THREAD_MARK_SEGMENTS = 48;

/** 円の基底(u・v)を作るための参照軸。direction とほぼ平行にならないものを選ぶ。 */
function referenceAxis(direction: Vec3): Vec3 {
  return Math.abs(direction[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
}

/** ベクトルが実質ゼロ(退化)かどうか。normalizeVec3 は長さ 0 を原点のまま返す約束。 */
function isZeroVec3(v: Vec3): boolean {
  return v[0] === 0 && v[1] === 0 && v[2] === 0;
}

/** 円 1 つぶんの線分(THREAD_MARK_SEGMENTS 分割の折れ線)を position の配列へ積む。 */
function pushThreadMarkCircle(
  positions: number[],
  center: Vec3,
  u: Vec3,
  v: Vec3,
  radius: number,
): void {
  const points: Vec3[] = [];
  for (let step = 0; step < THREAD_MARK_SEGMENTS; step += 1) {
    const angle = (step / THREAD_MARK_SEGMENTS) * Math.PI * 2;
    const point = addVec3(
      center,
      addVec3(scaleVec3(u, Math.cos(angle) * radius), scaleVec3(v, Math.sin(angle) * radius)),
    );
    points.push(point);
  }
  for (let step = 0; step < THREAD_MARK_SEGMENTS; step += 1) {
    const from = points[step];
    const to = points[(step + 1) % THREAD_MARK_SEGMENTS];
    positions.push(from[0], from[1], from[2], to[0], to[1], to[2]);
  }
}

/**
 * ねじの簡略表示の印(§0.a-0.15)を線分列へ組み立てる。three.js に触れない純関数
 * (Node で検査できる)。各印について、外径 d の円をねじ部の始め(origin)と終わり
 * (origin + direction×length)に 1 つずつ、軸線を 1 本描く。
 *
 * 方向が退化している(長さ 0、または円の基底が作れない)印は黙って飛ばす
 * (`buildSubShapeGeometry.ts` の「範囲が外れていても黙って飛ばす」と同じ考え方)。
 */
export function buildThreadMarkPositions(marks: readonly ThreadMarkInfo[]): Float32Array {
  const positions: number[] = [];
  for (const mark of marks) {
    const direction = normalizeVec3(mark.direction);
    if (isZeroVec3(direction)) {
      continue;
    }
    const u = normalizeVec3(crossVec3(referenceAxis(direction), direction));
    if (isZeroVec3(u)) {
      continue;
    }
    const v = crossVec3(direction, u);
    const radius = mark.majorDiameter / 2;
    const end = addVec3(mark.origin, scaleVec3(direction, mark.length));
    pushThreadMarkCircle(positions, mark.origin, u, v, radius);
    pushThreadMarkCircle(positions, end, u, v, radius);
    positions.push(mark.origin[0], mark.origin[1], mark.origin[2], end[0], end[1], end[2]);
  }
  return Float32Array.from(positions);
}

type SolidMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
type SolidEdges = THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;

/** ボディ 1 つぶんの部品。並びは前回と同じかどうかを参照で見分けられるよう控えておく。 */
interface BodyDraw {
  featureId: string;
  positions: Float32Array | null;
  indices: Uint32Array | null;
  edgePositions: Float32Array | null;
  readonly mesh: SolidMesh;
  readonly edges: SolidEdges;
}

export interface SolidLayer {
  /** シーンへ足す入れ物。 */
  readonly group: THREE.Group;
  /**
   * 描画データと表示スタイルを反映する。
   * 同じ組み立て結果(同一オブジェクト)を渡し直したときは並びを触らない。
   */
  update(bundle: SolidGeometryBundle, displayStyle: DisplayStyle): void;
  /**
   * 部分形状(面・辺・頂点)のホバー・選択の強調を差し替える(§0.a-0.7)。
   * `update` と同じく、同じ組み立て結果を渡し直したときは並びを触らない。
   */
  updateSubShapes(bundle: SubShapeHighlightBundle): void;
  /**
   * ねじの簡略表示の印を差し替える(§0.a-0.15)。全ボディぶんをまとめた 1 本の配列で渡す
   * (`createViewportScene.ts` がボディの一覧から集める)。同じ配列(同一参照)を渡し直したときは
   * 並びを触らない。
   */
  updateThreadMarks(marks: readonly ThreadMarkInfo[]): void;
  /** 光線に当たったボディの featureId。当たらなければ null(FR-106)。 */
  pickBody(raycaster: THREE.Raycaster): string | null;
  /**
   * 光線に当たった面。当たったボディの featureId と、その三角形の通し番号を返す
   * (面の通し番号への変換は `createViewportScene.ts` の `pickFaceAt` が行う、FR-106)。
   */
  pickFace(raycaster: THREE.Raycaster): { readonly featureId: string; readonly triangleIndex: number } | null;
  dispose(): void;
}

/**
 * 並びを差し替える。**同じ並び(同じ入れ物)なら何もせず**、個数が同じなら書き写すだけに
 * して毎回の作り直しを避ける(NFR-PF-1)。個数が変わったときだけ新しい入れ物を作る。
 */
function setVectorAttribute(
  geometry: THREE.BufferGeometry,
  name: string,
  values: Float32Array,
): void {
  const existing = geometry.getAttribute(name);
  if (existing instanceof THREE.BufferAttribute && existing.array instanceof Float32Array) {
    if (existing.array === values) {
      return;
    }
    if (existing.array.length === values.length) {
      existing.array.set(values);
      existing.needsUpdate = true;
      return;
    }
  }
  geometry.setAttribute(name, new THREE.BufferAttribute(values, 3));
}

/** 三角形の頂点番号を差し替える。考え方は `setVectorAttribute` と同じ。 */
function setIndices(geometry: THREE.BufferGeometry, values: Uint32Array): void {
  const existing = geometry.getIndex();
  if (existing !== null && existing.array instanceof Uint32Array) {
    if (existing.array === values) {
      return;
    }
    if (existing.array.length === values.length) {
      existing.array.set(values);
      existing.needsUpdate = true;
      return;
    }
  }
  geometry.setIndex(new THREE.BufferAttribute(values, 1));
}

const SUB_SHAPE_EMPHASES: readonly SubShapeEmphasis[] = ['hovered', 'selected'];

type SubShapeFaceMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
type SubShapeLines = THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
type SubShapePoints = THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;

/** 部分形状 1 強調度(ホバー or 選択)ぶんの重ね描き 3 本(§0.a-0.7)。 */
interface SubShapeOverlay {
  readonly faces: SubShapeFaceMesh;
  readonly edges: SubShapeLines;
  readonly vertices: SubShapePoints;
}

/**
 * 部分形状の重ね描き 3 本を 1 色ぶん作る。面は半透明のメッシュ、辺・頂点は
 * `depthTest: false`(裏側も見える、§0.a-0.27)。renderOrder は面が立体の面の直後、
 * 辺・頂点はスケッチの面の縁と同じ層(`createSketchLayer.ts` の `FACE_OUTLINE_RENDER_ORDER`)。
 */
function createSubShapeOverlay(color: number): SubShapeOverlay {
  const faces: SubShapeFaceMesh = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: SUB_SHAPE_FACE_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
      // 元の面とほぼ同じ位置に重なるので、z 争いを避けて必ず手前に出す
      // (立体側の polygonOffsetFactor/Units は +1 で奥へ押すので、符号を反対にする)。
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );
  faces.renderOrder = SUB_SHAPE_FACE_RENDER_ORDER;
  faces.visible = false;

  const edges: SubShapeLines = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  );
  edges.renderOrder = SUB_SHAPE_LINE_RENDER_ORDER;
  edges.visible = false;

  const vertices: SubShapePoints = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({
      color,
      size: SUB_SHAPE_POINT_SIZE,
      sizeAttenuation: false,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  );
  vertices.renderOrder = SUB_SHAPE_LINE_RENDER_ORDER;
  vertices.visible = false;

  return { faces, edges, vertices };
}

/** 部分形状の重ね描き 1 組へ、組み立て済みの並びを流し込む。 */
function applySubShapeOverlay(overlay: SubShapeOverlay, highlight: SubShapeHighlight): void {
  setVectorAttribute(overlay.faces.geometry, 'position', highlight.facePositions);
  setVectorAttribute(overlay.faces.geometry, 'normal', highlight.faceNormals);
  setIndices(overlay.faces.geometry, highlight.faceIndices);
  overlay.faces.geometry.computeBoundingSphere();
  overlay.faces.visible = highlight.facePositions.length > 0;

  setVectorAttribute(overlay.edges.geometry, 'position', highlight.edgePositions);
  overlay.edges.geometry.computeBoundingSphere();
  overlay.edges.visible = highlight.edgePositions.length > 0;

  setVectorAttribute(overlay.vertices.geometry, 'position', highlight.vertexPositions);
  overlay.vertices.geometry.computeBoundingSphere();
  overlay.vertices.visible = highlight.vertexPositions.length > 0;
}

function disposeSubShapeOverlay(overlay: SubShapeOverlay): void {
  overlay.faces.geometry.dispose();
  overlay.faces.material.dispose();
  overlay.edges.geometry.dispose();
  overlay.edges.material.dispose();
  overlay.vertices.geometry.dispose();
  overlay.vertices.material.dispose();
}

export function createSolidLayer(): SolidLayer {
  const group = new THREE.Group();

  /**
   * 面の材質は全ボディで 1 つを共有する(P2 のボディは同じ色、§0.a-0.21)。
   * 面と稜線を同時に出すとき、稜線が面に埋もれてちらつくのを防ぐ(FR-105)。
   *
   * **外観(FR-1106〜1110、P5)への準備(§7)。** 面ごとに色・柄を分けるときは、ここを
   * `material` の配列にし、`BufferGeometry.addGroup(start, count, materialIndex)` を
   * `SolidFaceEntry.triangleOffset` / `triangleCount` から作る形に差し替える(実装はしない)。
   */
  const faceMaterial = new THREE.MeshStandardMaterial({
    color: SOLID_COLOR,
    roughness: SOLID_ROUGHNESS,
    metalness: SOLID_METALNESS,
    // 閉じた立体なので裏面は見えない。両面を描くと稜線の裏側が透けて見えて重くなる。
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  /**
   * 稜線の材質は強調の度合いごとに 1 つずつ。ボディごとには作らず、
   * どれを使うかだけを切り替える(ボディが増えても材質は 3 つのまま)。
   * `none` の色だけは表示スタイルで変わる(面の上か、稜線だけか)。
   */
  const edgeMaterials: Readonly<Record<SolidEmphasis, THREE.LineBasicMaterial>> = {
    none: new THREE.LineBasicMaterial({ color: EDGE_COLOR_OVER_SOLID }),
    hovered: new THREE.LineBasicMaterial({ color: HOVERED_COLOR }),
    selected: new THREE.LineBasicMaterial({ color: SELECTED_COLOR }),
  };

  const subShapeColors: Readonly<Record<SubShapeEmphasis, number>> = {
    hovered: HOVERED_COLOR,
    selected: SELECTED_COLOR,
  };

  /**
   * 部分形状(面・辺・頂点)の重ね描き(§0.a-0.7)。ホバー用・選択用の 2 組だけを作り、
   * ボディごとには増やさない(全ボディの強調中の要素を 1 本のバッファへまとめる)。
   */
  const subShapeOverlays: Readonly<Record<SubShapeEmphasis, SubShapeOverlay>> = {
    hovered: createSubShapeOverlay(subShapeColors.hovered),
    selected: createSubShapeOverlay(subShapeColors.selected),
  };
  for (const emphasis of SUB_SHAPE_EMPHASES) {
    const overlay = subShapeOverlays[emphasis];
    group.add(overlay.faces);
    group.add(overlay.edges);
    group.add(overlay.vertices);
  }
  let lastSubShapeBundle: SubShapeHighlightBundle | null = null;

  /**
   * ねじの簡略表示の印(§0.a-0.15)。全ボディぶんを 1 本の `LineSegments` にまとめる
   * (部分形状の重ね描きと同じ考え方)。**renderOrder は面の縁と同じ 2**
   * (`SUB_SHAPE_LINE_RENDER_ORDER`)。裏側(手前の面に隠れた側)の印も見えるよう
   * `depthTest: false` にする(部分形状のオーバーレイと同じ扱い。JIS の簡略図示は
   * 隠れ線かどうかを描き分けないため)。薄い線に見せるため不透明度を下げる。
   */
  const threadMarkLines = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      color: THREAD_MARK_COLOR,
      transparent: true,
      opacity: 0.75,
      depthTest: false,
      depthWrite: false,
    }),
  );
  threadMarkLines.renderOrder = SUB_SHAPE_LINE_RENDER_ORDER;
  threadMarkLines.visible = false;
  group.add(threadMarkLines);
  let lastThreadMarks: readonly ThreadMarkInfo[] | null = null;

  const draws: BodyDraw[] = [];
  /** 当たり判定にかける面。`draws` と同じ順に並ぶ。 */
  const pickTargets: THREE.Object3D[] = [];
  /** 当たった面 → ボディの id。userData は型が any になるので Map で持つ。 */
  const idByObject = new Map<THREE.Object3D, string>();

  let lastBundle: SolidGeometryBundle | null = null;

  function createDraw(): BodyDraw {
    const mesh: SolidMesh = new THREE.Mesh(new THREE.BufferGeometry(), faceMaterial);
    mesh.renderOrder = SOLID_RENDER_ORDER;
    const edges: SolidEdges = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      edgeMaterials.none,
    );
    edges.renderOrder = SOLID_RENDER_ORDER;
    group.add(mesh);
    group.add(edges);
    return {
      featureId: '',
      positions: null,
      indices: null,
      edgePositions: null,
      mesh,
      edges,
    };
  }

  function disposeDraw(draw: BodyDraw): void {
    group.remove(draw.mesh);
    group.remove(draw.edges);
    draw.mesh.geometry.dispose();
    draw.edges.geometry.dispose();
  }

  /** ボディ 1 つぶんの形を反映する。前回と同じ並びなら何もしない。 */
  function applyGeometry(draw: BodyDraw, entry: SolidDrawEntry): void {
    if (
      draw.featureId === entry.featureId &&
      draw.positions === entry.positions &&
      draw.indices === entry.indices &&
      draw.edgePositions === entry.edgePositions
    ) {
      return;
    }
    setVectorAttribute(draw.mesh.geometry, 'position', entry.positions);
    setVectorAttribute(draw.mesh.geometry, 'normal', entry.normals);
    setIndices(draw.mesh.geometry, entry.indices);
    // 位置が変われば包む球も変わるので、視錐台の外と誤判定されないよう作り直す。
    // 当たり判定(Raycaster)もこの球で粗く絞るため、必ず取り直す。
    draw.mesh.geometry.computeBoundingSphere();
    setVectorAttribute(draw.edges.geometry, 'position', entry.edgePositions);
    draw.edges.geometry.computeBoundingSphere();
    draw.featureId = entry.featureId;
    draw.positions = entry.positions;
    draw.indices = entry.indices;
    draw.edgePositions = entry.edgePositions;
  }

  /** 部品の数をボディの数に合わせ、形を流し込む。 */
  function syncDraws(entries: readonly SolidDrawEntry[]): void {
    while (draws.length > entries.length) {
      const draw = draws.pop();
      if (draw !== undefined) {
        disposeDraw(draw);
      }
    }
    while (draws.length < entries.length) {
      draws.push(createDraw());
    }
    pickTargets.length = 0;
    idByObject.clear();
    for (let position = 0; position < entries.length; position += 1) {
      const draw = draws[position];
      const entry = entries[position];
      applyGeometry(draw, entry);
      pickTargets.push(draw.mesh);
      idByObject.set(draw.mesh, entry.featureId);
    }
  }

  /**
   * 表示スタイルと強調を材質へ写す(FR-105、FR-106)。
   *
   * シェーディング = 面のみ / シェーディング+エッジ = 面と稜線 / ワイヤーフレーム = 稜線のみ。
   * ただし**ホバー中・選択中のボディの稜線は、面のみの表示でも出す**。稜線でしか強調を
   * 示さない決まり(§0.a-0.21「面の色は変えない」)なので、面のみの表示で稜線を全部消すと
   * 何を選んでいるのか分からなくなるため(NFR-UX-7)。
   */
  function applyStyle(entries: readonly SolidDrawEntry[], displayStyle: DisplayStyle): void {
    const showFaces = displayStyle !== 'wireframe';
    const showEdges = displayStyle !== 'shaded';
    edgeMaterials.none.color.setHex(
      displayStyle === 'wireframe' ? EDGE_COLOR_WIREFRAME : EDGE_COLOR_OVER_SOLID,
    );
    for (let position = 0; position < entries.length; position += 1) {
      const draw = draws[position];
      const entry = entries[position];
      draw.mesh.visible = showFaces && entry.triangleCount > 0;
      draw.edges.visible =
        (showEdges || entry.emphasis !== 'none') && entry.edgeCount > 0;
      draw.edges.material = edgeMaterials[entry.emphasis];
    }
  }

  return {
    group,

    update(bundle, displayStyle): void {
      if (bundle !== lastBundle) {
        lastBundle = bundle;
        syncDraws(bundle.entries);
      }
      applyStyle(bundle.entries, displayStyle);
    },

    updateSubShapes(bundle): void {
      if (bundle === lastSubShapeBundle) {
        return;
      }
      lastSubShapeBundle = bundle;
      applySubShapeOverlay(subShapeOverlays.hovered, bundle.hovered);
      applySubShapeOverlay(subShapeOverlays.selected, bundle.selected);
    },

    updateThreadMarks(marks): void {
      if (marks === lastThreadMarks) {
        return;
      }
      lastThreadMarks = marks;
      const positions = buildThreadMarkPositions(marks);
      setVectorAttribute(threadMarkLines.geometry, 'position', positions);
      threadMarkLines.geometry.computeBoundingSphere();
      threadMarkLines.visible = positions.length > 0;
    },

    pickFace(raycaster): { readonly featureId: string; readonly triangleIndex: number } | null {
      // pickBody と同じ的(ボディの面メッシュ)を使う。faceIndex は three.js が
      // 「当たった三角形の通し番号」として Intersection に添えてくれる。
      const hits = raycaster.intersectObjects(pickTargets, false);
      for (const hit of hits) {
        const featureId = idByObject.get(hit.object);
        if (featureId !== undefined && typeof hit.faceIndex === 'number') {
          return { featureId, triangleIndex: hit.faceIndex };
        }
      }
      return null;
    },

    pickBody(raycaster): string | null {
      // 近い順に並ぶので先頭が手前のボディ。表示スタイルで面を隠していても当たる
      // (three.js の Raycaster は visible を見ない)ため、ワイヤーフレーム表示でも選べる。
      const hits = raycaster.intersectObjects(pickTargets, false);
      for (const hit of hits) {
        const featureId = idByObject.get(hit.object);
        if (featureId !== undefined) {
          return featureId;
        }
      }
      return null;
    },

    dispose(): void {
      for (const draw of draws) {
        disposeDraw(draw);
      }
      draws.length = 0;
      pickTargets.length = 0;
      idByObject.clear();
      faceMaterial.dispose();
      edgeMaterials.none.dispose();
      edgeMaterials.hovered.dispose();
      edgeMaterials.selected.dispose();
      for (const emphasis of SUB_SHAPE_EMPHASES) {
        disposeSubShapeOverlay(subShapeOverlays[emphasis]);
      }
      threadMarkLines.geometry.dispose();
      threadMarkLines.material.dispose();
      lastBundle = null;
      lastSubShapeBundle = null;
      lastThreadMarks = null;
    },
  };
}
