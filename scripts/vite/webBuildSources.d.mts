export function captureWebBuildSources(root: string): Promise<Readonly<Record<string, string>>>;

export function captureDesktopBuildSources(root: string): Promise<Readonly<Record<string, string>>>;

export function selectBuildSourceNames(names: readonly string[], deleted: ReadonlySet<string>, desktop: boolean): string[];

export function listWebBuildSourceNames(root: string): string[];
