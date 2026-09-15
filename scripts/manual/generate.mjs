/** Generate reviewable local HTML; release certification and real-screen provenance are separate required gates. */
import { createHash } from 'node:crypto';
import { argv } from 'node:process';
import { log } from 'node:console';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, build, createLogger } from 'vite';
import { buildNativeControlInventory } from './control-inventory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argument = argv.slice(2);
if (argument.length !== 1 || !/^[a-z0-9][a-z0-9-]*$/u.test(argument[0])) {
  throw new Error('Usage: node scripts/manual/generate.mjs <new-output-name>; output is restricted to dist/<name>.');
}
const destination = join(root, 'dist', argument[0]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = { format: 'pointercad-manual/1', releaseCertified: false,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirtySources: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '',
  inputs: {}, images: {}, outputs: {}, chapters: [], volumes: [], featureCoverage: null, commandCoverage: [], supplementaryCoverage: null, nativeControlCoverage: null, buildId: '' };
const inputs = new Map();
const buildErrors = [], logger = createLogger('warn'), writeBuildError = logger.error.bind(logger);
logger.error = (message, options) => { buildErrors.push(message); writeBuildError(message, options); };
const readInput = async path => {
  const absolute = resolve(root, path);
  if (relative(root, absolute).startsWith(`..${sep}`)) throw new Error(`Input escapes project: ${path}`);
  const bytes = await readFile(absolute); inputs.set(path, bytes); manifest.inputs[path] = hash(bytes); return bytes;
};
const controlSources = [];
const readControls = async folder => {
  for (const entry of (await readdir(join(root, folder), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = `${folder}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Control source must stay inside the project: ${path}`);
    if (entry.isDirectory()) await readControls(path);
    else if (entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
      controlSources.push({ path, source: (await readInput(path)).toString('utf8') });
    }
  }
};
await readControls('packages/ui/src');
manifest.nativeControlCoverage = buildNativeControlInventory(controlSources);
await readInput('scripts/manual/control-inventory.mjs');
const server = await createServer({ configFile: false, root, logLevel: 'warn', customLogger: logger,
  // This server only loads the listed SSR sources; it must not scan unrelated HTML experiments in the workspace.
  optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null, hmr: false },
  ssr: { noExternal: ['@pointercad/help-content'] } });
let pages;
let validateManualLinks;
try {
  const { MANUAL_CHAPTERS, MANUAL_VOLUMES } = await server.ssrLoadModule('/packages/help-content/src/manualManifest.ts');
  const { FEATURE_HELP_BINDINGS } = await server.ssrLoadModule('/packages/help-content/src/featureHelpBindings.ts');
  const { parseHelpRequirements, buildHelpFeatureCoverage, buildCommandHelpCoverage } =
    await server.ssrLoadModule('/packages/help-content/src/helpFeatureCoverage.ts');
  const { COMMAND_DEFINITIONS } = await server.ssrLoadModule('/packages/ui/src/commands/commandDefinitions.ts');
  manifest.featureCoverage = buildHelpFeatureCoverage(
    parseHelpRequirements((await readInput('docs/requirements.md')).toString('utf8')), MANUAL_CHAPTERS, FEATURE_HELP_BINDINGS);
  manifest.commandCoverage = buildCommandHelpCoverage(COMMAND_DEFINITIONS, MANUAL_CHAPTERS);
  const { buildSupplementaryHelpCoverage } = await server.ssrLoadModule('/packages/ui/src/help/supplementaryHelpCoverage.ts');
  manifest.supplementaryCoverage = buildSupplementaryHelpCoverage(MANUAL_CHAPTERS);
  const { buildManualPages } = await server.ssrLoadModule('/packages/ui/src/help/manualPages.tsx');
  ({ validateManualLinks } = await server.ssrLoadModule('/packages/ui/src/help/manualLinks.ts'));
  const sources = new Map(), images = {}, imageFiles = new Map();
  for (const chapter of MANUAL_CHAPTERS) {
    const markdown = (await readInput(`packages/help-content/${chapter.path}`)).toString('utf8');
    sources.set(chapter.id, markdown);
    for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^\s)]+)\)/gu)) {
      const name = match[1].replace(/^\.\//u, '');
      if (!/^images\/[a-zA-Z0-9_-]+\.png$/u.test(name)) throw new Error(`Unsupported manual image: ${name}`);
      images[match[1]] = `../${name}`;
      if (!imageFiles.has(name)) {
        const bytes = await readInput(`packages/help-content/docs/ja/${name}`);
        imageFiles.set(name, bytes); manifest.images[name] = { sha256: hash(bytes), captureCertified: false };
      }
    }
  }
  pages = new Map(buildManualPages(sources, images));
  pages.set('feature-coverage.json', JSON.stringify({ format: 'pointercad-help-coverage/1',
    features: manifest.featureCoverage, commands: manifest.commandCoverage, supplementary: manifest.supplementaryCoverage, nativeControls: manifest.nativeControlCoverage, releaseCertified: false }, null, 2));
  for (const [name, bytes] of imageFiles) pages.set(name, bytes);
  for (const path of ['packages/help-content/src/featureHelpBindings.ts', 'packages/help-content/src/helpFeatureCoverage.ts',
    'packages/help-content/src/topics.ts', 'packages/help-content/src/manualManifest.ts',
    'packages/help-content/src/searchIndex.ts', 'packages/help-content/src/uiReferences.ts',
    'packages/ui/src/help/manualPages.tsx', 'packages/ui/src/help/manualHtml.tsx', 'packages/ui/src/help/HelpMarkdown.tsx',
    'packages/ui/src/help/helpLibrary.ts', 'packages/ui/src/help/manualSearch.ts', 'packages/ui/src/help/manualSearchEntry.ts', 'packages/ui/src/help/manualLinks.ts',
    'packages/ui/src/help/offlineManualNavigation.ts', 'scripts/vite/offlineProtocol.mjs',
    'scripts/manual/generate.mjs', 'scripts/manual/manual.css', 'pnpm-lock.yaml', 'package.json',
    'packages/ui/package.json', 'packages/help-content/package.json', 'tsconfig.base.json', 'packages/ui/tsconfig.json']) await readInput(path);
  // The runtime action catalog owns its source IDs, labels and description routes.
  const { readdir: commandFiles } = await import('node:fs/promises');
  for (const folder of ['packages/ui/src/commands', 'packages/ui/src/shell/menus']) {
    for (const name of (await commandFiles(join(root, folder))).filter(name => /\.tsx?$/u.test(name) && !name.endsWith('.test.ts')).sort()) {
      await readInput(`${folder}/${name}`);
    }
  }
  for (const path of ['packages/ui/src/drawing/drawingToolbarItems.ts',
    'packages/ui/src/sheetMetal/sheetMetalMenuItems.ts', 'packages/ui/src/scripting/scriptMenuItems.ts']) await readInput(path);
  for (const path of ['packages/ui/src/help/supplementaryHelpCoverage.ts', 'packages/ui/src/settings/settings.ts',
    'packages/ui/src/settings/numericToolDefaults.ts', 'packages/ui/src/settings/autoSaveSettings.ts',
    'packages/ui/src/settings/shortcutSettings.ts', 'packages/ui/src/sketch/numericInput.ts',
    'packages/ui/src/sketch/numericDefaultSources.ts', 'packages/ui/src/sheetMetal/sheetMetalDefaultSources.ts',
    'packages/ui/src/sheetMetal/sheetFields.ts', 'packages/ui/src/drawing/drawingToolDefaults.ts',
    'packages/ui/src/file/fileContracts.ts']) await readInput(path);
  // The translation resolver imports the whole dictionary, including labels outside help.
  const { readdir } = await import('node:fs/promises');
  for (const name of (await readdir(join(root, 'packages/ui/src/i18n/ja'))).filter(name => name.endsWith('.json')).sort()) {
    await readInput(`packages/ui/src/i18n/ja/${name}`);
  }
  await readInput('packages/ui/src/i18n/ja.ts');
  // Embed the verified font in the shared stylesheet so file:// manuals need no font fetch/CORS exception.
  const font = await readInput('apps/web/public/fonts/NotoSansJP-Regular.otf');
  const css = inputs.get('scripts/manual/manual.css').toString('utf8');
  if (!css.includes('"fonts/NotoSansJP-Regular.otf"')) throw new Error('Manual font reference is missing');
  pages.set('manual.css', css.replace('"fonts/NotoSansJP-Regular.otf"', `"data:font/otf;base64,${font.toString('base64')}"`));
  pages.set('fonts/LICENSES.txt', await readInput('apps/web/public/fonts/LICENSES.txt'));
  manifest.chapters = MANUAL_CHAPTERS; manifest.volumes = MANUAL_VOLUMES;
} finally { await server.close(); }
const bundle = await build({ configFile: false, root, logLevel: 'warn', customLogger: logger, build: { write: false, minify: true,
  lib: { entry: join(root, 'packages/ui/src/help/manualSearchEntry.ts'), name: 'PointerCadManual', formats: ['iife'] } } });
const chunks = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(output => output.output);
if (chunks.length !== 1 || chunks[0].type !== 'chunk') throw new Error('Manual search must be a single local script');
pages.set('manualSearch.js', chunks[0].code);
if (buildErrors.length) throw new Error(`Manual build logged ${buildErrors.length} errors; no output is certified or written.`);
validateManualLinks(new Map([...pages].filter(([name]) => name.endsWith('.html'))), new Set(pages.keys()));
for (const [path, bytes] of inputs) {
  if (hash(await readFile(join(root, path))) !== hash(bytes)) throw new Error(`Manual input changed during generation: ${path}`);
}
for (const [name, content] of pages) manifest.outputs[name] = hash(content);
manifest.buildId = hash(JSON.stringify({ inputs: manifest.inputs, outputs: manifest.outputs }));
await mkdir(join(root, 'dist'), { recursive: true });
if ((await lstat(join(root, 'dist'))).isSymbolicLink()) throw new Error('Manual output parent must not be a link');
await mkdir(destination); // Refuse to overwrite an earlier manual or partially written output.
for (const [name, content] of pages) {
  const target = resolve(destination, name);
  if (relative(destination, target).startsWith(`..${sep}`)) throw new Error('Manual output escapes destination');
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, { flag: 'wx' });
}
await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
log(JSON.stringify({ destination, chapters: manifest.chapters.length, volumes: manifest.volumes.length,
  images: Object.keys(manifest.images).length, buildId: manifest.buildId, releaseCertified: false }));
