/**
 * The one judgement of where the single-file Windows portable extracted itself. Dependency-free (node:path only), so
 * the product's post-exit cleanup (portableCleanup.ts), the release script (scripts/release/portableLaunch.mjs) and the
 * release CI check (e2e/release) all share it. No process or file is touched here.
 */
import { win32 } from 'node:path';

/**
 * NSIS names $PLUGINSDIR with its my_GetTempFileName (Source/exehead/util.c): the prefix starts as "nsa" and its
 * third letter is advanced by GetTickCount() % 26, so it is "ns" plus one of a..z. Win32 GetTempFileName then appends
 * the hexadecimal unique number (lower 16 bits, 1 to 4 digits) and ".TMP". InitPluginsDir replaces that file with a
 * directory of the same name, and electron-builder's portable.nsi extracts into "$PLUGINSDIR\app".
 * The CI run 36818570903 extracted to "nsy3217.tmp", which the former "nsi" only pattern rejected (v1.0.0 cleanup then
 * silently did nothing for 25 of 26 launches).
 */
export const NSIS_PLUGINS_DIRECTORY = /^ns[a-z][0-9a-f]{1,4}\.tmp$/iu;

function samePath(left, right) {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

/**
 * This launch's NSIS extraction directory ("<temporary>\ns?XXXX.tmp" holding "app\PointerCAD.exe"), or null.
 * Accept only the direct child of this process's temporary folder, never a globally discovered TEMP directory.
 */
export function nsisExtractionDirectory(executable, temporary) {
  if (typeof executable !== 'string' || typeof temporary !== 'string'
    || !win32.isAbsolute(executable) || !win32.isAbsolute(temporary)) return null;
  const app = win32.dirname(executable), directory = win32.dirname(app);
  if (win32.basename(executable) !== 'PointerCAD.exe' || win32.basename(app) !== 'app'
    || !NSIS_PLUGINS_DIRECTORY.test(win32.basename(directory)) || !samePath(win32.dirname(directory), temporary)) return null;
  return directory;
}
