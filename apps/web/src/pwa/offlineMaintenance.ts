/** A later live page requests collection after old pages close. This sends no document or formula. */
export function startOfflineMaintenance(container: ServiceWorkerContainer, page: Document): () => void {
  const request = () => {
    if (page.visibilityState === 'visible') container.controller?.postMessage({ format: 'pointercad-offline-cleanup/1' });
  };
  const timer = setInterval(request, 60_000);
  page.addEventListener('visibilitychange', request);
  container.addEventListener('controllerchange', request);
  return () => { clearInterval(timer); page.removeEventListener('visibilitychange', request);
    container.removeEventListener('controllerchange', request); };
}
