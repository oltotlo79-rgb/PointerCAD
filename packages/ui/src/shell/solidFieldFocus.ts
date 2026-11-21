/**
 * 右の欄の立体の 1 欄へ焦点を移す頼み(ストアの `focusRequest`。M-05 4-1b の押し引きで穴の面を押した時)の受け手。
 *
 * 右の欄の焦点の正本は、ふだんは利用者のクリックとタブ移動で、こちらからは動かさない。例外はこの頼みだけで、
 * 頼みが指す立体と欄の鍵を返す。呼び出し側はその欄の `focused` を真にし(`ExpressionField` が焦点を移して全選択する)、
 * この関数が描いた後に頼みを消す(子の欄の効果が先に走るので、焦点を移した後に消える)。
 */

import { useEffect } from 'react';

import type { SolidFieldKey } from '../solid/solidPropertyContracts.js';
import { useAppStore } from '../store/useAppStore.js';

/** この立体の欄を指す頼みがあれば、その欄の鍵。無ければ null。 */
export function useSolidFieldFocus(featureId: string): SolidFieldKey | null {
  const request = useAppStore((state) => state.focusRequest);
  const target = request?.target;
  const fieldKey = target?.kind === 'solidField' && target.featureId === featureId ? target.fieldKey : null;
  useEffect(() => {
    if (fieldKey !== null && request !== null) useAppStore.getState().consumeFocusRequest(request.serial);
  }, [fieldKey, request]);
  return fieldKey;
}
