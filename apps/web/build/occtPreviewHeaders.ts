import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream';
import type { Plugin } from 'vite';

/** Preview does not interpret public/_headers. Serve only the encoded OCCT stream. */
export function occtPreviewHeaders(): Plugin {
  return {
    name: 'pointercad-occt-preview-headers',
    apply: (_config, environment) => environment.isPreview === true,
    configurePreviewServer(server) {
      const output = resolve(server.config.root, server.config.build.outDir);
      const prefix = `${server.config.base}occt/stream/`;
      server.middlewares.use((request, response, next) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          next();
          return;
        }
        // Do not decode escaped separators or accept paths outside this exact asset namespace.
        const pathname = (request.url ?? '').split('?')[0];
        const filename = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
        if (!/^opencascade\.full-[a-f0-9]{64}\.wasm$/.test(filename)) {
          next();
          return;
        }
        const serve = async () => {
          const file = await open(resolve(output, 'occt', 'stream', filename), 'r');
          let transferred = false;
          try {
            const stat = await file.stat();
            const magic = Buffer.alloc(3);
            if (!stat.isFile()) {
              next();
              return;
            }
            const { bytesRead } = await file.read(magic, 0, magic.length, 0);
            if (bytesRead !== 3 || magic[0] !== 0x1f || magic[1] !== 0x8b || magic[2] !== 8) {
              next();
              return;
            }
            // These normally come from Vite's later static middleware. Preserve preview policy.
            for (const [name, value] of Object.entries(server.config.preview.headers ?? {})) {
              if (value !== undefined) response.setHeader(name, value);
            }
            response.setHeader('Content-Type', 'application/wasm');
            response.setHeader('Content-Encoding', 'gzip');
            response.setHeader('Content-Length', stat.size);
            response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            if (request.method === 'HEAD') {
              response.end();
              return;
            }
            // Keep the verified handle: replacing/removing the path cannot turn this into a gzip 404.
            const stream = file.createReadStream({ start: 0, autoClose: true });
            transferred = true;
            pipeline(stream, response, () => { /* pipeline closes both ends on transfer failure. */ });
          } finally {
            if (!transferred) await file.close();
          }
        };
        void serve().catch((error: unknown) => {
          if (error instanceof Error && 'code' in error
            && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
            next();
          } else {
            next(error);
          }
        });
      });
    },
  };
}
