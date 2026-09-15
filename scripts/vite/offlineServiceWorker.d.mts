import type { Plugin } from 'vite';

export function buildOfflineServiceWorker(): Promise<string>;
export function offlineServiceWorker(): Plugin;
