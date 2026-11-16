/**
 * 規格部品の選ぶ窓(フォーム)の操作の受け口。今の規格部品・鋼材の窓と、機械要素(登録口の族)の窓が同じ物を使う。
 * Enter で置き、Esc で閉じる。IME の変換中(と、変換を確定した Enter の直後の暗黙の送信)は置かず閉じない。
 */
import type { FormHTMLAttributes, MutableRefObject } from 'react';

import { isCompositionKey } from '../commands/compositionKey.js';
import { useAppStore } from '../store/useAppStore.js';

export interface PickerComposition {
  /** IME の変換中。 */
  readonly composing: MutableRefObject<boolean>;
  /** 最後のキーが変換に使われた。新しいキーか指の操作でだけ消す。 */
  readonly compositionKey: MutableRefObject<boolean>;
}

type PickerFormProps = Required<Pick<FormHTMLAttributes<HTMLFormElement>,
  'onCompositionStart' | 'onCompositionEnd' | 'onPointerDownCapture' | 'onSubmit' | 'onKeyDown'>>;

export function pickerFormProps(refs: PickerComposition, submit: () => void): PickerFormProps {
  return {
    onCompositionStart: () => { refs.composing.current = true; },
    onCompositionEnd: () => { refs.composing.current = false; },
    onPointerDownCapture: () => { refs.compositionKey.current = false; },
    onSubmit: (event) => {
      event.preventDefault();
      // The confirming Enter may submit after compositionend; only a new key/pointer clears it.
      if (!refs.composing.current && !refs.compositionKey.current) submit();
    },
    onKeyDown: (event) => {
      refs.compositionKey.current = refs.composing.current || isCompositionKey(event.nativeEvent);
      if (refs.compositionKey.current || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      useAppStore.getState().closeStandardPartPicker();
    },
  };
}
