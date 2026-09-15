import type { Plugin } from 'vite';

export function buildExactMathAssets(manifest: unknown, files: ReadonlyMap<string, Buffer>): Map<string, Buffer>;
export function collectExactMathAssets(folder?: string): Map<string, Buffer>;
export function exactMathAssets(): Plugin;
