/** Read the repository's own notice inventories and emit one CycloneDX sbom.json; builds or publishes nothing. */
import { argv } from 'node:process';
import { log } from 'node:console';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localGitEnvironment } from '../lib/gitEnvironment.mjs';
import { buildSbom, findSbomGaps } from './sbom.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [outputName] = argv.slice(2);
if (!outputName || !/^[a-z0-9][a-z0-9-]*$/u.test(outputName)) {
  throw new Error('Usage: node scripts/release/build-sbom.mjs <new-output>');
}
const sourceCommit = execFileSync('git', ['--no-optional-locks', '-c', 'safe.directory=' + root.replaceAll('\\', '/'), 'rev-parse', 'HEAD'],
  { cwd: root, env: localGitEnvironment(), encoding: 'utf8', windowsHide: true }).trim();
const sbom = buildSbom(root, { sourceCommit, generatedAt: new Date().toISOString() });
const gaps = findSbomGaps(sbom);
const output = join(root, 'dist', outputName);
await mkdir(output);
await writeFile(join(output, 'sbom.json'), JSON.stringify(sbom, null, 2) + '\n', { flag: 'wx' });
log(JSON.stringify({ output, sourceCommit, components: sbom.components.length,
  unresolvedNotices: gaps.unresolvedNotices.length, unclassifiedLicenses: gaps.unclassifiedLicenses.length,
  noLicenseInformation: gaps.noLicenseInformation.length }));
