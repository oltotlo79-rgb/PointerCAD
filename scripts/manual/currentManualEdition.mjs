/** Read the same catalog, renderer and labels used by the application. No listener, output or build. */
import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'vite';
import { buildNativeControlInventory } from './control-inventory.mjs';
import { verifyManualConsistency } from './manualConsistency.mjs';
import { desktopFileHash } from '../release/desktopFileInventory.mjs';
import { offlineAssetUrl } from '../vite/offlineProtocol.mjs';

export async function verifyCurrentManualEdition(root, manualFiles) {
  const source = manualFiles.find(file => file.path === 'manifest.json')?.bytes;
  if (!source || source.length > 8_388_608) throw new Error('Missing or excessive manual manifest');
  const manifest = JSON.parse(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(source));
  if (!manifest || typeof manifest.inputs !== 'object' || manifest.inputs === null || Array.isArray(manifest.inputs)
    || Object.keys(manifest.inputs).length === 0) throw new Error('Missing manual source inventory');
  const readInput = async name => {
    offlineAssetUrl(name);
    let cursor = root;
    for (const part of name.split('/')) {
      cursor = join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Manual source must not be a link: ' + name);
    }
    if (!(await lstat(cursor)).isFile()) throw new Error('Manual source must be a file: ' + name);
    const content = await readFile(cursor);
    if (manifest.inputs[name] !== desktopFileHash(content)) throw new Error('Manual source changed or unrecorded: ' + name);
    return content;
  };
  // Recheck every recorded input, including labels, generation code and local fonts.
  for (const name of Object.keys(manifest.inputs)) await readInput(name);
  const controls = [];
  const walk = async folder => {
    const entries = await readdir(join(root, folder), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const name = folder + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Control source must not be a link: ' + name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && name.endsWith('.tsx') && !name.endsWith('.test.tsx')) {
        controls.push({ path: name, source: (await readInput(name)).toString('utf8') });
      }
    }
  };
  await walk('packages/ui/src');
  const server = await createServer({ configFile: false, root, logLevel: 'warn',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false }, ssr: { noExternal: ['@pointercad/help-content'] } });
  let result;
  try {
    const { MANUAL_CHAPTERS: chapters, MANUAL_VOLUMES: volumes } = await server.ssrLoadModule('/packages/help-content/src/manualManifest.ts');
    const { FEATURE_HELP_BINDINGS } = await server.ssrLoadModule('/packages/help-content/src/featureHelpBindings.ts');
    const { parseHelpRequirements, buildHelpFeatureCoverage, buildCommandHelpCoverage } =
      await server.ssrLoadModule('/packages/help-content/src/helpFeatureCoverage.ts');
    const { COMMAND_DEFINITIONS } = await server.ssrLoadModule('/packages/ui/src/commands/commandDefinitions.ts');
    const { buildSupplementaryHelpCoverage } = await server.ssrLoadModule('/packages/ui/src/help/supplementaryHelpCoverage.ts');
    const { buildManualPages } = await server.ssrLoadModule('/packages/ui/src/help/manualPages.tsx');
    const { validateManualLinks } = await server.ssrLoadModule('/packages/ui/src/help/manualLinks.ts');
    const sources = new Map(), imageLinks = {}, images = new Map();
    for (const chapter of chapters) {
      const markdown = (await readInput('packages/help-content/' + chapter.path)).toString('utf8');
      sources.set(chapter.id, markdown);
      for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^\s)]+)\)/gu)) {
        const name = match[1].replace(/^\.\//u, '');
        if (!/^images\/[a-zA-Z0-9_-]+\.png$/u.test(name)) throw new Error('Unsupported manual image: ' + name);
        imageLinks[match[1]] = '../' + name;
        if (!images.has(name)) images.set(name, await readInput('packages/help-content/docs/ja/' + name));
      }
    }
    const pages = buildManualPages(sources, imageLinks);
    validateManualLinks(pages, new Set(manualFiles.map(file => file.path)));
    result = verifyManualConsistency(manualFiles, { chapters, volumes, pages, images,
      featureCoverage: buildHelpFeatureCoverage(parseHelpRequirements((await readInput('docs/requirements.md')).toString('utf8')),
        chapters, FEATURE_HELP_BINDINGS), commandCoverage: buildCommandHelpCoverage(COMMAND_DEFINITIONS, chapters),
      supplementaryCoverage: buildSupplementaryHelpCoverage(chapters), nativeControlCoverage: buildNativeControlInventory(controls) });
  } finally { await server.close(); }
  // A check performed while editing is not evidence for either the old or new manual.
  for (const name of Object.keys(manifest.inputs)) await readInput(name);
  return result;
}
