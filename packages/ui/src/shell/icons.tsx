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
