export type E2eBuildTargets = 'desktop' | 'web' | 'both';
export const E2E_DESKTOP_PROJECTS: readonly string[];
export const E2E_WEB_PROJECTS: readonly string[];
export const E2E_BOTH_PROJECTS: readonly string[];
export function e2eBuildTargets(argv: readonly string[]): E2eBuildTargets;
export function e2eWebServer(targets: E2eBuildTargets, port: number, readyScript: string): {
  command: string;
  url?: string;
  wait?: { stdout: RegExp };
};
