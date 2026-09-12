// Invoked only by the quality gate to identify the actual package-manager runtime.
// A shim can dispatch to a different installed version from its own package.
import { realpathSync } from 'node:fs';
import process from 'node:process';

const manager = process.env.npm_execpath;
if (typeof manager !== 'string' || manager.length === 0) {
  throw new Error('The package-manager runtime could not be identified');
}
process.stdout.write(JSON.stringify({
  node_runtime: realpathSync(process.execPath),
  pnpm_runtime: realpathSync(manager),
}));
