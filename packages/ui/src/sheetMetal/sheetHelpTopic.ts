import type { SheetMetalToolKind } from '../store/sheetMetalSlice.js';

const topics: Readonly<Record<SheetMetalToolKind, string>> = {
  sheetBase: 'sheet-metal', sheetFlange: 'sheet-metal-flange', sheetBend: 'sheet-metal-bend-relief',
  sheetRelief: 'sheet-metal-bend-relief', sheetUnfold: 'sheet-metal-flat',
};
export function sheetHelpTopic(kind: SheetMetalToolKind): string { return topics[kind]; }
