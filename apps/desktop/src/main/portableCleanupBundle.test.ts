import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

/**
 * v1.0.1 stops the portable post-exit cleanup (see main.ts and noEncodedPowerShell.test.ts): its hidden PowerShell
 * launch with an encoded command line was blocked by Microsoft Defender as Trojan:Win32/Commando.A!ml on 2026-10-01.
 * The former expectations that the main bundle embeds the cleanup script ('Portable extraction directory was
 * replaced.', 'Wait-OwnedProcess') and resolves Node built-ins at runtime ('getBuiltinModule', used only by the
 * cleanup) were removed because the feature was stopped. They are inverted here so the actually shipped main bundle
 * proves the cleanup and its launch shape are absent. Re-enable the embedding checks when v1.0.2 restores the feature.
 */
describe('v1.0.1 の主プロセスの束に終了後の片付けと符号化した PowerShell の起動を含めない', () => {
  it('実際のVite設定で束ね、片付けの台本・符号化の起動を含まず、Nodeの機能をブラウザー用へ置換しない', async () => {
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
      'portable-cleanup-startup.json', 'EncodedCommand', 'FromBase64String', 'portableCleanup.ps1?raw']) {
      expect(main.code, text).not.toContain(text);
    }
    expect(main.code).not.toMatch(/powershell\.exe/iu);
    expect(main.code).not.toContain('__vite-browser-external');
  });
});
