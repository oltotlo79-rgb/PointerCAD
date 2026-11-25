import { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore.js';
import type { ExchangeKernel } from './exchangeFile.js';

interface IgesProbe {
  readonly kernel: ExchangeKernel;
  readonly available: boolean;
}

/** Probe the attached worker when an exchange panel opens. */
export function useIgesSupport(): 'checking' | 'supported' | 'unavailable' {
  const kernel = useAppStore(state => state.exchangeKernel);
  const [probe, setProbe] = useState<IgesProbe | null>(null);
  useEffect(() => {
    if (kernel?.supportsIges === undefined) return;
    let current = true;
    void kernel.supportsIges().then(available => {
      if (current) setProbe({ kernel, available });
    }, () => {
      if (current) setProbe({ kernel, available: false });
    });
    return () => { current = false; };
  }, [kernel]);
  if (kernel?.supportsIges === undefined) return 'unavailable';
  if (probe?.kernel !== kernel) return 'checking';
  return probe.available ? 'supported' : 'unavailable';
}
