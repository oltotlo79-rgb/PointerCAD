/** 形状を作る各段から、キャッシュの鍵に含める材料だけを選ぶ。 */
import type { SheetSolidPlan } from '../sheetMetal/resolveSheetGeometry.js';
import type { SolidStepKeyMaterial } from './cacheKey.js';
import type { SolidStepPlan } from './resolvePart.js';
import { directEditKeyMaterial } from './directEditOperations.js';
import { fingerprintKeyText } from './subShapeRef.js';
import { importedShapeOf } from './types.js';
import {
  toKeyCurve, toKeyExtrudeEnd,
  toKeyPrimitiveShape, toKeySurfaceShape, toKeyThruSection,
  toKeyTransform, toKeyVec3,
} from './solidPlanKeyGeometry.js';
import {
  chamferKeyMaterial, filletKeyMaterial, holeKeyMaterial, threadKeyMaterial, threadShaftKeyMaterial,
} from './solidPlanKeyMachining.js';

/** 通常の和・差では配置を省き、工具の向きや位置が変わったパターンだけ新しい鍵にする。 */
function booleanToolMaterial(plan: Extract<SolidStepPlan, { readonly kind: 'boolean' }>) {
  return { toolKey: plan.toolKey,
    ...(plan.transforms === undefined ? {} : { transforms: plan.transforms.map(toKeyTransform) }),
    ...(plan.patternTool === undefined ? {} : { patternTool: plan.patternTool }) };
}

/** スイープのねじれ・先細り・中空(M-07)の鍵の材料。plan に載った欄だけ(使わないスイープの鍵は変えない)。 */
function sweepShapeKeyMaterial(plan: Extract<SolidStepPlan, { readonly kind: 'sweep' }>) {
  return {
    ...(plan.twist === undefined ? {} : { twist: plan.twist }),
    ...(plan.endScale === undefined ? {} : { endScale: plan.endScale }),
    ...(plan.wallThickness === undefined ? {} : { wallThickness: plan.wallThickness }),
    ...(plan.holes === undefined ? {} : { holes: plan.holes.map((loop) => loop.map(toKeyCurve)) }),
  };
}

/** 押し出しの外周と穴を一緒に鍵へ渡す。 */
function extrudeProfileKey(plan: Extract<SolidStepPlan, { readonly kind: 'extrude' }>) {
  return { profile: plan.profile.map(toKeyCurve),
    ...(plan.holes === undefined || plan.holes.length === 0 ? {} : { holes: plan.holes.map(loop => loop.map(toKeyCurve)) }) };
}

function surfaceKeyMaterial(plan: Extract<SolidStepPlan, { kind: 'surface' | 'blend' }>): SolidStepKeyMaterial {
  if (plan.kind === 'blend') return { ...plan, a: { sourceKey: plan.a.sourceKey, query: fingerprintKeyText(plan.a.query) },
    b: { sourceKey: plan.b.sourceKey, query: fingerprintKeyText(plan.b.query) } };
  return { kind: 'surface', shape: toKeySurfaceShape(plan.shape), targetKey: plan.targetKey };
}

/** 1段ぶんの鍵の材料。名前・抑制・色は混ぜない(形が変わらないため)。 */
export function keyMaterialFor(plan: Exclude<SolidStepPlan, SheetSolidPlan>): SolidStepKeyMaterial {
  switch (plan.kind) {
    case 'extrude':
      // 後から足した 5 欄は**省略された欄も既定で埋めてから**渡す。埋めても
      // `keyExtrudeExtras` が既定を空文字列に畳むので、従来の押し出しの鍵は変わらず、
      // 「欄を省いた押し出し」と「既定を明示した押し出し」も同じ鍵になる。
      return {
        kind: 'extrude',
        ...extrudeProfileKey(plan),
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
        ...(plan.faces === undefined ? {} : {
          faces: plan.faces.map(face => ({
            targetKey: face.targetKey, query: fingerprintKeyText(face.query),
          })),
        }),
        tolerance: plan.tolerance,
      };
    case 'boolean':
      // 上流の鍵をそのまま材料にするので、上流が変われば下流の鍵も必ず変わる(鍵の連鎖)。
      return {
        kind: 'boolean',
        operation: plan.operation,
        targetKey: plan.targetKey,
        ...booleanToolMaterial(plan),
        // 立てた差だけ材料に入る。欄が無ければ鍵の文字列は以前と同じ(既存のキャッシュはそのまま当たる)。
        ...(plan.requireRemoval === true ? { requireRemoval: true } : {}),
      };
    case 'hole':
      return holeKeyMaterial(plan);
    case 'thread':
      return threadKeyMaterial(plan);
    case 'spring':
      // 全長(length)と derived は混ぜない(cacheKey.ts の SpringKeyMaterial の注釈)。
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
      return filletKeyMaterial(plan);
    case 'chamfer':
      return chamferKeyMaterial(plan);
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
        frenet: plan.frenet, ...sweepShapeKeyMaterial(plan),
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
      return threadShaftKeyMaterial(plan);
    case 'functionSurface':
      return { kind: 'functionSurface', inputSignature: plan.inputSignature };
    case 'holeTranslate': case 'faceRotate':
      return directEditKeyMaterial(plan);
    case 'faceOffset':
      // 対象を消費する。面は指紋の鍵文字列、距離は評価済みの mm を混ぜる(式を変えれば鍵が変わる)。
      return {
        kind: 'faceOffset',
        targetKey: plan.targetKey,
        face: fingerprintKeyText(plan.face),
        offset: plan.offset,
      };
    case 'blend': case 'surface':
      // 面を借りる作り方(face / offset)でも消費しないが targetKey は必ず混ぜる
      // (混ぜないと上流を編集しても鍵が変わらず古い面の形が返る。NFR-PF-3)。
      return surfaceKeyMaterial(plan);
    case 'thicken':
      return { kind: plan.kind, targetKey: plan.targetKey, thickness: plan.thickness, side: plan.side };
    case 'offsetBody':
      return { kind: plan.kind, targetKey: plan.targetKey, distance: plan.distance };
    case 'shell':
      return {
        kind: 'shell',
        targetKey: plan.targetKey,
        // 並びはすでに planShell が通し番号の昇順に揃えてある(R 面取りと同じ)。
        openFaces: plan.openFaces.map(fingerprintKeyText),
        thickness: plan.thickness,
        outward: plan.outward,
      };
    case 'surfaceCut':
      return {
        kind: 'surfaceCut', targetKey: plan.targetKey, keepPositive: plan.keepPositive,
        blade: plan.blade.kind === 'extrusion'
          ? { ...plan.blade, profile: plan.blade.profile.map(toKeyCurve),
            planeOrigin: toKeyVec3(plan.blade.planeOrigin), planeNormal: toKeyVec3(plan.blade.planeNormal) }
          : plan.blade.kind === 'plane'
            ? { kind: 'plane', origin: toKeyVec3(plan.blade.origin), normal: toKeyVec3(plan.blade.normal) }
            : plan.blade,
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
