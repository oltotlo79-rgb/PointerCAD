export interface RuntimeDependency {
  name: string;
  version: string;
  license: string;
  folders: string[];
  parents: string[];
}
export function installedRuntimeDependencies(root: string): RuntimeDependency[];
export function verifyRuntimeDependencyInventory(
  actual: readonly Pick<RuntimeDependency, 'name' | 'version' | 'license'>[],
  expected: readonly Pick<RuntimeDependency, 'name' | 'version' | 'license'>[],
): void;
