/**
 * スケッチの表示層(計画書 docs/plans/P1-式とスケッチ.md タスク20 手順3)。
 *
 * 対応要件: FR-105(表示スタイル)、FR-310(面の色)、NFR-PF-1(60fps)。
 *
 * `buildSketchGeometry` が組み立てた並びを three.js の部品へ流し込む。
 * **毎フレーム作り直さない**。同じ組み立て結果を渡し直したときは何もせず、
 * 要素数が変わらないときは並びの中身だけを差し替える(NFR-PF-1)。
 * 常時の描画ループはここにも作らない(docs/報告記録.md 2026-09-02 15:42)。
 *
 * 色は画面の配色(packages/ui/src/shell/appShell.css の --pcad-* トークン)から
 * `themeColors.ts` が読み取って渡す(three.js は CSS 変数を直接読めないため)。
 * テーマを変えたときは `setThemeColors` で材質の色だけを塗り替え、**部品は作り直さない**
 * (FR-908 の即時反映、NFR-PF-1)。
 */

import type { WorkPlane } from '@pointercad/model';
import * as THREE from 'three';

import { toLineSegmentPositions } from '../sketch/sampleCurve.js';
import type { EditPreview } from '../sketch/trimPreview.js';
import type { DisplayStyle } from '../store/useAppStore.js';
import type { SketchEmphasis, SketchFaceDraw, SketchGeometryBundle } from './buildSketchGeometry.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';

/**
 * 点の大きさ(画素)。遠近で大きさを変えない(sizeAttenuation: false)ので、
 * 遠くの点も同じ大きさで押せる。当たり判定の半径(pickMath.ts の 6 画素)と揃える。
 */
const POINT_SIZE_PIXELS = 6;

/**
 * 線の太さ(画素)。WebGL の実装上、太い線は描けず 1 画素で描かれる端末が多い
 * (太線には three/examples/jsm の Line2 が要るが、P1 では依存を増やさない)。
 * 意図した太さを残しておき、対応している環境ではこの太さで出る。
 */
const CURVE_WIDTH_PIXELS = 1.5;

/*
 * 点の色 = --pcad-sketch-point、線の色 = --pcad-sketch-curve、面の縁 = --pcad-sketch-outline、
 * ホバー・選択 = --pcad-emphasis-hovered / --pcad-emphasis-selected(themeColors.ts)。
 *
 * ホバーと選択の色の決め方(§0.a-0.23-⑩): 以前は --pcad-accent と --pcad-accent-hover の
 * 色差だけで示していたが、実機の目視で見分けにくいと分かった(`docs/報告記録.md`
 * 2026-09-03 20:40 の②)。ダークではホバーを明るい水色 `0x8ec5ff` にして明度差を広げ、
 * 選択は `0x4f8cff` に据え置いた(背景 --pcad-surface に対して約 8.88:1 と約 5.02:1 で、
 * どちらも 4.5:1 以上。濃い青 `0x2f6fe0` 案は約 3.43:1 で不採用、2026-09-03)。
 * 明るいテーマでは地が反転するので、**ホバーを淡い青・選択を濃い青**にして同じだけの
 * 明度差を作る(値は appShell.css のテーマごとの塊にある)。立体側
 * (`createSolidLayer.ts`)も同じトークンを使い、「選んでいる」の見え方を 1 通りに保つ。
 */

/** 面の艶。立体(createViewportScene.ts)より少しだけ艶を抑える。 */
const FACE_ROUGHNESS = 0.6;
const FACE_METALNESS = 0.02;

/** 面の半透明。奥の線が透けて見える濃さにし、選ぶほど濃くする(FR-310)。 */
const FACE_OPACITY: Readonly<Record<SketchEmphasis, number>> = {
  none: 0.35,
  // 完全に決まった要素(FR-313)は状態を表すだけなので、濃さは既定と同じにする。
  constrained: 0.35,
  hovered: 0.45,
  selected: 0.55,
};

/** 強調のときだけ面を発光させる。色そのもの(FR-310)は変えずに選択が分かるようにする。 */
const FACE_EMISSIVE_INTENSITY: Readonly<Record<SketchEmphasis, number>> = {
  none: 0,
  // 面は拘束の相手にならない(`constrainedElements.ts` が種類で外す)ので発光させない。
  constrained: 0,
  hovered: 0.2,
  selected: 0.35,
};

/** 強調していないときは発光させないので黒(発光の強さも 0)。 */
const NO_EMISSIVE_COLOR = 0x000000;

/** 面の発光に使う色。強調していないときだけテーマに依らない。 */
function emphasisColorOf(colors: ThemeColors, emphasis: SketchEmphasis): number {
  switch (emphasis) {
    case 'hovered':
      return colors.hovered;
    case 'selected':
      return colors.selected;
    case 'constrained':
    case 'none':
      return NO_EMISSIVE_COLOR;
  }
}

/** 作図面の矩形。塗りはごく薄く、縁でだけ向きを示す(NFR-UX-1 の「見れば分かる」)。 */
const WORK_PLANE_FILL_OPACITY = 0.05;
const WORK_PLANE_BORDER_OPACITY = 0.35;

const EMPHASES: readonly SketchEmphasis[] = ['none', 'constrained', 'hovered', 'selected'];

/**
 * 構築線(FR-320)の破線の刻み(mm)。実線と一目で見分く長さにしつつ、
 * 短い補助線でも 2〜3 個の刻みが見えるくらいの細かさにする。
 * `LineDashedMaterial` はワールド長で刻むので、`computeLineDistances()` が要る。
 */
const CONSTRUCTION_DASH_SIZE_MM = 2.4;
const CONSTRUCTION_GAP_SIZE_MM = 1.6;

/**
 * 描く順。数が大きいほど後に描かれ、画面では前に出る。
 *
 * 下書きの点・線・円弧は**面より必ず前**に出す。面に隠れると座標を確かめられず、
 * 下書きとして用を成さないため(FR-105、NFR-UX-1)。three.js は不透明なものを先に、
 * 半透明なものを後にまとめて描くので、半透明の面より後へ回すには点・線も
 * 「半透明」の側に置く必要がある(透け具合は 1 のままなので色も太さも変わらない)。
 * そのうえで `depthTest: false` を付け、面や方眼の奥にあっても隠れないようにする。
 * 面の `depthWrite: false` は据え置きなので、面どうしの前後は今までどおり。
 */
const FACE_OUTLINE_RENDER_ORDER = 2;
const CURVE_RENDER_ORDER = 3;
const POINT_RENDER_ORDER = 4;

/**
 * トリム・延長の予告(FR-322、P4 タスク22)を描く順。
 *
 * **もとの線とまったく同じ場所に重ねる**ので、いちばん後に描いて必ず上に出す。
 * ここが線(3)より小さいと、消える区間の赤がもとの灰色の線に隠れて見えない
 * (深度は `depthTest: false` なので、前後はこの数だけで決まる)。
 */
const EDIT_PREVIEW_RENDER_ORDER = 5;

/**
 * 予告の濃さ。トリムは「ここが消える」と言い切る強調なので濃く、延長は「まだ無い線」の
 * 予告なので薄くする(§0.a-0.26 の「薄く予告表示」)。
 */
const TRIM_PREVIEW_OPACITY = 1;
const EXTEND_PREVIEW_OPACITY = 0.6;

type PointsObject = THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
type LinesObject = THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
type DashedLinesObject = THREE.LineSegments<THREE.BufferGeometry, THREE.LineDashedMaterial>;

/** 強調の度合いごとに 1 つずつ持つ部品と、中身が入っているかの印。 */
interface DrawSet<T extends THREE.Object3D> {
  readonly objects: Readonly<Record<SketchEmphasis, T>>;
  readonly hasData: Record<SketchEmphasis, boolean>;
}

export interface SketchLayer {
  /** シーンへ足す入れ物。 */
  readonly group: THREE.Group;
  /**
   * 描画データと表示スタイルを反映する。
   * 同じ組み立て結果(同一オブジェクト)を渡し直したときは並びを触らない。
   */
  update(bundle: SketchGeometryBundle, displayStyle: DisplayStyle): void;
  /**
   * 表示テーマの色を反映する(FR-908)。材質の色を塗り替えるだけで、
   * 部品も並びも作り直さない(NFR-PF-1)。
   */
  setThemeColors(colors: ThemeColors): void;
  /**
   * トリム・延長の予告(FR-322、P4 タスク22)。消える区間・伸びる区間の折れ線を
   * もとの線の上へ重ねて描く。`null` で消す。
   */
  setEditPreview(preview: EditPreview | null): void;
  /** いま描いている作図面。矩形の向きが変わる。 */
  setWorkPlane(plane: WorkPlane): void;
  /**
   * 作図面の矩形を出すか(FR-330、P4 タスク33、タスク10 の申し送り)。
   * 3D スケッチ(作図面なし)では**矩形を出さない**。作図面が無いのに XY の面が
   * 出ていると「この面の上にかいている」と誤解させるため。
   */
  setWorkPlaneVisible(visible: boolean): void;
  /** 作図面の矩形の広がり(原点からの片側の長さ、mm)。方眼と同じにする。 */
  setWorkPlaneExtent(extent: number): void;
  dispose(): void;
}

function createPoints(color: number): PointsObject {
  const object = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({
      color,
      size: POINT_SIZE_PIXELS,
      sizeAttenuation: false,
      // 面より後に描くための「半透明」扱い。透け具合は 1 のままなので色は変わらない。
      transparent: true,
      // 面の奥にある点も隠さない。前後は renderOrder だけで決める。
      depthTest: false,
      depthWrite: false,
    }),
  );
  object.renderOrder = POINT_RENDER_ORDER;
  return object;
}

function createLines(color: number, renderOrder: number): LinesObject {
  const object = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      color,
      linewidth: CURVE_WIDTH_PIXELS,
      // 点と同じ理由(面より後に描き、面の奥でも隠れない)。太さは変えない。
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  );
  object.renderOrder = renderOrder;
  return object;
}

/**
 * 構築線(FR-320)を引く破線の線。実体にならない補助の線だと見た目で分かるようにする。
 * 色は実線と同じトークンを使い、**破線かどうかだけ**で違いを出す(色を増やさない)。
 */
function createDashedLines(color: number): DashedLinesObject {
  const object = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineDashedMaterial({
      color,
      linewidth: CURVE_WIDTH_PIXELS,
      dashSize: CONSTRUCTION_DASH_SIZE_MM,
      gapSize: CONSTRUCTION_GAP_SIZE_MM,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  );
  object.renderOrder = CURVE_RENDER_ORDER;
  return object;
}

function createPointSet(): DrawSet<PointsObject> {
  return {
    objects: {
      none: createPoints(DEFAULT_THEME_COLORS.sketchPoint),
      constrained: createPoints(DEFAULT_THEME_COLORS.sketchConstrained),
      hovered: createPoints(DEFAULT_THEME_COLORS.hovered),
      selected: createPoints(DEFAULT_THEME_COLORS.selected),
    },
    hasData: { none: false, constrained: false, hovered: false, selected: false },
  };
}

function createLineSet(baseColor: number, renderOrder: number): DrawSet<LinesObject> {
  return {
    objects: {
      none: createLines(baseColor, renderOrder),
      constrained: createLines(DEFAULT_THEME_COLORS.sketchConstrained, renderOrder),
      hovered: createLines(DEFAULT_THEME_COLORS.hovered, renderOrder),
      selected: createLines(DEFAULT_THEME_COLORS.selected, renderOrder),
    },
    hasData: { none: false, constrained: false, hovered: false, selected: false },
  };
}

function createDashedLineSet(baseColor: number): DrawSet<DashedLinesObject> {
  return {
    objects: {
      none: createDashedLines(baseColor),
      constrained: createDashedLines(DEFAULT_THEME_COLORS.sketchConstrained),
      hovered: createDashedLines(DEFAULT_THEME_COLORS.hovered),
      selected: createDashedLines(DEFAULT_THEME_COLORS.selected),
    },
    hasData: { none: false, constrained: false, hovered: false, selected: false },
  };
}

/**
 * 位置の並びを差し替える。**個数が同じなら同じ入れ物へ書き写すだけ**にして、
 * 毎回の作り直しを避ける(NFR-PF-1)。個数が変わったときだけ新しい入れ物を作る。
 * 位置が変われば包む球も変わるので、視錐台の外と誤判定されないよう作り直す。
 */
function setPositions(object: THREE.Points | THREE.LineSegments, values: Float32Array): boolean {
  const geometry = object.geometry;
  const existing = geometry.getAttribute('position');
  if (
    existing instanceof THREE.BufferAttribute &&
    existing.array instanceof Float32Array &&
    existing.array.length === values.length
  ) {
    existing.array.set(values);
    existing.needsUpdate = true;
  } else {
    geometry.setAttribute('position', new THREE.BufferAttribute(values, 3));
  }
  geometry.computeBoundingSphere();
  return values.length > 0;
}

/**
 * 面の色と強調を材質へ写す。作り直さずに塗り替えられるよう、ここに1箇所だけ置く。
 * 面そのものの色(FR-310)は利用者が選んだ値なのでテーマに従わず、強調の発光だけが従う。
 */
function applyFaceMaterial(
  material: THREE.MeshStandardMaterial,
  face: SketchFaceDraw,
  colors: ThemeColors,
): void {
  material.color.set(face.color);
  material.emissive.setHex(emphasisColorOf(colors, face.emphasis));
  material.emissiveIntensity = FACE_EMISSIVE_INTENSITY[face.emphasis];
  material.opacity = FACE_OPACITY[face.emphasis];
}

function faceMaterial(face: SketchFaceDraw, colors: ThemeColors): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    roughness: FACE_ROUGHNESS,
    metalness: FACE_METALNESS,
    side: THREE.DoubleSide,
    transparent: true,
    // 半透明なので深度は書かない。奥の線・点が面に隠れて消えるのを防ぐ。
    depthWrite: false,
    // 縁が面に埋もれてちらつくのを防ぐ(createViewportScene.ts と同じ扱い)。
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  applyFaceMaterial(material, face, colors);
  return material;
}

/** 1 辺 1 の正方形の縁(4 本の線分)。入れ物の拡大率で実寸に合わせる。 */
function createSquareBorderGeometry(): THREE.BufferGeometry {
  const half = 0.5;
  const corners: readonly (readonly [number, number])[] = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ];
  const values: number[] = [];
  for (let index = 0; index < corners.length; index += 1) {
    const from = corners[index];
    const to = corners[(index + 1) % corners.length];
    values.push(from[0], from[1], 0, to[0], to[1], 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(values, 3));
  return geometry;
}

export function createSketchLayer(): SketchLayer {
  const group = new THREE.Group();

  /** いま効いているテーマの色。`setThemeColors` が来るまでは既定(ダーク)。 */
  let colors: ThemeColors = DEFAULT_THEME_COLORS;

  // 作図面 → 面 → 縁 → 線 → 点 の順に足す。前後は足した順ではなく renderOrder が決める
  // (作図面 -1 → 面 0 → 縁 2 → 線 3 → 点 4)。小さいものほど後に描いて上に出す。
  const workPlaneGroup = new THREE.Group();
  const workPlaneFill = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: DEFAULT_THEME_COLORS.workPlane,
      transparent: true,
      opacity: WORK_PLANE_FILL_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  // 方眼と同じ平面に重なるので、方眼より先に描いて方眼を消さないようにする。
  workPlaneFill.renderOrder = -1;
  const workPlaneBorder = new THREE.LineSegments(
    createSquareBorderGeometry(),
    new THREE.LineBasicMaterial({
      color: DEFAULT_THEME_COLORS.workPlane,
      transparent: true,
      opacity: WORK_PLANE_BORDER_OPACITY,
      depthWrite: false,
    }),
  );
  workPlaneBorder.renderOrder = -1;
  workPlaneGroup.add(workPlaneFill);
  workPlaneGroup.add(workPlaneBorder);
  group.add(workPlaneGroup);

  const faceGroup = new THREE.Group();
  group.add(faceGroup);

  const outlines = createLineSet(DEFAULT_THEME_COLORS.sketchOutline, FACE_OUTLINE_RENDER_ORDER);
  const curves = createLineSet(DEFAULT_THEME_COLORS.sketchCurve, CURVE_RENDER_ORDER);
  // 構築線(FR-320)は同じ色の破線で引く。実線とは別の並びに分けてあるので、
  // 材質を 1 本ずつ塗り分けずに済む(buildSketchGeometry.ts の constructionCurves)。
  const constructionCurves = createDashedLineSet(DEFAULT_THEME_COLORS.sketchCurve);
  const points = createPointSet();
  for (const emphasis of EMPHASES) {
    group.add(outlines.objects[emphasis]);
    group.add(curves.objects[emphasis]);
    group.add(constructionCurves.objects[emphasis]);
    group.add(points.objects[emphasis]);
  }

  /*
   * トリム・延長の予告(FR-322、P4 タスク22)。要素ごとではなく**同時に 1 本だけ**出る
   * 一時的な線なので、強調(none / hovered / selected)の 3 本組は作らず 1 本で持つ。
   * 色と濃さは種類(消える区間 / 伸びる区間)で塗り替える。
   */
  const editPreviewLines = createLines(
    DEFAULT_THEME_COLORS.trimRemove,
    EDIT_PREVIEW_RENDER_ORDER,
  );
  editPreviewLines.visible = false;
  group.add(editPreviewLines);

  /** いま出している予告。テーマを変えたときに色を塗り直すために覚えておく。 */
  let lastEditPreview: EditPreview | null = null;

  /** 予告の色と濃さを、いまのテーマと種類から材質へ写す。 */
  function applyEditPreviewMaterial(preview: EditPreview): void {
    const trim = preview.kind === 'trim';
    editPreviewLines.material.color.setHex(trim ? colors.trimRemove : colors.hovered);
    editPreviewLines.material.opacity = trim ? TRIM_PREVIEW_OPACITY : EXTEND_PREVIEW_OPACITY;
  }

  let lastBundle: SketchGeometryBundle | null = null;

  /**
   * いま出している面。`faceGroup.children` から取り出すと型が広がって材質を辿れないので、
   * 作ったものを自分で覚えておき、片付けるときはここから消す。
   */
  const faceSurfaces: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] = [];

  /** 前回描いた面。三角形が同じなら作り直さずに色だけ塗り替えるための控え。 */
  let lastFaces: readonly SketchFaceDraw[] = [];

  /** 面のメッシュを片付ける。 */
  function clearFaces(): void {
    for (const surface of faceSurfaces) {
      faceGroup.remove(surface);
      surface.geometry.dispose();
      surface.material.dispose();
    }
    faceSurfaces.length = 0;
  }

  function rebuildFaces(faces: readonly SketchFaceDraw[]): void {
    clearFaces();
    for (const face of faces) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(face.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(face.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(face.indices, 1));
      geometry.computeBoundingSphere();
      const surface = new THREE.Mesh(geometry, faceMaterial(face, colors));
      // どの面フィーチャーかを名前で持つ(userData は型が any になるので使わない)。
      surface.name = face.featureId;
      faceGroup.add(surface);
      faceSurfaces.push(surface);
    }
  }

  /** 三角形が前回と同じ面の並びか。同じならメッシュを作り直さずに済む。 */
  function hasSameFaceGeometry(faces: readonly SketchFaceDraw[]): boolean {
    if (faces.length !== lastFaces.length) {
      return false;
    }
    for (let index = 0; index < faces.length; index += 1) {
      const next = faces[index];
      const previous = lastFaces[index];
      if (
        next.featureId !== previous.featureId ||
        next.positions !== previous.positions ||
        next.indices !== previous.indices
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * 面を反映する。ホバーや選択が変わっただけのときは三角形が同じなので、
   * メッシュを作り直さず材質の色だけを塗り替える(マウスを動かすたびの作り直しを避ける)。
   */
  function updateFaces(faces: readonly SketchFaceDraw[]): void {
    if (hasSameFaceGeometry(faces)) {
      for (let index = 0; index < faces.length; index += 1) {
        applyFaceMaterial(faceSurfaces[index].material, faces[index], colors);
      }
    } else {
      rebuildFaces(faces);
    }
    lastFaces = faces;
  }

  function applyDisplayStyle(displayStyle: DisplayStyle): void {
    // 立体の表示スタイル(FR-105)に合わせる。面は稜線だけの表示で消し、
    // 面の縁は面だけの表示で消す。点と線・円弧は下書きそのものなので、
    // どの表示スタイルでも消さない(消すと線だけのスケッチが見えなくなる)。
    faceGroup.visible = displayStyle !== 'wireframe';
    for (const emphasis of EMPHASES) {
      outlines.objects[emphasis].visible =
        displayStyle !== 'shaded' && outlines.hasData[emphasis];
      curves.objects[emphasis].visible = curves.hasData[emphasis];
      constructionCurves.objects[emphasis].visible = constructionCurves.hasData[emphasis];
      points.objects[emphasis].visible = points.hasData[emphasis];
    }
  }

  return {
    group,

    update(bundle, displayStyle): void {
      if (bundle !== lastBundle) {
        lastBundle = bundle;
        for (const emphasis of EMPHASES) {
          points.hasData[emphasis] = setPositions(
            points.objects[emphasis],
            bundle.points[emphasis],
          );
          curves.hasData[emphasis] = setPositions(
            curves.objects[emphasis],
            bundle.curves[emphasis],
          );
          constructionCurves.hasData[emphasis] = setPositions(
            constructionCurves.objects[emphasis],
            bundle.constructionCurves[emphasis],
          );
          // 破線の刻みはワールド長で決まるので、位置を入れ替えたら測り直す。
          constructionCurves.objects[emphasis].computeLineDistances();
          outlines.hasData[emphasis] = setPositions(
            outlines.objects[emphasis],
            bundle.faceOutlines[emphasis],
          );
        }
        updateFaces(bundle.faces);
      }
      applyDisplayStyle(displayStyle);
    },

    setThemeColors(next): void {
      colors = next;
      points.objects.none.material.color.setHex(colors.sketchPoint);
      points.objects.constrained.material.color.setHex(colors.sketchConstrained);
      points.objects.hovered.material.color.setHex(colors.hovered);
      points.objects.selected.material.color.setHex(colors.selected);
      curves.objects.none.material.color.setHex(colors.sketchCurve);
      curves.objects.constrained.material.color.setHex(colors.sketchConstrained);
      curves.objects.hovered.material.color.setHex(colors.hovered);
      curves.objects.selected.material.color.setHex(colors.selected);
      constructionCurves.objects.none.material.color.setHex(colors.sketchCurve);
      constructionCurves.objects.constrained.material.color.setHex(colors.sketchConstrained);
      constructionCurves.objects.hovered.material.color.setHex(colors.hovered);
      constructionCurves.objects.selected.material.color.setHex(colors.selected);
      outlines.objects.none.material.color.setHex(colors.sketchOutline);
      // 面の縁は要素そのものではないので、決まり具合の色は付けず既定色のままにする。
      outlines.objects.constrained.material.color.setHex(colors.sketchOutline);
      outlines.objects.hovered.material.color.setHex(colors.hovered);
      outlines.objects.selected.material.color.setHex(colors.selected);
      workPlaneFill.material.color.setHex(colors.workPlane);
      workPlaneBorder.material.color.setHex(colors.workPlane);
      // 出しっぱなしの予告も、次にマウスが動くのを待たずにその場で塗り替える。
      if (lastEditPreview !== null) {
        applyEditPreviewMaterial(lastEditPreview);
      }
      // いま出している面の強調(発光)も、次の組み立てを待たずにその場で塗り替える。
      const shared = Math.min(faceSurfaces.length, lastFaces.length);
      for (let index = 0; index < shared; index += 1) {
        applyFaceMaterial(faceSurfaces[index].material, lastFaces[index], colors);
      }
    },

    setEditPreview(preview): void {
      lastEditPreview = preview;
      if (preview === null) {
        editPreviewLines.visible = false;
        return;
      }
      applyEditPreviewMaterial(preview);
      editPreviewLines.visible = setPositions(
        editPreviewLines,
        new Float32Array(toLineSegmentPositions(preview.points)),
      );
    },

    setWorkPlane(plane): void {
      workPlaneGroup.position.set(plane.origin[0], plane.origin[1], plane.origin[2]);
      workPlaneGroup.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(
          new THREE.Vector3(plane.axisU[0], plane.axisU[1], plane.axisU[2]),
          new THREE.Vector3(plane.axisV[0], plane.axisV[1], plane.axisV[2]),
          new THREE.Vector3(plane.normal[0], plane.normal[1], plane.normal[2]),
        ),
      );
    },

    setWorkPlaneVisible(visible): void {
      workPlaneGroup.visible = visible;
    },

    setWorkPlaneExtent(extent): void {
      // 1 辺 1 の正方形を作ってあるので、拡大率は片側の長さの 2 倍。
      workPlaneGroup.scale.set(extent * 2, extent * 2, 1);
    },

    dispose(): void {
      clearFaces();
      lastFaces = [];
      workPlaneFill.geometry.dispose();
      workPlaneFill.material.dispose();
      workPlaneBorder.geometry.dispose();
      workPlaneBorder.material.dispose();
      editPreviewLines.geometry.dispose();
      editPreviewLines.material.dispose();
      lastEditPreview = null;
      for (const emphasis of EMPHASES) {
        points.objects[emphasis].geometry.dispose();
        points.objects[emphasis].material.dispose();
        curves.objects[emphasis].geometry.dispose();
        curves.objects[emphasis].material.dispose();
        constructionCurves.objects[emphasis].geometry.dispose();
        constructionCurves.objects[emphasis].material.dispose();
        outlines.objects[emphasis].geometry.dispose();
        outlines.objects[emphasis].material.dispose();
      }
      lastBundle = null;
    },
  };
}
