import type { ShapeExportDiagnostic } from '../types.js';

/** Carry a known refusal while retaining the original exception for existing direct readers. */
export class ShapeExportError extends Error {
  constructor(readonly diagnostic: ShapeExportDiagnostic, message: string) {
    super(message);
  }
}
