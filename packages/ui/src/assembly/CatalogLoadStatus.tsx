/**
 * 選ぶ画面を開いた時に、規格部品の族の表を登録口から読み込み、「読み込み中・済み・失敗」を窓に出す。
 * 登録された族が無い時は何も出さない(今の窓の見た目を変えない)。
 */
import { PRODUCT_CATALOG_REGISTRY, type CatalogRegistry } from '@pointercad/model';
import { useEffect, useState } from 'react';

import { t } from '../i18n/t.js';
import { loadRegisteredCatalogFamilies, type CatalogLoadState } from './catalogFamilyLoading.js';

const MESSAGES = {
  loading: 'catalog.loading.inProgress',
  ready: 'catalog.loading.ready',
  failed: 'catalog.loading.failed',
} as const satisfies Readonly<Record<Exclude<CatalogLoadState, 'none'>, Parameters<typeof t>[0]>>;

/** 窓を開いている間に族の表を読み込み、その状態を返す。閉じた後に終わった読み込みは状態を書かない。 */
export function useCatalogFamilies(open: boolean, registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): CatalogLoadState {
  const [state, setState] = useState<CatalogLoadState>('none');
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    void loadRegisteredCatalogFamilies(registry, setState, () => alive);
    return () => { alive = false; };
  }, [open, registry]);
  return state;
}

/** 族の表の状態の 1 行。失敗は警告として読み上げる。 */
export function CatalogLoadStatus({ state }: { readonly state: CatalogLoadState }): React.JSX.Element | null {
  if (state === 'none') return null;
  return <p className="pcad-popover__hint" role={state === 'failed' ? 'alert' : 'status'}>{t(MESSAGES[state])}</p>;
}
