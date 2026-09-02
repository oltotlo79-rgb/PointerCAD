import { PointerCadApp, t } from '@pointercad/ui';
import '@pointercad/ui/style.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const container = document.getElementById('root');
if (container === null) {
  // React の起動前に落ちる唯一の箇所。文言の正本は ja.json に置く(NFR-MA-5)。
  throw new Error(t('bootstrap.rootMissing'));
}

createRoot(container).render(
  <StrictMode>
    <PointerCadApp />
  </StrictMode>,
);
