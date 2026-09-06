/**
 * 書き出す立体の決め方(要件 FR-803・FR-804・FR-427、計画書 docs/plans/P6-入出力.md
 * §0.a-0.12・§0.a-0.15・§0.a-0.20・§0.a-0.22・§2.8、タスク2)。
 *
 * ここにあるのは**純関数だけ**で、ファイルもカーネルも触らない。「何を書き出すか」を
 * 先に決めてから(NFR-UX-5「できないことは実行前に断る」)、kernel / io が「どう書くか」を
 * 受け持つ。断りと警告は文字列のキーで返し、日本語の文言は `packages/ui` が持つ。
 */

import type { SolidBody, SolidBodyKind } from '../kernelBridge.js';

import {
  EXPORT_DEVIATION_MM,
  EXPORT_FORMATS,
  EXPORT_MESH_QUALITY,
  type ExportFormat,
  type ExportMeshQuality,
  type ExportNoticeKey,
  type ExportOutcome,
  type ExportQuality,
  type ExportRequest,
  type FileKind,
  type ImportFormat,
} from './types.js';

/**
 * その形式が**面だけの立体**(閉じていない形)を持てるか(§0.a-0.12)。
 *
 * STEP は B-rep なので開いた殻をそのまま持てる。OBJ・glTF は見せるための三角形の集まりで、
 * 閉じているかを問わない。**STL と 3MF は 3D プリント向けの形式で、閉じた立体しか
 * 意味を持たない**ので断る(§2.8「面だけの立体は STL に書き出せません。」)。
 */
export function acceptsShellBody(format: ExportFormat): boolean {
  switch (format) {
    case 'step':
    case 'obj':
    case 'glb':
      return true;
    case 'stl':
    case '3mf':
      return false;
  }
}

/**
 * その形式が**読み込んだ三角形の形**(メッシュ)を持てるか(§0.a-0.23、§2.8)。
 *
 * 三角形の形式(STL・3MF・OBJ・glTF)はそのまま書ける。**STEP だけは B-rep しか持てず、
 * メッシュ → B-rep の変換はしない**(§0.a-0.23)ので断る(§2.8「読み込んだ三角形の形は
 * STEP に書き出せません。STL・3MF・OBJ・glTF なら書き出せます。」)。
 */
export function acceptsMeshBody(format: ExportFormat): boolean {
  switch (format) {
    case 'stl':
    case '3mf':
    case 'obj':
    case 'glb':
      return true;
    case 'step':
      return false;
  }
}

/**
 * その形式にその種類の立体を書けるか。書けないときは**断りのキー**を返す(§2.8 の表)。
 *
 * 閉じた立体(`'solid'`)はどの形式にも書けるので必ず `null` になる。
 */
export function checkExportBodyKind(
  format: ExportFormat,
  kind: SolidBodyKind,
): ExportNoticeKey | null {
  switch (kind) {
    case 'solid':
      return null;
    case 'shell':
      return acceptsShellBody(format) ? null : 'shellNotSupported';
    case 'mesh':
      return acceptsMeshBody(format) ? null : 'meshNotSupported';
  }
}

/**
 * その形式が**三角形を使うか**(なめらかさの指定が効くか)。
 *
 * `.pcad` / ひな形は文書そのもの、STEP は B-rep の曲面、DXF は 2D の線なので、いずれも
 * 三角形分割を通らない。**引数が `ExportFormat` ではなく `FileKind` なのは、DXF が
 * 立体の書き出しの形式ではない**(§0.a-0.34。書き出すのはスケッチの線)一方で、
 * 「なめらかさが効くか」だけは同じ問いだからである。
 */
export function usesTriangles(kind: FileKind): boolean {
  switch (kind) {
    case 'stl':
    case '3mf':
    case 'obj':
    case 'glb':
      return true;
    case 'pcad':
    case 'pcadt':
    case 'step':
    case 'dxf':
      return false;
  }
}

/**
 * その形式が**色を持てるか**(§0.a-0.22)。STEP は XCAF の色、OBJ は材質ファイル、
 * glTF と 3MF は材質を持てる。**STL には色が無い**(§0.a-0.15)。
 */
export function carriesColor(format: ExportFormat): boolean {
  switch (format) {
    case 'step':
    case '3mf':
    case 'obj':
    case 'glb':
      return true;
    case 'stl':
      return false;
  }
}

/**
 * 書き出しに使う三角形分割の逸脱(mm)。三角形を使わない形式では `null`(品質は無視される)。
 * **品質 → mm の表は `EXPORT_DEVIATION_MM` の 1 か所だけ**にある(§0.a-0.20)。
 */
export function exportDeviationMm(kind: FileKind, quality: ExportQuality): number | null {
  return usesTriangles(kind) ? EXPORT_DEVIATION_MM[quality] : null;
}

/**
 * 書き出しに使う三角形分割の細かさの対(§0.a-0.64)。三角形を使わない形式では `null`。
 *
 * **カーネルへ渡すのはこちら。** 長さだけを渡すと角度の既定(0.5 ラジアン)が先に効いて
 * 丸い面が粗いままになり、FR-803 の精度(球で 1% 以内)が成り立たない
 * (`EXPORT_MESH_QUALITY` の注釈にある実測)。
 */
export function exportMeshQuality(
  kind: FileKind,
  quality: ExportQuality,
): ExportMeshQuality | null {
  return usesTriangles(kind) ? EXPORT_MESH_QUALITY[quality] : null;
}

/**
 * ボディの種類。**詰め替え(`toSolidBody`)は必ず値を入れる**が、`SolidBody.bodyKind` は
 * 型のうえでは任意の欄(P5 の見本を直せるのが ui のタスクだったため)なので、欄が無い
 * ときは閉じた立体とみなす。0 と偽るような既定ではなく、カーネルが返す実際の値
 * (§0.a-0.77 で必須の欄になった)と一致する。
 */
function bodyKindOf(body: SolidBody): SolidBodyKind {
  return body.bodyKind ?? 'solid';
}

/** 同じキーを 2 度入れない(画面は同じ 1 行を 2 度出さない)。 */
function addNotice(notices: ExportNoticeKey[], key: ExportNoticeKey): void {
  if (!notices.includes(key)) {
    notices.push(key);
  }
}

/**
 * 依頼から**実際に書き出す立体**を決める(FR-427、FR-803)。
 *
 * 決め方は 3 段:
 * 1. 対象(すべて / 選んだ立体)で絞る。
 * 2. 形式が持てない種類の立体(面だけの立体・読み込んだ三角形の形)を弾く。
 *    **弾いた残りが 1 つでもあれば警告を添えて続け**、全部弾いて 0 個になったら
 *    その理由で断る(3 つのうち 1 つが面だけ、というときに全部を止めないため)。
 * 3. 効かない指定(色を持てない形式で色を出す、三角形を使わない形式のなめらかさ)を
 *    警告にする(**断らない**。§0.a-0.15)。
 *
 * 立体が 1 つも残らないときの理由は、**最初に弾いた立体の種類**のキーにする
 * (画面は 1 行だけ出す。NFR-UX-5)。1 つも渡されなかった・選ばれなかったときは
 * `nothingToExport`(§2.8「書き出せる立体がありません。」)。
 */
export function selectExportBodies(
  bodies: readonly SolidBody[],
  request: ExportRequest,
): ExportOutcome {
  const scoped = request.scope === 'all'
    ? bodies
    : bodies.filter((body) => request.selectedFeatureIds.includes(body.featureId));
  if (scoped.length === 0) {
    return { ok: false, reason: 'nothingToExport' };
  }

  const featureIds: string[] = [];
  const dropped: ExportNoticeKey[] = [];
  for (const body of scoped) {
    const refusal = checkExportBodyKind(request.format, bodyKindOf(body));
    if (refusal === null) {
      featureIds.push(body.featureId);
    } else {
      addNotice(dropped, refusal);
    }
  }
  const firstRefusal = dropped[0];
  if (featureIds.length === 0 && firstRefusal !== undefined) {
    return { ok: false, reason: firstRefusal };
  }
  if (featureIds.length === 0) {
    return { ok: false, reason: 'nothingToExport' };
  }

  const warnings: ExportNoticeKey[] = [...dropped];
  if (request.withColors && !carriesColor(request.format)) {
    addNotice(warnings, 'colorNotSupported');
  }
  if (!usesTriangles(request.format)) {
    addNotice(warnings, 'qualityIgnored');
  }
  return {
    ok: true,
    selection: {
      featureIds,
      deviationMm: exportDeviationMm(request.format, request.quality),
      meshQuality: exportMeshQuality(request.format, request.quality),
      warnings,
    },
  };
}

/**
 * 読み込める形式はすべて書き出しもできること(FR-802 と FR-803 の整合)。
 * P2 が `packages/io` に置いた関数を、P6 で model へ寄せたもの(あちらは再輸出だけ)。
 * 一覧は `EXPORT_FORMATS` の 1 か所だけを見る(並びを写さない)。
 */
export function canRoundTrip(format: ImportFormat): boolean {
  return EXPORT_FORMATS.some((candidate) => candidate === format);
}
