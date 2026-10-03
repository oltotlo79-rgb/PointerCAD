import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { expect, it } from 'vitest';

it('実際のデスクトップの起動入口は64KiB以内で、本体・React・計算コードへ静的依存しない', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = await build({ root, configFile: fileURLToPath(new URL('../../vite.renderer.config.ts', import.meta.url)),
    configLoader: 'runner', logLevel: 'silent', build: { write: false, emptyOutDir: false } });
  if (Array.isArray(result) || !('output' in result)) throw new Error('Unexpected desktop build result');
  const chunks = new Map(result.output.filter(item => item.type === 'chunk').map(item => [item.fileName, item]));
  const entry = [...chunks.values()].find(chunk => chunk.isEntry && chunk.facadeModuleId?.endsWith('/index.html'));
  if (entry === undefined) throw new Error('Desktop startup entry missing');
  const visited = new Set<string>();
  let bytes = 0;
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const chunk = chunks.get(name);
    if (chunk === undefined) throw new Error(`Unresolved startup import: ${name}`);
    bytes += Buffer.byteLength(chunk.code);
    for (const id of Object.keys(chunk.modules)) {
      const path = id.replaceAll('\\', '/');
      const entryModule = /\/apps\/desktop\/(?:index\.html|src\/renderer\/main\.tsx)$/u.test(path);
      const startupModule = /\/packages\/ui\/src\/shell\/startup(?:Presentation|Recovery)\.ts$/u.test(path);
      const helper = ['\0vite/preload-helper.js', '\0vite/modulepreload-polyfill.js', '\0rolldown/runtime.js', 'rolldown:runtime'].includes(id);
      expect(entryModule || startupModule || helper, `起動復旧に本体が混入: ${id}`).toBe(true);
    }
    chunk.imports.forEach(visit);
  };
  const application = [...chunks.values()].find(chunk => Object.keys(chunk.modules)
    .some(id => id.endsWith('/apps/desktop/src/renderer/application.tsx')));
  if (application === undefined) throw new Error('Desktop application entry missing');
  visited.clear();
  const visitApplication = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const chunk = chunks.get(name);
    if (chunk === undefined) throw new Error(`Unresolved application import: ${name}`);
    for (const id of Object.keys(chunk.modules)) {
      expect(id).not.toMatch(/\/(?:HelpHost|DrawingWorkspace|StrengthPropertyPanel|AssemblyOverlays|AssemblyTree|AssemblyPropertyPanel|ScriptPanel|MathGeometryPanel)\.tsx$/u);
    }
    chunk.imports.forEach(visitApplication);
  };
  visitApplication(application.fileName);
  visited.clear();
  visit(entry.fileName);
  expect(bytes).toBeLessThanOrEqual(65_536);
  // The import-free guard runs just before the entry, so a failed static import of the entry still reloads once.
  const guard = [...chunks.values()].find(chunk => chunk.isEntry && chunk.facadeModuleId?.endsWith('/packages/ui/src/shell/startupGuardEntry.ts'));
  if (guard === undefined) throw new Error('Desktop startup guard missing');
  expect(guard.imports).toEqual([]);
  expect(guard.dynamicImports).toEqual([]);
  expect(Object.keys(guard.modules).every(id => /\/packages\/ui\/src\/shell\/startupGuard(?:Entry)?\.ts$/u.test(id.replaceAll('\\', '/')))).toBe(true);
  const page = result.output.find(item => item.type === 'asset' && item.fileName === 'index.html');
  if (page?.type !== 'asset') throw new Error('Desktop page missing');
  const html = String(page.source);
  const guardAt = html.indexOf(`<script type="module" crossorigin src="./${guard.fileName}" data-startup-guard></script>`);
  const entryAt = html.indexOf(`src="./${entry.fileName}"`);
  expect(guardAt).toBeGreaterThan(html.indexOf('http-equiv="Content-Security-Policy"'));
  expect(entryAt).toBeGreaterThan(guardAt);
});

it('配布する本体へ起動画面のHTML・文言を同梱し、起動時の外部読込みを要しない', async () => {
  const result = await build({ root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: fileURLToPath(new URL('../../vite.main.config.ts', import.meta.url)),
    configLoader: 'runner', logLevel: 'silent', build: { write: false, emptyOutDir: false } });
  const outputs = Array.isArray(result) ? result : [result];
  const entries = outputs.flatMap(output => {
    if (!('output' in output)) throw new Error('Unexpected main build result');
    return output.output.filter(item => item.type === 'chunk' && item.isEntry);
  });
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  if (entry?.type !== 'chunk') throw new Error('Desktop main entry missing');
  expect(entry.code).toContain('data-startup-shell');
  expect(entry.code).toContain('prefers-reduced-motion');
  expect(entry.code).not.toMatch(/require\(["'][^"']+\.(?:html|json)\?raw["']\)/u);
});
