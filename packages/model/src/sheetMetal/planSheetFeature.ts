/** 部品履歴との境界。成功した板金だけを下流の曲げ元として貸す。 */
import { resolveSheetBase, resolveSheetFlange, type ResolvedSheetBody, type SheetFaceResolver, type SheetGeometryPlan } from './resolveSheetGeometry.js';
import type { SheetGeometryResult } from './panelGeometry.js';
import type { SheetMetalFeature } from './types.js';
import { resolveSheetLineBend, type SheetLineResolver } from './resolveLineBend.js';
import { resolveSheetRelief } from './resolveSheetRelief.js';

export function planSheetFeature(feature: SheetMetalFeature, face: SheetFaceResolver,
  bodyKeys: ReadonlyMap<string, string>, consumed: ReadonlySet<string>, sheetBodies: ReadonlyMap<string, ResolvedSheetBody>,
  line: SheetLineResolver = () => undefined): SheetGeometryResult<SheetGeometryPlan> {
  if (feature.kind === 'sheetBase') return resolveSheetBase(feature, face);
  if (consumed.has(feature.targetFeatureId)) return { ok: false, message: '元の板金はすでに別の加工に使われています。最新の板金ボディを選んでください。' };
  const key = bodyKeys.get(feature.targetFeatureId), body = sheetBodies.get(feature.targetFeatureId);
  if (key === undefined || body === undefined) return { ok: false, message: '曲げの元になる板金が見つかりません。板金基板または板金の履歴を選んでください。' };
  if (feature.kind === 'sheetBend') return resolveSheetLineBend(feature, body, line);
  if (feature.kind === 'sheetRelief') return resolveSheetRelief(feature, body);
  return resolveSheetFlange(feature, body, key, face);
}
