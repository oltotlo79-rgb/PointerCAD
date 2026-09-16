import { useLayoutEffect, useRef, useState } from 'react';

/** 検索を確定した一回だけ、開いた階層の対象行を表示領域へ入れる。 */
export function useRevealNamedTreeRow() {
  const ref = useRef<HTMLElement>(null);
  const [request, setRequest] = useState<{ readonly key: string } | null>(null);
  useLayoutEffect(() => {
    if (request === null || ref.current === null) return;
    // 保存名・IDをCSSセレクタへ連結せず、所属を含む鍵をそのまま照合する。
    const row = [...ref.current.querySelectorAll<HTMLElement>('[data-name-search-key]')]
      .find(element => element.dataset.nameSearchKey === request.key);
    row?.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
  }, [request]);
  return { ref, reveal: (key: string): void => setRequest({ key }) };
}
