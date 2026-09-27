import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSha256Sums, collectReleaseFileDigests, formatSha256Sums,
  readDesktopCandidateAssets, verifyReleaseDigestsAgainstCandidates,
} from '../../../../scripts/release/build-sha256sums.mjs';

const version = '1.0.0';
const setup = `PointerCAD-${version}-windows-x64-setup.exe`;
const portable = `PointerCAD-${version}-windows-x64-portable.exe`;
const appImage = `PointerCAD-${version}-linux-x64.AppImage`;
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

const roots: string[] = [];
function tempDir(prefix: string): string {
  const path = mkdtempSync(join(resolve(tmpdir()), prefix));
  roots.push(path);
  return path;
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function writeCandidate(stage: string, platform: 'win32' | 'linux', assets: { name: string; bytes: number; sha256: string }[]): void {
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, 'candidate.json'), JSON.stringify({
    format: 'pointercad-desktop-candidate/1', version, sourceCommit: 'a'.repeat(40), platform, arch: 'x64',
    signed: false, assets, packages: [], application: {}, installed: false, releaseCertified: false,
  }));
}

function makeStagedCandidates(folder: string): { windowsStage: string; linuxStage: string } {
  const setupBytes = 'setup-bytes', portableBytes = 'portable-bytes', appImageBytes = 'appimage-bytes';
  writeFileSync(join(folder, setup), setupBytes);
  writeFileSync(join(folder, portable), portableBytes);
  writeFileSync(join(folder, appImage), appImageBytes);
  const windowsStage = tempDir('pointercad-sha256sums-win-');
  writeCandidate(windowsStage, 'win32', [
    { name: setup, bytes: setupBytes.length, sha256: hashOf(setupBytes) },
    { name: portable, bytes: portableBytes.length, sha256: hashOf(portableBytes) },
  ]);
  const linuxStage = tempDir('pointercad-sha256sums-linux-');
  writeCandidate(linuxStage, 'linux', [{ name: appImage, bytes: appImageBytes.length, sha256: hashOf(appImageBytes) }]);
  return { windowsStage, linuxStage };
}

describe('配布物ごとのSHA-256一覧(SHA256SUMS)を作る', () => {
  it('sha256sum -cがそのまま読める形で、名前順・LF・1行1件に並べる', () => {
    const entries = [
      { name: 'b.pdf', sha256: 'b'.repeat(64) },
      { name: 'a.exe', sha256: 'a'.repeat(64) },
    ];
    expect(formatSha256Sums(entries)).toBe(`${'a'.repeat(64)}  a.exe\n${'b'.repeat(64)}  b.pdf\n`);
  });

  it('空・重複名・16進以外の指紋・改行を含む名前を拒否する', () => {
    expect(() => formatSha256Sums([])).toThrow('Nothing to record');
    expect(() => formatSha256Sums([{ name: 'a', sha256: 'a'.repeat(64) }, { name: 'a', sha256: 'b'.repeat(64) }])).toThrow('Duplicate');
    expect(() => formatSha256Sums([{ name: 'a', sha256: 'zz' }])).toThrow('Invalid SHA256SUMS entry hash');
    expect(() => formatSha256Sums([{ name: 'a\nb', sha256: 'a'.repeat(64) }])).toThrow('Invalid SHA256SUMS entry name');
  });

  it('フォルダー内の各ファイルを実際にSHA-256で集計し、名前順に返す', async () => {
    const folder = tempDir('pointercad-sha256sums-collect-');
    writeFileSync(join(folder, 'b.pdf'), 'volume-2');
    writeFileSync(join(folder, 'a.exe'), 'installer');
    const entries = await collectReleaseFileDigests(folder);
    expect(entries).toEqual([
      { name: 'a.exe', sha256: hashOf('installer') },
      { name: 'b.pdf', sha256: hashOf('volume-2') },
    ]);
  });

  it('空のフォルダーを拒否する', async () => {
    const folder = tempDir('pointercad-sha256sums-empty-');
    await expect(collectReleaseFileDigests(folder)).rejects.toThrow('no files to sum');
  });

  it('中身が空のファイルを拒否する', async () => {
    const folder = tempDir('pointercad-sha256sums-invalid-');
    writeFileSync(join(folder, 'empty.pdf'), '');
    await expect(collectReleaseFileDigests(folder)).rejects.toThrow('Invalid release file');
  });

  it('シンボリックリンクを拒否する(権限が無い環境では確認を省く)', async (context) => {
    const folder = tempDir('pointercad-sha256sums-link-');
    writeFileSync(join(folder, 'real.pdf'), 'volume');
    try {
      await symlink(join(folder, 'real.pdf'), join(folder, 'link.pdf'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return; }
      throw error;
    }
    await expect(collectReleaseFileDigests(folder)).rejects.toThrow('must not be a link');
  });

  it('既存のSHA256SUMSは集計から外し、読めないフォルダーは拒否する', async () => {
    const folder = tempDir('pointercad-sha256sums-existing-');
    writeFileSync(join(folder, 'a.exe'), 'installer');
    writeFileSync(join(folder, 'SHA256SUMS'), 'stale');
    const entries = await collectReleaseFileDigests(folder);
    expect(entries).toEqual([{ name: 'a.exe', sha256: hashOf('installer') }]);
    await expect(collectReleaseFileDigests(join(folder, 'missing'))).rejects.toThrow();
  });

  it('candidate.jsonの記録と一致するassets[].sha256を名前で読み出す', async () => {
    const folder = tempDir('pointercad-sha256sums-candidate-ok-');
    const { windowsStage } = makeStagedCandidates(folder);
    const windows = await readDesktopCandidateAssets(windowsStage);
    expect(windows.platform).toBe('win32');
    expect(windows.version).toBe(version);
    expect(windows.assets.get(setup)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('形式・欠落・別版のcandidate.jsonを拒否する', async () => {
    const bad = tempDir('pointercad-sha256sums-candidate-bad-');
    writeFileSync(join(bad, 'candidate.json'), JSON.stringify({ format: 'other/1' }));
    await expect(readDesktopCandidateAssets(bad)).rejects.toThrow('Invalid desktop candidate record');
    const badPlatform = tempDir('pointercad-sha256sums-candidate-darwin-');
    writeFileSync(join(badPlatform, 'candidate.json'),
      JSON.stringify({ format: 'pointercad-desktop-candidate/1', version, platform: 'darwin', assets: [] }));
    await expect(readDesktopCandidateAssets(badPlatform)).rejects.toThrow('Unsupported desktop candidate platform');
  });

  it('release-manifestの記録と食い違うファイルを止める', () => {
    const entries = [{ name: setup, sha256: 'a'.repeat(64) }];
    const candidates = [{ platform: 'win32' as const, version, assets: new Map([[setup, 'b'.repeat(64)]]) }];
    expect(() => verifyReleaseDigestsAgainstCandidates(entries, candidates)).toThrow('differs from the desktop candidate record');
  });

  it('release-manifestが要求する配布物が抜けていると止める', () => {
    const entries = [{ name: 'other.exe', sha256: 'a'.repeat(64) }];
    const candidates = [{ platform: 'win32' as const, version, assets: new Map([[setup, 'a'.repeat(64)]]) }];
    expect(() => verifyReleaseDigestsAgainstCandidates(entries, candidates)).toThrow('missing a desktop candidate asset');
  });

  it('通しでSHA256SUMSを1回だけ書き、両OSの候補と一致することを確かめる', async () => {
    const folder = tempDir('pointercad-sha256sums-build-');
    const { windowsStage, linuxStage } = makeStagedCandidates(folder);
    const result = await buildSha256Sums({ folder, windowsStage, linuxStage });
    expect(result.entries.map((entry) => entry.name)).toEqual([appImage, portable, setup].sort());
    expect(result.content.trim().split('\n')).toHaveLength(3);
    await expect(buildSha256Sums({ folder, windowsStage, linuxStage })).rejects.toThrow();
  });

  it('配布物を改ざんすると通しの組み立てが止まる', async () => {
    const folder = tempDir('pointercad-sha256sums-tamper-');
    const { windowsStage, linuxStage } = makeStagedCandidates(folder);
    writeFileSync(join(folder, setup), 'tampered-bytes');
    await expect(buildSha256Sums({ folder, windowsStage, linuxStage })).rejects.toThrow('differs from the desktop candidate record');
  });
});
