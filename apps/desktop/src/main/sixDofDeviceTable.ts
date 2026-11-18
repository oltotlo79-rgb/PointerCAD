/**
 * 3D マウス(多軸の入力機器。設計 B-09 3-5)として読ませてよい HID 機器の見分け: 許す番号の組の表と、HID の規格の
 * 「多軸の入力機器」の用途。Electron の口への差し替えは sixDofDevices.ts。
 */

/** 製造元と製品の番号の組。 */
export interface HidDeviceId {
  readonly vendorId: number;
  readonly productId: number;
}

/** 製造元の番号ごとの、許す製品の番号。 */
const ALLOWED_PRODUCTS: readonly (readonly [number, readonly number[]])[] = [
  [0x046d, [0xc603, 0xc605, 0xc606, 0xc621, 0xc623, 0xc625, 0xc626, 0xc627, 0xc628, 0xc629, 0xc62b, 0xc640]],
  [0x256f, [0xc62e, 0xc62f, 0xc631, 0xc632, 0xc633, 0xc635]],
];

/**
 * 多軸の入力機器として許す番号の組。2 つの独立な公開の資料(USB の番号の公開の一覧と、多軸の入力機器の公開の運転ソフトの
 * 機器の表)で一致した 18 組だけを入れる(2026-11-18 取得。出どころの URL・SHA-256 は作業の記録に置き、ここには番号だけを
 * 持つ)。番号が載っていても、多軸の入力機器の用途を持たない機器は許さない(isSixDofDevice)。
 */
export const SIX_DOF_DEVICE_IDS: readonly HidDeviceId[] = Object.freeze(ALLOWED_PRODUCTS.flatMap(([vendorId, products]) =>
  products.map((productId) => Object.freeze({ vendorId, productId }))));

/** HID の規格の用途: Generic Desktop の Multi-axis Controller。 */
const GENERIC_DESKTOP_PAGE = 0x01;
const MULTI_AXIS_CONTROLLER = 0x08;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function hasMultiAxisUsage(collections: unknown): boolean {
  return Array.isArray(collections) && collections.some((collection: unknown) => isRecord(collection)
    && collection.usagePage === GENERIC_DESKTOP_PAGE && collection.usage === MULTI_AXIS_CONTROLLER);
}

/** 多軸の入力機器の用途を持ち、番号の組が許す表に載る HID 機器か(形の違う値は断る)。 */
export function isSixDofDevice(device: unknown, ids: readonly HidDeviceId[] = SIX_DOF_DEVICE_IDS): boolean {
  if (!isRecord(device) || !hasMultiAxisUsage(device.collections)) return false;
  const { vendorId, productId } = device;
  return ids.some((id) => id.vendorId === vendorId && id.productId === productId);
}
