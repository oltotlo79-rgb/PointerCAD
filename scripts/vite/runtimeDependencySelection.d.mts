export function runtimeDependencySelection(root: string): (metadata: {
  name: string; version: string;
  dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
}) => string[];
