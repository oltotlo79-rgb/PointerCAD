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
 * 色は画面の配色(packages/ui/src/shell/appShell.css の --pcad-* トークン)から
 * `themeColors.ts` が読み取って渡す(three.js は CSS 変数を直接読めないため)。
 * テーマを変えたときは `setThemeColors` で材質の色だけを塗り替え、**部品は作り直さない**
 * (FR-908 の即時反映、NFR-PF-1)。
 *
 * P5 タスク10(計画書 docs/plans/P5-高度なソリッド・外観と測定.md §2.5、§2.6)で
 * **面ごと・立体ごとの外観(FR-1106〜1109)** を足した。要点は 3 つ。
 *
 * 1. 面の材質は**ボディごとの配列**になった。まとまり(`geometry.addGroup`)を作るのは
 *    純関数 `appearance/buildFaceGroups.ts`(タスク7)で、ここはその結果を流し込むだけ。
 *    **外観を 1 つも割り当てていない立体は長さ 1 の配列・まとまり 1 つ**なので、
 *    ドローコールも絵も P2〜P4 と変わらない(§0.a-0.12)。
 * 2. 材質は見え方が同じなら使い回し、使われなくなったら捨てる
 *    (`appearance/createAppearanceMaterial.ts`、タスク9)。**毎コマは作り直さない。**
 * 3. 映り込み(鏡・ガラス、FR-1107)の環境マップは外から渡される。作る・捨てるの判断は
 *    レンダラとシーンを持つ `createViewportScene.ts` が行う(§0.a-0.9)。
 */

import {
  addVec3,
  crossVec3,
  DEFAULT_APPEARANCE,
  normalizeVec3,
  scaleVec3,
  type AppearanceSpec,
  type Vec3,
} from '@pointercad/model';
import * as THREE from 'three';

import { appearanceKeyText, type FaceGroup } from '../appearance/buildFaceGroups.js';
import {
  createAppearanceMaterialStore,
  type PatternTextureSource,
} from '../appearance/createAppearanceMaterial.js';
import type { DisplayStyle } from '../store/useAppStore.js';
import type {
  SolidDrawEntry,
  SolidEmphasis,
  SolidGeometryBundle,
} from './buildSolidGeometry.js';
import type { SubShapeEmphasis, SubShapeHighlight, SubShapeHighlightBundle } from './buildSubShapeGeometry.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';

/*
 * 立体の艶(艶を抑えた樹脂のように見せて、面の向きの差を読み取りやすくする)は、P5 から
 * 外観の既定値(`model` の `DEFAULT_APPEARANCE`: 光沢 5・粗さ 55)が正本になった。
 * 色そのもの(--pcad-solid)は引き続きテーマが決める(下の `themedAppearance`)。
 */

/*
 * 稜線は、面の上に重ねるときは暗く、稜線だけのときは地から浮くよう明るくする(FR-105)。
 * 明るいテーマではどちらも暗い側へ寄せる(値は appShell.css のテーマごとの塊)。
 *
 * ホバーと選択の色の決め方は `createSketchLayer.ts` の注釈にまとめてある。
 * **同じトークン(--pcad-emphasis-hovered / --pcad-emphasis-selected)を使う**ので、
 * スケッチと立体で「選んでいる」の見え方が 2 通りに割れることはない。
 */

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

/**
 * 稜線は**面より後に**描く(FR-105)。
 *
 * 面は `polygonOffset` で少しだけ奥へ押してあり、稜線はその上に重なる。重なる画素の色は
 * 描いた順で決まる(縁のなめらか化が後から描いたほうを勝たせる)ので、順序を材質の
 * 作られた順に任せてはいけない。three.js の不透明の並べ替えは renderOrder → 材質の通し番号
 * (作った順)の順に見るため、P2〜P4 は「面の材質を稜線より先に作っていた」ことで
 * たまたま面が先に描かれていた。P5 で面の材質を外観から**後から**作るようにしたので、
 * このままでは順序が逆転して縁の画素の色が変わる(2026-09-05 実測: 800×600 の絵で 122 画素、
 * 最大の階調差 41)。**順序をここで明示して、P4 と同じ絵を保つ**(§0.a-0.12)。
 */
const SOLID_EDGE_RENDER_ORDER = SOLID_RENDER_ORDER + 0.25;

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

/** ねじの印を描く円の分割数(線の色は --pcad-thread-mark。細実線、JIS の簡略図示に倣う)。 */
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

/*
 * 外観の割り当て(文書の表)から組み立てへ渡す一式を作る `buildAppearanceInput` は、
 * three.js に触れない純関数であり、上限の先出し検査(コマンド側)からも同じものを使うため、
 * P5 タスク11 で `appearance/appearanceCommands.ts` へ移した。ここは import して使うだけにする
 * (同じ組み立てを 2 か所に持たない)。
 */

/** 既定の外観の鍵。テーマの色を当てる相手かどうかの判定に使う(下の `themedAppearance`)。 */
const DEFAULT_APPEARANCE_KEY = appearanceKeyText(DEFAULT_APPEARANCE);

/** 0xrrggbb を `#rrggbb` の文字にする(外観の色は文字で持つため)。 */
function hexColorText(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

/**
 * 既定の外観の色だけを、いまのテーマの立体の色(`--pcad-solid`)へ差し替える(FR-908)。
 *
 * 外観を割り当てていない立体の色はテーマが決める(P2 からの決まり)ので、材質を作る前に
 * ここで色を差し替える。**割り当てのある外観は 1 つも触らない**(利用者が選んだ色を
 * テーマで塗り替えない)。判定は鍵(見え方)で行うので、プリセット「既定」を明示的に
 * 割り当てた面も同じ扱いになる(見え方が同じものを 2 通りに描かない)。
 */
function themedAppearance(spec: AppearanceSpec, solidColor: number): AppearanceSpec {
  if (appearanceKeyText(spec) !== DEFAULT_APPEARANCE_KEY) {
    return spec;
  }
  const color = hexColorText(solidColor);
  return color === spec.color ? spec : { ...spec, color };
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

/**
 * 面の材質は**ボディごとの配列**(FR-1106)。まとまり(`geometry.addGroup`)の
 * `materialIndex` がこの配列を指す。外観を 1 つも割り当てていない立体は長さ 1 の配列に
 * なり、P2 と同じ 1 ドローコールで描かれる(§0.a-0.12)。
 */
type SolidMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial[]>;
type SolidEdges = THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;

/** ボディ 1 つぶんの部品。並びは前回と同じかどうかを参照で見分けられるよう控えておく。 */
interface BodyDraw {
  featureId: string;
  positions: Float32Array | null;
  indices: Uint32Array | null;
  edgePositions: Float32Array | null;
  /** 前回反映したまとまり(中身で比べる)。 */
  groups: readonly FaceGroup[] | null;
  /** 前回反映した外観の一覧(参照で比べる)。 */
  appearances: readonly AppearanceSpec[] | null;
  readonly mesh: SolidMesh;
  readonly edges: SolidEdges;
}

export interface SolidLayer {
  /** シーンへ足す入れ物。 */
  readonly group: THREE.Group;
  /**
   * 描画データと表示スタイルを反映する。
   * 同じ組み立て結果(同一オブジェクト)を渡し直したときは並びを触らない。
   *
   * `environment` は映り込み用の環境マップ(FR-1107)。鏡・ガラスが 1 つも無ければ `null`
   * で、そのときは材質にも入れない(§0.a-0.9)。作る・捨てるの判断は
   * `createViewportScene.ts` が行う(レンダラとシーンを持っているのがそちらのため)。
   */
  update(
    bundle: SolidGeometryBundle,
    displayStyle: DisplayStyle,
    environment?: THREE.Texture | null,
  ): void;
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
  /**
   * 表示テーマの色を反映する(FR-908)。材質の色を塗り替えるだけで、
   * 部品も並びも作り直さない(NFR-PF-1)。
   */
  setThemeColors(colors: ThemeColors): void;
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
  itemSize = 3,
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
  geometry.setAttribute(name, new THREE.BufferAttribute(values, itemSize));
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

/**
 * 立体の層を作る。
 *
 * `patterns` は柄のテクスチャの出どころ(FR-1108)。既定は実物
 * (`appearance/patternTexture.ts`)で、canvas の無い Node の検査からは偽物を渡せる
 * (`createAppearanceMaterial.ts` の `PatternTextureSource`)。
 */
export function createSolidLayer(patterns?: PatternTextureSource): SolidLayer {
  const group = new THREE.Group();

  /** いま効いているテーマの色。`setThemeColors` が来るまでは既定(ダーク)。 */
  let colors: ThemeColors = DEFAULT_THEME_COLORS;

  /** いまの表示スタイル。テーマが変わったとき、稜線の色をどちらへ塗るかの判断に使う。 */
  let lastDisplayStyle: DisplayStyle = 'shadedWithEdges';

  /**
   * 面の材質の入れ物(FR-1106〜1109、P5 タスク9・10)。**ビューポートに 1 つだけ**持ち、
   * 見え方(`appearanceKeyText`)が同じ外観には同じ材質を返す。使われなくなった材質と
   * 柄のテクスチャは `collect` / `dispose` が捨てる(WebGL の資源は GC で戻らない)。
   *
   * P2〜P4 はここが `faceMaterial` 1 つで、全ボディの `THREE.Mesh` が共有していた。
   * P5 でボディごとの材質配列(`geometry.addGroup` + `mesh.material = [...]`)へ移したが、
   * **外観を 1 つも割り当てていない立体は長さ 1 の配列・まとまり 1 つ**になるので、
   * ドローコールも絵も P2 と変わらない(§0.a-0.12)。既定の外観の値
   * (色 `#b8bfcc`・光沢 5・粗さ 55)は、そのころの `SOLID_ROUGHNESS` / `SOLID_METALNESS` と
   * `--pcad-solid` をそのまま写したものである(`model` の `DEFAULT_APPEARANCE`)。
   */
  const materialStore = createAppearanceMaterialStore(patterns);

  /** いま材質へ入れている環境マップ(FR-1107)。鏡・ガラスが無ければ null。 */
  let environment: THREE.Texture | null = null;

  /**
   * 材質を作り直す必要があるか(テーマの色が変わった・環境マップが入れ替わった)。
   * **毎コマは触らない**(docs/報告記録.md 2026-09-02 15:42「常時の描画ループを作らない」)。
   */
  let appearanceDirty = true;

  /**
   * 稜線の材質は強調の度合いごとに 1 つずつ。ボディごとには作らず、
   * どれを使うかだけを切り替える(ボディが増えても材質は 3 つのまま)。
   * `none` の色だけは表示スタイルで変わる(面の上か、稜線だけか)。
   */
  const edgeMaterials: Readonly<Record<SolidEmphasis, THREE.LineBasicMaterial>> = {
    none: new THREE.LineBasicMaterial({ color: DEFAULT_THEME_COLORS.solidEdgeOverSolid }),
    hovered: new THREE.LineBasicMaterial({ color: DEFAULT_THEME_COLORS.hovered }),
    selected: new THREE.LineBasicMaterial({ color: DEFAULT_THEME_COLORS.selected }),
  };

  /**
   * 部分形状(面・辺・頂点)の重ね描き(§0.a-0.7)。ホバー用・選択用の 2 組だけを作り、
   * ボディごとには増やさない(全ボディの強調中の要素を 1 本のバッファへまとめる)。
   */
  const subShapeOverlays: Readonly<Record<SubShapeEmphasis, SubShapeOverlay>> = {
    hovered: createSubShapeOverlay(DEFAULT_THEME_COLORS.hovered),
    selected: createSubShapeOverlay(DEFAULT_THEME_COLORS.selected),
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
      color: DEFAULT_THEME_COLORS.threadMark,
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
    // 材質はまだ決まっていない(最初の update で外観から作る)。空の配列で始める。
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
      indices: null,
      edgePositions: null,
      groups: null,
      appearances: null,
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
    // 柄(FR-1108)を貼るための箱投影 UV。**同じ並び(同一参照)なら触らない**
    // ので、ホバーや選択が変わっただけの組み立て直しでは GPU へ送り直さない。
    setVectorAttribute(draw.mesh.geometry, 'uv', entry.uv, 2);
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

  /**
   * ボディ 1 つぶんの外観(まとまりと材質の配列)を反映する(FR-1106)。
   *
   * **前回と同じまとまり・同じ外観で、材質を作り直す理由も無いときは何もしない。**
   * `clearGroups` / `addGroup` と `mesh.material` の入れ替えは、three.js に材質の
   * 束ね直しをさせるので、ホバーが動くたびに行うと 60fps(NFR-PF-1)を脅かす。
   */
  function applyAppearance(draw: BodyDraw, entry: SolidDrawEntry): void {
    if (
      !appearanceDirty &&
      sameGroups(draw.groups, entry.groups) &&
      sameAppearances(draw.appearances, entry.appearances)
    ) {
      return;
    }
    const materials = entry.appearances.map((spec) =>
      materialStore.materialFor(themedAppearance(spec, colors.solid), environment),
    );
    const geometry = draw.mesh.geometry;
    geometry.clearGroups();
    for (const faceGroup of entry.groups) {
      geometry.addGroup(faceGroup.start, faceGroup.count, faceGroup.materialIndex);
    }
    draw.mesh.material = materials;
    draw.groups = entry.groups;
    draw.appearances = entry.appearances;
  }

  /**
   * いま画面に出ている外観で使っていない材質を捨てる(§2.5.3)。
   * テーマの色を当てた後の外観で数えないと、テーマを切り替えた直後に**使っている材質を
   * 捨ててしまう**ので、`applyAppearance` と同じ `themedAppearance` を通す。
   */
  function collectMaterials(entries: readonly SolidDrawEntry[]): void {
    const used: AppearanceSpec[] = [];
    for (const entry of entries) {
      for (const spec of entry.appearances) {
        used.push(themedAppearance(spec, colors.solid));
      }
    }
    materialStore.collect(used);
  }

  /** 部品の数をボディの数に合わせ、形と外観を流し込む。 */
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
      applyAppearance(draw, entry);
      pickTargets.push(draw.mesh);
      idByObject.set(draw.mesh, entry.featureId);
    }
    collectMaterials(entries);
    appearanceDirty = false;
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
    lastDisplayStyle = displayStyle;
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
  }

  return {
    group,

    update(bundle, displayStyle, nextEnvironment = null): void {
      if (nextEnvironment !== environment) {
        environment = nextEnvironment;
        appearanceDirty = true;
      }
      // 並びも外観も前回のままなら、表示スタイルの入切だけで済ませる(毎コマの作り直しをしない)。
      if (bundle !== lastBundle || appearanceDirty) {
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

    setThemeColors(next): void {
      colors = next;
      // 既定の外観の色はテーマが決める(FR-908)。材質そのものは次の `update` で作り直す
      // (材質の入れ物が鍵で使い回すので、色を直に書き換えると鍵と中身が食い違う)。
      appearanceDirty = true;
      edgeMaterials.none.color.setHex(
        lastDisplayStyle === 'wireframe' ? colors.solidEdgeWireframe : colors.solidEdgeOverSolid,
      );
      edgeMaterials.hovered.color.setHex(colors.hovered);
      edgeMaterials.selected.color.setHex(colors.selected);
      for (const emphasis of SUB_SHAPE_EMPHASES) {
        const overlay = subShapeOverlays[emphasis];
        const color = emphasis === 'hovered' ? colors.hovered : colors.selected;
        overlay.faces.material.color.setHex(color);
        overlay.edges.material.color.setHex(color);
        overlay.vertices.material.color.setHex(color);
      }
      threadMarkLines.material.color.setHex(colors.threadMark);
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
      // 材質の入れ物は、貯めた材質と柄のテクスチャの表をまとめて捨てる(§2.5.3)。
      materialStore.dispose();
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
      environment = null;
      appearanceDirty = true;
    },
  };
}
