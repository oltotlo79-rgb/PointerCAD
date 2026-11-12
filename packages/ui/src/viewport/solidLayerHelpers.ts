/**
 * 立体の表示層のうち、形そのものではない補助の表示の責務: ねじの簡略表示の印、球面の案内線(FR-431)、
 * 切断面の予告(FR-432)、断面表示のつまみ(FR-111)。
 *
 * どれも**ボディごとには増やさない**(ねじの印だけは印ごとに 1 本。遠い印の 2 mm の幅を Float32 で
 * 保つため)。同じ並び・同じ内容(同一参照)を渡し直したときは入れ物を触らない(NFR-PF-1)。
 * 印と案内線は断面表示で一緒に切り、予告とつまみは平面の上にあるので切らない。
 */
import { addVec3, crossVec3, normalizeVec3, scaleVec3, type ResolvedPlane, type Vec3 } from '@pointercad/model';
import * as THREE from 'three';

import { buildCutPreviewPositions } from './buildCutPreview.js';
import type { CutPreview, SectionHandle } from './createSolidLayer.js';
import { bodyReach, type BodyDraw } from './solidLayerBodies.js';
import { disposeBorrowedGeometry, setVectorAttribute } from './solidLayerBuffers.js';
import { SUB_SHAPE_FACE_RENDER_ORDER, SUB_SHAPE_LINE_RENDER_ORDER } from './solidLayerRenderOrder.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';

/**
 * ねじの簡略表示の印。B-rep には現れない、描画だけのための情報。
 *
 * **置き場について:** 本来は kernel の `ThreadMarkInfo`(`SolidBodyMesh.threadMarks`)が model の
 * `SolidBody` に添って届く。`ui` は `kernel` へ直接依存できない(`apps → ui → model → kernel/expression`
 * の一方向、rules/04-設計の規律.md)ので、欄の形だけをここに書く(`buildSolidGeometry.ts` の
 * `SolidBodyWithSubShapes` と同じ橋渡しの考え方)。
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

/**
 * 球面の案内線(FR-431)の不透明度。形そのものより控えめにして、
 * 案内であることが見た目で分かるようにする。
 */
const SPHERE_GRID_OPACITY = 0.5;

/**
 * 切断面の予告の色。選択・ホバーと別の**警告系の黄**にして、「これから切る場所」だと読み取れるように
 * する。テーマの表(`themeColors.ts`)へは足さない——予告は道具を使っている間だけ出る一時的な表示で、
 * 明暗どちらのテーマでも同じ黄が読めるため(部分形状の重ね描きの色がテーマに従うのとは役割が違う)。
 */
const CUT_PREVIEW_COLOR = 0xf0b429;
/** 予告の四角の不透明度。向こう側の形が透けて見える濃さ。 */
const CUT_PREVIEW_FACE_OPACITY = 0.2;

/**
 * 断面表示のつまみ(FR-111)の色。切断の予告表示をそのまま使い回し、色だけ変える。切断(形が変わる)と
 * 断面表示(見た目だけ)は結果がまったく違うので、同じ黄で出すと取り違える。こちらは**落ち着いた青**
 * (「いま見ているだけ」の合図)。予告と同じく、明暗どちらのテーマでも読める色を直に持つ。
 */
const SECTION_HANDLE_COLOR = 0x38bdf8;

/**
 * つまみの四角の対角長が測れないとき(ボディが 1 つも無い)の代わりの大きさ(mm)。
 * 何も無い画面で断面表示を入れても、つまみが 1 画素も出ないと動かしようがないため
 * (NFR-UX-7)。方眼の刻みと同じ桁にしてある。
 */
const SECTION_HANDLE_MIN_DIAGONAL = 40;

/**
 * つまみの四角を、いま描いているボディより少しだけ広く出す倍率。
 * ぴったりだと切り口の縁で四角が終わってしまい、平面がどこにあるか読み取りにくい。
 */
const SECTION_HANDLE_MARGIN = 1.15;

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
 * ねじの簡略表示の印を線分列へ組み立てる。three.js に触れない純関数
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

type HelperLines = THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
type HelperFace = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
type Acquire = <T extends { dispose(): void }>(resource: T) => T;

/** 予告・つまみの四角(両面描き・奥行きを書かない半透明)。 */
function squareFace(acquired: Acquire, color: number): HelperFace {
  const face = new THREE.Mesh(
    acquired(new THREE.BufferGeometry()),
    acquired(new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: CUT_PREVIEW_FACE_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
    })),
  );
  face.renderOrder = SUB_SHAPE_FACE_RENDER_ORDER;
  face.visible = false;
  return face;
}

/** 補助の線。`depthTest` を切ると面に隠れても見える。 */
function helperLines(acquired: Acquire, parameters: THREE.LineBasicMaterialParameters): HelperLines {
  const lines = new THREE.LineSegments(
    acquired(new THREE.BufferGeometry()),
    acquired(new THREE.LineBasicMaterial(parameters)),
  );
  lines.renderOrder = SUB_SHAPE_LINE_RENDER_ORDER;
  lines.visible = false;
  return lines;
}

/**
 * 補助の部品を、描く順の見分けに効く作った順(材質と部品の通し番号)を変えずに作る:
 * ねじの印 → 予告の四角 → 球面の案内線 → 予告の矢印 → つまみの四角 → つまみの矢印。
 */
function createHelperObjects(acquired: Acquire) {
  /*
    ねじの簡略表示の印。全ボディぶんの材質を 1 つにまとめる(部分形状の重ね描きと同じ考え方)。
    裏側(手前の面に隠れた側)の印も見えるよう `depthTest: false` にする(JIS の簡略図示は隠れ線か
    どうかを描き分けないため)。薄い線に見せるため不透明度を下げる。
  */
  const threadMarkLines = helperLines(acquired, {
    color: DEFAULT_THEME_COLORS.threadMark, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false,
  });
  // 切断面の予告(FR-432)の四角。四角 1 枚と矢印 1 本だけを作り、ボディごとには増やさない。
  const cutPreviewFace = squareFace(acquired, CUT_PREVIEW_COLOR);
  /*
    球面の案内線(FR-431)。全球ぶんを 1 本の `LineSegments` にまとめるので、5° の 7,704 本でも
    ドローコールは 1 回で済む。色は方眼の主線の薄い灰にする。**ホバー・選択の色とは別の色**にするのが
    要点で、案内線が強調と同じ色だと「いま何を選んでいるか」が読めなくなる。`depthTest: true` にして
    球の裏側の線は手前の面に隠す。球の三角形は真球の内側に張られるため、案内線は半径をごくわずかに
    持ち上げて面との競りを避ける(持ち上げ量は組み立て側=`createViewportScene.ts` が決める)。
  */
  const sphereGridLines = helperLines(acquired, {
    color: DEFAULT_THEME_COLORS.gridMajor, transparent: true, opacity: SPHERE_GRID_OPACITY, depthWrite: false,
  });
  const cutPreviewArrow = helperLines(acquired, {
    color: CUT_PREVIEW_COLOR, transparent: true, depthTest: false, depthWrite: false,
  });
  /*
    断面表示のつまみ(FR-111)。切断の予告と同じ 2 本(四角と矢印)を色だけ変えて作る。**つまみ自身は
    クリップしない**——平面の真上にあるので、自分の切る面で消えてしまっては掴めなくなるため。
  */
  const sectionHandleFace = squareFace(acquired, SECTION_HANDLE_COLOR);
  const sectionHandleArrow = helperLines(acquired, {
    color: SECTION_HANDLE_COLOR, transparent: true, depthTest: false, depthWrite: false,
  });
  return { threadMarkLines, cutPreviewFace, sphereGridLines, cutPreviewArrow, sectionHandleFace, sectionHandleArrow };
}

/**
 * 平面の上に四角と矢印を出す(切断の予告と断面のつまみに共通)。四角と矢印は平面の原点を中心に
 * local に組み立て、平面の原点(double)へ置く(遠い平面でも大きさが Float32 で崩れない)。
 */
function showSquareAndArrow(face: HelperFace, arrow: HelperLines, plane: ResolvedPlane, diagonal: number,
  keep: 'positive' | 'negative'): void {
  const positions = buildCutPreviewPositions({ ...plane, origin: [0, 0, 0] }, diagonal, keep);
  const [x, y, z] = plane.origin;
  face.position.set(x, y, z);
  arrow.position.set(x, y, z);
  face.updateMatrixWorld(true);
  arrow.updateMatrixWorld(true);
  setVectorAttribute(face.geometry, 'position', positions.facePositions);
  face.geometry.computeVertexNormals();
  face.geometry.computeBoundingSphere();
  face.visible = positions.facePositions.length > 0;
  setVectorAttribute(arrow.geometry, 'position', positions.arrowPositions);
  arrow.geometry.computeBoundingSphere();
  arrow.visible = positions.arrowPositions.length > 0;
}

interface SolidHelperOptions {
  readonly group: THREE.Group;
  /** 層の作りかけの資源の持ち主へ預ける(作る途中で失敗しても捨てられる)。 */
  readonly acquired: Acquire;
  /** いま描いているボディ。つまみの四角の大きさを測る。 */
  readonly draws: readonly BodyDraw[];
}

/** 1 つの層の補助の表示。返す関数はどれも層の持ち主(`createSolidLayer`)だけが呼ぶ。 */
export function createSolidHelperDisplays(options: SolidHelperOptions) {
  const { group, acquired, draws } = options;
  const { threadMarkLines, cutPreviewFace, sphereGridLines, cutPreviewArrow, sectionHandleFace, sectionHandleArrow } =
    createHelperObjects(acquired);
  group.add(threadMarkLines, cutPreviewFace, sphereGridLines, cutPreviewArrow, sectionHandleFace, sectionHandleArrow);
  /**
   * One line object per thread mark. Its circles and axis are built around the local origin
   * and placed by the mark's double origin, so a far mark keeps its 2 mm width in Float32 and
   * two far marks are never merged into one shared base. The shared material stays with
   * `threadMarkLines` (clipping, theme and disposal follow it).
   */
  const threadMarkDraws: HelperLines[] = [];
  let lastThreadMarks: readonly ThreadMarkInfo[] | null = null;
  let lastSphereGridPositions: Float32Array | null = null;
  let lastCutPreview: CutPreview | null = null;
  let lastSectionHandle: SectionHandle | null = null;

  /**
   * つまみの四角と矢印を組み立て直す。`lastSectionHandle` が null なら消すだけ。四角の対角長は
   * いま描いているボディの届く範囲の 2 倍(どこを中心に切っても四角が対象を覆う)。
   */
  function rebuildSectionHandle(): void {
    if (lastSectionHandle === null) {
      sectionHandleFace.visible = false;
      sectionHandleArrow.visible = false;
      return;
    }
    const reach = bodyReach(draws, lastSectionHandle.plane.origin);
    const diagonal = reach > 0 ? reach * 2 * SECTION_HANDLE_MARGIN : SECTION_HANDLE_MIN_DIAGONAL;
    showSquareAndArrow(sectionHandleFace, sectionHandleArrow, lastSectionHandle.plane, diagonal, lastSectionHandle.keep);
  }

  function updateThreadMarks(marks: readonly ThreadMarkInfo[]): void {
    if (marks === lastThreadMarks) {
      return;
    }
    lastThreadMarks = marks;
    const locals = marks.flatMap((mark) => {
      const positions = buildThreadMarkPositions([{ ...mark, origin: [0, 0, 0] }]);
      return positions.length === 0 ? [] : [{ origin: mark.origin, positions }];
    });
    while (threadMarkDraws.length > locals.length) {
      const draw = threadMarkDraws.pop();
      if (draw !== undefined) {
        group.remove(draw);
        disposeBorrowedGeometry(draw.geometry);
      }
    }
    while (threadMarkDraws.length < locals.length) {
      const draw = new THREE.LineSegments(new THREE.BufferGeometry(), threadMarkLines.material);
      draw.renderOrder = SUB_SHAPE_LINE_RENDER_ORDER;
      threadMarkDraws.push(draw);
      group.add(draw);
    }
    locals.forEach((local, index) => {
      const draw = threadMarkDraws[index];
      setVectorAttribute(draw.geometry, 'position', local.positions);
      draw.geometry.computeBoundingSphere();
      draw.position.set(local.origin[0], local.origin[1], local.origin[2]);
      draw.visible = true;
    });
    group.updateMatrixWorld(true);
  }

  function updateSphereGrid(positions: Float32Array | null, origin: Vec3): void {
    sphereGridLines.position.set(origin[0], origin[1], origin[2]);
    sphereGridLines.updateMatrixWorld(true);
    const sameBacking = positions === lastSphereGridPositions;
    lastSphereGridPositions = positions;
    if (positions === null || positions.length === 0) {
      sphereGridLines.visible = false;
      return;
    }
    setVectorAttribute(sphereGridLines.geometry, 'position', positions);
    // A Float32Array is mutable even when its identity is unchanged. The
    // attribute and bounds containers stay owned by this geometry.
    const attribute = sphereGridLines.geometry.getAttribute('position');
    if (sameBacking && attribute instanceof THREE.BufferAttribute) attribute.needsUpdate = true;
    sphereGridLines.geometry.computeBoundingSphere();
    sphereGridLines.visible = true;
  }

  function updateCutPreview(preview: CutPreview | null): void {
    if (preview === lastCutPreview) {
      // 同じ平面を渡し直したときは並びを 1 つも触らない(NFR-PF-1)。
      return;
    }
    lastCutPreview = preview;
    if (preview === null) {
      cutPreviewFace.visible = false;
      cutPreviewArrow.visible = false;
      return;
    }
    showSquareAndArrow(cutPreviewFace, cutPreviewArrow, preview.plane, preview.diagonal, preview.keep);
  }

  return {
    updateThreadMarks,
    updateSphereGrid,
    updateCutPreview,
    updateSectionHandle(handle: SectionHandle | null): void {
      lastSectionHandle = handle;
      rebuildSectionHandle();
    },
    /** 形が変われば覆うべき広さも変わるので、つまみを出しているあいだは組み立て直す。 */
    rebuildSectionHandle,
    /** 断面表示で一緒に切る材質(ねじの印と球面の案内線)。予告とつまみは入れない。 */
    clippedMaterials(): readonly THREE.Material[] {
      return [threadMarkLines.material, sphereGridLines.material];
    },
    /** テーマの色(FR-908)。部品は作り直さず、印と案内線の色だけを塗り替える。 */
    applyTheme(colors: ThemeColors): void {
      threadMarkLines.material.color.setHex(colors.threadMark);
      sphereGridLines.material.color.setHex(colors.gridMajor);
    },
    /** 破棄で解放する、印ごとの線(材質は `threadMarkLines` のもの)。 */
    markDraws(): readonly HelperLines[] { return threadMarkDraws; },
    /** 破棄で解放する補助の部品(形と材質を持つ)。並びは破棄の手順の順。 */
    ownedObjects(): readonly (HelperLines | HelperFace)[] {
      return [threadMarkLines, sphereGridLines, cutPreviewFace, cutPreviewArrow, sectionHandleFace, sectionHandleArrow];
    },
    /** 破棄の終わりに、控えを空にする。 */
    reset(): void {
      threadMarkDraws.length = 0;
      lastSectionHandle = null;
      lastCutPreview = null;
      lastThreadMarks = null;
      lastSphereGridPositions = null;
    },
  };
}
