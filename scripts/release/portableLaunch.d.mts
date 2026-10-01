export interface PortableCandidate {
  readonly version: string;
  readonly sourceCommit: string;
  readonly platform: 'win32';
  readonly arch: 'x64';
  readonly application: {
    readonly applicationMetadataSha256: string;
    readonly manualBuildId: string;
    readonly pdfVolumes: number;
    readonly files: number;
  };
}
export function assertPortableLaunchEnvironment(environment: Readonly<Record<string, string | undefined>>, platform: string): void;
export function readPortableLaunchTarget(candidatePath: string): Promise<{ executable: string; candidate: PortableCandidate }>;
export function portableLaunchArguments(userData: string): string[];
export function portableLaunchPlan(isolation: { readonly executable: string; readonly userData: string; readonly temporary: string },
  environment: Readonly<Record<string, string | undefined>>, platform: string): {
  executable: string;
  args: string[];
  options: { cwd: string; env: Record<string, string | undefined>; windowsHide: true; shell: false; stdio: ['ignore', 'pipe', 'pipe'] };
};
export function portableDebuggerEndpoint(contents: string): string | null;
export function portableExtractionDirectory(executable: string, temporary: string): string;
