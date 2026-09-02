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

/** 透視投影。視点へ集まる線で表す。 */
export function PerspectiveIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.5 2.5v11" />
      <path d="M2.5 3.6 12.6 7.5" />
      <path d="M2.5 12.4 12.6 8.5" />
      <circle cx="13.2" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/** 平行投影。平行なままの線で表す。 */
export function OrthographicIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.5 2.5v11" />
      <path d="M13.5 2.5v11" />
      <path d="M2.5 5.5h11" />
      <path d="M2.5 10.5h11" />
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

/** 吸着。折れた線と、その角に重なる丸で「この点に合わせる」を表す。 */
export function SnapIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2 12.6 8 8l6-4.6" />
      <circle cx="8" cy="8" r="2.6" />
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
