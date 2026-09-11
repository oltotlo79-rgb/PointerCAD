/**
 * タイムライン(FR-507)の並び・依存・並べ替えの妥当性と、途中までの文書(FR-506)
 * (計画書 docs/plans/P4b-スケッチの仕上げ.md §2.7、タスク9)。
 *
 * **帯の並び**: `references`(順)→ `solids`(順)の 1 本の通し(§0.a-0.20)。
 * スケッチ(`PartDocument.sketches`)は帯に出さない。配列ではあるが履歴ではなく、
 * 「何番目に作られたか」を表す欄をどこにも持たないためである(帯へ混ぜると、
 * 作られた順を推測で決めることになる)。スケッチは、それを使う立体の依存として
 * 間接的に帯へ効く(下の「立体 → スケッチ → 立体」)。
 *
 * **依存の集め方**: 「他のフィーチャーを指す欄」をすべて数え上げ、指し先が帯の中の
 * ものなら辺を 1 本張る。既にある正本は写さずそのまま呼ぶ。
 *
 * | 依存 | 材料(正本) |
 * |---|---|
 * | 立体 → 立体(消費) | `consumedTargetsOf`(createPartDocument.ts) |
 * | 立体 → スケッチ → 立体 / 作業平面 | `referencedSketchIds`(resolvePart.ts)+ そのスケッチの依存 |
 * | 立体 → 立体(部分形状) | `SubShapeRef.bodyFeatureId`(穴・ねじ穴の面、フィレット・面取りの辺) |
 * | 立体 → 立体(消費しないが指す) | ミラーの対象・鏡の面、曲面の `face`、罫線面/ロフトの立体の面と球、基本形状の頂点、押し出しの「選んだ面まで」(P5 タスク45) |
 * | 立体 → 基準ジオメトリ | `AxisSpec` の `reference`(回転軸・パターンの向き・ばねの軸) |
 * | 基準ジオメトリ → 何でも | `PlaneSpec` / `ReferenceAxisDefinition` / `ReferencePointDefinition` / `AxisSpec` / `PointReference` |
 * | スケッチ → 立体 | 投影(`SketchProjectedCurveFeature.source`)・交差(`planeSection.targetFeatureId`)・3D スケッチの頂点参照(`PointReference` の `subShape`)・球面上の点(同 `sphereGrid`、FR-431) |
 * | スケッチ → 基準ジオメトリ | 各要素の作図面 `planeId`(任意の作業平面 FR-328)、鏡像の平面 |
 *
 * **順序の規則は 1 つだけ**: 「どのフィーチャーも、自分が指す先より後ろにいる」。
 * 既存の `resolveReferences.ts`(基準ジオメトリの前方参照の禁止)と `resolvePart.ts`
 * (投影のもとはスケッチを使う立体より前)が解決のときに断っているものと同じ規約で、
 * ここでは**並べ替える前に**同じことを判定して、実行してから失敗させない(NFR-UX-5)。
 *
 * 例外を投げず、断りは日本語で相手の名前つきに返す(FR-504、NFR-RE-1)。
 */

import type { AxisSpec, PlaneSpec } from '../geometry/planeSpec.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { WorkPlaneId } from '../sketch/planeMath.js';
import type {
  CoordinateInput,
  CopyPlacement,
  PointArrayLayout,
  PointReference,
  SketchDocument,
  SketchFeature,
} from '../sketch/types.js';
import { consumedTargetsOf } from './createPartDocument.js';
import { referencedSketchIds } from './resolvePart.js';
import type {
  PartDocument,
  ReferenceAxisDefinition,
  ReferenceFeature,
  ReferenceFeatureKind,
  ReferencePointDefinition,
  RuledSection,
  SolidFeature,
  SolidFeatureKind,
} from './types.js';

/** 帯の 1 件がどちらの履歴のものか。配列が 2 本あるので、差し込み位置の計算に要る。 */
export type TimelineSection = 'reference' | 'solid';

/** タイムラインの帯に並べる 1 つ。`references`(順)→ `solids`(順)の通し。 */
export interface TimelineEntry {
  /** 帯の中の通し番号(0 始まり)。つまみの位置はこの番号で表す。 */
  readonly index: number;
  readonly section: TimelineSection;
  readonly featureId: string;
  readonly name: string;
  readonly kind: ReferenceFeatureKind | SolidFeatureKind;
  /**
   * 抑制されているか(FR-503)。抑制は削除ではないので帯には出る。
   * 基準ジオメトリは抑制の欄を持たない(`visible` は表示の切替であって、
   * 非表示でも参照はできる)ので常に false。
   */
  readonly suppressed: boolean;
}

/** 並べ替えを断った理由。`blockingFeatureId` は原因になったフィーチャー。 */
export interface ReorderRefusal {
  readonly ok: false;
  /** 日本語の理由。相手のフィーチャーの名前を必ず含める(FR-504、NFR-UX-5)。 */
  readonly reason: string;
  /**
   * 断りの原因になったフィーチャーの id。依存が壊れるときは「壊れる側」
   * (指している方)の id。位置が履歴の外だったときだけ空文字になる。
   */
  readonly blockingFeatureId: string;
}

export type ReorderOutcome = { readonly ok: true; readonly document: PartDocument } | ReorderRefusal;

/** 動かせるかどうかだけを見た結果(文書を作らない)。 */
export type MoveCheck = { readonly ok: true } | ReorderRefusal;

/* ------------------------------------------------------------------ *
 * 帯を組み立てる
 * ------------------------------------------------------------------ */

/** 帯に並べる 1 本の列を作る(FR-507)。抑制された段も出す(FR-503)。 */
export function buildTimeline(document: PartDocument): readonly TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const feature of document.references) {
    entries.push({
      index: entries.length,
      section: 'reference',
      featureId: feature.id,
      name: feature.name,
      kind: feature.kind,
      suppressed: false,
    });
  }
  for (const feature of document.solids) {
    entries.push({
      index: entries.length,
      section: 'solid',
      featureId: feature.id,
      name: feature.name,
      kind: feature.kind,
      suppressed: feature.suppressed,
    });
  }
  return entries;
}

/** 帯の中の通し番号。履歴に無ければ null。 */
export function timelineIndexOf(document: PartDocument, featureId: string): number | null {
  const found = buildTimeline(document).find((entry) => entry.featureId === featureId);
  return found === undefined ? null : found.index;
}

/* ------------------------------------------------------------------ *
 * 依存グラフ
 * ------------------------------------------------------------------ */

/** 依存を集めるときの手掛かり。文書 1 つにつき 1 回だけ組み立てる。 */
interface DependencyContext {
  /** 基準ジオメトリの id。 */
  readonly referenceIds: ReadonlySet<string>;
  /** 立体(= ボディ)の id。 */
  readonly solidIds: ReadonlySet<string>;
  readonly sketches: readonly SketchDocument[];
  /** スケッチの要素の id → そのスケッチの id。部品文書からの点・端点の参照を引く。 */
  readonly sketchOfElement: ReadonlyMap<string, string>;
  /** スケッチ 1 本ぶんの依存の覚え書き(同じスケッチを何度も歩かないため)。 */
  readonly sketchCache: Map<string, readonly string[]>;
}

function createContext(document: PartDocument): DependencyContext {
  const sketchOfElement = new Map<string, string>();
  for (const sketch of document.sketches) {
    for (const feature of sketch.features) {
      // 同じ id が 2 本のスケッチにあるときは先に出たほうを採る(決定性のため。
      // resolveReferences.ts の点の探し方と同じ約束)。
      if (!sketchOfElement.has(feature.id)) {
        sketchOfElement.set(feature.id, sketch.id);
      }
    }
  }
  return {
    referenceIds: new Set(document.references.map((feature) => feature.id)),
    solidIds: new Set(document.solids.map((feature) => feature.id)),
    sketches: document.sketches,
    sketchOfElement,
    sketchCache: new Map(),
  };
}

/** 並び順を保ったまま重複を落とす。 */
function dedupe(ids: readonly string[]): readonly string[] {
  return ids.length <= 1 ? ids : [...new Set(ids)];
}

/** 指し先が基準ジオメトリなら 1 本の辺、そうでなければ辺なし。 */
function referenceDependency(context: DependencyContext, featureId: string): readonly string[] {
  return context.referenceIds.has(featureId) ? [featureId] : [];
}

/** 指し先が立体なら 1 本の辺、そうでなければ辺なし。 */
function solidDependency(context: DependencyContext, featureId: string): readonly string[] {
  return context.solidIds.has(featureId) ? [featureId] : [];
}

/** 面・辺・頂点の参照は、その形を持つボディへの依存になる。 */
function subShapeDependencies(context: DependencyContext, ref: SubShapeRef): readonly string[] {
  return solidDependency(context, ref.bodyFeatureId);
}

/**
 * 作図面の id は、基準の 3 面(`'xy'` 等)・3D スケッチ(`'free'`)・任意の作業平面
 * (基準ジオメトリの id)のいずれか。最後のときだけ依存になる。
 */
function workPlaneDependencies(
  context: DependencyContext,
  planeId: WorkPlaneId,
): readonly string[] {
  return referenceDependency(context, planeId);
}

/** スケッチの要素の id(点列の n 番目は `featureId#n`)から、それを持つスケッチを引く。 */
function sketchIdOfElement(context: DependencyContext, elementId: string): string | null {
  const separator = elementId.indexOf('#');
  const featureId = separator < 0 ? elementId : elementId.slice(0, separator);
  return context.sketchOfElement.get(featureId) ?? null;
}

function axisSpecDependencies(context: DependencyContext, spec: AxisSpec): readonly string[] {
  switch (spec.kind) {
    case 'world':
      return [];
    case 'line':
      return sketchDependencies(context, spec.line.sketchId);
    case 'reference':
      return referenceDependency(context, spec.referenceFeatureId);
  }
}

function pointReferenceDependencies(
  context: DependencyContext,
  reference: PointReference,
): readonly string[] {
  switch (reference.kind) {
    case 'origin':
      return [];
    case 'previous':
      // 「直前の点」は同じスケッチの中の文脈で、他のフィーチャーを指さない。
      return [];
    case 'point': {
      // 部品文書では基準点を先に見て、無ければスケッチの点を探す
      // (resolveReferences.ts の `pointAt` と同じ順序)。
      const asReference = referenceDependency(context, reference.pointId);
      if (asReference.length > 0) {
        return asReference;
      }
      const sketchId = sketchIdOfElement(context, reference.pointId);
      return sketchId === null ? [] : sketchDependencies(context, sketchId);
    }
    case 'vertex': {
      const sketchId = sketchIdOfElement(context, reference.featureId);
      return sketchId === null ? [] : sketchDependencies(context, sketchId);
    }
    case 'subShape':
      return subShapeDependencies(context, reference.ref);
    case 'sphereGrid':
      // 球面上の点(FR-431、P5 タスク19)は球そのものに乗っているので、球のフィーチャーへ
      // 依存する。球の半径・中心を変えると点が動く(要件 FR-431)ことを、依存の向きでも表す。
      return solidDependency(context, reference.sphereFeatureId);
  }
}

function coordinateDependencies(
  context: DependencyContext,
  input: CoordinateInput,
): readonly string[] {
  return input.mode === 'absolute' ? [] : pointReferenceDependencies(context, input.base);
}

function pointArrayDependencies(
  context: DependencyContext,
  layout: PointArrayLayout,
): readonly string[] {
  switch (layout.kind) {
    case 'linear':
      return coordinateDependencies(context, layout.base);
    case 'circular':
      return coordinateDependencies(context, layout.center);
    case 'grid':
      return coordinateDependencies(context, layout.base);
  }
}

function copyPlacementDependencies(
  context: DependencyContext,
  placement: CopyPlacement,
): readonly string[] {
  switch (placement.kind) {
    case 'mirror':
      // 軸は同じスケッチの線分なので依存にならない。平面は作業平面を指しうる。
      return placement.basis.kind === 'plane'
        ? workPlaneDependencies(context, placement.basis.planeId)
        : [];
    case 'translate':
      return coordinateDependencies(context, placement.delta);
    case 'linearArray':
      return coordinateDependencies(context, placement.direction);
    case 'circularArray':
      return coordinateDependencies(context, placement.center);
  }
}

/**
 * スケッチの要素 1 つが、帯の中の何を指しているか。
 * 網羅 switch にしてあるので、新しい種類を足すとここで型検査が落ちて足し忘れを防げる。
 */
function sketchFeatureDependencies(
  context: DependencyContext,
  feature: SketchFeature,
): readonly string[] {
  switch (feature.kind) {
    case 'point':
      return coordinateDependencies(context, feature.at);
    case 'line':
      return [
        ...coordinateDependencies(context, feature.from),
        ...coordinateDependencies(context, feature.to),
      ];
    case 'arc': {
      const orientation = feature.freeOrientation;
      return [
        ...coordinateDependencies(context, feature.center),
        ...(orientation === undefined
          ? []
          : [
              ...coordinateDependencies(context, orientation.normal),
              ...coordinateDependencies(context, orientation.xAxis),
            ]),
      ];
    }
    case 'pointArray':
      return pointArrayDependencies(context, feature.layout);
    case 'face':
      // 境界に並ぶのは同じスケッチの要素だけ(帯の外)。
      return [];
    case 'rectangle':
      return [
        ...coordinateDependencies(context, feature.corner1),
        ...coordinateDependencies(context, feature.corner2),
      ];
    case 'polygon':
      return coordinateDependencies(context, feature.center);
    case 'slot':
      return [
        ...coordinateDependencies(context, feature.center1),
        ...coordinateDependencies(context, feature.center2),
      ];
    case 'ellipse':
      return coordinateDependencies(context, feature.center);
    case 'spline':
      return feature.points.flatMap((point) => coordinateDependencies(context, point));
    case 'offset':
      // オフセットが持つのは同じスケッチの要素の参照と距離だけ。
      return [];
    case 'copy':
      return copyPlacementDependencies(context, feature.placement);
    case 'projectedCurve':
      return subShapeDependencies(context, feature.source);
    case 'planeSection':
      return solidDependency(context, feature.targetFeatureId);
  }
}

/**
 * スケッチ 1 本が帯の中の何を指しているか(作図面の作業平面と、投影・交差・頂点参照の立体)。
 *
 * 覚え書きへ先に空を入れてから歩くのは、スケッチの中の点が同じスケッチの点を基準に
 * している(相対座標)ときに自分自身を呼び戻すため。外側の呼び出しが全部を集めるので、
 * 呼び戻された側は空を返してよい。
 *
 * 拘束(`SketchDocument.constraints`、FR-313)は見ない。`ConstraintTarget` が指せるのは
 * 同じスケッチの点・端点・曲線だけで、帯の中のものを指す欄を持たないため。
 */
function sketchDependencies(context: DependencyContext, sketchId: string): readonly string[] {
  const remembered = context.sketchCache.get(sketchId);
  if (remembered !== undefined) {
    return remembered;
  }
  context.sketchCache.set(sketchId, []);
  const sketch = context.sketches.find((candidate) => candidate.id === sketchId);
  if (sketch === undefined) {
    return [];
  }
  const found: string[] = [];
  for (const feature of sketch.features) {
    found.push(...workPlaneDependencies(context, feature.planeId));
    found.push(...sketchFeatureDependencies(context, feature));
  }
  const unique = dedupe(found);
  context.sketchCache.set(sketchId, unique);
  return unique;
}

/**
 * ソリッドフィーチャー 1 つが指しているもの。
 *
 * 消費(ブーリアンの対象と相手・加工の対象・パターンのもと)は `consumedTargetsOf`、
 * 使うスケッチは `referencedSketchIds` が正本なので、ここには写さずそのまま呼ぶ。
 * 残るのは部分形状の参照(`SubShapeRef`)と基準軸の参照だけで、そこだけを網羅 switch で
 * 数え上げる(新しい種類を足すと型検査が落ちる)。
 */
function solidDependencies(
  context: DependencyContext,
  feature: SolidFeature,
): readonly string[] {
  const found: string[] = [];
  for (const consumedId of consumedTargetsOf(feature)) {
    found.push(...solidDependency(context, consumedId));
  }
  // スケッチの一覧を渡すのは、拡大縮小の中心と点集合パターンの点(`PointReference`)が
  // 「どのスケッチか」を持たず、id で探さないと数えられないためである(タスク46)。
  for (const sketchId of referencedSketchIds(feature, context.sketches)) {
    found.push(...sketchDependencies(context, sketchId));
  }
  switch (feature.kind) {
    case 'sew':
    case 'boolean':
      // 面の参照と対象の id だけで、上の 2 つに数え終えている。
      break;
    case 'extrude':
      /*
        押し出し(FR-401、FR-415)。「選んだ面まで」(`end.toFace`)だけが立体の面を指す
        (P5 タスク43・45)。**消費しないが上流を指す**ので、ここで数えないと
        「面を借りている立体」より前へ押し出しを動かせてしまう(FR-507)。
        「次の面まで」(`toNext`)は相手を指す欄を持たない(解決が「直前の生きた立体」を
        選ぶ)ので、文書だけを見るここでは数えられない。
      */
      if (feature.end !== undefined && feature.end.kind === 'toFace') {
        found.push(...subShapeDependencies(context, feature.end.face));
      }
      break;
    case 'revolve':
      found.push(...axisSpecDependencies(context, feature.axis));
      break;
    case 'hole':
    case 'threadHole':
      found.push(...subShapeDependencies(context, feature.face));
      break;
    case 'fillet':
    case 'chamfer':
      for (const target of feature.targets) {
        found.push(...subShapeDependencies(context, target));
      }
      break;
    case 'pattern':
      // 点集合(FR-425、P5 タスク43)は軸を持たないので、軸の依存は数えない
      // (点そのものの依存は `PointReference` が id しか持たず追えない。t46 への申し送り)。
      if (feature.placement.kind !== 'points') {
        found.push(
          ...axisSpecDependencies(
            context,
            feature.placement.kind === 'linear'
              ? feature.placement.direction
              : feature.placement.axis,
          ),
        );
      }
      break;
    case 'spring':
      found.push(...axisSpecDependencies(context, feature.axis));
      break;
    case 'primitive':
      // 基本形状(FR-429)。中心に立体の頂点を指したときだけ上流を指す(**消費しない**、
      // §0.a-0.19)。向きの軸は他の種類と同じ扱い。
      if (feature.origin.kind === 'vertex') {
        found.push(...subShapeDependencies(context, feature.origin.ref));
      }
      found.push(...axisSpecDependencies(context, feature.axis));
      break;
    case 'ruled':
      found.push(...ruledSectionDependencies(context, [feature.first, feature.second]));
      break;
    case 'loft':
      found.push(...ruledSectionDependencies(context, feature.sections));
      break;
    case 'draft':
      // 抜き勾配(FR-417)。対象は消費するので上で数え終えているが、面の指紋は別の
      // ボディを指しうる(解決は断るが、並べ替えの判定は解決の成否と無関係に効く)。
      for (const face of [...feature.faces, feature.neutralFace]) {
        found.push(...subShapeDependencies(context, face));
      }
      break;
    case 'mirror':
      /*
        ミラー(FR-419、§0.a-0.36)。**対象を消費しないので `consumedTargetsOf` には
        現れない**が、鏡に映すもとの立体は必ず自分より前になければならない
        (docs/報告記録.md 2026-09-05 19:38 の t45 への申し送り)。鏡が立体の面のときは
        その面を持つ立体も同じ理由で数える。
      */
      found.push(...solidDependency(context, feature.targetFeatureId));
      if (feature.plane.kind === 'workPlane') {
        found.push(...workPlaneDependencies(context, feature.plane.planeId));
      } else {
        found.push(...subShapeDependencies(context, feature.plane.face));
      }
      break;
    case 'transform':
      // 移動/回転(FR-424)。対象は消費するので上で数え終えている。軸だけを足す。
      if (feature.rotationAxis !== null) {
        found.push(...axisSpecDependencies(context, feature.rotationAxis));
      }
      break;
    case 'scale':
      // 拡大縮小(FR-424)。中心は `PointReference` なので、基準点・立体の頂点を
      // 指していれば数えられる(スケッチの点は id から引く。`pointReferenceDependencies`)。
      found.push(...pointReferenceDependencies(context, feature.origin));
      break;
    case 'sweep':
      // スイープ(FR-409)。断面も経路もスケッチの中なので、上のスケッチの依存で数え終えている。
      break;
    case 'rib':
      // リブ(FR-420)。対象は消費するので上で数え終えており、輪郭はスケッチの中にある。
      break;
    case 'emboss':
    case 'threadShaft':
      // エンボス・外ねじ(FR-421、FR-423)。対象は消費するので上で数え終えているが、
      // 面の指紋は別のボディを指しうる(解決は断るが、並べ替えの判定は解決の成否と無関係)。
      found.push(...subShapeDependencies(context, feature.face));
      break;
    case 'surface':
      /*
        曲面(FR-428、§0.a-0.45)。**どの作り方でも消費しない**が、`face`(立体の面を
        取り出す)のときだけ上流を指すので、ミラーと同じ理由で数える(t45 への申し送り)。
        ほかの 4 種はスケッチの面・軸だけで、上の 2 つに数え終えている。
      */
      if (feature.operation.kind === 'face' || feature.operation.kind === 'offset') {
        // 面を借りる立体は `targetFeatureId` と面の指紋の両方が指す(ふつうは同じ id)。
        // 面のオフセット(タスク42b の 6 種目)も面を借りるだけなので同じ扱い。
        found.push(...solidDependency(context, feature.operation.targetFeatureId));
        found.push(...subShapeDependencies(context, feature.operation.face));
      } else if (feature.operation.kind === 'revolve') {
        found.push(...axisSpecDependencies(context, feature.operation.axis));
      }
      break;
    case 'shell':
      // くり抜き(FR-418、§2.12)。対象は消費するので上で数え終えているが、開ける面の
      // 指紋は別のボディを指しうる(解決は断るが、並べ替えの判定は解決の成否と無関係)。
      for (const face of feature.openFaces) {
        found.push(...subShapeDependencies(context, face));
      }
      break;
    case 'cut':
      /*
        平面による切断(FR-432、§2.9b、タスク27c)。対象は消費するので上で数え終えているが、
        **切断面が指すもの**(点・辺・面・軸・作業平面)は別のボディや基準ジオメトリを
        指しうる。基準ジオメトリの平面とまったく同じものを指せるので、
        `planeSpecDependencies` をそのまま使う(規則を 2 か所に書かない)。
        `pairedWith` は依存ではない(対の相手は同じ対象を切るだけで、互いを材料にしない)。
      */
      found.push(...planeSpecDependencies(context, feature.plane));
      break;
    case 'importedSolid':
    case 'importedMesh':
      /*
        読み込んだ形の 2 種(FR-802、P6 §2.8、タスク20)。**依存は 1 つも無い。**
        スケッチも立体の面も基準ジオメトリも指さず、ファイルから入った形そのものを
        持っているだけなので、履歴のどこへでも動かせる(FR-507)。
      */
      break;
  }
  return found;
}

/**
 * 罫線面・ロフト(FR-430、FR-410)の断面が指しているもの。
 *
 * **立体の面(`solidFace`)と球(`sphere`)は消費しない**ので `consumedTargetsOf` には
 * 現れないが、輪郭を借りるもとの立体は必ず自分より前になければならない
 * (docs/報告記録.md 2026-09-05 19:38 の t45 への申し送り)。
 * スケッチの面は上のスケッチの依存で数え終えている。
 */
function ruledSectionDependencies(
  context: DependencyContext,
  sections: readonly RuledSection[],
): readonly string[] {
  return sections.flatMap((section) => {
    switch (section.kind) {
      case 'sketchFace':
      case 'sketchCurves':
        return [];
      case 'sphere':
        return solidDependency(context, section.sphereFeatureId);
      case 'solidFace':
        return subShapeDependencies(context, section.ref);
    }
  });
}

function referenceAxisDependencies(
  context: DependencyContext,
  definition: ReferenceAxisDefinition,
): readonly string[] {
  switch (definition.kind) {
    case 'twoPoints':
      return [
        ...pointReferenceDependencies(context, definition.from),
        ...pointReferenceDependencies(context, definition.to),
      ];
    case 'edge':
      return subShapeDependencies(context, definition.edge);
    case 'faceNormal':
      return subShapeDependencies(context, definition.face);
    case 'faceIntersection':
      return [
        ...subShapeDependencies(context, definition.face1),
        ...subShapeDependencies(context, definition.face2),
      ];
  }
}

function referencePointDependencies(
  context: DependencyContext,
  definition: ReferencePointDefinition,
): readonly string[] {
  switch (definition.kind) {
    case 'coordinate':
      return coordinateDependencies(context, definition.at);
    case 'vertex':
      return subShapeDependencies(context, definition.vertex);
    case 'edgeMidpoint':
      return subShapeDependencies(context, definition.edge);
    case 'faceCenter':
      return subShapeDependencies(context, definition.face);
  }
}

function planeSpecDependencies(
  context: DependencyContext,
  spec: PlaneSpec,
): readonly string[] {
  switch (spec.kind) {
    case 'threePoints':
      return [
        ...pointReferenceDependencies(context, spec.p1),
        ...pointReferenceDependencies(context, spec.p2),
        ...pointReferenceDependencies(context, spec.p3),
      ];
    case 'pointAndEdge':
      return [
        ...pointReferenceDependencies(context, spec.point),
        ...subShapeDependencies(context, spec.edge),
      ];
    case 'pointAndAxis':
      return [
        ...pointReferenceDependencies(context, spec.point),
        ...axisSpecDependencies(context, spec.axis),
      ];
    case 'pointAndParallelFace':
      return [
        ...pointReferenceDependencies(context, spec.point),
        ...subShapeDependencies(context, spec.face),
      ];
    case 'face':
      return subShapeDependencies(context, spec.face);
    case 'workPlane':
      return workPlaneDependencies(context, spec.planeId);
    case 'tilted':
      return [
        ...workPlaneDependencies(context, spec.base),
        ...axisSpecDependencies(context, spec.axis),
      ];
  }
}

/** 基準ジオメトリ 1 つが指しているもの。 */
function referenceDependencies(
  context: DependencyContext,
  feature: ReferenceFeature,
): readonly string[] {
  switch (feature.kind) {
    case 'referencePlane':
      return planeSpecDependencies(context, feature.plane);
    case 'referenceAxis':
      return referenceAxisDependencies(context, feature.definition);
    case 'referencePoint':
      return referencePointDependencies(context, feature.definition);
    case 'referenceCoordinateSystem':
      return [
        ...pointReferenceDependencies(context, feature.origin),
        ...axisSpecDependencies(context, feature.xAxis),
        ...axisSpecDependencies(context, feature.yAxis),
      ];
  }
}

/**
 * 帯の全項目について「自分より前になければならない項目の id」を作る(FR-507)。
 *
 * 自分自身への辺は落とす。参照が自分へ戻ってくる文書(作業平面 → スケッチの点 →
 * その作業平面)は解決のときに `circularReference` として断られるもので、
 * 並べ替えの可否をここで二重に断らない(同じ規約を 2 か所に書かない)。
 */
export function historyDependencies(
  document: PartDocument,
): ReadonlyMap<string, readonly string[]> {
  const context = createContext(document);
  const graph = new Map<string, readonly string[]>();
  for (const feature of document.references) {
    graph.set(feature.id, withoutSelf(feature.id, referenceDependencies(context, feature)));
  }
  for (const feature of document.solids) {
    graph.set(feature.id, withoutSelf(feature.id, solidDependencies(context, feature)));
  }
  return graph;
}

function withoutSelf(featureId: string, ids: readonly string[]): readonly string[] {
  return dedupe(ids).filter((id) => id !== featureId);
}

/** そのフィーチャーが参照している(自分より前になければならない)フィーチャーの id。 */
export function dependenciesOf(
  document: PartDocument,
  featureId: string,
): readonly string[] {
  return historyDependencies(document).get(featureId) ?? [];
}

/* ------------------------------------------------------------------ *
 * 並べ替えの妥当性
 * ------------------------------------------------------------------ */

/** 並びの中で最初に見つかった「指し先が自分より後ろ」。無ければ null。 */
interface DependencyViolation {
  /** 壊れる側(指している方)。 */
  readonly dependent: TimelineEntry;
  /** 指されている方。 */
  readonly dependency: TimelineEntry;
}

/**
 * 並び**全体**を検査する(1 件ずつ場当たりに判定しない)。
 * 見るのは配列の位置であって `TimelineEntry.index` ではない(並べ替えた後の仮の並びを
 * そのまま渡せるようにするため)。
 */
function firstViolation(
  order: readonly TimelineEntry[],
  graph: ReadonlyMap<string, readonly string[]>,
): DependencyViolation | null {
  const position = new Map<string, number>();
  order.forEach((entry, index) => {
    if (!position.has(entry.featureId)) {
      position.set(entry.featureId, index);
    }
  });
  for (let index = 0; index < order.length; index += 1) {
    const entry = order[index];
    for (const dependencyId of graph.get(entry.featureId) ?? []) {
      const at = position.get(dependencyId);
      if (at !== undefined && at >= index) {
        return { dependent: entry, dependency: order[at] };
      }
    }
  }
  return null;
}

/** from の位置のものを抜き、to の位置へ差し込んだ新しい配列。 */
function moveInArray<T>(items: readonly T[], from: number, to: number): readonly T[] {
  const moved = items[from];
  const rest = items.filter((_, index) => index !== from);
  return [...rest.slice(0, to), moved, ...rest.slice(to)];
}

interface ReorderPlan {
  readonly section: TimelineSection;
  readonly arrayFrom: number;
  readonly arrayTo: number;
}

/** 並べ替えの下調べ。`plan` が null なら動かす必要が無い(from === to)。 */
type ReorderPlanOutcome = { readonly ok: true; readonly plan: ReorderPlan | null } | ReorderRefusal;

function planReorder(document: PartDocument, from: number, to: number): ReorderPlanOutcome {
  const entries = buildTimeline(document);
  if (!Number.isInteger(from) || from < 0 || from >= entries.length) {
    return { ok: false, reason: '動かすものが履歴の中にありません。', blockingFeatureId: '' };
  }
  const moved = entries[from];
  if (!Number.isInteger(to) || to < 0 || to >= entries.length) {
    return {
      ok: false,
      reason: `${moved.name}を置こうとした位置が履歴の外です。`,
      blockingFeatureId: moved.featureId,
    };
  }
  if (from === to) {
    return { ok: true, plan: null };
  }
  // 先に依存を見るのは、断りの理由として「どのフィーチャーが困るのか」が
  // いちばん役に立つため(FR-504)。置き場の食い違いはその後に見る。
  const violation = firstViolation(moveInArray(entries, from, to), historyDependencies(document));
  if (violation !== null) {
    return {
      ok: false,
      reason:
        `${violation.dependent.name}は${violation.dependency.name}を使っているので、` +
        `${violation.dependency.name}より後ろでなければなりません。`,
      blockingFeatureId: violation.dependent.featureId,
    };
  }
  // 基準ジオメトリと立体は別々の配列なので、帯の上でも互いの区間へは入れない。
  const referenceCount = document.references.length;
  const insideSection = moved.section === 'reference' ? to < referenceCount : to >= referenceCount;
  if (!insideSection) {
    return {
      ok: false,
      reason:
        moved.section === 'reference'
          ? `${moved.name}は基準ジオメトリなので、立体の間へは動かせません。`
          : `${moved.name}は立体なので、基準ジオメトリの間へは動かせません。`,
      blockingFeatureId: moved.featureId,
    };
  }
  const offset = moved.section === 'reference' ? 0 : referenceCount;
  return { ok: true, plan: { section: moved.section, arrayFrom: from - offset, arrayTo: to - offset } };
}

/**
 * 帯の from の位置のものを to の位置へ動かす(FR-507)。
 * 依存を壊すなら理由つきで断り、文書は変えない(FR-504)。
 */
export function reorderTimeline(
  document: PartDocument,
  from: number,
  to: number,
): ReorderOutcome {
  const outcome = planReorder(document, from, to);
  if (!outcome.ok) {
    return outcome;
  }
  if (outcome.plan === null) {
    // 動かす必要が無いときは同じ文書をそのまま返す(形状キャッシュの鍵を変えない)。
    return { ok: true, document };
  }
  const { section, arrayFrom, arrayTo } = outcome.plan;
  return {
    ok: true,
    document:
      section === 'reference'
        ? { ...document, references: moveInArray(document.references, arrayFrom, arrayTo) }
        : { ...document, solids: moveInArray(document.solids, arrayFrom, arrayTo) },
  };
}

/**
 * そのフィーチャーを帯の `newIndex` へ動かせるか(ドラッグ中の予告に使う。NFR-UX-5)。
 * 文書を作らないので、ドラッグのたびに何度呼んでもよい。
 */
export function canMoveHistoryItem(
  document: PartDocument,
  featureId: string,
  newIndex: number,
): MoveCheck {
  const from = timelineIndexOf(document, featureId);
  if (from === null) {
    return { ok: false, reason: '動かすものが履歴の中にありません。', blockingFeatureId: '' };
  }
  const outcome = planReorder(document, from, newIndex);
  return outcome.ok ? { ok: true } : outcome;
}

/** そのフィーチャーを帯の `newIndex` へ動かした新しい文書(`reorderTimeline` の id 版)。 */
export function moveHistoryItem(
  document: PartDocument,
  featureId: string,
  newIndex: number,
): ReorderOutcome {
  const from = timelineIndexOf(document, featureId);
  if (from === null) {
    return { ok: false, reason: '動かすものが履歴の中にありません。', blockingFeatureId: '' };
  }
  return reorderTimeline(document, from, newIndex);
}

/* ------------------------------------------------------------------ *
 * 途中までの文書(ロールバック、FR-506)
 * ------------------------------------------------------------------ */

/** つまみを `index` に置いたとき、各配列に残る件数。抑制も 1 件として数える(帯の見た目と揃える)。 */
function cutCounts(
  document: PartDocument,
  index: number,
): { readonly references: number; readonly solids: number } {
  const kept = index + 1;
  return {
    references: Math.min(Math.max(kept, 0), document.references.length),
    solids: Math.min(Math.max(kept - document.references.length, 0), document.solids.length),
  };
}

/**
 * つまみを `index` に置いたときの「途中までの文書」(FR-506、FR-507)。
 * `index` は帯の通し番号で、**その段までを含む**。`null` なら文書そのもの。
 *
 * **フィーチャーそのものは複製しない**(配列を切るだけ)。複製すると
 * `resolvePart` が作る段の鍵が変わり、つまみを動かすたびに全段が作り直しになる
 * (NFR-PF-3 に反する)。つまみの位置は保存しないので、この関数は文書へ欄を足さない
 * (§0.a-0.19。抑制 `suppressed` は利用者の指定であって、つまみとは別のもの)。
 */
export function documentUpTo(document: PartDocument, index: number | null): PartDocument {
  const total = document.references.length + document.solids.length;
  if (index === null || index >= total - 1) {
    // 末尾(またはそれ以降)なら切るものが無い。同じ文書をそのまま返す。
    return document;
  }
  const counts = cutCounts(document, index);
  return {
    ...document,
    references: document.references.slice(0, counts.references),
    solids: document.solids.slice(0, counts.solids),
  };
}

/**
 * つまみが `index` にあるとき、新しいフィーチャーを差し込む**配列の**位置(FR-507)。
 * 帯は 1 本の通し番号だが、配列は `references` と `solids` の 2 本あるので、
 * どちらへ入れるかを `section` で受け取る。
 */
export function insertPositionAt(
  document: PartDocument,
  index: number | null,
  section: TimelineSection,
): number {
  const total = document.references.length + document.solids.length;
  const end = section === 'reference' ? document.references.length : document.solids.length;
  if (index === null || index >= total - 1) {
    return end;
  }
  const counts = cutCounts(document, index);
  return section === 'reference' ? counts.references : counts.solids;
}
