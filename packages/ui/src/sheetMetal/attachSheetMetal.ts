/** 実Workerを1つの入口で配線する。プレビューの所有先は文書本体と分け、必ず返す。 */
import { recomputePart, recomputeSheetFlat, type AssemblyKernelBridge } from '@pointercad/model';
import type { SheetMetalComputer, SheetMetalFlatComputer } from '../store/sheetMetalSlice.js';
import { useAppStore } from '../store/useAppStore.js';
import { createSheetOutputComputer } from './sheetOutputComputer.js';

export function attachSheetMetal(bridge: AssemblyKernelBridge): () => void {
  let detached = false;
  const computer: SheetMetalComputer = async (document, requestId, shouldCancel) => {
    const partId = `sheet-preview:${requestId}`;
    const importedShapes = useAppStore.getState().importedShapes;
    try {
      return await recomputePart(document, bridge, { partId, generation: 1, importedShapes, shouldCancel: () => detached || shouldCancel() });
    } finally { await bridge.releasePart(partId); }
  };
  useAppStore.getState().setSheetMetalComputer(computer);
  const flatComputer: SheetMetalFlatComputer = async (body, definition, requestId, shouldCancel) => {
    const partId = `sheet-flat:${requestId}`;
    try { return await recomputeSheetFlat(body, definition, bridge, { partId, generation: 1, shouldCancel: () => detached || shouldCancel() }); }
    finally { await bridge.releasePart(partId); }
  };
  useAppStore.getState().setSheetMetalFlatComputer(flatComputer);
  const outputComputer = createSheetOutputComputer(bridge, () => detached);
  useAppStore.getState().setSheetOutputComputer(outputComputer);
  return () => {
    detached = true;
    const state = useAppStore.getState();
    if (state.sheetMetalComputer === computer) { state.closeSheetMetalTool(); state.setSheetMetalComputer(null); }
    if (state.sheetMetalFlatComputer === flatComputer) state.setSheetMetalFlatComputer(null);
    if (state.sheetOutputComputer === outputComputer) state.setSheetOutputComputer(null);
  };
}
