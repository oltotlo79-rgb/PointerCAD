import type { ResolvedSketch, SketchMesh } from '@pointercad/model';
import { buildSketchGeometry, EMPTY_RESOLVED_SKETCH, NO_HIGHLIGHT, type SketchHighlight } from './buildSketchGeometry.js';
import type { ViewportScene } from './createViewportScene.js';
import type { ViewportSceneLayers } from './viewportSceneResources.js';

/*
 * createViewportScene のスケッチの表示の入力(FR-105・FR-310・FR-313・FR-320)と、スケッチの層へ
 * そのまま渡す作図の補助(作図面・トリムの予告・向きの吸着・拘束の印)。描画用の並びは入力の
 * どれかが変わったときだけ組み立て直し(NFR-PF-1)、描画のたびには作らない。
 */

type SketchInputMethods = Pick<ViewportScene, 'setSketch' | 'setConstructionIds' | 'setConstrainedFeatureIds'
  | 'setSketchHighlight' | 'setWorkPlane' | 'setWorkPlaneVisible' | 'setEditPreview' | 'setTracking' | 'setConstraintMarks'
  | 'setSelectedConstraint' | 'setInferredConstraintMarks'>;
type SketchLayers = Pick<ViewportSceneLayers, 'sketchLayer' | 'trackingLayer' | 'constraintLayer' | 'inferenceLayer'>;

export function createSceneSketchInputs(layers: SketchLayers) {
  const { sketchLayer, trackingLayer, constraintLayer, inferenceLayer } = layers;
  /** スケッチの現在値。組み立て直すのは変化したときだけ(NFR-PF-1)。 */
  let resolvedSketch: ResolvedSketch = EMPTY_RESOLVED_SKETCH;
  let sketchMesh: SketchMesh | null = null;
  let sketchHighlight: SketchHighlight = NO_HIGHLIGHT;
  /** 構築線(FR-320)として破線で引く要素の id。履歴から引いた集合を外から入れてもらう。 */
  let constructionIds: ReadonlySet<string> = new Set<string>();
  /** 完全に決まった要素(FR-313)の id。これも外から入れてもらう。 */
  let constrainedIds: ReadonlySet<string> = new Set<string>();
  let sketchBundle = buildSketchGeometry(resolvedSketch, sketchMesh, sketchHighlight);
  /** スケッチの入力のどれかが変わったときに、描画用の並びを組み立て直す。 */
  function rebuildSketchBundle(): void {
    sketchBundle = buildSketchGeometry(
      resolvedSketch,
      sketchMesh,
      sketchHighlight,
      constructionIds,
      constrainedIds,
    );
  }

  const methods: SketchInputMethods = {
    setSketch(nextSketch, nextMesh): void {
      resolvedSketch = nextSketch;
      sketchMesh = nextMesh;
      rebuildSketchBundle();
    },

    setConstructionIds(ids): void {
      constructionIds = ids;
      rebuildSketchBundle();
    },

    setConstrainedFeatureIds(ids): void {
      constrainedIds = ids;
      rebuildSketchBundle();
    },

    setSketchHighlight(hoveredElementId, selection): void {
      sketchHighlight = { hoveredElementId, selection };
      rebuildSketchBundle();
    },

    setWorkPlaneVisible(visible): void {
      sketchLayer.setWorkPlaneVisible(visible);
    },

    setWorkPlane(plane): void {
      sketchLayer.setWorkPlane(plane);
    },

    setEditPreview(preview): void {
      sketchLayer.setEditPreview(preview);
    },

    setTracking(lines): void {
      trackingLayer.setLines(lines);
    },

    setConstraintMarks(marks): void {
      constraintLayer.setMarks(marks);
    },

    setSelectedConstraint(constraintId): void {
      constraintLayer.setSelected(constraintId);
    },

    setInferredConstraintMarks(marks): void {
      inferenceLayer.setMarks(marks);
    },
  };
  return { methods, bundle: () => sketchBundle };
}
