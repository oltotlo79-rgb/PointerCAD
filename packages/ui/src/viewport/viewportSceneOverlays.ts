import { buildSphereGridPositions, isValidSphereGridStep, type SphereGridSpec } from './buildSphereGrid.js';
import type { CutPreview } from './createSolidLayer.js';
import type { ViewportScene, ViewportSceneOptions } from './createViewportScene.js';
import type { CylinderBasisGuide } from './cylinderBasisGuide.js';
import type { PlanarBasisGuide } from './planarBasisGuide.js';
import { createSectionClipping, updateBasisGuideLayers, type ViewportSceneLayers } from './viewportSceneResources.js';

/*
 * createViewportScene の重ね表示。形を 1 つも変えない表示だけの層(干渉・解析の場・下絵・基準・測定)へ
 * 受け取った値を渡し、立体に重ねるもの(切断の予告・球面の案内線・円筒と平面の基準の案内)は値を
 * 控えて、描画のたびに立体の受領が今のままの時だけ出す。断面表示のクリッピング平面もここが配る。
 */

/**
 * 球面の案内線を球の面からどれだけ外へ持ち上げるか(半径に対する割合、FR-431)。
 *
 * 球の三角形は真球の**内側**に張られる(弦なので必ず内側へ入る)ので、案内線を真半径で
 * 引くと面と深度が競って縞になる。半径の 0.2% だけ外へ出せば、いちばん粗い分割でも面より
 * 確実に手前に来る(r=10 なら 0.02mm。画面では 1 画素に満たない)。吸着で決まる点そのものは
 * **真半径のまま**なので、作られる点の位置はこの持ち上げの影響を受けない。
 */
const SPHERE_GRID_LIFT = 0.002;

/** 球面の案内線の中身が同じか(中心・半径・間隔の 5 つの数だけで決まる)。 */
function sameSphereGridSpec(a: SphereGridSpec | null, b: SphereGridSpec | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.radius === b.radius &&
    a.stepDegrees === b.stepDegrees &&
    a.center[0] === b.center[0] &&
    a.center[1] === b.center[1] &&
    a.center[2] === b.center[2]
  );
}

type OverlayMethods = Pick<ViewportScene, 'setInterference' | 'setCutPreview' | 'setSectionView' | 'setAnalysisField'
  | 'setAnalysisMode' | 'setCanvases' | 'setCylinderBasisGuide' | 'setPlanarBasisGuide' | 'setSphereGrid' | 'setReferences'
  | 'setMeasurement'>;

export function createSceneOverlays(layers: ViewportSceneLayers, options: ViewportSceneOptions, isDisposed: () => boolean) {
  const { solidLayer, interferenceLayer, analysisFieldLayer, analysisModeLayer, canvasLayer, cylinderBasisLayer,
    planarBasisLayers, referenceLayer, measureLayer } = layers;
  let cylinderGuide: CylinderBasisGuide | null = null;
  let planarGuide: PlanarBasisGuide | null = null;
  /** 切断面の予告(FR-432)。道具を使っている間だけ入り、確定・取消で null に戻る。 */
  let cutPreview: CutPreview | null = null;
  const sectionClipping = createSectionClipping(layers);
  /** 球面の案内線(FR-431)。出していないときは null。 */
  let sphereGridSpec: SphereGridSpec | null = null;
  let sphereGridPositions: Float32Array | null = null;

  const methods: OverlayMethods = {
    setInterference(result, selectedKey): void {
      interferenceLayer.update(result, selectedKey);
    },

    setCutPreview(preview): void {
      cutPreview = preview;
    },

    setSectionView: sectionClipping.setSectionView,

    setAnalysisField(field): void {
      if (isDisposed()) return;
      analysisFieldLayer.set(field);
    },
    setAnalysisMode(preview): void {
      if (isDisposed()) return;
      analysisModeLayer.set(preview);
    },

    setCanvases(draws): void {
      if (isDisposed()) return;
      canvasLayer.update(draws);
    },

    setCylinderBasisGuide(guide): void {
      if (isDisposed()) return;
      cylinderGuide = guide;
      if (guide === null) cylinderBasisLayer.update(null);
    },

    setPlanarBasisGuide(guide): void {
      if (isDisposed()) return;
      planarGuide = guide;
      for (const layer of planarBasisLayers) {
        layer.update(null);
        layer.group.visible = false;
      }
    },

    setSphereGrid(spec): void {
      if (sameSphereGridSpec(sphereGridSpec, spec)) {
        return;
      }
      sphereGridSpec = spec;
      sphereGridPositions =
        spec === null || !isValidSphereGridStep(spec.stepDegrees) || !(spec.radius > 0)
          ? null
          : buildSphereGridPositions({ ...spec, center: [0, 0, 0], radius: spec.radius * (1 + SPHERE_GRID_LIFT) });
    },

    setReferences(references): void {
      referenceLayer.update(references);
    },

    setMeasurement(measurement): void {
      measureLayer.update(measurement);
    },
  };

  return {
    methods,
    /** 描画の前に、立体に重ねるものを立体の受領が今のままの時だけ出す(古い立体の上に残さない)。 */
    syncSolidOverlays(currentSolid: boolean): void {
      solidLayer.updateCutPreview(currentSolid ? cutPreview : null);
      solidLayer.updateSphereGrid(currentSolid ? sphereGridPositions : null, sphereGridSpec?.center);
      const basisState = options.readSolidMeshState?.();
      updateBasisGuideLayers(layers, currentSolid, cylinderGuide, planarGuide, basisState);
    },
  };
}
