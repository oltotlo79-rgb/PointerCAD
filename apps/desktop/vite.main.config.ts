import { defineConfig } from 'vite';

/**
 * 本体プロセスは CommonJS で出す。Electron の本体プロセスで ESM を使うと
 * sandbox: true の preload と噛み合わせが難しくなるため。
 */
export default defineConfig({
  build: {
    outDir: 'dist/main',
    emptyOutDir: true,
    target: 'node22',
    lib: {
      entry: 'src/main/main.ts',
      formats: ['cjs'],
      fileName: () => 'main.cjs',
    },
    rollupOptions: {
      external: ['electron', 'node:path', 'node:url', 'node:fs', 'node:crypto'],
    },
  },
});
