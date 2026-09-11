/** 折曲げ形状と展開条件の鍵を分け、K変更でB-repを再生成しない。 */
import { hash64, keyCurveList, keyNumber } from '../part/cacheKey.js';
import type { SheetSolidPlan, ResolvedSheetBody, SheetFlangeGeometryInput, SheetBodyBendGeometry } from './resolveSheetGeometry.js';

function flangeKey(input: SheetFlangeGeometryInput): readonly unknown[] {
  const common = [input.kind, input.frame.origin.map(keyNumber), input.frame.xAxis.map(keyNumber),
    input.frame.yAxis.map(keyNumber), input.frame.normal.map(keyNumber),
    ...[input.width, input.thickness, input.radius, input.angle].map(keyNumber)];
  switch (input.kind) {
    case 'rectangle': return [...common, keyNumber(input.secondLength)];
    case 'profile': return [...common, keyCurveList(input.outer), input.holes.map(keyCurveList)];
  }
}

function bodyBendKey(bend: SheetBodyBendGeometry): readonly unknown[] {
  const common = [bend.kind, bend.frame.origin.map(keyNumber), bend.frame.xAxis.map(keyNumber), bend.frame.yAxis.map(keyNumber),
    bend.frame.normal.map(keyNumber), ...[bend.radius, bend.thickness, bend.angle].map(keyNumber)];
  return bend.kind === 'rectangle' ? [...common, keyNumber(bend.width)]
    : [...common, keyNumber(bend.neutralRadius), keyCurveList(bend.outer), bend.holes.map(keyCurveList)];
}
export function sheetShapeKey(plan: SheetSolidPlan): string {
  switch (plan.kind) {
    case 'sheetBody': return hash64(JSON.stringify(['sheetBody', plan.panels.map(sheetShapeKey), plan.bends.map(bodyBendKey)]));
    case 'sheetJoin': return hash64(JSON.stringify(['sheetJoin', plan.targetKey, plan.toolKey]));
    case 'sheetBase':
      return hash64(JSON.stringify(['sheetBase', keyCurveList(plan.outer), plan.holes.map(keyCurveList),
        keyNumber(plan.thickness), plan.normal.map(keyNumber), plan.reversed]));
    case 'sheetFlange':
      return hash64(JSON.stringify(['sheetFlange', plan.targetKey, plan.flanges.map(flangeKey)]));
  }
}

/** 保存しない導出キー。元形状・K・固定面・明示継ぎ目のいずれも展開を更新する。 */
export function sheetFlatKey(shapeKey: string, body: ResolvedSheetBody, fixedPanelId: string, seams: readonly string[]): string {
  return hash64(JSON.stringify(['sheetFlat', shapeKey, fixedPanelId, [...seams].sort(), body.bends.map((bend) => [
    bend.id, keyNumber(bend.kFactor), keyNumber(bend.allowance),
  ])]));
}
