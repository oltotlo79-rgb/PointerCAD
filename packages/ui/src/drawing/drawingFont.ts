import { createFontStore } from '@pointercad/drawing';

/** 文書と編集状態はストア、字体の解析済み資産だけを共有する。 */
export const drawingFont = createFontStore();
