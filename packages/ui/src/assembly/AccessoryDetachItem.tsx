/**
 * 組立の木の部品の右クリックのメニューの「付属の部品を外す」(A3)。付属の組を付けた本体の時だけ出す。押すと付属の部品を消し、記録も消える
 * (removeComponent の道。元に戻す 1 回で戻る)。木の関数の行数を増やさないよう、別の部品にした。
 */
import { accessoryIdsOf } from '@pointercad/model';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { deleteAssemblyComponents } from './placeComponentActions.js';

export function AccessoryDetachItem({ componentId, onDone }: { readonly componentId: string; readonly onDone: () => void }):
React.JSX.Element | null {
  const count = useAppStore((state) => (state.assembly === null ? 0 : accessoryIdsOf(state.assembly, componentId).length));
  if (count === 0) return null;
  return (<button title={t('controlGuide.button.assemblyDetachAccessories')} type="button" role="menuitem" className="pcad-button pcad-menu__item"
    onClick={() => {
      const assembly = useAppStore.getState().assembly;
      if (assembly !== null) deleteAssemblyComponents(accessoryIdsOf(assembly, componentId));
      onDone();
    }}>
    {t('assembly.accessory.detach').replace('{count}', String(count))}
  </button>);
}
