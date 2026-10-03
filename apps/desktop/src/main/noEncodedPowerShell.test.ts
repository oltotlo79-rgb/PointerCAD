import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Recurrence check for 2026-10-01 02:00:07: Microsoft Defender blocked a PowerShell whose script was passed as an
 * encoded command line (gzip + base64 + scriptblock) as Trojan:Win32/Commando.A!ml, judged from the command line alone.
 * The portable cleanup used the same shape, so v1.0.1 stopped it. v1.0.2 restores it as a staged script file started
 * with -File (portableCleanup.ts). No desktop source may start PowerShell with an encoded, compressed or inline script
 * again, and the cleanup must stay wired into the real entry.
 */
const mainDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = dirname(mainDirectory);
const entry = join(mainDirectory, 'main.ts');

// PowerShell accepts any unambiguous prefix of -EncodedCommand (-e, -en, -enc, ...) and the alias -ec.
const encodedSwitches = ['ec', ...Array.from('encodedcommand', (_, index) => 'encodedcommand'.slice(0, index + 1))];
const ENCODED_LAUNCH_PATTERNS: readonly RegExp[] = [
  /EncodedCommand/iu,
  new RegExp(String.raw`(?<![\w-])-(?:${encodedSwitches.join('|')})(?=[\s'"\x60,\]]|$)`, 'imu'),
  /FromBase64String/iu,
  // Shapes that read as obfuscation: compressed payloads, run-a-string, and a hidden window switch.
  /GZipStream|DeflateStream/iu,
  /Invoke-Expression|(?<![\w-])iex(?![\w-])/iu,
  /\[scriptblock\]::Create/iu,
  /-WindowStyle/iu,
];

function shippedSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const path = join(directory, item.name);
    if (item.isDirectory()) return shippedSources(path);
    if (!item.isFile() || /\.test\.tsx?$/u.test(item.name)) return [];
    return ['.ts', '.tsx', '.mts', '.mjs', '.cjs', '.js', '.ps1', '.html'].includes(extname(item.name).toLowerCase()) ? [path] : [];
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

function hits(source: string): string[] {
  return ENCODED_LAUNCH_PATTERNS.filter(pattern => pattern.test(source)).map(pattern => pattern.source);
}

describe('配布するデスクトップ版が PowerShell を符号化・圧縮・文字列実行の形で起こさない', () => {
  it('走査の型が実際の起動の形を見つけ、普通の書き方は見つけない', () => {
    const launches = ['-EncodedCommand JABz', "'-EncodedCommand',", '-enc JABz', '-e JABz', "'-ec', data",
      "[Convert]::FromBase64String('AA==')", '[IO.Compression.GZipStream]::new($bytes)', 'IEX $code',
      'Invoke-Expression $code', '& ([scriptblock]::Create($source))', "'-WindowStyle', 'Hidden'"];
    for (const launch of launches) expect(hits(launch), launch).not.toEqual([]);
    for (const harmless of ['Out-File -Encoding utf8', '-NoProfile -Command -', 'value-enc x', 'case -e1',
      "'-ExecutionPolicy', 'RemoteSigned', '-File', script", 'const suffix = "-ex"', 'complexity']) {
      expect(hits(harmless), harmless).toEqual([]);
    }
  });

  it('デスクトップ版のソース(テストを除く)のどこにも符号化・圧縮・文字列実行の起動が無い', () => {
    const sources = shippedSources(sourceDirectory);
    // Guard against an empty scan: the cleanup and its script are part of what is shipped.
    expect(sources.map(name)).toEqual(expect.arrayContaining(['main.ts', 'portableCleanup.ts', 'portableCleanup.ps1', 'portableCleanupStart.ps1', 'portableExtraction.mjs']));
    const found = sources.flatMap(path => hits(readFileSync(path, 'utf8')).map(pattern => `${name(path)}: ${pattern}`));
    expect(found).toEqual([]);
  });

  it('終了後の片付け(と台本・展開先の判定)は main.ts から到達し、到達する全ファイルにその形が無い', () => {
    const reachable = [...reachableFrom(entry)].map(name);
    for (const part of ['main.ts', 'appProtocol.ts', 'portableCleanup.ts', 'portableCleanup.ps1', 'portableCleanupStart.ps1',
      'portableExtraction.mjs']) {
      expect(reachable).toContain(part);
    }
    for (const path of reachable) expect(hits(readFileSync(join(mainDirectory, path), 'utf8')), path).toEqual([]);
  });
});
