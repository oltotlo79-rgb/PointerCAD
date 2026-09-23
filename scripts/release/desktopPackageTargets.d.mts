export interface DesktopPackageTarget {
  readonly target: 'nsis' | 'portable' | 'AppImage';
  readonly name: string;
}
export function desktopPackagePlan(platform: string, version: string): readonly DesktopPackageTarget[];
export function verifyDesktopPackageArtifacts(platform: string, version: string,
  assets: readonly { readonly name: string; readonly bytes: number; readonly sha256: string }[]): readonly {
    readonly target: DesktopPackageTarget['target'];
    readonly files: readonly string[];
    readonly launchVerified: false;
  }[];
