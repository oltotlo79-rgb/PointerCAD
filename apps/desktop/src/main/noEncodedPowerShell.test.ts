import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Recurrence check for 2026-10-01 02:00:07: Microsoft Defender blocked a hidden PowerShell whose script was passed as an
 * encoded command line (gzip + base64 + scriptblock) as Trojan:Win32/Commando.A!ml. The product's portable cleanup
 * used the same shape, so v1.0.1 stops calling it (main.ts). The shipped main process must not be able to start
 * PowerShell that way. The cleanup module is kept only as a part for v1.0.2 and must stay unreachable from main.ts.
 */
const mainDirectory = dirname(fileURLToPath(import.meta.url));
const entry = join(mainDirectory, 'main.ts');

// PowerShell accepts any unambiguous prefix of -EncodedCommand (-e, -en, -enc, ...) and the alias -ec.
const encodedSwitches = ['ec', ...Array.from('encodedcommand', (_, index) => 'encodedcommand'.slice(0, index + 1))];
const ENCODED_LAUNCH_PATTERNS: readonly RegExp[] = [
  /EncodedCommand/iu,
  new RegExp(String.raw`(?<![\w-])-(?:${encodedSwitches.join('|')})(?=[\s'"\x60,\]]|$)`, 'imu'),
  /FromBase64String/iu,
];

/** Modules that still contain the blocked launch shape. They are parked for v1.0.2 and must not be reachable. */
const PARKED_MODULES = ['portableCleanup.ts'];

function shippedSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const path = join(directory, item.name);
    if (item.isDirectory()) return shippedSources(path);
    if (!item.isFile() || /\.test\.ts$/u.test(item.name)) return [];
    return ['.ts', '.ps1'].includes(extname(item.name).toLowerCase()) ? [path] : [];
  });
}

function name(path: string): string {
  return relative(mainDirectory, path).replaceAll('\\', '/');
}

function resolveImport(from: string, specifier: string): string {
  const target = resolve(dirname(from), specifier.replace(/\?.*$/u, ''));
  const candidates = [target, target.replace(/\.js$/u, '.ts'), target.replace(/\.js$/u, '.tsx'), `${target}.ts`, join(target, 'index.ts')];
  const found = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  // An unresolved relative import must fail here instead of silently shrinking the reachable set.
  if (found === undefined) throw new Error(`Unresolved import ${specifier} in ${from}`);
  return found;
}

/** Every local file the main entry can load through static, dynamic, raw-text or require imports. */
function reachableFrom(start: string): Set<string> {
  const seen = new Set<string>();
  const pending = [start];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (extname(path).toLowerCase() === '.ps1') continue;
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gu)) {
      const specifier = match[1];
      if (specifier?.startsWith('.') === true) pending.push(resolveImport(path, specifier));
    }
  }
  return seen;
}

describe('配布する主プロセスが PowerShell を符号化したコマンドで起こさない', () => {
  it('走査の型が実際の起動の形を見つける', () => {
    const launches = ['-EncodedCommand JABz', "'-EncodedCommand',", '-enc JABz', '-e JABz', "'-ec', data",
      "[Convert]::FromBase64String('AA==')"];
    for (const launch of launches) expect(ENCODED_LAUNCH_PATTERNS.some(pattern => pattern.test(launch)), launch).toBe(true);
    for (const harmless of ['Out-File -Encoding utf8', '-NoProfile -Command -', 'value-enc x', 'case -e1']) {
      expect(ENCODED_LAUNCH_PATTERNS.some(pattern => pattern.test(harmless)), harmless).toBe(false);
    }
  });

  it('主プロセスのソース(テストを除く .ts・.ps1)で符号化の起動を含むのは止めた片付けの部品だけ', () => {
    const hits = shippedSources(mainDirectory)
      .filter(path => ENCODED_LAUNCH_PATTERNS.some(pattern => pattern.test(readFileSync(path, 'utf8'))))
      .map(name).sort();
    expect(hits).toEqual(PARKED_MODULES);
  });

  it('止めた片付けの部品(と台本)は main.ts から到達しない', () => {
    const reachable = [...reachableFrom(entry)].map(name);
    expect(reachable).toContain('main.ts');
    expect(reachable).toContain('appProtocol.ts');
    for (const parked of [...PARKED_MODULES, 'portableCleanup.ps1']) expect(reachable).not.toContain(parked);
    for (const path of reachable) {
      const source = readFileSync(join(mainDirectory, path), 'utf8');
      for (const pattern of ENCODED_LAUNCH_PATTERNS) expect(pattern.test(source), `${path}: ${pattern.source}`).toBe(false);
    }
  });
});
