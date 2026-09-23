/** Check a local generated manual against today's help; never marks a release as accepted. */
import { argv } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from 'node:console';
import { collectDesktopFiles } from '../release/desktopFileInventory.mjs';
import { verifyCurrentManualEdition } from './currentManualEdition.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), args = argv.slice(2);
if (args.length !== 1 || !/^[a-z0-9][a-z0-9-]*$/u.test(args[0])) {
  throw new Error('Usage: node scripts/manual/verify.mjs <manual-output-name>; source is restricted to dist/.');
}
const files = await collectDesktopFiles(root, resolve(root, 'dist', args[0]));
log(JSON.stringify(await verifyCurrentManualEdition(root, files)));
