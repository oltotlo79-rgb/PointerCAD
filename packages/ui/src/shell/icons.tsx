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

/**
 * 図柄そのものの型。図柄を値として並べる表(`toolbarMenus.ts` の畳んだ一覧など)が
 * React の型に触れずに済むよう、ここで名前を付けて輸出する。
 */
export type IconComponent = (props: IconProps) => React.JSX.Element;

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

/** 部品表。見出しと3行2列の表で表す。 */
export function BomIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="2" y="2.25" width="12" height="11.5" rx="1" />
      <path d="M2 5.25h12M2 8.25h12M2 11.25h12M6 5.25v8.5" />
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

/**
 * 円(FR-326)。中心の点を添えた真円で表す(P4 タスク32)。
 * 円弧(四分円+破線の半径)とも楕円(横長)とも絵柄が重ならないようにしてある。
 */
export function CircleToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/**
 * 2 点+半径の円弧(FR-313)。通したい 2 点を両端に置いた弧で表す(P4 タスク32)。
 * 線分(2 点を直線で結ぶ)と対になる絵柄で、結ぶ線が弧かどうかで見分ける。
 */
export function TwoPointArcToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3.4 11.4A7.4 7.4 0 0 1 12.6 11.4" />
      <circle cx="3.4" cy="11.4" r="1.5" />
      <circle cx="12.6" cy="11.4" r="1.5" />
    </SvgIcon>
  );
}

/**
 * 3 点の円弧(FR-330、P4 タスク36、2026-09-04 追加要件)。2 点+半径の円弧と同じ弧の上に、
 * 通過点(塗りつぶした小さな点、弧の上に乗る)を添えて「3 点をクリックしてかく」ことを表す。
 */
export function ThreePointArcToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3.4 11.4A7.4 7.4 0 0 1 12.6 11.4" />
      <circle cx="3.4" cy="11.4" r="1.3" />
      <circle cx="12.6" cy="11.4" r="1.3" />
      <circle cx="8" cy="9.8" r="1.1" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/**
 * 矩形(FR-314)。長方形の輪郭で表す(P4 タスク4、統括の指示 2026-09-04)。
 * `FeatureTree.tsx` の KIND_ICONS がツリーの行の頭に、道具アイコンとしてタスク12 が使う。
 */
export function RectangleToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="2" y="4" width="12" height="8" />
    </SvgIcon>
  );
}

/** 正多角形(FR-315)。正六角形の輪郭で表す(P4 タスク4、統括の指示 2026-09-04)。 */
export function PolygonToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 2 13.2 5 13.2 11 8 14 2.8 11 2.8 5z" />
    </SvgIcon>
  );
}

/** 長穴(FR-316)。両端が半円で丸まった横長の輪郭で表す(P4 タスク4、統括の指示 2026-09-04)。 */
export function SlotToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="2" y="5.5" width="12" height="5" rx="2.5" />
    </SvgIcon>
  );
}

/** 楕円(FR-318)。横長の楕円の輪郭で表す(P4 タスク5)。 */
export function EllipseToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <ellipse cx="8" cy="8" rx="6" ry="3.6" />
    </SvgIcon>
  );
}

/** スプライン(FR-317)。点の間をなめらかにうねる曲線で表す(P4 タスク5)。 */
export function SplineToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2 11.5C4.5 11.5 4.5 4.5 8 4.5s3.5 7 6 7" />
    </SvgIcon>
  );
}

/**
 * オフセット(FR-321)。もとの輪郭(実線)と、それをずらした複製(破線)を入れ子にして表す。
 * 「元は残り、ずらした複製ができる」ことが 1 枚で読める絵柄にしてある(P4 タスク32)。
 */
export function OffsetToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="1.5" y="4.2" width="13" height="7.6" rx="1.6" strokeDasharray="1.6 1.6" />
      <rect x="4.3" y="6.4" width="7.4" height="3.2" rx="1" />
    </SvgIcon>
  );
}

/**
 * トリム(FR-322)。交わる線(縦)で区切られた横線の、**消える側を破線**にして表す。
 * 「交点で区切って、押した側が消える」ことが 1 枚で読める絵柄にしてある(P4 タスク22)。
 */
export function TrimToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 2.2V13.8" />
      <path d="M1.6 10.5H8" />
      <path d="M8 10.5H14.4" strokeDasharray="1.6 1.6" />
    </SvgIcon>
  );
}

/**
 * 延長(FR-322)。短い線(実線)が、破線でぶつかる相手の線(縦)まで伸びる絵柄
 * (P4 タスク22)。トリムの図柄と左右対称の作りにして、隣に並べても取り違えないようにした。
 */
export function ExtendToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M13.2 2.2V13.8" />
      <path d="M1.6 8H7" />
      <path d="M7 8H13.2" strokeDasharray="1.6 1.6" />
    </SvgIcon>
  );
}

/**
 * スケッチの角の丸め(FR-323、P4 タスク23)。直角に交わる 2 本の実線の角が円弧で丸まり、
 * 落ちる角の先が破線で残る絵柄。立体の R 面取り(`FilletIcon`)とは別の図柄にして、
 * 「線の角」と「立体の辺」を取り違えないようにしてある。
 */
export function SketchFilletToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2 13.5H8.5" />
      <path d="M13.5 8.5V2" />
      <path d="M8.5 13.5A5 5 0 0 0 13.5 8.5" />
      <path d="M8.5 13.5H13.5V8.5" strokeDasharray="1.3 1.3" />
    </SvgIcon>
  );
}

/**
 * スケッチの角の面取り(FR-323、P4 タスク23)。丸めの図柄と同じ形で、角を斜めの実線で
 * 切り落とす絵柄。並べて置いても円弧と斜線の違いで見分けられる。
 */
export function SketchChamferToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2 13.5H8.5" />
      <path d="M13.5 8.5V2" />
      <path d="M8.5 13.5 13.5 8.5" />
      <path d="M8.5 13.5H13.5V8.5" strokeDasharray="1.3 1.3" />
    </SvgIcon>
  );
}

/**
 * ミラー(FR-324、P4 タスク24)。鏡の軸(縦の破線)をはさんで、実線の三角と破線の三角が
 * 向かい合う絵柄。「軸で折り返した複製ができる」ことが 1 枚で読める。
 */
export function MirrorToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 1.6V14.4" strokeDasharray="1.6 1.6" />
      <path d="M6.4 3.6 1.8 8l4.6 4.4z" />
      <path d="M9.6 3.6 14.2 8l-4.6 4.4z" strokeDasharray="1.3 1.3" />
    </SvgIcon>
  );
}

/**
 * 複写(FR-324、P4 タスク24)。実線の四角から矢印が伸び、ずれた先に破線の四角が並ぶ。
 * オフセットの図柄(入れ子の四角)とは重ならない絵柄にしてある。
 */
export function CopyToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="1.4" y="6.6" width="6" height="6" />
      <rect x="8.6" y="2.4" width="6" height="6" strokeDasharray="1.3 1.3" />
      <path d="M6.6 5.6 9.8 2.4" />
    </SvgIcon>
  );
}

/**
 * 直線配列(FR-324、P4 タスク24)。実線の縦棒 1 本と破線の縦棒 2 本を等間隔に並べ、
 * 下に間隔の矢印を添える。加工の直線パターン(丸を並べる)とは絵柄を分けてある
 * (こちらはスケッチの線を並べる道具なので、並ぶものを棒にした)。
 */
export function LinearArrayToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.4 2.2V10" />
      <path d="M8 2.2V10" strokeDasharray="1.3 1.3" />
      <path d="M13.6 2.2V10" strokeDasharray="1.3 1.3" />
      <path d="M2.4 13H13.6" />
      <path d="M11.8 11.6 13.6 13 11.8 14.4" />
    </SvgIcon>
  );
}

/**
 * 円形配列(FR-324、P4 タスク24)。破線の軌道の上に、実線の棒 1 本と破線の棒 2 本を
 * 120 度おきに置く。加工の円形パターン(丸を並べる)と同じ構図だが、並ぶものを棒にして
 * 「スケッチの線を並べる道具」だと分かるようにした。
 */
export function CircularArrayToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="8" cy="8" r="5.4" strokeDasharray="1.6 1.6" />
      <path d="M8 1.4V5" />
      <path d="M13.7 11.3 10.6 9.5" strokeDasharray="1.3 1.3" />
      <path d="M2.3 11.3 5.4 9.5" strokeDasharray="1.3 1.3" />
    </SvgIcon>
  );
}

/**
 * 投影(FR-325、P4 タスク27)。上にある立体の面(実線の四角)から、まっすぐ下の作図面へ
 * 落ちる**破線の矢**と、落ちた先の輪郭(細い四角)を描く。「上の形が下の面へ写る」ことが
 * 1 枚で読める絵柄にしてある。
 */
export function ProjectToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="3.4" y="1.6" width="9.2" height="4.2" />
      <path d="M4.6 6.4V9.6" strokeDasharray="1.3 1.3" />
      <path d="M11.4 6.4V9.6" strokeDasharray="1.3 1.3" />
      <rect x="3.4" y="10.2" width="9.2" height="4.2" />
    </SvgIcon>
  );
}

/**
 * 断面(交差、FR-325、P4 タスク27)。立体(縦長の四角)を横切る作図面を**太い横線**で表し、
 * 交わってできる線(切り口)を線の上に置く。投影の図柄と作りを変えて、隣に並べても
 * 取り違えないようにした。
 */
export function SectionToolIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="4.4" y="1.8" width="7.2" height="12.4" strokeDasharray="1.6 1.6" />
      <path d="M1.4 8H14.6" />
      <path d="M4.4 8H11.6" strokeWidth="2.2" />
    </SvgIcon>
  );
}

/**
 * 畳んだ一覧「作図」のボタン(§0.a-0.14、P4 タスク32)。四角と楕円を重ねて
 * 「いろいろな形をまとめてかく入口」を表す。中の道具を一度でも使うと、ボタンの図柄は
 * 最後に使った道具のものへ変わるので、これは何も使っていないときの顔になる。
 */
export function ShapeGroupIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="1.6" y="5.6" width="8" height="7.2" />
      <circle cx="10.6" cy="6.4" r="4.2" />
    </SvgIcon>
  );
}

/**
 * 畳んだ一覧「編集」のボタン(§0.a-0.14、P4 タスク32)。はさみで「かいたものへ手を入れる」
 * ことを表す。中身はオフセットから始まり、トリム・延長・フィレット・面取り・ミラー・複写が
 * 加わる(タスク22〜24)ので、特定の道具ではなく道具箱の顔にしてある。
 */
export function EditGroupIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3.2 2.4 11.4 11.1" />
      <path d="M12.8 2.4 4.6 11.1" />
      <circle cx="3.3" cy="12.7" r="1.7" />
      <circle cx="12.7" cy="12.7" r="1.7" />
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
 * 基準ジオメトリの節(P4 タスク33、FR-328・FR-329)。原点から出る 2 本の軸と点で
 * 「形を作らない基準のあつまり」を表す。作図面(PlaneIcon)と見分けるため軸を主にする。
 */
export function ReferenceGroupIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3 13V3" />
      <path d="M3 13h10" />
      <circle cx="9.5" cy="6.5" r="1.4" />
    </SvgIcon>
  );
}

/** 基準軸(FR-329)。両端に矢じりを付けた 1 本の線で「向きだけを持つ基準」を表す。 */
export function ReferenceAxisIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2 12 14 4" />
      <path d="M2 12 4.6 11.4" />
      <path d="M2 12 2.6 9.4" />
      <path d="M14 4 11.4 4.6" />
      <path d="M14 4 13.4 6.6" />
    </SvgIcon>
  );
}

/** 基準点(FR-329)。十字の交点に丸を置いて「参照のためだけの点」を表す。 */
export function ReferencePointIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 2v3.2" />
      <path d="M8 10.8V14" />
      <path d="M2 8h3.2" />
      <path d="M10.8 8H14" />
      <circle cx="8" cy="8" r="1.8" />
    </SvgIcon>
  );
}

/** 基準座標系(FR-329)。原点から 3 方向へ出る短い軸で表す。 */
export function CoordinateSystemIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M5 11V3.5" />
      <path d="M5 11h7.5" />
      <path d="M5 11 1.8 14" />
    </SvgIcon>
  );
}

/** 投影(FR-325)。立体の辺から作図面へ落ちる矢印で「面へ写す」を表す。 */
export function ProjectCurveIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3.4 3.2h9.2" />
      <path d="M8 4.6v5.2" />
      <path d="M6.4 8.4 8 10.2l1.6-1.8" />
      <path d="M2.2 13.4 4.6 11.6h8.8" />
    </SvgIcon>
  );
}

/** 交差(FR-325)。面と立体が交わってできる線を、面の中の閉じた輪で表す。 */
export function PlaneSectionIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M1.8 11.2 6.2 4.8h8l-4.4 6.4z" />
      <ellipse cx="8" cy="8" rx="2.6" ry="1.6" />
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

/*
 * 向きの吸着(FR-110、P4b タスク16)の 4 つ。点に合わせる 5 つと同じ一覧に並ぶので、
 * 同じ 16×16 の枠と線の太さで描き、**破線(画面に出る案内線と同じ見た目)**で
 * 「線に沿って合わせる」ことを示す。点に合わせる 5 つが持っている四角は入れない
 * (合う先が 1 点ではなく向きなので、四角があると点に合うものと見分けが付かない)。
 */

/** 角度。起点から 2 本が開き、その間に角度の弧を描く。 */
export function SnapPolarIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.6 13.4h11" />
      <path d="M2.6 13.4 12.4 4.2" strokeDasharray="2.4 1.6" />
      <path d="M8.2 13.4a6 6 0 0 0 1.9-4.4" />
      <circle cx="2.6" cy="13.4" r="1.1" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/** 延長線。実線の先が破線でそのまま伸びる。 */
export function SnapExtensionIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.2 8h5.6" />
      <path d="M7.8 8h6" strokeDasharray="2.4 1.6" />
      <circle cx="7.8" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

/** 垂線。実線の端から破線が直角に立ち上がる。 */
export function SnapPerpendicularIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.4 13.2h11.2" />
      <path d="M8 13.2V2.4" strokeDasharray="2.4 1.6" />
      <path d="M8 10.6h2.6v2.6" />
    </SvgIcon>
  );
}

/** 平行線。同じ向きの実線と破線が並ぶ。 */
export function SnapParallelIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.6 11.6 9.4 4.8" />
      <path d="M6.6 13.4 13.4 6.6" strokeDasharray="2.4 1.6" />
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

/**
 * 名前を付けて保存(FR-812、P6 タスク31)。保存の板の右下に鉛筆を重ねて
 * 「保存するときに名前を書く」を表す。保存(`SaveIcon`)と見分けが付くよう、
 * 板そのものは右下を開けてある。
 */
export function SaveAsIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M11.8 8.2V5.4L9.2 2.6H2.6v10.8h4.2" />
      <path d="M5.2 2.6h3.4v2.8H5.2z" />
      <path d="M13.9 8.4 9.4 12.9l-2.2.6.6-2.2z" />
    </SvgIcon>
  );
}

/**
 * 「ファイル」の畳んだ一覧のボタンに出す図柄(P6 §0.57、タスク31)。
 *
 * 新規・開く・保存の 3 つと同じ溝に並ぶので、書類に「ほかにもある」の 3 点を添えて
 * 「ファイルまわりのそのほかの操作」を表す。1 つの操作を指す図柄ではないため、
 * どれか 1 つの道具の絵にはしない(一覧から選んだ後は選んだ道具の図柄に変わる)。
 */
export function FileMenuIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3.4 1.9h5.2l3 3v5.1H3.4z" />
      <path d="M8.6 1.9v3h3" />
      <circle cx="4.6" cy="13.4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="7.5" cy="13.4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10.4" cy="13.4" r="0.9" fill="currentColor" stroke="none" />
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

/*
 * 加工の 6 つ(P3、§2.11)とばね。穴・ねじ穴は「板に丸い穴」、R/C 面取りは「角を、実線(加工後)と
 * 破線(加工前の角)で描き分け」、パターンは「もとの 1 つ(実線)と複製(破線)」で表す。
 * ばねは横倒しにしたコイルをそのまま描く。文字を出さないボタンで使うので、名前は
 * 読み上げ名(aria-label)とツールチップが担う(Toolbar.tsx、FR-904)。
 */

/** 穴。板に丸い穴が 1 つあいた形。 */
export function HoleIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="2" y="3.5" width="12" height="8" rx="1.2" />
      <circle cx="8" cy="7.5" r="2.4" />
    </SvgIcon>
  );
}

/** ねじ穴。穴の中に、ねじ山を表す破線の円をもう 1 つ重ねる。 */
export function ThreadHoleIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="2" y="3.5" width="12" height="8" rx="1.2" />
      <circle cx="8" cy="7.5" r="2.6" />
      <circle cx="8" cy="7.5" r="1.2" strokeDasharray="1 1" />
    </SvgIcon>
  );
}

/** R 面取り。角を丸めた実線に、もとの角(破線)を重ねて「丸めた」ことを表す。 */
export function FilletIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3 13.5V7.5a4.5 4.5 0 0 1 4.5-4.5h6" />
      <path d="M3 3v4.5h4.5" strokeDasharray="1.4 1.4" />
    </SvgIcon>
  );
}

/** C 面取り。角を斜めに切った実線に、もとの角(破線)を重ねる(R 面取りの弧を直線にした対)。 */
export function ChamferIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3 13.5V7.5l4.5-4.5h6" />
      <path d="M3 3v4.5h4.5" strokeDasharray="1.4 1.4" />
    </SvgIcon>
  );
}

/**
 * 直線パターン。もとの穴(実線の丸)から矢印の向きへ、複製(破線の丸)が並ぶ。
 * 点列の道具(点が並ぶだけ)と区別できるよう、向きの矢印を添える。
 */
export function LinearPatternIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M1.6 4.4h9.6" />
      <path d="M9.4 2.6 11.8 4.4 9.4 6.2" />
      <circle cx="3.2" cy="11.4" r="1.4" />
      <circle cx="8" cy="11.4" r="1.4" strokeDasharray="1.3 1.3" />
      <circle cx="12.8" cy="11.4" r="1.4" strokeDasharray="1.3 1.3" />
    </SvgIcon>
  );
}

/**
 * 円形パターン。破線の軌道の上に、もとの穴(実線の丸)と複製(破線の丸)を並べる。
 * 円形パターンは軌道の上に点が並ぶ絵にして、円形パターンの図柄と重ならないようにする。
 */
export function CircularPatternIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="8" cy="8.4" r="5" strokeDasharray="1.6 1.6" />
      <circle cx="8" cy="3.4" r="1.3" />
      <circle cx="12.3" cy="10.9" r="1.3" strokeDasharray="1.3 1.3" />
      <circle cx="3.7" cy="10.9" r="1.3" strokeDasharray="1.3 1.3" />
    </SvgIcon>
  );
}

/**
 * ばね(FR-414)。横倒しにしたコイルを、重なった丸 4 つで表す。
 * 円形パターン(軌道+点)とは絵柄が重ならないようにしてある。
 */
export function SpringIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="3.4" cy="8" r="2.4" />
      <circle cx="7" cy="8" r="2.4" />
      <circle cx="10.6" cy="8" r="2.4" />
      <circle cx="13.6" cy="8" r="2.2" />
    </SvgIcon>
  );
}

/*
 * 基本形状5種(FR-429、P5 タスク18)。「作る」の一覧に並ぶ。
 *
 * 5 つとも**その形そのもの**を正面から見た輪郭で描く(押し出し・回転のように操作を表す
 * 図柄ではなく、置かれる形が一目で分かるほうがよいため。NFR-UX-7)。塗りは他の立体の図柄と
 * 同じ半透明(fillOpacity 0.35)、線は共通の 1.5、枡は 16 × 16。
 */

/** 球。丸1つと、丸みを示す経線1本。 */
export function SphereIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="8" cy="8" r="5.8" fill="currentColor" fillOpacity={0.35} />
      <path d="M8 2.2c1.9 1.6 1.9 10 0 11.6" />
    </SvgIcon>
  );
}

/**
 * 球面上の点(FR-431、P5 タスク22)。球に緯線・経線の案内を 1 本ずつ引き、その交点に
 * 点を打った形。球の図柄(`SphereIcon`)とは「交点の丸」があるかどうかで見分けられる。
 */
export function SphereGridPointIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="8" cy="8" r="5.8" fill="currentColor" fillOpacity={0.2} />
      <path d="M8 2.2c1.9 1.6 1.9 10 0 11.6" />
      <path d="M2.4 6.2c3.4 1.3 7.8 1.3 11.2 0" />
      <circle cx="10.6" cy="5.6" r="1.5" fill="currentColor" />
    </SvgIcon>
  );
}

/** 箱。立方体を斜めから見た形(製品の印の立方体と同じ描き方で、面を塗る)。 */
export function BoxIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="M8 1.9 13.8 5.2v5.6L8 14.1 2.2 10.8V5.2z"
        fill="currentColor"
        fillOpacity={0.35}
      />
      <path d="M2.2 5.2 8 8.5l5.8-3.3" />
      <path d="M8 8.5v5.6" />
    </SvgIcon>
  );
}

/** 円柱。上面の楕円と横の 2 本、底の弧。 */
export function CylinderIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3.4 3.6h9.2v8.8H3.4z" fill="currentColor" fillOpacity={0.35} />
      <ellipse cx="8" cy="3.6" rx="4.6" ry="1.9" />
      <path d="M3.4 3.6v8.8M12.6 3.6v8.8" />
      <path d="M3.4 12.4c0 1.05 2.06 1.9 4.6 1.9s4.6-.85 4.6-1.9" />
    </SvgIcon>
  );
}

/** 円錐。頂点から底の楕円へ下りる 2 本と、底の弧。 */
export function ConeIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 2 12.6 12.2H3.4z" fill="currentColor" fillOpacity={0.35} />
      <path d="M8 2 3.4 12.2M8 2l4.6 10.2" />
      <ellipse cx="8" cy="12.2" rx="4.6" ry="1.9" />
    </SvgIcon>
  );
}

/** トーラス。外の輪と、中心の穴。 */
export function TorusIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <ellipse cx="8" cy="8" rx="6.2" ry="4" fill="currentColor" fillOpacity={0.35} />
      <ellipse cx="8" cy="8" rx="2.4" ry="1.3" />
    </SvgIcon>
  );
}

/*
 * 面をつなぐ(罫線面、FR-430)とロフト(FR-410)。P5 タスク27。「作る」の一覧に並ぶ。
 *
 * どちらも「上下 2 つの輪郭を結ぶ」形だが、**結び方の違いがひと目で分かる**ように描き分ける。
 * 面をつなぐは横の線を**まっすぐ**に、ロフトは**ふくらませた曲線**にしてある(§0.a-0.25 の
 * 違いは `ruled` の真偽 1 つだけなので、絵でもその 1 点だけを変える)。
 * 輪郭の楕円は上を小さく下を大きくして、「大きさの違う 2 つを結ぶ」ことを表す。
 */

/** 面をつなぐ(罫線面)。上下の輪郭を**直線**で結ぶ。 */
export function RuledIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M5.2 3.4 2.6 12.6h10.8L10.8 3.4z" fill="currentColor" fillOpacity={0.35} />
      <ellipse cx="8" cy="3.4" rx="2.8" ry="1.2" />
      <path d="M5.2 3.4 2.6 12.6M10.8 3.4l2.6 9.2" />
      <path d="M2.6 12.6c0 .9 2.42 1.6 5.4 1.6s5.4-.7 5.4-1.6" />
    </SvgIcon>
  );
}

/** ロフト。上下の輪郭を**なめらかな曲線**で結ぶ。 */
export function LoftIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="M5.2 3.4C3.4 6.2 6.2 9.4 2.6 12.6h10.8C9.8 9.4 12.6 6.2 10.8 3.4z"
        fill="currentColor"
        fillOpacity={0.35}
      />
      <ellipse cx="8" cy="3.4" rx="2.8" ry="1.2" />
      <path d="M5.2 3.4C3.4 6.2 6.2 9.4 2.6 12.6M10.8 3.4c1.8 2.8-1 6 2.6 9.2" />
      <path d="M2.6 12.6c0 .9 2.42 1.6 5.4 1.6s5.4-.7 5.4-1.6" />
    </SvgIcon>
  );
}

/**
 * 設定(FR-908、FR-909)。世の中の道具と同じ歯車で、表示設定の入口を表す。
 * 歯は 8 枚を 45 度ごとに置き、中心に軸の丸を 1 つ。
 */
export function GearIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="8" cy="8" r="2.3" />
      <path d="M8 1.4v1.9M8 12.7v1.9M14.6 8h-1.9M3.3 8H1.4M12.67 3.33l-1.35 1.35M4.68 11.32l-1.35 1.35M12.67 12.67l-1.35-1.35M4.68 4.68 3.33 3.33" />
    </SvgIcon>
  );
}

/* ===========================================================================
 * 拘束の図柄(FR-313、P4b タスク13)
 *
 * 14 種すべてに図柄を用意する。ビューポートの印は 1 文字の記号
 * (`constraintSummary.ts` の `symbol`)だが、ツールバーの畳んだ一覧と拘束の一覧は
 * ボタンの大きさの図柄が要るため(t12 の申し送り)。
 *
 * 描き分けの決まり: **拘束の相手(線・円・点)を薄い線で描き、条件そのものを濃い印で
 * 重ねる**のではなく、16×16 の中で「何と何がどうなるか」だけを線で表す。細かい記号を
 * 入れると 16 画素では潰れるため。
 * ======================================================================== */

/** 一致(点 2 つを重ねる)。重なった 2 つの丸で表す。 */
export function CoincidentConstraintIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="6.4" cy="8" r="3.1" />
      <circle cx="9.6" cy="8" r="3.1" />
    </SvgIcon>
  );
}

/** 水平(線を横向きにそろえる)。横線と、その両端の小さな縦の目印。 */
export function HorizontalConstraintIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2 8h12" />
      <path d="M2 5.6v4.8M14 5.6v4.8" />
    </SvgIcon>
  );
}

/** 垂直(線を縦向きにそろえる)。水平の図柄を 90 度回したもの。 */
export function VerticalConstraintIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 2v12" />
      <path d="M5.6 2h4.8M5.6 14h4.8" />
    </SvgIcon>
  );
}

/** 平行(2 本の線が平行)。同じ傾きの 2 本。 */
export function ParallelConstraintIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M5 2.4 2.4 13.6" />
      <path d="M13.6 2.4 11 13.6" />
    </SvgIcon>
  );
}

/** 直角(2 本の線が直角)。縦線と横線、角の小さな四角。 */
export function PerpendicularConstraintIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M4 2v11.2h9.6" />
      <path d="M4 10.4h3.2v2.8" />
    </SvgIcon>
  );
}

/** 接線(線が円に接する)。円と、その下側に触れる横線。 */
export function TangentConstraintIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="8" cy="6.6" r="4.2" />
      <path d="M1.6 11h12.8" />
    </SvgIcon>
  );
}

/** 同心(2 つの円の中心が重なる)。大小の円と中心の点。 */
export function ConcentricConstraintIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="2.6" />
    </SvgIcon>
  );
}

/** 等しい(長さ・半径が同じ)。長さの等しい 2 本の横線。 */
export function EqualConstraintIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3 5.6h10" />
      <path d="M3 10.4h10" />
    </SvgIcon>
  );
}

/** 対称(軸をはさんで向かい合う)。中央の破線の軸と、左右の点。 */
export function SymmetricConstraintIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 1.8v12.4" strokeDasharray="1.8 1.6" />
      <circle cx="3.4" cy="8" r="1.6" />
      <circle cx="12.6" cy="8" r="1.6" />
    </SvgIcon>
  );
}

/** 固定(その場に留めて動かなくする)。四隅を留めた四角。 */
export function FixConstraintIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1" />
      <path d="M8 6.4v3.2M6.4 8h3.2" />
    </SvgIcon>
  );
}

/** 距離(2 点の間の長さ)。両端に止め線のある矢印。 */
export function DistanceConstraintIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.6 3.6v8.8M13.4 3.6v8.8" />
      <path d="M2.6 8h10.8" />
      <path d="M5.2 6 2.6 8l2.6 2M10.8 6l2.6 2-2.6 2" />
    </SvgIcon>
  );
}

/** 角度(2 本の線のなす角)。開いた 2 本と、間の弧。 */
export function AngleConstraintIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.4 13.4h11.2" />
      <path d="M2.4 13.4 12 3.6" />
      <path d="M8.4 13.4A6 6 0 0 0 6.6 9.2" />
    </SvgIcon>
  );
}

/** 半径。円と、中心から縁への矢印。 */
export function RadiusConstraintIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 8h5.2" />
      <path d="M11 6.2 13.2 8 11 9.8" />
    </SvgIcon>
  );
}

/** 直径。円と、端から端への矢印。 */
export function DiameterConstraintIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M2.6 8h10.8" />
      <path d="M4.8 6.2 2.8 8l2 1.8M11.2 6.2 13.2 8l-2 1.8" />
    </SvgIcon>
  );
}

/**
 * 「拘束」の区画そのものの図柄(まだ一度も使っていないときに畳んだボタンへ出る)。
 * 直角の印を大きく描いて、「条件で形を決める」ことを表す。
 */
export function ConstraintGroupIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3 2.4v11.2h10" />
      <path d="M3 10.6h3v3" />
      <circle cx="12.2" cy="4.2" r="1.6" />
    </SvgIcon>
  );
}

/**
 * 「作る」の一覧そのものの図柄(P5 タスク51)。立体の輪郭に小さな「+」を添えて
 * 「立体を新しく作る道具のまとまり」を表す。中身は押し出し・回転・縫合・ばねで始まり、
 * 基本形状・罫線・スイープ・ロフト(タスク18・49)が加わるので、特定の道具ではなく
 * 道具箱の顔にしてある(`ShapeGroupIcon` / `EditGroupIcon` と同じ考え方)。
 */
export function CreateGroupIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.6 5.6 7 3.2l4.4 2.4v4.8L7 12.8l-4.4-2.4z" />
      <path d="M13.4 1.8v3.4M11.7 3.5h3.4" />
    </SvgIcon>
  );
}

/**
 * 「合わせる」の一覧そのものの図柄(P5 タスク51)。2 つの輪郭が重なるところを描いて
 * 「立体どうしを組み合わせる(和・差・積)」ことを表す。和・差・積の図柄(`UnionIcon` 等)は
 * 塗りで結果を描き分けているので、こちらは塗らずに「重なりそのもの」だけを描いて見分ける。
 */
export function CombineGroupIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="6" cy="8" r="4.2" />
      <circle cx="10" cy="8" r="4.2" />
    </SvgIcon>
  );
}

/**
 * 「加工」の一覧そのものの図柄(P5 タスク51)。角を落とした塊に穴を 1 つあけて
 * 「できた立体へ手を入れる」ことを表す。中身は穴・ねじ穴・R面取り・C面取り・パターンで
 * 始まり、切断・シェル・リブ(タスク27f・49)が加わる。
 */
export function MachiningGroupIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.4 13.2V5.8l3.4-3h7.8v10.4z" />
      <circle cx="8.4" cy="8.6" r="1.9" />
    </SvgIcon>
  );
}

/**
 * 外観(色・材質、FR-1106〜1110、P5 タスク12)。角の丸い正方形を十字に4分割し、
 * 1 区画だけを薄く塗って「色を選ぶ見本」を表す。
 */
export function AppearanceIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="1.6" />
      <path d="M8 2.2v11.6M2.2 8h11.6" />
      <path d="M8 2.2h3.8a1.6 1.6 0 0 1 1.6 1.6V8H8z" fill="currentColor" fillOpacity={0.35} stroke="none" />
    </SvgIcon>
  );
}

/**
 * 測る(FR-1101、FR-1102、P5 タスク32)。斜めに寝かせた物差しと、目盛りの短い線 3 本。
 * 世の中の CAD の「測定」と同じ見立てで、何をする道具かが図柄だけで読める(NFR-UX-7)。
 */
export function MeasureIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.2 10.4 10.4 2.2l3.4 3.4-8.2 8.2z" />
      <path d="M5 5.4 6.6 7M7.1 3.3 8.7 4.9M7.9 8.5 9.5 10.1M10 6.4l1.6 1.6" />
    </SvgIcon>
  );
}

/**
 * 3D プリントの点検(FR-815、P6 タスク46)。積み上がった層の線 3 本と、調べる虫めがね。
 * 「積んで作るものを調べる」が図柄だけで読める(NFR-UX-7)。外観(枡)・測る(物差し)・
 * 下絵(作図面)と重ならない図柄にして、一覧の 4 行を見分けられるようにする。
 */
export function PrintCheckIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.2 13.6h11.6M2.2 11.2h11.6M2.2 8.8h7.4" />
      <circle cx="10.4" cy="4.6" r="2.9" />
      <path d="M12.5 6.7 14.2 8.4" />
    </SvgIcon>
  );
}

/*
 * P5 の Should 群 12 種の図柄(FR-409、FR-417〜428、FR-432。タスク50、§2.15)。
 *
 * 約束は既存の図柄と同じで、枡は 16 × 16、線は共通の 1.5、塗りは半透明(0.35)。
 * 「作る」の一覧へ 3 つ(ミラー・スイープ・曲面)、「加工」の一覧へ 9 つ
 * (抜き勾配・くり抜き・リブ・エンボス・外ねじ・移動/回転・拡大縮小・点パターン・切断)。
 * **一覧の中に並ぶだけなのでツールバーの幅は 1 画素も増えない**(§0.a-0.80)。
 */

/** ミラー(FR-419)。鏡の線をはさんで、同じ形が向かい合う。 */
export function MirrorSolidIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 1.6v12.8" strokeDasharray="2 1.6" />
      <path d="M6.4 4.2H2.2l2.1 3.8-2.1 3.8h4.2z" fill="currentColor" fillOpacity={0.35} />
      <path d="M9.6 4.2h4.2l-2.1 3.8 2.1 3.8H9.6z" />
    </SvgIcon>
  );
}

/** スイープ(FR-409)。曲がった経路と、その先頭に立てた断面の輪。 */
export function SweepIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3.4 12.8C3.4 7.6 7 4.6 12.8 4.6" />
      <ellipse cx="3.4" cy="12.8" rx="2.2" ry="1" />
      <ellipse cx="12.8" cy="4.6" rx="1" ry="2.2" fill="currentColor" fillOpacity={0.35} />
    </SvgIcon>
  );
}

/** 曲面(FR-428)。厚みの無い、たわんだ 1 枚の面。 */
export function SurfaceIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="M2 10.4c2.4-3.2 4.4-3.2 6-1.2s3.6 2 6-1.2v3.2c-2.4 3.2-4.4 3.2-6 1.2s-3.6-2-6 1.2z"
        fill="currentColor"
        fillOpacity={0.35}
      />
      <path d="M2 4.4c2.4-3.2 4.4-3.2 6-1.2s3.6 2 6-1.2" />
    </SvgIcon>
  );
}

/** 抜き勾配(FR-417)。上の面はそのままで、側面だけが内へ倒れる。 */
export function DraftIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3.6 13.4 5.8 2.6h4.4l2.2 10.8z" fill="currentColor" fillOpacity={0.35} />
      <path d="M5.8 2.6h4.4" />
      <path d="M2 2.6h2.4M2 13.4h2.4" strokeDasharray="1.6 1.2" />
    </SvgIcon>
  );
}

/** くり抜き(FR-418)。外の四角の内側に、壁の厚みぶん小さい四角。 */
export function ShellIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path
        d="M2.4 2.4h11.2v11.2H2.4zM4.8 4.8v6.4h6.4V4.8z"
        fill="currentColor"
        fillOpacity={0.35}
        fillRule="evenodd"
      />
      <path d="M2.4 2.4h11.2v11.2H2.4z" />
      <path d="M4.8 4.8h6.4v6.4H4.8z" />
    </SvgIcon>
  );
}

/** リブ(FR-420)。土台の上に立てた、薄い補強の壁。 */
export function RibIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2 11.2h12v2.4H2z" fill="currentColor" fillOpacity={0.35} />
      <path d="M6.8 3.2h2.4v8H6.8z" fill="currentColor" fillOpacity={0.35} />
      <path d="M2 11.2h12" />
    </SvgIcon>
  );
}

/** エンボス(FR-421)。平らな面の上に、輪郭が浮き出している。 */
export function EmbossIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2 9.6h12v4H2z" fill="currentColor" fillOpacity={0.35} />
      <path d="M6 9.6V5.6h4v4" />
      <path d="M6 5.6h4" />
    </SvgIcon>
  );
}

/** 外ねじ(FR-423)。丸い軸の外側に、ねじ山の斜めの線。 */
export function ThreadShaftIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M4.4 3.2h7.2v9.6H4.4z" fill="currentColor" fillOpacity={0.35} />
      <path d="M4.4 4.8h7.2M4.4 7.2h7.2M4.4 9.6h7.2M4.4 12h7.2" />
    </SvgIcon>
  );
}

/** 移動/回転(FR-424)。もとの位置から、矢印の向きへ動く。 */
export function TransformIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.2 8.4h5.2v5.2H2.2z" strokeDasharray="1.6 1.2" />
      <path d="M8.6 2.4h5.2v5.2H8.6z" fill="currentColor" fillOpacity={0.35} />
      <path d="M5.6 7.2 8.4 4.4M8.4 4.4H6.6M8.4 4.4v1.8" />
    </SvgIcon>
  );
}

/** 拡大縮小(FR-424)。小さい四角が、同じ形のまま大きくなる。 */
export function ScaleIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.4 2.4h11.2v11.2H2.4z" strokeDasharray="1.6 1.2" />
      <path d="M2.4 2.4h6v6h-6z" fill="currentColor" fillOpacity={0.35} />
      <path d="M9.6 9.6l3.4 3.4M13 13h-2.4M13 13v-2.4" />
    </SvgIcon>
  );
}

/** 点パターン(FR-425)。散らばった点それぞれの場所へ、同じ加工を置く。 */
export function PointPatternIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <circle cx="4" cy="4.4" r="1.4" fill="currentColor" fillOpacity={0.35} />
      <circle cx="12" cy="3.6" r="1.4" />
      <circle cx="4.8" cy="11.6" r="1.4" />
      <circle cx="11.4" cy="10.8" r="1.4" />
    </SvgIcon>
  );
}

/** 切断(FR-432)。立体を斜めの平面で切り分け、片側だけが残る。 */
export function CutIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3.2 12.8V6.4l9.6-3.2v6.4z" fill="currentColor" fillOpacity={0.35} />
      <path d="M3.2 12.8h9.6V3.2" strokeDasharray="1.6 1.2" />
      <path d="M1.6 9.6 14.4 4.8" />
    </SvgIcon>
  );
}

/**
 * 読み込んだ形(FR-802)。箱(受け皿)へ、上から矢印が入っていく——
 * ファイルから B-rep を取り込んだことを表す(統括の指示、P6 タスク20 の帰結)。
 */
export function ImportedSolidIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.8 7.6h10.4v6h-10.4z" fill="currentColor" fillOpacity={0.35} />
      <path d="M8 1.6v5.2" />
      <path d="M5.6 4.4 8 6.8l2.4-2.4" />
    </SvgIcon>
  );
}

/**
 * 読み込んだ三角形の形(FR-802)。1 枚の三角形を 4 枚へ分けた網の目——
 * B-rep にしない、三角形のままの形であることを表す(統括の指示、P6 タスク20 の帰結)。
 */
export function ImportedMeshIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M8 2 13.6 12H2.4z" fill="currentColor" fillOpacity={0.35} />
      <path d="M8 2 13.6 12H2.4z" />
      <path d="M10.8 7 8 12 5.2 7z" />
    </SvgIcon>
  );
}

/**
 * 書き出す(FR-803、P6 タスク32)。箱から矢印が**外へ出ていく**——
 * いまの立体をファイルへ渡すことを表す。読み込む図柄と矢印の向きだけが違う。
 */
export function ExportIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.8 9.2h10.4v4.8h-10.4z" fill="currentColor" fillOpacity={0.35} />
      <path d="M8 7.6v-5.6" />
      <path d="M5.6 4.4 8 2l2.4 2.4" />
    </SvgIcon>
  );
}

/**
 * 読み込む(FR-802、FR-813、P6 タスク32)。箱へ矢印が**入っていく**——
 * ほかのソフトのファイルを取り込むことを表す。履歴の段の図柄
 * (`ImportedSolidIcon`)と同じ向きにそろえてある。
 */
export function ImportIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.8 9.2h10.4v4.8h-10.4z" fill="currentColor" fillOpacity={0.35} />
      <path d="M8 2v5.6" />
      <path d="M5.6 5.2 8 7.6l2.4-2.4" />
    </SvgIcon>
  );
}

/**
 * ひな形として保存(FR-814、P6 タスク33)。角を折った白紙に星を添えて
 * 「これからの部品のもとになる 1 枚」を表す。中身の入っていない部品なので、
 * 白紙(`NewFileIcon`)を土台にしてある。
 */
export function TemplateSaveIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3.6 2h5.2l3 3v6.2H3.6z" />
      <path d="M8.8 2v3h3" />
      <path d="M11.4 10.6l.8 1.7 1.8.3-1.3 1.3.3 1.8-1.6-.9-1.6.9.3-1.8-1.3-1.3 1.8-.3z" />
    </SvgIcon>
  );
}

/**
 * ひな形から新規(FR-814、P6 タスク33)。ひな形の白紙から**もう 1 枚**が起きる形。
 * 「ひな形として保存」(`TemplateSaveIcon`)と土台の白紙をそろえてあるので、
 * 一覧の中で 2 つが対になって読める。
 */
export function TemplateNewIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M2.2 1.9h4.4l2.6 2.6v5.6H2.2z" strokeDasharray="1.6 1.2" />
      <path d="M7.2 5.6h4.4l2.6 2.6v5.9H7.2z" />
      <path d="M11.6 5.6v2.6h2.6" />
    </SvgIcon>
  );
}

/**
 * 印刷(FR-810、P6 タスク33)。世の中の道具と同じ、紙の出るプリンタの形。
 * 上が送り込む紙、真ん中が本体、下が刷り上がった紙。
 */
export function PrintIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M4.6 1.9h6.8v3.4H4.6z" />
      <path d="M2.2 5.3h11.6v5.1H2.2z" />
      <path d="M4.6 8.6h6.8v5.5H4.6z" fill="currentColor" fillOpacity={0.35} />
    </SvgIcon>
  );
}

/**
 * 最近使ったファイル(FR-807、P6 タスク33)。書類に時計の針を添えて
 * 「いつ触ったか」を覚えているだけであることを表す(場所は覚えない、NFR-SE-1)。
 */
export function RecentFileIcon(props: IconProps): React.JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M3.2 1.9h4.6l2.6 2.6v3.1" />
      <path d="M3.2 1.9v12.2h3.4" />
      <path d="M7.8 1.9v2.6h2.6" />
      <circle cx="10.9" cy="10.9" r="3.2" />
      <path d="M10.9 9v2h1.6" />
    </SvgIcon>
  );
}
