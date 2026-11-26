import type { AxisFrame } from '../geometry/planeSpec.js';
import { resolveConstrainedSketch, type ConstrainedSketch } from '../sketch/constraints/solveSketch.js';
import type { WorkPlane, WorkPlaneId } from '../sketch/planeMath.js';
import { NO_PART_POINT, type PartPointLookup, type ResolvedSphere } from '../sketch/resolveCoordinate.js';
import type { PointReference, SketchDocument } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import type { PartError, PartErrorCode } from './partPlanningResult.js';
import {
  createReferenceResolver,
  type ReferenceError,
  type ReferenceErrorCode,
  type ResolvedPointWithIdentity,
  type ResolvedReferences,
} from './resolveReferences.js';
import type { ResolvedPartSketch } from './resolvedPlanGeometry.js';
import type { PartDocument, PrimitiveFeature } from './types.js';

type SketchOptions = NonNullable<Parameters<typeof resolveConstrainedSketch>[1]>;
export type PartSketchOptions = Required<Pick<SketchOptions, 'offsetCurves' | 'projectedCurves'>> &
  Pick<SketchOptions, 'subShape' | 'invalidInputs' | 'workerBrokenInputs' | 'functionCurves'> &
  { readonly functionPoint: SketchOptions['functionPoint'] };

/**
 * 基準ジオメトリの断り(`ReferenceErrorCode`)を、ツリーが読む `PartErrorCode` へ写す。
 * 失敗の一覧を 1 か所(`ResolvedPart.errors`)にまとめるための詰め替え。
 */
export const REFERENCE_ERROR_CODES: Readonly<Record<ReferenceErrorCode, PartErrorCode>> = {
  missingPoint: 'missingProfile',
  missingSubShape: 'missingSubShape',
  missingAxis: 'missingProfile',
  missingPlane: 'missingProfile',
  collinear: 'notPlanar',
  notStraightEdge: 'degenerate',
  notFlatFace: 'degenerate',
  invalidValue: 'invalidValue',
  degenerate: 'degenerate',
  circularReference: 'circularReference',
};

export function toPartError(error: ReferenceError): PartError {
  return { featureId: error.featureId, code: REFERENCE_ERROR_CODES[error.code], text: error.text };
}

/**
 * 拘束まで解いたスケッチ(`ConstrainedSketch`)を、外へ返す形(`ResolvedPartSketch`)へ詰め替える。
 * `resolveSketchesAndReferences` の中で2か所(球の基準点の解決、最終の一覧)から
 * 同じ詰め替えが要るので、ここへ1つだけ置く(同じ規則を2か所に書かない)。
 */
function toResolvedPartSketch(sketchId: string, constrained: ConstrainedSketch): ResolvedPartSketch {
  return {
    sketchId,
    resolved: constrained.resolved,
    diagnosis: constrained.diagnosis,
    constraintErrors: constrained.errors,
  };
}

/**
 * スケッチと基準ジオメトリを、互いを頼りながら解く。
 *
 * スケッチは作図面として任意の作業平面(FR-328)を指せて、その作業平面はスケッチの点を
 * 基準にできる。どちらを先に解くかは決められないので、**頼まれたときに解いて覚える**形にする。
 * 解いている最中のスケッチをもう一度頼まれたら null を返し、基準ジオメトリ側が
 * 「循環しています」と断る(FR-504。無限に呼び合わない)。
 */
export function resolvePartSketches(
  document: PartDocument,
  options: PartSketchOptions,
  sphereOrigin: (feature: PrimitiveFeature, sketches: readonly ResolvedPartSketch[]) => Vec3 | null,
): {
  readonly sketches: readonly ResolvedPartSketch[];
  readonly references: ResolvedReferences;
  readonly workPlane: (planeId: WorkPlaneId) => WorkPlane | null;
  /** 点の参照の解決(拡大縮小の中心 FR-424 が使う)。 */
  readonly point: (reference: PointReference) => Vec3 | null;
  readonly pointWithIdentity: (reference: PointReference) => ResolvedPointWithIdentity | null;
  readonly axisFrames: ReadonlyMap<string, AxisFrame>;
} {
  const { offsetCurves, projectedCurves, subShape } = options;
  // 拘束まで解いた結果を覚える(FR-313)。**スケッチを解く場所は
  // この関数の中の 2 か所だけ**で、どちらも `resolveConstrainedSketch` を通す
  // (片方だけ差し替えると拘束が効かない経路が残る)。
  const resolvedSketches = new Map<string, ConstrainedSketch>();
  const resolvingSketches = new Set<string>();

  /**
   * 球の基本形状(FR-429)を id で引き、中心と半径にする(球面上の点 FR-431)。
   *
   * 球を引くのは部品文書の側の役目(`resolveCoordinate.ts` の `ResolveContext.sphere` の
   * 注釈)。中心は `sphereOrigin`(基本形状の基準点の解決)、半径は `shape.radius.value`
   * をそのまま使う(同じ規則を2か所に書かない)。
   *
   * **その時点までに解決できたスケッチだけ**を渡す。スケッチの解決はこの関数の中で
   * 「頼まれたときに解いて覚える」形になっており、球の基準点にまだ解けていないスケッチの
   * 点(`SolidOrigin.sketchPoint`)を指していれば `sphereOrigin` が null を
   * 返し、ここでは null(呼び出し側の「球が見つかりません」)になる。基準点に立体の頂点
   * (`SolidOrigin.vertex`)を指す球も同じ理由で解けない(`bodyKeys` はソリッドの段を作る前
   * なのでまだ空)。どちらも検証の範囲(座標で指定した球)には現れない。
   */
  function sphereAt(sphereFeatureId: string): ResolvedSphere | null {
    if (options.invalidInputs?.has(sphereFeatureId)) return null;
    const feature = document.solids.find((candidate) => candidate.id === sphereFeatureId);
    if (feature === undefined || feature.kind !== 'primitive' || feature.shape.kind !== 'sphere') {
      return null;
    }
    if (feature.suppressed) {
      // 抑制した球は画面に無いので、その球面上の点も置けない。
      return null;
    }
    const radius = feature.shape.radius.value;
    if (!Number.isFinite(radius) || radius <= 0) {
      return null;
    }
    const knownSketches: readonly ResolvedPartSketch[] = Array.from(
      resolvedSketches.entries(),
    ).map(([sketchId, constrained]) => toResolvedPartSketch(sketchId, constrained));
    const center = sphereOrigin(feature, knownSketches);
    return center === null ? null : { center, radius };
  }

  /**
   * スケッチの点の基準 'point' から部品の基準点を引く(組立の文脈の参照)。解くのは既存の
   * `resolver.point` だけ。座標の値(絶対)で決めた基準点だけを通す。頂点・辺・面・相対の基準点は
   * このスケッチから作る立体やスケッチに戻って循環し得るので断る。消えた基準点は none(従来の「見つからない」)。
   */
  function partPointAt(pointId: string): PartPointLookup {
    const feature = document.references.find((reference) => reference.id === pointId);
    if (feature === undefined) return NO_PART_POINT;
    if (feature.kind !== 'referencePoint') {
      return { kind: 'refused', text: { key: 'partError.coordinate.partPointNotReference', parameters: { id: pointId } } };
    }
    if (feature.definition.kind !== 'coordinate' || feature.definition.at.mode !== 'absolute') {
      return { kind: 'refused', text: { key: 'partError.coordinate.partPointNotAbsolute', parameters: { id: pointId, name: feature.name } } };
    }
    const position = resolver.point({ kind: 'point', pointId });
    return position === null ? { kind: 'refused', text: { key: 'partError.coordinate.partPointUnresolved', parameters: { id: pointId, name: feature.name } } } : { kind: 'point', position };
  }

  const solveOne = (sketch: SketchDocument): ConstrainedSketch =>
    resolveConstrainedSketch(sketch, {
      invalidInputs: options.invalidInputs,
      workerBrokenInputs: options.workerBrokenInputs,
      workPlane: (planeId) => resolver.workPlane(planeId),
      offsetCurves,
      projectedCurves,
      functionCurves: options.functionCurves,
      functionPoint: options.functionPoint,
      subShape,
      sphere: sphereAt,
      partPoint: partPointAt,
    });

  const resolver = createReferenceResolver(document, {
    functionPoint: options.functionPoint,
    invalidInputs: options.invalidInputs,
    sketch: (sketchId) => {
      const remembered = resolvedSketches.get(sketchId);
      if (remembered !== undefined) {
        return remembered.resolved;
      }
      if (resolvingSketches.has(sketchId)) {
        return null;
      }
      const found = document.sketches.find((sketch) => sketch.id === sketchId);
      if (found === undefined) {
        return null;
      }
      resolvingSketches.add(sketchId);
      const constrained = solveOne(found);
      resolvingSketches.delete(sketchId);
      resolvedSketches.set(sketchId, constrained);
      return constrained.resolved;
    },
    // 基準ジオメトリ(FR-328、FR-329)も同じ口で「いまの形」を見る。
    subShape,
  });

  // 基準ジオメトリを先に解く(スケッチが作図面として使うため)。中で必要になった
  // スケッチはその場で解かれ、覚えられる。
  const references = resolver.resolveAll();
  const axisFrames = new Map<string, AxisFrame>(
    references.axes.map((axis) => [axis.featureId, { origin: axis.origin, direction: axis.direction }]),
  );

  const sketches: ResolvedPartSketch[] = document.sketches.map((sketch) => {
    const remembered = resolvedSketches.get(sketch.id);
    const constrained = remembered ?? solveOne(sketch);
    if (remembered === undefined) {
      resolvedSketches.set(sketch.id, constrained);
    }
    return toResolvedPartSketch(sketch.id, constrained);
  });

  return {
    sketches,
    references,
    workPlane: resolver.workPlane,
    point: resolver.point,
    pointWithIdentity: resolver.pointWithIdentity,
    axisFrames,
  };
}
