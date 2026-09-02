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
 * 色は画面の配色(packages/ui/src/shell/appShell.css の --pcad-* トークン)と
 * 同じ値を 16 進の定数として持つ。CSS 変数は three.js から読めないため。
 */

import type { WorkPlane } from '@pointercad/model';
import * as THREE from 'three';

import type { DisplayStyle } from '../store/useAppStore.js';
import type { SketchEmphasis, SketchFaceDraw, SketchGeometryBundle } from './buildSketchGeometry.js';

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

/** 点の色 = --pcad-text。線の色 = --pcad-text-muted。面の縁 = --pcad-text-faint。 */
const POINT_COLOR = 0xe8eaf0;
const CURVE_COLOR = 0x9aa3b2;
const FACE_OUTLINE_COLOR = 0x6b7380;

/** 選択の色 = --pcad-accent。ホバーはその一段薄い --pcad-accent-hover(NFR-UX-7)。 */
const SELECTED_COLOR = 0x4f8cff;
const HOVERED_COLOR = 0x6b9eff;

/** 面の艶。立体(createViewportScene.ts)より少しだけ艶を抑える。 */
const FACE_ROUGHNESS = 0.6;
const FACE_METALNESS = 0.02;

/** 面の半透明。奥の線が透けて見える濃さにし、選ぶほど濃くする(FR-310)。 */
const FACE_OPACITY: Readonly<Record<SketchEmphasis, number>> = {
  none: 0.35,
  hovered: 0.45,
  selected: 0.55,
};

/** 強調のときだけ面を発光させる。色そのもの(FR-310)は変えずに選択が分かるようにする。 */
const FACE_EMISSIVE_INTENSITY: Readonly<Record<SketchEmphasis, number>> = {
  none: 0,
  hovered: 0.2,
  selected: 0.35,
};

const EMPHASIS_COLOR: Readonly<Record<SketchEmphasis, number>> = {
  none: 0x000000,
  hovered: HOVERED_COLOR,
  selected: SELECTED_COLOR,
};

/** 作図面の矩形。塗りはごく薄く、縁でだけ向きを示す(NFR-UX-1 の「見れば分かる」)。 */
const WORK_PLANE_COLOR = 0x4f8cff;
const WORK_PLANE_FILL_OPACITY = 0.05;
const WORK_PLANE_BORDER_OPACITY = 0.35;

const EMPHASES: readonly SketchEmphasis[] = ['none', 'hovered', 'selected'];

type PointsObject = THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
type LinesObject = THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;

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
  /** いま描いている作図面。矩形の向きが変わる。 */
  setWorkPlane(plane: WorkPlane): void;
  /** 作図面の矩形の広がり(原点からの片側の長さ、mm)。方眼と同じにする。 */
  setWorkPlaneExtent(extent: number): void;
  dispose(): void;
}

function createPoints(color: number): PointsObject {
  return new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ color, size: POINT_SIZE_PIXELS, sizeAttenuation: false }),
  );
}

function createLines(color: number): LinesObject {
  return new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color, linewidth: CURVE_WIDTH_PIXELS }),
  );
}

function createPointSet(): DrawSet<PointsObject> {
  return {
    objects: {
      none: createPoints(POINT_COLOR),
      hovered: createPoints(HOVERED_COLOR),
      selected: createPoints(SELECTED_COLOR),
    },
    hasData: { none: false, hovered: false, selected: false },
  };
}

function createLineSet(baseColor: number): DrawSet<LinesObject> {
  return {
    objects: {
      none: createLines(baseColor),
      hovered: createLines(HOVERED_COLOR),
      selected: createLines(SELECTED_COLOR),
    },
    hasData: { none: false, hovered: false, selected: false },
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

/** 面の色と強調を材質へ写す。作り直さずに塗り替えられるよう、ここに1箇所だけ置く。 */
function applyFaceMaterial(material: THREE.MeshStandardMaterial, face: SketchFaceDraw): void {
  material.color.set(face.color);
  material.emissive.setHex(EMPHASIS_COLOR[face.emphasis]);
  material.emissiveIntensity = FACE_EMISSIVE_INTENSITY[face.emphasis];
  material.opacity = FACE_OPACITY[face.emphasis];
}

function faceMaterial(face: SketchFaceDraw): THREE.MeshStandardMaterial {
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
  applyFaceMaterial(material, face);
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

  // 作図面 → 面 → 縁 → 線 → 点 の順に足す。小さいものほど後に描いて上に出す。
  const workPlaneGroup = new THREE.Group();
  const workPlaneFill = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: WORK_PLANE_COLOR,
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
      color: WORK_PLANE_COLOR,
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

  const outlines = createLineSet(FACE_OUTLINE_COLOR);
  const curves = createLineSet(CURVE_COLOR);
  const points = createPointSet();
  for (const emphasis of EMPHASES) {
    group.add(outlines.objects[emphasis]);
    group.add(curves.objects[emphasis]);
    group.add(points.objects[emphasis]);
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
      const surface = new THREE.Mesh(geometry, faceMaterial(face));
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
        applyFaceMaterial(faceSurfaces[index].material, faces[index]);
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
          outlines.hasData[emphasis] = setPositions(
            outlines.objects[emphasis],
            bundle.faceOutlines[emphasis],
          );
        }
        updateFaces(bundle.faces);
      }
      applyDisplayStyle(displayStyle);
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
      for (const emphasis of EMPHASES) {
        points.objects[emphasis].geometry.dispose();
        points.objects[emphasis].material.dispose();
        curves.objects[emphasis].geometry.dispose();
        curves.objects[emphasis].material.dispose();
        outlines.objects[emphasis].geometry.dispose();
        outlines.objects[emphasis].material.dispose();
      }
      lastBundle = null;
    },
  };
}
