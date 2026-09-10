/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** PlaywrightのWebサーバーだけが設定するE2E観測口の有効化印。 */
  readonly VITE_PCAD_E2E?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
