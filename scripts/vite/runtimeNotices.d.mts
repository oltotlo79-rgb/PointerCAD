import type { Plugin } from 'vite';
export interface RuntimeNoticeDistribution {
  assets: Map<string, Buffer>;
  unresolved: string[];
  additionalNotices: { appliesTo: string; file: string; sha256: string }[];
}
export function collectRuntimeNotices(root?: string): RuntimeNoticeDistribution;
export function assertRuntimeNoticesPublishable(distribution: Pick<RuntimeNoticeDistribution, 'unresolved'>): void;
export function runtimeNotices(): Plugin;
