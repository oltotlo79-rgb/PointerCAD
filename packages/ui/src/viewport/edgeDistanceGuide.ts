import { edgeDistanceHoleCenters, findSolid, type Vec3 } from '@pointercad/model';
import { addScaled, dotVec3, subVec3 } from '@pointercad/model/vec3';
import { previewSolidCommit } from '../sketch/numericInput.js';
import { picksHoleEdges } from '../solid/edgeDistanceHoleInput.js';
import { commitMachiningInput } from '../solid/machiningCommands.js';
import { parseSubShapeId, subShapeBodiesOf } from '../solid/subShapeSelection.js';
import type { AppState } from '../store/appState.js';
import type { MeasurementState } from './createMeasureLayer.js';
import { isPlanarBasisGuideCurrent, type PlanarBasisGuide } from './planarBasisGuide.js';
import { captureSolidMeshAdmission } from './solidMeshAdmission.js';

/** 予告の札(穴の中心・辺 1・辺 2)。 */
interface EdgeDistanceGuideLabels {
  readonly center: string;
  readonly edge1: string;
  readonly edge2: string;
}

/** 辺の直線の上で、点に最も近い点(辺からの距離の寸法線の足)。辺がつぶれていれば null。 */
function footOnLine(point: Vec3, start: Vec3, end: Vec3): Vec3 | null {
  const direction = subVec3(end, start), length = Math.hypot(...direction);
  if (!(length > 0)) return null;
  const unit: Vec3 = [direction[0] / length, direction[1] / length, direction[2] / length];
  return addScaled(start, unit, dotVec3(subVec3(point, start), unit));
}

/**
 * 辺からの距離の穴(M-02)の 3D の予告。穴の欄で置き方が「辺からの距離」の間だけ、いま決定した時と同じ道
 * (`previewSolidCommit` → `commitMachiningInput`)で置き方を作り、model の `edgeDistanceHoleCenters`(穴表と同じ式)で
 * 最初の位置の中心を求めて、選んだ 2 本の辺からその中心までの寸法線を、面内の原点の案内と同じ描き方(`PlanarBasisGuide`)で返す。
 * 決定が断る入力・中心が求まらない時は null。文書・測定・履歴へは書かない。
 */
export function edgeDistanceGuide(state: AppState, labels: EdgeDistanceGuideLabels): PlanarBasisGuide | null {
  const input = state.numericInput;
  if (!picksHoleEdges(input) || input === null) return null;
  const admission = captureSolidMeshAdmission(state);
  if (admission === null) return null;
  const commit = previewSolidCommit(input, { ...state.parameterAnalysis, lengthUnit: state.displaySettings.lengthUnit });
  if (commit === null) return null;
  const outcome = commitMachiningInput({ document: state.document, bodies: subShapeBodiesOf(state.bodies), selection: state.selection }, commit);
  const feature = outcome.ok ? findSolid(outcome.document, outcome.featureId) : undefined;
  if ((feature?.kind !== 'hole' && feature?.kind !== 'threadHole') || feature.planar?.kind !== 'edge-distance') return null;
  const placement = feature.planar;
  const bodies = state.bodies.filter(body => body.featureId === feature.face.bodyFeatureId && body.isValid === true);
  const body = bodies.length === 1 ? bodies[0] : undefined;
  const center = body === undefined ? undefined : edgeDistanceHoleCenters(body, feature.face, placement)?.[0];
  const edges = body === undefined ? [] : state.selection.flatMap(id => {
    const parsed = parseSubShapeId(id);
    const edge = parsed?.kind === 'edge' && parsed.bodyFeatureId === body.featureId
      ? body.edges.find(row => row.index === parsed.index) : undefined;
    return edge === undefined ? [] : [edge];
  });
  const [location] = placement.locations;
  if (center === undefined || edges.length !== 2 || location === undefined) return null;
  const [foot1, foot2] = edges.map(edge => footOnLine(center, edge.start, edge.end));
  if (foot1 === null || foot2 === null || ![...center, ...foot1, ...foot2].every(Number.isFinite)) return null;
  const line = (from: Vec3, text: string, value: number): MeasurementState => ({
    result: { kind: 'pointDistance', value, unit: 'mm', segment: [from, center] }, text, angle: null, anchor: null,
  });
  const guide: PlanarBasisGuide = { admission, selection: state.selection, drawing: line(center, labels.center, 0),
    xDrawing: line(foot1, labels.edge1, location.distance1.value), yDrawing: line(foot2, labels.edge2, location.distance2.value) };
  return isPlanarBasisGuideCurrent(guide, state) ? guide : null;
}
