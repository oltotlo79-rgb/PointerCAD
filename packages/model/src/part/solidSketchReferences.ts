/** 立体が参照するスケッチと履歴上の初回使用を集め、投影の解決順序へ渡す。 */
import type { AxisSpec, PlaneSpec } from '../geometry/planeSpec.js';
import type { PointReference, SketchDocument } from '../sketch/types.js';
import { constraintTargets, sketchConstraints } from '../sketch/constraints/types.js';
import { mapSketchCoordinates } from '../sketch/mapCoordinates.js';
import { sheetFeatureDependencies } from '../sheetMetal/featureInputs.js';
import type { PatternPlacement, RuledSection, SolidFeature, SurfaceOperation } from './types.js';

/** 軸の指定がスケッチの線分を指しているなら、そのスケッチの id。 */
function axisSketchIds(spec: AxisSpec): readonly string[] {
  return spec.kind === 'line' ? [spec.line.sketchId] : [];
}

/**
 * 点の参照(`PointReference`)が指しているスケッチの id(FR-325 の順序の制約)。
 *
 * `PointReference` は**どのスケッチかを持たない**(`{ kind: 'point'; pointId }` のように
 * フィーチャーの id だけ)ので、`resolveReferences.ts` と同じ約束で**全スケッチを id で
 * 探す**。座標の式・立体の頂点・球面上の点はスケッチを見ないので null になる。
 *
 * これが要るのは、拡大縮小の中心(FR-424)と点集合パターンの点(FR-425)だけが
 * 「スケッチを使うのに参照からスケッチ id を読めない」種類だからである。数え上げられないと
 * 順序の制約(投影のもとにできるのは、そのスケッチを使う立体より前の立体だけ)が
 * その 2 種で効かず、**自分より後の立体を投影したスケッチの点で穴を並べられてしまう**
 * ため、ここで数え上げる。
 */
export function sketchIdOfPointReference(
  reference: PointReference,
  sketches: readonly SketchDocument[],
): string | null {
  if (reference.kind === 'functionPoint') return reference.parent.kind === 'curve' ? reference.parent.sketchId : null;
  let featureId: string | null = null;
  if (reference.kind === 'point') {
    featureId = reference.pointId;
  } else if (reference.kind === 'vertex') {
    featureId = reference.featureId;
  }
  if (featureId === null) {
    return null;
  }
  const owner = sketches.find((sketch) =>
    sketch.features.some((feature) => feature.id === featureId),
  );
  return owner === undefined ? null : owner.id;
}

/** 点の参照の並びから、重複を除かずにスケッチの id を集める(並びは呼び出し側で使わない)。 */
function pointSketchIds(
  references: readonly PointReference[],
  sketches: readonly SketchDocument[],
): readonly string[] {
  return references.flatMap((reference) => {
    const sketchId = sketchIdOfPointReference(reference, sketches);
    return sketchId === null ? [] : [sketchId];
  });
}

/**
 * 1 つのソリッドフィーチャーが使うスケッチの id(FR-325 の順序の制約)。
 *
 * 「投影のもとにできるのは、そのスケッチを使う立体より前に作られた立体だけ」を
 * 機械的に判定するために要る。断面・回転軸・穴の中心・ばねの始点・パターンの向きの
 * どれもスケッチを指しうるので、種類ごとに列挙する(網羅 switch なので、
 * 新しいソリッドフィーチャーを足すとここで型検査が落ちて足し忘れを防げる)。
 */
export function referencedSketchIds(
  feature: SolidFeature,
  sketches: readonly SketchDocument[] = [],
): readonly string[] {
  switch (feature.kind) {
    case 'sheetBase': case 'sheetFlange': case 'sheetBend': case 'sheetRelief': return sheetFeatureDependencies(feature).sketchItems.map((item) => item.sketchId);
    case 'extrude':
      return [feature.profile.sketchId];
    case 'revolve':
      return [feature.profile.sketchId, ...axisSketchIds(feature.axis)];
    case 'sew':
      return feature.faces.map((face) => face.sketchId);
    case 'boolean':
      return [];
    case 'hole':
    case 'threadHole':
      return feature.centers.map((center) => center.sketchId);
    case 'fillet':
    case 'chamfer':
      // 辺・頂点の指紋しか持たない(スケッチを見ない)。
      return [];
    case 'pattern':
      return patternSketchIds(feature.placement, sketches);
    case 'spring':
      return [feature.origin.sketchId, ...axisSketchIds(feature.axis)];
    case 'primitive':
      // 基本形状(FR-429)。スケッチを見るのは中心にスケッチの点を指したときだけで、
      // 座標の式・立体の頂点はスケッチを使わない。向きの軸は他の種類と同じ扱い。
      return [
        ...(feature.origin.kind === 'sketchPoint' ? [feature.origin.ref.sketchId] : []),
        ...axisSketchIds(feature.axis),
      ];
    case 'ruled':
      // 面をつなぐ(FR-430)。スケッチを見るのは断面が「スケッチの面」のときだけで、
      // 立体の面・球はスケッチを使わない。
      return sectionSketchIds([feature.first, feature.second]);
    case 'loft':
      return sectionSketchIds(feature.sections);
    /*
      Should 群。**参照の欄はこの段で確定しているので、
      「どのスケッチを使うか」はいまここで正しく数え上げる**(解決の実装を待たない)。
      順序の制約は解決の成否と無関係に効く判定だからである。
    */
    case 'draft':
    case 'holeTranslate':
    case 'faceRotate':
    case 'faceOffset':
    case 'mirror':
    case 'threadShaft':
    case 'shell':
      // 面の指紋とフィーチャーの id しか持たない(スケッチを見ない)。
      // くり抜き(FR-418)も同じで、開ける面は指紋で持つ。
      return [];
    case 'emboss':
      // 相手の面は指紋で、輪郭だけがスケッチの面フィーチャー。
      return [feature.profile.sketchId];
    case 'transform':
      return feature.rotationAxis === null ? [] : axisSketchIds(feature.rotationAxis);
    case 'scale':
      // 中心の点はスケッチの点でありうる。`PointReference` は「どのスケッチか」を持たない
      // ので、**スケッチの一覧を渡されたときだけ** id で探して数える(
      // 渡されないときは以前のまま空——既存の呼び出しのふるまいを変えないため)。
      return pointSketchIds([feature.origin], sketches);
    case 'sweep':
      return [feature.profile.sketchId, feature.path.sketchId, ...(feature.guide === undefined ? [] : [feature.guide.sketchId])];
    case 'rib':
      return [feature.profile.sketchId];
    case 'surface':
      return surfaceSketchIds(feature.operation);
    case 'functionSurface':
      return [];
    case 'surfaceCut':
      return feature.blade.kind === 'extrusion' ? [feature.blade.profile.sketchId]
        : feature.blade.kind === 'plane' ? planeSketchIds(feature.blade.plane, sketches) : [];
    case 'cut':
      // 切断(FR-432)。切断面の点がスケッチの点でありうるので、拡大縮小の
      // 中心とまったく同じ扱いで id から探す(スケッチの一覧を渡されたときだけ数える)。
      return planeSketchIds(feature.plane, sketches);
    case 'importedSolid':
    case 'importedMesh':
      // 読み込んだ形(FR-802)。**スケッチを 1 本も見ない**(ファイルから入った
      // 形そのものなので、参照の欄が 1 つも無い)。
      return [];
  }
}

/**
 * 平面の指定(`PlaneSpec`)が使うスケッチの id(FR-325 の順序の制約)。
 *
 * 点は `PointReference` で「どのスケッチか」を持たないので、`scale` の中心・点集合
 * パターンと同じく **id で全スケッチから探す**(`pointSketchIds`)。面・辺は指紋なので
 * スケッチを見ない。基準にする作業平面(`workPlane` / `tilted`)が使うスケッチは
 * 基準ジオメトリ側の依存で、ここでは数えない(`referenceDependencies` の役目)。
 */
function planeSketchIds(
  spec: PlaneSpec,
  sketches: readonly SketchDocument[],
): readonly string[] {
  switch (spec.kind) {
    case 'threePoints':
      return pointSketchIds([spec.p1, spec.p2, spec.p3], sketches);
    case 'pointAndEdge':
    case 'pointAndParallelFace':
      return pointSketchIds([spec.point], sketches);
    case 'pointAndAxis':
      return [...pointSketchIds([spec.point], sketches), ...axisSketchIds(spec.axis)];
    case 'face':
    case 'workPlane':
      return [];
    case 'tilted':
      return axisSketchIds(spec.axis);
  }
}

/** パターンの並べ方が使うスケッチの id(FR-411、FR-412、FR-425)。 */
function patternSketchIds(
  placement: PatternPlacement,
  sketches: readonly SketchDocument[],
): readonly string[] {
  switch (placement.kind) {
    case 'linear':
      return axisSketchIds(placement.direction);
    case 'circular':
      return axisSketchIds(placement.axis);
    case 'points':
      // 点集合(FR-425)。`scale` の中心とまったく同じ扱いで、id から探す。
      return pointSketchIds(placement.points.map((point) => point.reference), sketches);
  }
}

/** 曲面の作り方が使うスケッチの id(FR-428)。 */
function surfaceSketchIds(operation: SurfaceOperation): readonly string[] {
  switch (operation.kind) {
    case 'extrude':
    case 'planar':
      return [operation.profile.sketchId];
    case 'revolve':
      return [operation.profile.sketchId, ...axisSketchIds(operation.axis)];
    case 'loft':
      return operation.sections.map((section) => section.sketchId);
    case 'face':
    case 'offset':
      // 立体の面を取り出す(離す)だけなのでスケッチを見ない。
      return [];
  }
}

/** 罫線面・ロフトの断面が使うスケッチの id(スケッチの面を指したものだけ)。 */
function sectionSketchIds(sections: readonly RuledSection[]): readonly string[] {
  return sections.flatMap((section) =>
    section.kind === 'sketchFace' || section.kind === 'sketchCurves' ? [section.ref.sketchId] : [],
  );
}

/**
 * スケッチごとに「そのスケッチを最初に使うソリッドフィーチャーの履歴上の位置」を作る。
 * 使われていないスケッチは表に入らない(= どの立体を参照してもよい)。
 * 抑制されたフィーチャー(FR-503)はボディを作らないので数えない。
 */
export function firstSketchUseIndexes(
  solids: readonly SolidFeature[],
  sketches: readonly SketchDocument[],
): ReadonlyMap<string, number> {
  const first = new Map<string, number>();
  solids.forEach((feature, index) => {
    if (feature.suppressed) {
      return;
    }
    for (const sketchId of referencedSketchIds(feature, sketches)) {
      if (!first.has(sketchId)) {
        first.set(sketchId, index);
      }
    }
  });
  return first;
}

/** Elements needed by one profile, including intra-sketch construction and constraints. */
export function sketchProfileFeatureIds(sketch: SketchDocument, rootId: string): ReadonlySet<string> {
  const ownerId = (id: string): string => id.split('#')[0];
  const features = new Map(sketch.features.map((feature) => [feature.id, feature]));
  const found = new Set<string>();
  const queue: string[] = [];
  const add = (id: string): void => {
    const owner = ownerId(id);
    if (features.has(owner) && !found.has(owner)) { found.add(owner); queue.push(owner); }
  };
  const constraints = sketchConstraints(sketch).map((constraint) => constraintTargets(constraint).map((target) =>
    ownerId(target.kind === 'point' ? target.pointId : target.kind === 'vertex' ? target.featureId : target.element.featureId)));
  add(rootId);
  for (let at = 0; at < queue.length; at += 1) {
    const id = queue[at], feature = features.get(id);
    if (feature === undefined) continue;
    if (feature.kind === 'face') feature.boundary.forEach((item) => add(item.featureId));
    if (feature.kind === 'copy' || feature.kind === 'offset') feature.source.forEach((item) => add(item.featureId));
    if (feature.kind === 'copy' && feature.placement.kind === 'mirror' && feature.placement.basis.kind === 'axis') {
      add(feature.placement.basis.axis.featureId);
    }
    let coordinateIndex = 0;
    mapSketchCoordinates(feature, (input) => {
      const first = coordinateIndex++ === 0;
      if (input.mode === 'absolute') return input;
      const base = input.base;
      if (base.kind === 'point') add(base.pointId);
      if (base.kind === 'vertex') add(base.featureId);
      if (base.kind === 'functionPoint') {
        if (base.parent.kind === 'curve' && base.parent.sketchId === sketch.id) add(base.parent.featureId);
        if (base.direction?.sourcePointId !== undefined) add(base.direction.sourcePointId);
      }
      // Later line/rectangle/slot/spline coordinates use their own preceding point.
      // Other previous bases may use any earlier successful non-face feature.
      const localPrevious = !first && (feature.kind === 'line' || feature.kind === 'rectangle'
        || feature.kind === 'slot' || feature.kind === 'spline');
      if (base.kind === 'previous' && !localPrevious) {
        for (const earlier of sketch.features) {
          if (earlier.id === id) break;
          if (earlier.kind !== 'face') add(earlier.id);
        }
      }
      return input;
    });
    for (const targets of constraints) if (targets.includes(id)) targets.forEach(add);
  }
  return found;
}
