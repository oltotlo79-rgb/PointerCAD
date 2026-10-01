/** Dependency-free check of where the single-file Windows portable extracted itself. No process or file is touched. */
import { win32 } from 'node:path';

/**
 * NSIS names $PLUGINSDIR with its my_GetTempFileName (Source/exehead/util.c): the prefix starts as "nsa" and its
 * third letter is advanced by GetTickCount() % 26, so it is "ns" plus one of a..z. Win32 GetTempFileName then appends
 * the hexadecimal unique number (lower 16 bits, 1 to 4 digits) and ".TMP". InitPluginsDir replaces that file with a
 * directory of the same name, and electron-builder's portable.nsi extracts into "$PLUGINSDIR\app".
 * The CI run 36818570903 extracted to "nsy3217.tmp", which the former "nsi" only pattern rejected.
 */
const NSIS_PLUGINS_DIRECTORY = /^ns[a-z][0-9a-f]{1,4}\.tmp$/iu;

/** Accept only this run's NSIS extraction, never a globally discovered TEMP directory. */
export function nsisExtractionDirectory(executable, temporary) {
  const app = win32.dirname(executable), directory = win32.dirname(app);
  if (!win32.isAbsolute(executable) || !win32.isAbsolute(temporary)
    || win32.basename(executable) !== 'PointerCAD.exe' || win32.basename(app) !== 'app'
    || !NSIS_PLUGINS_DIRECTORY.test(win32.basename(directory))
    || win32.normalize(win32.dirname(directory)).toLowerCase() !== win32.normalize(temporary).toLowerCase()) {
    throw new Error(`Portable process is outside this run's NSIS extraction: ${executable}`);
  }
  return directory;
}
