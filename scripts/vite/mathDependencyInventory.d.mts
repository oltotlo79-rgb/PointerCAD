/** Metadata read from the installed packages. */
export interface MathDependencyRecord { readonly name: string; readonly version: string; readonly license: string }
export function mathPackageFolder(root: string, chain: readonly string[]): string;
export function installedMathDependencies(root: string): readonly MathDependencyRecord[];
export function verifyMathDependencyInventory(actual: readonly MathDependencyRecord[], recorded: readonly MathDependencyRecord[]): void;
