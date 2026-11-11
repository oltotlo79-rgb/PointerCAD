/**
 * Model adapter that re-exports the kernel's OCCT-free mesh arithmetic (`occt/exchangeShared.ts`) for io.
 * The single body stays in kernel; this file only re-exports it through the existing kernel entry
 * (io -> model -> kernel). No Worker, OCCT, new subpath or extra computation.
 */
export { computeVertexNormals, computeVolume } from '@pointercad/kernel';
