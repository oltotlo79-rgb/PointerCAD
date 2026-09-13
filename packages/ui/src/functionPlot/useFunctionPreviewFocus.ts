import { useEffect, useRef } from 'react';

/** The preview is the result of an explicit action; keep it above the sticky confirmation bar. */
export function useFunctionPreviewFocus() {
  const figure = useRef<HTMLElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => figure.current?.scrollIntoView({ block: 'end', behavior: 'instant' }));
    return () => cancelAnimationFrame(frame);
  }, []);
  return figure;
}
