/** 展開パネルを実カーネルへ渡す境界。計算途中や失敗形状を表示結果にしない。 */
import type { KernelBridge, SolidBody, SolidRecomputeOptions } from '../kernelBridge.js';
import { createSheetFlatSteps } from './flatSteps.js';
import type { ResolvedSheetBody } from './resolveSheetGeometry.js';
import type { SheetUnfoldDefinition } from './types.js';
import { unfoldSheetBody, type SheetFlatGeometry } from './unfoldSheetBody.js';

export type SheetFlatResult = { readonly ok: true; readonly body: SolidBody; readonly bodyKey: string; readonly geometry: SheetFlatGeometry }
  | { readonly ok: false; readonly message: string; readonly cancelled?: boolean };
export async function recomputeSheetFlat(sheet: ResolvedSheetBody, definition: SheetUnfoldDefinition,
  bridge: Pick<KernelBridge, 'recomputeSolids'>, options: SolidRecomputeOptions = {}): Promise<SheetFlatResult> {
  const geometry = unfoldSheetBody(sheet, definition.fixedPanelId, definition.seamConnectionIds);
  if (!geometry.ok) return geometry;
  const steps = createSheetFlatSteps(definition.sourceFeatureId, geometry.value); if (!steps.ok) return steps;
  const outcome = await bridge.recomputeSolids(steps.value, options);
  if (outcome.cancelled || options.shouldCancel?.()) return { ok: false, cancelled: true, message: '板金の展開を中止しました。' };
  if (outcome.failures.length > 0) return { ok: false, message: outcome.failures[0].message };
  const body = outcome.bodies.find((item) => item.featureId === definition.sourceFeatureId);
  return body === undefined ? { ok: false, message: '展開形状が得られませんでした。固定面と曲げの接続を確認してください。' }
    : { ok: true, body, bodyKey: steps.value[steps.value.length - 1].key, geometry: geometry.value };
}
