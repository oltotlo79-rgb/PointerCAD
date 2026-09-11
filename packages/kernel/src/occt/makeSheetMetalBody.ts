/** 指定線曲げやリリーフで分かれた平面・曲げ帯を、材料を失わない1立体に戻す。 */
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from './allocations.js';
import { unionShapes, type BooleanResult } from './booleanOp.js';
import { makeSheetMetalBase, type SheetMetalBaseInput } from './makeSheetMetalBase.js';
import { makeSheetMetalBendBand, type SheetMetalBendBandInput } from './makeSheetMetalBend.js';
import { makeSheetMetalCurvedPanel, type SheetMetalCurvedPanelInput } from './makeSheetMetalCurvedPanel.js';
import { countSheetMetalSolids } from './sheetMetalJoin.js';
import { isValidShape, measureVolume } from './solidMesh.js';

export type SheetMetalBodyBendInput = (SheetMetalBendBandInput & { readonly kind: 'rectangle' })
  | (SheetMetalCurvedPanelInput & { readonly kind: 'profile' });
export interface SheetMetalBodyInput {
  readonly panels: readonly SheetMetalBaseInput[];
  readonly bends: readonly SheetMetalBodyBendInput[];
}

export function makeSheetMetalBody(oc: OpenCascadeInstance, input: SheetMetalBodyInput): BooleanResult {
  if (input.panels.length === 0) throw new Error('板金には平面パネルが1枚以上必要です。');
  const { keep, release } = createAllocations();
  try {
    const parts = input.panels.map((panel) => keep(makeSheetMetalBase(oc, panel)));
    for (const bend of input.bends) parts.push(keep(bend.kind === 'rectangle'
      ? makeSheetMetalBendBand(oc, bend) : makeSheetMetalCurvedPanel(oc, bend)));
    const totalVolume = parts.reduce((sum, part) => sum + measureVolume(oc, part.shape), 0);
    // 離れた腕も含め、全ての接続を1回の非破壊Booleanで解決する。
    const joined = parts.length > 1 ? keep(unionShapes(oc, parts.map((part) => part.shape))) : null;
    const shape = joined?.shape ?? parts[0].shape;
    if (countSheetMetalSolids(oc, shape) !== 1 || !isValidShape(oc, shape))
      throw new Error('曲げた板金がつながっていません。指定線・接線と輪郭を確認してください。');
    const volume = joined?.volume ?? totalVolume;
    if (!Number.isFinite(totalVolume) || volume <= 1e-9 || Math.abs(volume - totalVolume) > Math.max(1e-7, totalVolume * 1e-10))
      throw new Error('曲げた板金が重なるか、材料が失われています。角度・半径とリリーフを確認してください。');
    return { shape, volume, delete: release };
  } catch (error) { release(); throw error; }
}
