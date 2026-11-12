/** 立体の種類と表示名をツリー・プロパティで共用する。 */
import type { SolidFeature, SolidLabelKey } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';

/**
 * 立体の種類の名前。ツールバーの道具の名前と同じ言葉にする(FR-501)。
 *
 * 種類が13個に増えたとき、暫定で7つを共通の「未対応」の文言(
 * `featureTree.unsupportedKind`)にしていた。ja.json とツールバーに
 * 加工6種+ばねの正式な文言が揃ったので、正式なキーへ置き換え、
 * 暫定キーは ja.json から削除した。
 */
export const SOLID_KIND_LABEL_KEYS: Readonly<Record<SolidLabelKey, MessageKey>> = {
  sheetBase: 'sheetMetal.base',
  sheetFlange: 'sheetMetal.flange',
  sheetBend: 'sheetMetal.lineBend',
  sheetRelief: 'sheetMetal.relief',
  extrude: 'toolbar.solid.extrude',
  revolve: 'toolbar.solid.revolve',
  sew: 'toolbar.solid.sew',
  union: 'toolbar.solid.union',
  subtract: 'toolbar.solid.subtract',
  intersect: 'toolbar.solid.intersect',
  hole: 'toolbar.machining.hole',
  threadHole: 'toolbar.machining.threadHole',
  fillet: 'toolbar.machining.fillet',
  chamfer: 'toolbar.machining.chamfer',
  linearPattern: 'toolbar.machining.linearPattern',
  circularPattern: 'toolbar.machining.circularPattern',
  spring: 'toolbar.solid.spring',
  // 基本形状5種(FR-429)。
  sphere: 'toolbar.solid.sphere',
  box: 'toolbar.solid.box',
  cylinder: 'toolbar.solid.cylinder',
  cone: 'toolbar.solid.cone',
  torus: 'toolbar.solid.torus',
  // 面をつなぐ(FR-430)とロフト(FR-410)。
  ruled: 'toolbar.solid.ruled',
  loft: 'toolbar.solid.loft',
  /*
    Should 群。
    ここは木とプロパティに種類の名前を出すための最小の割り当てで、
    「作る」の一覧に入る 3 つ(ミラー・スイープ・曲面)は `toolbar.solid.*`、
    「加工」の一覧に入る 6 つは `toolbar.machining.*` にする。
  */
  mirror: 'toolbar.solid.mirror',
  sweep: 'toolbar.solid.sweep',
  surface: 'toolbar.solid.surface',
  functionSurface: 'functionSurface.name',
  draft: 'toolbar.machining.draft',
  // 平らな面の移動(限られた一段)。「加工」の仲間なので toolbar.machining.*。
  faceOffset: 'toolbar.machining.faceOffset',
  holeTranslate: 'toolbar.machining.holeTranslate',
  faceRotate: 'toolbar.machining.faceRotate',
  rib: 'toolbar.machining.rib',
  emboss: 'toolbar.machining.emboss',
  threadShaft: 'toolbar.machining.threadShaft',
  transform: 'toolbar.machining.transform',
  scale: 'toolbar.machining.scale',
  pointPattern: 'toolbar.machining.pointPattern',
  // くり抜き(FR-418)。「加工」の仲間なので
  // `toolbar.machining.*`。
  shell: 'toolbar.machining.shell',
  // 平面による切断(FR-432)。「加工」の畳んだ一覧に入る
  // ので `toolbar.machining.*`。
  cut: 'toolbar.machining.cut',
  surfaceCut: 'toolbar.machining.cut',
  // 読み込んだ形のベースボディ 2 種(FR-802)。対象を取らず新しい
  // ボディを作る「作る」の仲間(基本形状・ばねと同じ)なので `toolbar.solid.*`。
  // 道具のボタン(File > 読み込み)はこのタスクの範囲外。
  importedSolid: 'toolbar.solid.importedSolid',
  importedMesh: 'toolbar.solid.importedMesh',
};

/**
 * 連番の単位で見た種類。ブーリアンは演算名(union / subtract / intersect)を返し、
 * パターンは配置名(linearPattern / circularPattern)を返す。
 * 名前(和1・差1・直線パターン1)を作る model の `SolidLabelKey` と同じ粒度にして、
 * ツリーの絵と種類の名前が実際の名前と食い違わないようにする。
 */
export function solidKindOf(feature: SolidFeature): SolidLabelKey {
  if (feature.kind === 'boolean') {
    return feature.operation;
  }
  if (feature.kind === 'pattern') {
    // 点集合(FR-425)も直線・円形と同じく配置ごとに別の連番にする
    // (model の `SolidLabelKey` と同じ粒度でないと、木の名前と種類の名前が食い違う)。
    switch (feature.placement.kind) {
      case 'linear':
        return 'linearPattern';
      case 'circular':
        return 'circularPattern';
      case 'points':
        return 'pointPattern';
    }
  }
  if (feature.kind === 'primitive') {
    // 基本形状(FR-429)はブーリアンと同じ理屈で、形ごとに別の連番・別の名前にする
    // (「球1」「箱1」…)。木を見て何を置いたのかが分かるようにするため。
    return feature.shape.kind;
  }
  return feature.kind;
}
