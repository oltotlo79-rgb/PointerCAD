import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Match the explicit pnpm removal; upstream metadata still lists the unused optional integration. */
export function runtimeDependencySelection(root) {
  const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  const selector = 'mathlive@0.110.0>@cortex-js/compute-engine';
  const declaration = new RegExp('^  ["\']' + selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '["\']: ["\']-["\']\\r?$', 'mu');
  const section = text => /^overrides:\r?\n((?:[ \t].*\r?\n|\r?\n)*)/mu.exec(text)?.[1] ?? '';
  if (!declaration.test(section(workspace)) || !declaration.test(section(lock))) throw new Error('Unverified mathematics dependency removal');
  if (/^ {2,8}['"]?(?:@cortex-js\/compute-engine|@arnog\/colors|quickjs-wasi|complex-esm)(?:@|['"]?:)/mu.test(lock)) {
    throw new Error('Removed runtime dependency is still locked');
  }
  return metadata => Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies }).filter(name => {
    if (metadata.name !== 'mathlive' || name !== '@cortex-js/compute-engine') return true;
    if (metadata.version !== '0.110.0' || metadata.dependencies[name] !== '0.58.0') {
      throw new Error('Review the changed mathematics editor integration');
    }
    return false;
  });
}
