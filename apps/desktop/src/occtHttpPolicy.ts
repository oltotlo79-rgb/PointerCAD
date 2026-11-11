import { DESKTOP_OCCT_TRANSPORT_ORIGIN } from '@pointercad/ui/desktop-occt-transport';

/**
 * Unpackaged automated Desktop launches only (e2e/tests/electronAppFlow.ts): the value `0` asks the product's
 * own OCCT HTTP server to bind an OS-assigned loopback port and keep it. Packaged applications never read it.
 */
export const OCCT_TRANSPORT_TEST_PORT_ENV = 'PCAD_E2E_OCCT_TRANSPORT_PORT';

/** False keeps the fixed product origin and the lazy preparation order. Any other test value fails the launch. */
export function launchOcctTransportEphemeralPort(isPackaged: boolean, value: string | undefined): boolean {
  if (isPackaged || value === undefined) return false;
  if (value !== '0') throw new Error(`Invalid ${OCCT_TRANSPORT_TEST_PORT_ENV}`);
  return true;
}

/** Desktop application only; help and Worker policies retain their own boundary. */
export function desktopAppContentSecurityPolicy(basePolicy: string, occtOrigin = DESKTOP_OCCT_TRANSPORT_ORIGIN): string {
  let found = false;
  const directives = basePolicy.split(';').map(directive => {
    const words = directive.trim().split(/\s+/);
    if (words[0] !== 'connect-src') return directive.trim();
    if (found || words.includes("'none'")) throw new Error('Invalid Desktop connect-src policy');
    found = true;
    if (!words.includes(occtOrigin)) words.push(occtOrigin);
    return words.join(' ');
  });
  if (!found) throw new Error('Desktop policy must declare connect-src');
  return directives.join(';');
}
