import { PointerCadApp } from '@pointercad/ui';
import '@pointercad/ui/style.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('画面の土台が見つかりません。');
}

createRoot(container).render(
  <StrictMode>
    <PointerCadApp />
  </StrictMode>,
);
