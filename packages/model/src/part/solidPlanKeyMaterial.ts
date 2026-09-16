/** 形状を作る各段から、キャッシュの鍵に含める材料だけを選ぶ。 */
import type { SheetSolidPlan } from '../sheetMetal/resolveSheetGeometry.js';
import type { SolidStepKeyMaterial } from './cacheKey.js';
import type { SolidStepPlan } from './resolvePart.js';
import { fingerprintKeyText } from './subShapeRef.js';
import { importedShapeOf } from './types.js';
import {
  toKeyCurve, toKeyExtrudeEnd, toKeyFilletRadius, toKeyHoleEntry,
  toKeyPrimitiveShape, toKeySurfaceShape, toKeyThruSection,
  toKeyTransform, toKeyVec3,
} from './solidPlanKeyGeometry.js';

/** 1段ぶんの鍵の材料(§0.a-0.20)。名前・抑制・色は混ぜない(形が変わらないため)。 */
export function keyMaterialFor(plan: Exclude<SolidStepPlan, SheetSolidPlan>): SolidStepKeyMaterial {
  switch (plan.kind) {
    case 'extrude':
      // P5 で足した 5 欄は**省略された欄も既定で埋めてから**渡す。埋めても
      // `keyExtrudeExtras` が既定を空文字列に畳むので、P2 からの押し出しの鍵は変わらず、
      // 「欄を省いた押し出し」と「既定を明示した押し出し」も同じ鍵になる(タスク44 の決め 3)。
      return {
        kind: 'extrude',
        profile: plan.profile.map(toKeyCurve),
        direction: toKeyVec3(plan.direction),
        distance: plan.distance,
        end:
          plan.end === undefined
            ? { kind: 'distance', distance: plan.distance }
            : toKeyExtrudeEnd(plan.end),
        taperAngle: plan.taperAngle ?? 0,
        taperOutward: plan.taperOutward ?? false,
        thin: plan.thin === undefined || plan.thin === null
          ? null
          : { thickness: plan.thin.thickness, side: plan.thin.side },
        targetKey: plan.targetKey ?? null,
      };
    case 'revolve':
      return {
        kind: 'revolve',
        profile: plan.profile.map(toKeyCurve),
        axisOrigin: toKeyVec3(plan.axisOrigin),
        axisDirection: toKeyVec3(plan.axisDirection),
        angle: plan.angle,
      };
    case 'sew':
      return {
        kind: 'sew',
        profiles: plan.profiles.map((profile) => profile.map(toKeyCurve)),
        tolerance: plan.tolerance,
      };
    case 'boolean':
      // 上流の鍵をそのまま材料にするので、上流が変われば下流の鍵も必ず変わる(鍵の連鎖)。
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
        face: fingerprintKeyText(plan.face),
        centers: plan.centers.map(toKeyVec3),
        diameter: plan.diameter,
        depth: plan.depth,
        tiltAngle: plan.tiltAngle,
        tiltAzimuth: plan.tiltAzimuth,
        transforms: plan.transforms.map(toKeyTransform),
        // 入口の形(FR-422)。省略と「広げない」は同じ鍵になる(`toKeyHoleEntry` の注釈)。
        entry: toKeyHoleEntry(plan.entry),
      };
    case 'thread':
      return {
        kind: 'thread',
        targetKey: plan.targetKey,
        face: fingerprintKeyText(plan.face),
        centers: plan.centers.map(toKeyVec3),
        drillDiameter: plan.drillDiameter,
        // 外径とねじ部の長さは印(必ず作る)から取る。実らせんの有無で欠けることがない。
        majorDiameter: plan.mark.majorDiameter,
        pitch: plan.pitch,
        threadLength: plan.mark.length,
        depth: plan.depth,
        // 実らせんか簡略表示かで形そのものが変わるので鍵に混ぜる(§0.a-0.15、§0.a-0.16)。
        modeled: plan.thread !== null,
        tiltAngle: plan.tiltAngle,
        tiltAzimuth: plan.tiltAzimuth,
        transforms: plan.transforms.map(toKeyTransform),
        // 入口の形(FR-422)。穴とまったく同じ扱いで、省略と「広げない」は同じ鍵になる。
        entry: toKeyHoleEntry(plan.entry),
      };
    case 'spring':
      // 全長(length)と derived は混ぜない(cacheKey.ts の SpringKeyMaterial の注釈、§0.a-0.30)。
      return {
        kind: 'spring',
        origin: toKeyVec3(plan.origin),
        direction: toKeyVec3(plan.direction),
        coilDiameter: plan.coilDiameter,
        wireDiameter: plan.wireDiameter,
        pitch: plan.pitch,
        turns: plan.turns,
        handedness: plan.handedness,
      };
    case 'fillet':
      return {
        kind: 'fillet',
        targetKey: plan.targetKey,
        // 並びはすでに planFillet が通し番号の昇順に揃えてある(FilletKeyMaterial の注釈)。
        targets: plan.targets.map(fingerprintKeyText),
        radius: toKeyFilletRadius(plan.radius),
      };
    case 'chamfer': {
      const size = plan.size;
      // ChamferKeyMaterial は3通りの大きさを「距離2つ」に均して持つ(cacheKey.ts の注釈)。
      // 等距離は distance2 を使わないので 0 に揃え、距離+角度は角度(ラジアン)を distance2 に置く。
      const [distance1, distance2] =
        size.kind === 'equal'
          ? [size.distance, 0]
          : size.kind === 'twoDistances'
            ? [size.distance1, size.distance2]
            : [size.distance, size.angle];
      return {
        kind: 'chamfer',
        targetKey: plan.targetKey,
        targets: plan.targets.map(fingerprintKeyText),
        mode: size.kind,
        distance1,
        distance2,
        swapReferenceFace: plan.swapReferenceFace,
      };
    }
    case 'primitive':
      // 頂点の指紋(originQuery)と上流の鍵(targetKey)を**必ず**混ぜる。混ぜないと、
      // 上流の押し出しを伸ばして頂点が動いても鍵が変わらず、古い位置の形が
      // キャッシュから返る(cacheKey.ts の `PrimitiveKeyMaterial` の注釈、NFR-PF-3)。
      return {
        kind: 'primitive',
        origin: toKeyVec3(plan.origin),
        axis: toKeyVec3(plan.axis),
        shape: toKeyPrimitiveShape(plan.shape),
        originQuery: plan.originQuery === null ? null : fingerprintKeyText(plan.originQuery),
        targetKey: plan.targetKey,
      };
    case 'thruSections':
      // 断面の輪郭・球の中心と半径をすべて混ぜる(cacheKey.ts の `ThruSectionsKeyMaterial`)。
      // 混ぜないと、スケッチの面を動かしても段の鍵が変わらず古い形が返る(NFR-PF-3)。
      return {
        kind: 'thruSections', smooth: plan.smooth,
        sections: plan.sections.map(toKeyThruSection),
        ruled: plan.ruled,
        closed: plan.closed,
        twist: plan.twist,
        sphereSegments: plan.sphereSegments,
      };
    case 'draft':
      return {
        kind: 'draft',
        targetKey: plan.targetKey,
        // 並びはすでに planDraft が通し番号の昇順に揃えてある(R 面取りと同じ)。
        faces: plan.faces.map(fingerprintKeyText),
        neutralFace: fingerprintKeyText(plan.neutralFace),
        angle: plan.angle,
        reversed: plan.reversed,
      };
    case 'mirror':
      // 対象を消費しないが targetKey を必ず混ぜる(元を編集したら鏡像も作り直す、NFR-PF-3)。
      return {
        kind: 'mirror',
        targetKey: plan.targetKey,
        origin: toKeyVec3(plan.origin),
        normal: toKeyVec3(plan.normal),
      };
    case 'transform':
      return {
        kind: 'transform',
        targetKey: plan.targetKey,
        translation: toKeyVec3(plan.translation),
        rotationOrigin: toKeyVec3(plan.rotationOrigin),
        rotationAxis: toKeyVec3(plan.rotationAxis),
        rotationAngle: plan.rotationAngle,
      };
    case 'scale':
      // uniform / perAxis はどちらか一方だけが入る(planScale が正規化済み)。
      return {
        kind: 'scale',
        targetKey: plan.targetKey,
        origin: toKeyVec3(plan.origin),
        uniform: plan.uniform,
        perAxis: plan.perAxis === null ? null : toKeyVec3(plan.perAxis),
      };
    case 'sweep':
      // 対象を取らない「作る」段なので targetKey を持たない(押し出し・ばねと同じ)。
      return {
        kind: 'sweep',
        profile: plan.profile.map(toKeyCurve),
        path: plan.path.map(toKeyCurve),
        ...(plan.guide === undefined ? {} : { guide: plan.guide.map(toKeyCurve) }),
        frenet: plan.frenet,
      };
    case 'rib':
      return {
        kind: 'rib',
        targetKey: plan.targetKey,
        profile: plan.profile.map(toKeyCurve),
        normal: toKeyVec3(plan.normal),
        thickness: plan.thickness,
        symmetric: plan.symmetric,
        direction: toKeyVec3(plan.direction),
        // 伸ばす/伸ばさないで形が変わるので鍵にも混ぜる(cacheKey.ts の RibKeyMaterial の注釈)。
        extendToBody: plan.extendToBody,
      };
    case 'emboss':
      return {
        kind: 'emboss',
        targetKey: plan.targetKey,
        face: fingerprintKeyText(plan.face),
        profiles: plan.profiles.map((profile) => profile.map(toKeyCurve)),
        depth: plan.depth,
        raised: plan.raised,
      };
    case 'threadShaft':
      return {
        kind: 'threadShaft',
        targetKey: plan.targetKey,
        face: fingerprintKeyText(plan.face),
        majorDiameter: plan.majorDiameter,
        pitch: plan.pitch,
        length: plan.length,
        fromEnd: plan.fromEnd,
        modeled: plan.modeled,
      };
    case 'functionSurface':
      return { kind: 'functionSurface', inputSignature: plan.inputSignature };
    case 'surface':
      // 面を借りる作り方(face / offset)でも消費しないが targetKey は必ず混ぜる
      // (混ぜないと上流を編集しても鍵が変わらず古い面の形が返る。NFR-PF-3)。
      return {
        kind: 'surface',
        shape: toKeySurfaceShape(plan.shape),
        targetKey: plan.targetKey,
      };
    case 'shell':
      return {
        kind: 'shell',
        targetKey: plan.targetKey,
        // 並びはすでに planShell が通し番号の昇順に揃えてある(R 面取りと同じ)。
        openFaces: plan.openFaces.map(fingerprintKeyText),
        thickness: plan.thickness,
        outward: plan.outward,
      };
    case 'cut':
      /*
        切断(FR-432)。**平面は解決済みの点と法線を混ぜる**(`planeSpecKeyText` は混ぜない)。
        指定の書き方が違っても同じ平面になるなら同じ形なので、鍵も同じにするためである。
        点の座標を変えれば解決した `origin` が動いて鍵も変わる(検証表の行)。
        **`pairedWith` は混ぜない**(形に影響しない。`CutKeyMaterial` の注釈)。
      */
      return {
        kind: 'cut',
        targetKey: plan.targetKey,
        origin: toKeyVec3(plan.origin),
        normal: toKeyVec3(plan.normal),
        keepPositive: plan.keepPositive,
      };
    case 'importedSolid':
      // 内容は原本ごとに一度だけ識別する。同じ文書内連番を持つ別部品とも衝突しない。
      return {
        kind: 'importedSolid',
        shapeRef: plan.shapeRef,
        shapeDigest: importedShapeOf(plan.bytes).shapeDigest,
      };
  }
}
