import type { Buffer } from 'node:buffer';
import type { Plugin } from 'vite';

export interface FemDistributionAssets {
  readonly assets: Map<string, Buffer>;
  readonly unresolved: readonly string[];
}
export function buildFemRuntimeAssets(manifest: unknown, files: ReadonlyMap<string, Buffer>): FemDistributionAssets;
export function joinStoredParts(manifest: unknown, files: ReadonlyMap<string, Buffer>): { manifest: unknown; files: ReadonlyMap<string, Buffer> };
export function collectFemRuntimeAssets(folder?: string): FemDistributionAssets;
export function assertFemApplicationBuildInputs(distribution: FemDistributionAssets, buildInputs: ReadonlyMap<string, Buffer>): void;
export function assertFemDistributionPublishable(distribution: FemDistributionAssets): void;
export function readFemDistributionGaps(folder?: string): string[];
export function nativeRebuildEvidenceGaps(manifest: unknown, files: ReadonlyMap<string, Buffer>): string[];
export function buildFemWorker(root?: string): Promise<string>;
export function femRuntimeAssets(workerContentSecurityPolicy: string): Plugin;
