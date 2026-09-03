/*
 * 画面で使うアイコン。新しい依存を増やさないため、インライン SVG で持つ。
 *
 * 取り決め: 座標系は 16 × 16、線は currentColor の線幅 1.5、面は currentColor の半透明。
 * 文字と並べて使うため既定の大きさは 16 画素、意味は隣の文字が担うので読み上げ対象にしない。
 */

/** アイコン共通の指定。 */
export interface IconProps {
  /** 一辺の画素数。既定は 16。 */
  readonly size?: number;
  /** 追加のクラス名。 */
  readonly className?: string;
}

interface SvgIconProps extends IconProps {
  readonly children: React.ReactNode;
}

const DEFAULT_SIZE = 16;

/** 全アイコン共通の外枠。大きさと色以外の指定をここ1箇所に集める。 */
function SvgIcon({ size = DEFAULT_SIZE, className, children }: SvgIconProps): React.JSX.Element {
  return (
    <svg
      className={className === undefined ? 'pcad-icon' : `pcad-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** 立方体。製品の印と、ツリーの形の行に使う。 */
export function CubeIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 1.75 14 5.25v5.5L8 14.25 2 10.75v-5.5z" />
      <path d="M2 5.25 8 8.75l6-3.5" />
      <path d="M8 8.75v5.5" />
    </SvgIcon>
  );
}

/** 重なり。ツリーの部品(まとまり)の行に使う。 */
export function LayersIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 1.75 14.25 5 8 8.25 1.75 5z" />
      <path d="M2.75 7.6 8 10.25 13.25 7.6" />
      <path d="M2.75 10.35 8 13l5.25-2.65" />
    </SvgIcon>
  );
}

/** 透視投影。画面の線から、奥の 1 点へ集まっていく 2 本の線で表す。 */
export function PerspectiveIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.5 2.5v11" />
      <path d="M2.5 3.6 10.8 6.8" />
      <path d="M2.5 12.4 10.8 9.2" />
      <circle cx="13.2" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/**
 * 平行投影。透視投影と同じ画面の線から、奥へ「平行なまま」伸びる 2 本の線で表す。
 * 2 つを並べたとき、線が集まるか平行のままかだけが違って見えるようにしてある。
 */
export function OrthographicIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.5 2.5v11" />
      <path d="M2.5 4.4h11" />
      <path d="M2.5 11.6h11" />
    </SvgIcon>
  );
}

/** 面のみ。塗りだけの立方体。 */
export function ShadedIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="M8 1.75 14 5.25v5.5L8 14.25 2 10.75v-5.5z"
        fill="currentColor"
        fillOpacity={0.35}
      />
    </SvgIcon>
  );
}

/** 面と稜線。塗りに稜線を重ねた立方体。 */
export function ShadedWithEdgesIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="M8 1.75 14 5.25v5.5L8 14.25 2 10.75v-5.5z"
        fill="currentColor"
        fillOpacity={0.35}
      />
      <path d="M2 5.25 8 8.75l6-3.5" />
      <path d="M8 8.75v5.5" />
    </SvgIcon>
  );
}

/** 稜線のみ。線だけの立方体。 */
export function WireframeIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 1.75 14 5.25v5.5L8 14.25 2 10.75v-5.5z" />
      <path d="M2 5.25 8 8.75l6-3.5" />
      <path d="M8 8.75v5.5" />
    </SvgIcon>
  );
}

/** 方眼。 */
export function GridIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="2" y="2" width="12" height="12" rx="1.5" />
      <path d="M6 2v12" />
      <path d="M10 2v12" />
      <path d="M2 6h12" />
      <path d="M2 10h12" />
    </SvgIcon>
  );
}

/** ホーム視点。 */
export function HomeIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.25 7.5 8 2.5l5.75 5" />
      <path d="M3.9 6.9v6.6h8.2V6.9" />
      <path d="M6.4 13.5V9.6h3.2v3.9" />
    </SvgIcon>
  );
}

/** 開閉の印。閉じているときは右向き、開いているときは CSS で 90 度回す。 */
export function ChevronRightIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </SvgIcon>
  );
}

/** マウス。ステータスバーの操作ガイドに添える。 */
export function MouseIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="4.25" y="1.75" width="7.5" height="12.5" rx="3.75" />
      <path d="M8 4.5v2.6" />
    </SvgIcon>
  );
}

/** 失敗の印。 */
export function AlertIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 1.9 15 13.7H1z" />
      <path d="M8 6.3v3.3" />
      <circle cx="8" cy="11.8" r="0.85" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/** 点を打つ。空状態の案内に添える。 */
export function PlotPointIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 1.5v3.2" />
      <path d="M8 11.3v3.2" />
      <path d="M1.5 8h3.2" />
      <path d="M11.3 8h3.2" />
      <circle cx="8" cy="8" r="2.3" />
      <circle cx="8" cy="8" r="0.85" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/** 中身が無いことを示す破線の立方体。 */
export function EmptyBoxIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 1.75 14 5.25v5.5L8 14.25 2 10.75v-5.5z" strokeDasharray="2.4 2.4" />
    </SvgIcon>
  );
}

/** 矢印のカーソル。選択の道具に使う。 */
export function CursorIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3.5 2.2v9.6l2.6-2.5 1.7 3.6 1.9-.9-1.7-3.5h3.6z" />
    </SvgIcon>
  );
}

/** 線分。2 つの端点を結ぶ線で表す。 */
export function LineToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M4.7 11.3 11.3 4.7" />
      <circle cx="3.4" cy="12.6" r="1.5" />
      <circle cx="12.6" cy="3.4" r="1.5" />
    </SvgIcon>
  );
}

/** 円弧。四分円と、その中心の点で表す。 */
export function ArcToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3.5 12.5A9 9 0 0 0 12.5 3.5" />
      <circle cx="3.5" cy="3.5" r="1" fill="currentColor" stroke="none" />
      <path d="M3.5 3.5 9.9 9.9" strokeDasharray="1.8 1.8" />
    </SvgIcon>
  );
}

/** 点列。一直線に等間隔で並ぶ 4 つの点。 */
export function PointArrayToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="2.6" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="6.2" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="9.8" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="13.4" cy="8" r="1.15" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/** 面。斜めに見た平行四辺形を塗って表す。 */
export function FaceToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M1.8 11.2 6.2 4.8h8l-4.4 6.4z" fill="currentColor" fillOpacity={0.35} />
    </SvgIcon>
  );
}

/** 作図面。斜めに見た平行四辺形に、方眼の線を1本ずつ入れて表す。 */
export function PlaneIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M1.8 11.2 6.2 4.8h8l-4.4 6.4z" />
      <path d="M4 8h8" />
      <path d="M5.8 11.2 10.2 4.8" />
    </SvgIcon>
  );
}

/**
 * 視点に合わせる。上に目、下に作図面を置いて「いま見ている向きの面にする」を表す。
 * 文字を出さないボタンで使うので、名前はツールチップと読み上げ名が担う。
 */
export function MatchViewIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M1.6 5.2c2.2-3 8.6-3 10.8 0-2.2 3-8.6 3-10.8 0z" />
      <circle cx="7" cy="5.2" r="1.3" />
      <path d="M2.6 13.4 5.8 9.4h7.6l-3.2 4z" />
    </SvgIcon>
  );
}

/** 吸着。折れた線と、その角に重なる丸で「この点に合わせる」を表す。 */
export function SnapIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2 12.6 8 8l6-4.6" />
      <circle cx="8" cy="8" r="2.6" />
    </SvgIcon>
  );
}

/*
 * 吸着の種別 5 つ。どれも「吸い付く場所」を、画面に出る印(.pcad-snap-marker)と同じ
 * 中を塗らない四角(一辺 4.8)で示し、線はその手前で止めて四角を潰さない。
 * 何に吸い付くかは、四角のまわりの線の描き方だけで描き分ける。
 */

/** 端点。線の先に四角を置く。四角が線の途中でなく端にあることが目印。 */
export function SnapEndpointIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.2 13.8 8.6 7.25" />
      <rect x="8.6" y="2.4" width="4.8" height="4.8" />
    </SvgIcon>
  );
}

/** 交点。斜めに交わる 2 本の線が四角のところで出会う。 */
export function SnapIntersectionIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.4 2.4 5.6 5.6" />
      <path d="M13.6 2.4 10.4 5.6" />
      <path d="M2.4 13.6 5.6 10.4" />
      <path d="M13.6 13.6 10.4 10.4" />
      <rect x="5.6" y="5.6" width="4.8" height="4.8" />
    </SvgIcon>
  );
}

/** 中点。両端に印のある線の、ちょうどまんなかに四角を置く。 */
export function SnapMidpointIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.6 5.6v4.8" />
      <path d="M13.4 5.6v4.8" />
      <path d="M2.6 8h3" />
      <path d="M10.4 8h3" />
      <rect x="5.6" y="5.6" width="4.8" height="4.8" />
    </SvgIcon>
  );
}

/** 中心。円の中心に四角を置く。 */
export function SnapCenterIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="8" cy="8" r="5.7" />
      <rect x="5.6" y="5.6" width="4.8" height="4.8" />
    </SvgIcon>
  );
}

/** 方眼。等間隔に並ぶ点の中の 1 つに、縦横の格子線とともに四角を置く。 */
export function SnapGridIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 2.2v3.4" />
      <path d="M8 10.4v3.4" />
      <path d="M2.2 8h3.4" />
      <path d="M10.4 8h3.4" />
      <circle cx="3.1" cy="3.1" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="12.9" cy="3.1" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="3.1" cy="12.9" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="12.9" cy="12.9" r="0.85" fill="currentColor" stroke="none" />
      <rect x="5.6" y="5.6" width="4.8" height="4.8" />
    </SvgIcon>
  );
}

/** 続けてかく。つながった 2 つの輪で表す。 */
export function ChainIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="5.9" cy="8" r="3.3" />
      <circle cx="10.1" cy="8" r="3.3" />
    </SvgIcon>
  );
}

/*
 * ファイルと履歴の 5 つ。文字を添えないボタンで使うので、世の中の道具と同じ図柄
 * (白紙・書類ばさみ・保存の板・左右に曲がる矢印)にして、見ただけで分かるようにする。
 * 名前は読み上げ名(aria-label)とツールチップが担う(Toolbar.tsx、FR-904)。
 */

/** 新規。角を折った白紙。 */
export function NewFileIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </SvgIcon>
  );
}

/** 開く。口の開いた書類ばさみ。 */
export function OpenFileIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2 12.6V3.6h4.2l1.6 2H13v2" />
      <path d="M2 12.6 4.3 7.6h10.2l-2.3 5z" />
    </SvgIcon>
  );
}

/** 保存。書き込む板(いわゆるフロッピー)。 */
export function SaveIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.8 2.6h7.6l2.8 2.8v8H2.8z" />
      <path d="M5.4 2.6h4.4v3.2H5.4z" />
      <path d="M5 13.4V9.6h6v3.8" />
    </SvgIcon>
  );
}

/** 元に戻す。左へ曲がって戻る矢印。 */
export function UndoIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M5.4 3.9 2.6 6.6l2.8 2.7" />
      <path d="M2.6 6.6h6a3.6 3.6 0 0 1 0 7.2H6.2" />
    </SvgIcon>
  );
}

/** やり直す。右へ曲がって進む矢印(元に戻すの鏡)。 */
export function RedoIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M10.6 3.9l2.8 2.7-2.8 2.7" />
      <path d="M13.4 6.6h-6a3.6 3.6 0 0 0 0 7.2h2.4" />
    </SvgIcon>
  );
}

/*
 * ソリッドの 6 つ。前の 3 つ(押し出し・回転・縫合)は「面をどう動かして立体にするか」を
 * 矢印で描き分け、後の 3 つ(和・差・積)は重なった 2 つの四角のどこが残るかを
 * 塗りつぶしで描き分ける。塗りは残るところ、細い破線は消えるところ。
 */

/** 押し出し。下の面から上へ伸びる矢印。 */
export function ExtrudeIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.2 13.2 6 9.6h7.8l-3.8 3.6z" fill="currentColor" fillOpacity={0.35} />
      <path d="M8 8.2V2.4" />
      <path d="M5.8 4.6 8 2.4l2.2 2.2" />
    </SvgIcon>
  );
}

/** 回転。軸(破線)のまわりを回る矢印と、回される断面。 */
export function RevolveIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M13.2 1.8v12.4" strokeDasharray="1.8 1.8" />
      <path d="M2.6 6.4h4.2v7.4H2.6z" fill="currentColor" fillOpacity={0.35} />
      <path d="M3 4.6C5.6 1.9 10.4 1.9 13 4.4" />
      <path d="M10.6 4.9 13.2 4.5l-.4-2.6" />
    </SvgIcon>
  );
}

/** 縫合。2 枚の面と、それをまたいで留めるかがり目。 */
export function SewIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.4 4.4h4v7.2h-4z" fill="currentColor" fillOpacity={0.35} />
      <path d="M9.6 4.4h4v7.2h-4z" fill="currentColor" fillOpacity={0.35} />
      <path d="M5.2 6.2h5.6" />
      <path d="M5.2 9.8h5.6" />
    </SvgIcon>
  );
}

/** 和。重なった 2 つの四角を 1 つにした形を塗る。 */
export function UnionIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="M2 3h7.5v2.5H14V13H6.5v-2.5H2z"
        fill="currentColor"
        fillOpacity={0.35}
      />
    </SvgIcon>
  );
}

/** 差。もとの四角から、重なったところを取り除いた形を塗る。取り除く方は破線。 */
export function SubtractIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M6.5 5.5H14V13H6.5z" strokeDasharray="1.8 1.8" />
      <path d="M2 3h7.5v2.5H6.5v5H2z" fill="currentColor" fillOpacity={0.35} />
    </SvgIcon>
  );
}

/** 積。重なったところだけを塗る。 */
export function IntersectIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2 3h7.5v7.5H2z" />
      <path d="M6.5 5.5H14V13H6.5z" />
      <path d="M6.5 5.5h3v5h-3z" fill="currentColor" fillOpacity={0.35} stroke="none" />
    </SvgIcon>
  );
}
