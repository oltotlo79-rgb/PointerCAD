import { defineConfig } from 'vite';

/** preload も CommonJS で出す(sandbox: true の preload は CommonJS しか読めない)。 */
export default defineConfig({
  build: {
    outDir: 'dist/preload',
    emptyOutDir: true,
    target: 'node22',
    lib: {
      entry: 'src/preload/preload.ts',
      formats: ['cjs'],
      fileName: () => 'preload.cjs',
    },
    rollupOptions: {
      external: ['electron'],
    },
  },
});
