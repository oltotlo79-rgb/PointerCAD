import type { DrawingDocument } from '@pointercad/drawing';
import type { DrawingSourceLibrary } from '../drawing/sourceLibrary.js';

/** The source library accompanies its drawing through projection, editing and saving. */
export interface DrawingExample {
  readonly id: 'flangeDrawing';
  readonly create: () => Promise<{ readonly document: DrawingDocument; readonly library: DrawingSourceLibrary }>;
}
