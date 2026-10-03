import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

/**
 * v1.0.2 restores the portable post-exit cleanup (main.ts). The actually shipped main bundle must embed the cleanup
 * script and the shared NSIS extraction judgement, resolve Node built-ins at runtime, and still contain none of the
 * launch shapes Microsoft Defender blocked on 2026-10-01 (Trojan:Win32/Commando.A!ml): an encoded command line with a
 * compressed base64 payload run as a script block. The helper and its starter are staged files run with -File instead.
 */
describe('主プロセスの束に終了後の片付けを含め、符号化した PowerShell の起動を含めない', () => {
  it('実際のVite設定で束ね、片付けの台本・展開先の判定を含み、符号化の起動を含まず、Nodeの機能をブラウザー用へ置換しない', async () => {
    const result = await build({
      configFile: fileURLToPath(new URL('../../vite.main.config.ts', import.meta.url)),
      root: fileURLToPath(new URL('../../', import.meta.url)),
      // Build in memory only. Do not overwrite dist or start Electron.
      build: { write: false, emptyOutDir: false },
    });
    const builds = Array.isArray(result) ? result : [result];
    const outputs = builds.flatMap(output => {
      if (!('output' in output)) throw new Error('Unexpected desktop build output');
      return output.output;
    });
    const main = outputs.find(output => output.type === 'chunk' && output.isEntry);
    if (main?.type !== 'chunk') throw new Error('Missing desktop main entry');
    // The bundle is the real entry: guard against checking an empty or wrong chunk.
    expect(main.code).toContain('registerSchemesAsPrivileged');
    for (const text of ['Portable extraction directory was replaced.', 'Wait-OwnedProcess', 'PointerCadPortableCleanup',
      'Remove-CleanupStage', 'portable-cleanup-startup.json', 'pointercad-cleanup-', 'RemoteSigned', 'getBuiltinModule',
      'CreateNoWindow', 'spawnSync']) {
      expect(main.code, text).toContain(text);
    }
    // The shared judgement of the extraction name ("ns" + a..z + hex), not the former "nsi" only pattern.
    expect(main.code).toContain('^ns[a-z][0-9a-f]{1,4}');
    expect(main.code).not.toContain('^nsi[0-9a-f]');
    for (const text of ['EncodedCommand', 'FromBase64String', 'GZipStream', '[scriptblock]::Create', 'Invoke-Expression',
      'WindowStyle', 'portableCleanup.ps1?raw']) {
      expect(main.code, text).not.toContain(text);
    }
    expect(main.code).not.toContain('__vite-browser-external');
  });
});
