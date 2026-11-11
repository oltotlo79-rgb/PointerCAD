import type { FemWorkerPort } from './client.js';

/** Fixed same-origin classic worker. Only the pinned build emits this path; no user URL or CDN fallback. */
export function createProductFemWorker(): FemWorkerPort {
  const url = new URL('./fem/worker.js', document.baseURI);
  const page = new URL(document.baseURI);
  if ((url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'app:')
    || url.protocol !== page.protocol || url.host !== page.host || (url.protocol === 'app:' && url.hostname !== 'pointercad')
    || url.pathname !== '/fem/worker.js' || url.search !== '' || url.hash !== '') {
    throw new Error('Invalid local FEM worker location');
  }
  return new Worker(url, { name: 'pointercad-linear-beam' });
}
