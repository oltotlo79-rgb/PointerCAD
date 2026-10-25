import { DESKTOP_OCCT_TRANSPORT_ORIGIN } from '@pointercad/ui/desktop-occt-transport';

/** Desktop application only; help and Worker policies retain their own boundary. */
export function desktopAppContentSecurityPolicy(basePolicy: string): string {
  let found = false;
  const directives = basePolicy.split(';').map(directive => {
    const words = directive.trim().split(/\s+/);
    if (words[0] !== 'connect-src') return directive.trim();
    if (found || words.includes("'none'")) throw new Error('Invalid Desktop connect-src policy');
    found = true;
    if (!words.includes(DESKTOP_OCCT_TRANSPORT_ORIGIN)) words.push(DESKTOP_OCCT_TRANSPORT_ORIGIN);
    return words.join(' ');
  });
  if (!found) throw new Error('Desktop policy must declare connect-src');
  return directives.join(';');
}
