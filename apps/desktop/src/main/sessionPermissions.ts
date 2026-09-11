import type { Session } from 'electron';

/** R11: 権限は全て明示拒否。保存・印刷は検証済みIPCを通る。 */
export function denyBrowserPermissions(session: Pick<Session,
  'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'setDevicePermissionHandler' | 'setDisplayMediaRequestHandler'>): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false); });
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => { callback({}); });
}
