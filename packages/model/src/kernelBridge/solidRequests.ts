/** Map resolved construction plans into geometry requests; this module owns no Worker or shape. */
import type { SolidStepRequest, SolidStepSpec, SurfaceInput, ThruSectionSpec } from '@pointercad/kernel';
import type { ResolvedSolidStep, SolidStepPlan, SurfaceShapePlan, ThruSectionPlan } from '../part/resolvePart.js';
import { toCurveSpec } from './curveConversions.js';
import { toSubShapeQuery } from './subShapeQuery.js';


/**
 * 罫線面・ロフトの断面 1 つをカーネルの言葉へ直す(FR-430、FR-410、P5 §2.9)。
 * 曲線の並びは `toCurveSpec` を使い回し、球は中心と半径をそのまま渡す。
 */
function toThruSectionSpec(section: ThruSectionPlan): ThruSectionSpec {
  switch (section.kind) {
    case 'curves':
      return { kind: 'curves', curves: section.curves.map((curve) => toCurveSpec(curve)) };
    case 'sphere':
      return { kind: 'sphere', center: section.center, radius: section.radius };
    case 'faceQuery':
      // 立体の面(§0.a-0.73)。輪郭の取り出しはカーネルの中で行うので、指紋と
      // 対象の段の鍵だけを渡す(穴・面取りの面と同じ扱い)。対象は消費しない(§0.a-0.27)。
      return {
        kind: 'faceQuery',
        targetKey: section.targetKey,
        query: toSubShapeQuery(section.query),
      };
  }
}

/**
 * 解決済みの 1 段の作り方をカーネルの言葉へ直す。
 * 向き・反転・両側の平行移動・角度の度→ラジアンは resolvePart が済ませてあるので、
 * ここでやるのは欄の名前を合わせることと、曲線・指紋を kernel の形へ直すことだけ。
 * 各節は return で閉じる(no-fallthrough)。
 *
 * 穴・ねじ穴・R面取り・C面取り・ばねの欄(`centers` / `transforms` / `thread` / `mark` / `size` 等)は
 * model 側の型(resolvePart.ts の `SolidStepPlan`)と kernel 側の型(kernel/src/types.ts の
 * `HoleStepSpec` 等)で欄の名前と形をそろえてあるので、指紋(`face` / `targets`)だけ
 * `toSubShapeQuery` で詰め替え、残りはそのまま渡す(タスク17 手順3)。
 */
function toSolidStepSpec(plan: SolidStepPlan): SolidStepSpec {
  switch (plan.kind) {
    case 'sheetBody': return { kind: 'sheetBody', panels: plan.panels.map((panel) => ({ thickness: panel.thickness, normal: panel.normal,
      reversed: panel.reversed, outer: panel.outer.map(toCurveSpec), holes: panel.holes.map((loop) => loop.map(toCurveSpec)) })),
      bends: plan.bends.map((bend) => bend.kind === 'rectangle' ? bend : { ...bend, outer: bend.outer.map(toCurveSpec),
        holes: bend.holes.map((loop) => loop.map(toCurveSpec)) }) };
    case 'sheetJoin': return { kind: 'sheetJoin', targetKey: plan.targetKey, toolKey: plan.toolKey };
    case 'sheetBase': return { kind: 'sheetBase', outer: plan.outer.map(toCurveSpec), holes: plan.holes.map((loop) => loop.map(toCurveSpec)),
      thickness: plan.thickness, normal: plan.normal, reversed: plan.reversed };
    case 'sheetFlange': return { kind: 'sheetFlange', targetKey: plan.targetKey, flanges: plan.flanges.map((flange) => {
      const common = { frame: flange.frame, width: flange.width, thickness: flange.thickness, radius: flange.radius, angle: flange.angle };
      switch (flange.kind) {
        case 'rectangle': return { ...common, kind: 'rectangle' as const, secondLength: flange.secondLength };
        case 'profile': return { ...common, kind: 'profile' as const, outer: flange.outer.map(toCurveSpec), holes: flange.holes.map((loop) => loop.map(toCurveSpec)) };
      }
    }) };
    case 'extrude':
      // P5 で足した終端・傾き・薄板(FR-415・FR-401・FR-416)は**省略されたまま渡す**。
      // 段に無い欄はカーネルでも既定(距離ぶんを片側へ、傾きなし、中実)になるので、
      // P2 からの押し出しの依頼は 1 ドットも変わらない(`ExtrudeStepSpec` の注釈)。
      return {
        kind: 'extrude',
        profile: plan.profile.map((curve) => toCurveSpec(curve)),
        direction: plan.direction,
        distance: plan.distance,
        ...(plan.end === undefined ? {} : { end: plan.end }),
        ...(plan.taperAngle === undefined
          ? {}
          : { taperAngle: plan.taperAngle, taperOutward: plan.taperOutward ?? false }),
        ...(plan.thin === undefined || plan.thin === null ? {} : { thin: plan.thin }),
        ...(plan.targetKey === undefined || plan.targetKey === null
          ? {}
          : { targetKey: plan.targetKey }),
      };
    case 'revolve':
      return {
        kind: 'revolve',
        profile: plan.profile.map((curve) => toCurveSpec(curve)),
        axisOrigin: plan.axisOrigin,
        axisDirection: plan.axisDirection,
        angle: plan.angle,
      };
    case 'sew':
      return {
        kind: 'sew',
        profiles: plan.profiles.map((profile) => profile.map((curve) => toCurveSpec(curve))),
        tolerance: plan.tolerance,
      };
    case 'boolean':
      return {
        kind: 'boolean',
        operation: plan.operation,
        targetKey: plan.targetKey,
        toolKey: plan.toolKey,
      };
    case 'hole':
      return {
        kind: 'hole',
        targetKey: plan.targetKey,
        face: toSubShapeQuery(plan.face),
        centers: plan.centers,
        diameter: plan.diameter,
        depth: plan.depth,
        tiltAngle: plan.tiltAngle,
        tiltAzimuth: plan.tiltAzimuth,
        transforms: plan.transforms,
        // 入口の形(ざぐり・皿もみ、FR-422、タスク46)。**広げないときは段にも載せない**
        // (省くとカーネルでも `{ kind: 'plain' }` になる。`HoleStepSpec.entry` の注釈)。
        ...(plan.entry === undefined ? {} : { entry: plan.entry }),
      };
    case 'thread':
      return {
        kind: 'thread',
        targetKey: plan.targetKey,
        face: toSubShapeQuery(plan.face),
        centers: plan.centers,
        drillDiameter: plan.drillDiameter,
        depth: plan.depth,
        tiltAngle: plan.tiltAngle,
        tiltAzimuth: plan.tiltAzimuth,
        transforms: plan.transforms,
        thread: plan.thread,
        mark: plan.mark,
        // 入口の形(ざぐり・皿もみ、FR-422、42c/46c)。穴とまったく同じ扱い(上の 'hole' 節)。
        ...(plan.entry === undefined ? {} : { entry: plan.entry }),
      };
    case 'fillet':
      return {
        kind: 'fillet',
        targetKey: plan.targetKey,
        targets: plan.targets.map((target) => toSubShapeQuery(target)),
        radius: plan.radius,
      };
    case 'chamfer':
      return {
        kind: 'chamfer',
        targetKey: plan.targetKey,
        targets: plan.targets.map((target) => toSubShapeQuery(target)),
        size: plan.size,
        swapReferenceFace: plan.swapReferenceFace,
      };
    case 'spring':
      // ばねは対象ボディを持たない(§0.36)ので targetKey が無い。
      return {
        kind: 'spring',
        origin: plan.origin,
        direction: plan.direction,
        coilDiameter: plan.coilDiameter,
        wireDiameter: plan.wireDiameter,
        pitch: plan.pitch,
        turns: plan.turns,
        handedness: plan.handedness,
      };
    case 'primitive':
      // 基本形状(FR-429、P5 §2.7)。中心・向き・寸法だけで決まる「作る」段だが、
      // 中心を立体の頂点にしたときだけ頂点の指紋(`originQuery`)と、その頂点を持つ
      // 立体の段の鍵(`targetKey`)を添え、カーネルが頂点を引いて位置を決める
      // (§0.a-0.18)。**それでも対象は消費しない**(§0.a-0.19)ので、加工フィーチャーの
      // `targetKey` と違い結果には両方のボディが残る。寸法(`shape`)は model と kernel で
      // 欄の名前・形をそろえてあるので、指紋だけ詰め替えて残りはそのまま渡す。
      return {
        kind: 'primitive',
        origin: plan.origin,
        axis: plan.axis,
        shape: plan.shape,
        originQuery: plan.originQuery === null ? null : toSubShapeQuery(plan.originQuery),
        targetKey: plan.targetKey,
      };
    case 'thruSections':
      /*
        罫線面(FR-430)とロフト(FR-410)は、model のフィーチャーが 2 種類でも
        カーネルの段は 1 種類で `ruled` の真偽しか違わない(P5 §0.a-0.25)。
        断面は輪郭(曲線の並び)・球(中心と半径)・立体の面(指紋と上流の鍵)の 3 通りで、
        詰め替えは `toThruSectionSpec`。球の近似の点の数(`sphereSegments`、§0.a-0.74)は
        カーネル側が必須の欄にしてある(既定を入れるのは model の役目)ので必ず渡す。
      */
      return {
        kind: 'thruSections', smooth: plan.smooth,
        sections: plan.sections.map((section) => toThruSectionSpec(section)),
        ruled: plan.ruled,
        closed: plan.closed,
        twist: plan.twist,
        sphereSegments: plan.sphereSegments,
      };
    /*
      P5 の Should 群のうちタスク45 が解決する 4 種(FR-417・FR-419・FR-424)。
      角度のラジアン化・平面の数値化・倍率の正規化は resolvePart が済ませてあるので、
      ここでやるのは指紋(`faces` / `neutralFace`)の詰め替えだけである。
      **消費するかどうかは `visible` を決める model 側の話**で、依頼の形には出ない。
    */
    case 'draft':
      return {
        kind: 'draft',
        targetKey: plan.targetKey,
        faces: plan.faces.map((face) => toSubShapeQuery(face)),
        neutralFace: toSubShapeQuery(plan.neutralFace),
        angle: plan.angle,
        reversed: plan.reversed,
      };
    case 'mirror':
      return {
        kind: 'mirror',
        targetKey: plan.targetKey,
        origin: plan.origin,
        normal: plan.normal,
      };
    case 'transform':
      return {
        kind: 'transform',
        targetKey: plan.targetKey,
        translation: plan.translation,
        rotationOrigin: plan.rotationOrigin,
        rotationAxis: plan.rotationAxis,
        rotationAngle: plan.rotationAngle,
      };
    case 'scale':
      return {
        kind: 'scale',
        targetKey: plan.targetKey,
        origin: plan.origin,
        uniform: plan.uniform,
        perAxis: plan.perAxis,
      };
    /*
      P5 の Should 群のうちタスク46 が解決する 5 種(FR-409・420・421・423・428)と、
      前倒しした Could 群の 1 種(FR-418)。断面・経路の座標、向き、角度のラジアン化、
      呼び径の引き当ては resolvePart が済ませてあるので、ここでやるのは曲線と指紋の
      詰め替えだけである(欄の名前と形は model と kernel でそろえてある)。
    */
    case 'sweep':
      return {
        kind: 'sweep',
        profile: plan.profile.map((curve) => toCurveSpec(curve)),
        path: plan.path.map((curve) => toCurveSpec(curve)),
        ...(plan.guide === undefined ? {} : { guide: plan.guide.map((curve) => toCurveSpec(curve)) }),
        frenet: plan.frenet,
      };
    case 'rib':
      return {
        kind: 'rib',
        targetKey: plan.targetKey,
        profile: plan.profile.map((curve) => toCurveSpec(curve)),
        normal: plan.normal,
        thickness: plan.thickness,
        symmetric: plan.symmetric,
        direction: plan.direction,
        // 材料に届くまで伸ばすか(FR-420、42c/46c)。RibStepSpec.extendToBody と同じ欄名。
        extendToBody: plan.extendToBody,
      };
    case 'emboss':
      return {
        kind: 'emboss',
        targetKey: plan.targetKey,
        face: toSubShapeQuery(plan.face),
        profiles: plan.profiles.map((profile) => profile.map((curve) => toCurveSpec(curve))),
        depth: plan.depth,
        raised: plan.raised,
      };
    case 'threadShaft':
      return {
        kind: 'threadShaft',
        targetKey: plan.targetKey,
        face: toSubShapeQuery(plan.face),
        majorDiameter: plan.majorDiameter,
        pitch: plan.pitch,
        length: plan.length,
        fromEnd: plan.fromEnd,
        modeled: plan.modeled,
      };
    case 'functionSurface':
      return { kind: 'functionSurface', geometry: plan.geometry };
    case 'surface':
      // 曲面(FR-428)。作り方 6 種の詰め替えは `toSurfaceInput`。`face` / `offset` の
      // ときだけ面を借りる立体の鍵を添えるが、**消費はしない**(§0.a-0.45)。
      return {
        kind: 'surface',
        shape: toSurfaceInput(plan.shape),
        targetKey: plan.targetKey,
      };
    case 'shell':
      return {
        kind: 'shell',
        targetKey: plan.targetKey,
        openFaces: plan.openFaces.map((face) => toSubShapeQuery(face)),
        thickness: plan.thickness,
        outward: plan.outward,
      };
    case 'cut':
      // 平面による切断(FR-432、§2.9b)。平面は resolvePart が「通る点+単位法線」まで
      // 解いてあるので、欄名を合わせるだけ(指紋は段へ運ばない)。
      return {
        kind: 'cut',
        targetKey: plan.targetKey,
        origin: plan.origin,
        normal: plan.normal,
        keepPositive: plan.keepPositive,
      };
    case 'importedSolid':
      /*
        読み込んだ形(FR-802、P6 §2.8、タスク20)。カーネルの `ImportedSolidStepSpec` は
        **バイト列 1 つだけ**を受け取る(`shapeRef` は `.pcad` の中の入れ物の名前で、
        カーネルは `.pcad` を知らないので運ばない。鍵は resolvePart が済ませてある)。
      */
      return { kind: 'importedSolid', bytes: plan.bytes };
  }
}

/**
 * 曲面の作り方(FR-428)をカーネルの `SurfaceInput` へ直す(タスク46)。
 * 種類も欄名も同じだが、曲線(`ResolvedCurve` → `CurveSpec`)と指紋
 * (`SubShapeRef` → `SubShapeQuery`)だけは詰め替えが要る。各節は return で閉じる。
 */
function toSurfaceInput(shape: SurfaceShapePlan): SurfaceInput {
  switch (shape.kind) {
    case 'extrude':
      return {
        kind: 'extrude',
        profile: shape.profile.map((curve) => toCurveSpec(curve)),
        direction: shape.direction,
        distance: shape.distance,
      };
    case 'revolve':
      return {
        kind: 'revolve',
        profile: shape.profile.map((curve) => toCurveSpec(curve)),
        axisOrigin: shape.axisOrigin,
        axisDirection: shape.axisDirection,
        angle: shape.angle,
      };
    case 'planar':
      return { kind: 'planar', profile: shape.profile.map((curve) => toCurveSpec(curve)) };
    case 'loft':
      return {
        kind: 'loft',
        sections: shape.sections.map((section) => section.map((curve) => toCurveSpec(curve))),
        ruled: shape.ruled,
      };
    case 'face':
      return { kind: 'face', face: toSubShapeQuery(shape.face) };
    case 'offset':
      return {
        kind: 'offset',
        face: toSubShapeQuery(shape.face),
        distance: shape.distance,
      };
  }
}

/**
 * 履歴 1 段ぶんの依頼を作る。結果との対応づけにはフィーチャーの id を使い、
 * 進捗に出す名前はフィーチャーの表示名をそのまま渡す(FR-501)。
 */
export function toSolidStepRequest(step: ResolvedSolidStep): SolidStepRequest {
  return {
    key: step.key,
    id: step.featureId,
    label: step.name,
    step: toSolidStepSpec(step.plan),
    visible: step.visible,
  };
}
