# P4b「スケッチの仕上げ」実装計画書(下書き)

> **作業担当(サブエージェント)向け:** 本計画は `superpowers:subagent-driven-development`(推奨)または `superpowers:executing-plans` でタスク単位に実行する。各手順は `- [ ]` のチェックボックスで進捗を追う。
> **gitへの書き込みは統括だけが行う。** 作業担当は commit / push / checkout / merge / stash / reset を一切行わない(`rules/01-役割と委譲.md` §1)。
> **この文書は下書きである。** §0 の質問に統括(および利用者)の回答が入り §0.a が埋まるまで、どのタスクにも着手しない。

**目的:** 要件 `docs/requirements.md`(v1.8)§9 の P4b 完了条件「拘束を付けた輪郭が、1 つの要素を動かすだけで条件を保ったまま整い、キーボードだけで作図でき、名前を付けた数値を 1 か所変えると全体が追従し、履歴を途中まで戻して確かめられる」を満たす。範囲は次の 5 つ。

| 要件 ID | 内容 | 優先度 |
|---|---|---|
| FR-313 | 完全な拘束(寸法拘束 4 種+幾何拘束 9 種)。付けると形が自動で整い、要素を動かすと条件を保ったまま追従する | **Must**(v1.8 で格上げ) |
| FR-207 | パラメータ表(名前付きの数値の一覧パネル。1 か所変えると参照が全て追従) | **Must**(v1.8 で FR-206 を具体化) |
| FR-208 | コマンドライン入力(道具名の短縮、絶対 `10,20`・相対 `@5,0`・極 `@10<45`・寸法 `r=5`) | Should |
| FR-110 | 直交・極トラッキング(0/90°・15° 刻み・延長線・垂線・平行線への吸着、案内線) | Should |
| FR-507 | タイムライン(履歴の帯・途中の状態の表示・順序の入れ替え。FR-506 を含む) | Should |

**構成方針:** P0〜P4 で確立した骨をそのまま使い、**新しい区画も新しい文書種も作らない**。P4b が足すのは次の 5 つで、いずれも既存の 2 つの型(`SketchDocument` / `PartDocument`)への欄の追加と、既存の解決の流れへの割り込みで済む。

1. **拘束ソルバー(FR-313)。** `SketchDocument.constraints` を新設し、**解決を 2 段**にする(`resolveSketch` で初期値 → 連立を解く → 上書き表を渡して `resolveSketch` をやり直す)。この 2 段の形は P4 のオフセット(`pendingOffsets`)・投影/交差(`pendingProjections`)ですでに使われている流儀と同じで、**解決そのものは純関数のまま**保たれる(§2.2)。
2. **パラメータ表(FR-207)。** `PartDocument.parameters` を新設する。式エンジンには**変数の口がすでにある**(`EvaluateOptions.variables`、`reevaluateDocument`)が、**どこからも呼ばれていない**(§1 の実在確認)。P4b はその口を部品文書の全域へ配線する(§2.6)。
3. **コマンドライン(FR-208)。** 既存のその場入力の状態機械(`numericInput.ts`、実測 3741 行)を**置き換えず**、打った文字列を同じ段の確定値へ翻訳する薄い層を足す(§2.5)。
4. **直交・極トラッキング(FR-110)。** 既存の吸着(`snapMath.ts`)は「点の候補」しか持たない。P4b は「向きの候補」を並べて足す(§2.4)。
5. **タイムライン(FR-507)。** 履歴の順序の妥当性(依存を壊す入れ替えの検出)を model の純関数に置き、つまみの位置は**保存しない**表示専用の状態にする(§2.7)。

**技術構成:** TypeScript(strict) / opencascade.js 2.0.0-beta.b5ff984 / decimal.js(式)/ Three.js / React + Zustand / Vitest / Playwright。**P4b で追加する外部依存は 0 件。** 拘束ソルバーは自前で書く(§0.1)。カーネル(OCCT)の呼び出しも 1 つも増えない(拘束・トラッキング・コマンドライン・パラメータ・タイムラインはすべて座標と式の計算で、B-rep を作らない)。

**前提:** **P4 のタスク 20 までがコミット済み(HEAD `6084a56`)、タスク 22・24・25・33・35b・36・31・34 が未完了。** P4b は P4 の完了後に着手する。特に**タスク31(`.pcad` のスキーマ版 4)が未着手**である点は §0.17 の判断に直結する(2026-09-04 実測、§1.5)。

---

## 0. 統括への確認事項

計画の実行前に統括の判断が要る点。各項目に作業担当の推奨案と根拠を添える。**【利用者に確認】の印が付いた 7 件は利用者の好みに関わるので、統括が選択肢の形で利用者へ聞く**(`docs/報告記録.md` 2026-09-04 20:50 の利用者の指示「私が決めるべき内容やもっと詳細に内容を詰めるべき項目があれば選択肢で私に都度質問して」)。

| # | 論点 | 作業担当の推奨案と根拠 |
|---|---|---|
| 0.1 | **拘束の解き方(要件§12 の未決「逐次か連立か」)** | **案 A(連立)を推奨する。** 変数を「スケッチの点の作図面上の座標(u, v)と、円弧・楕円の半径」、式を「拘束 1 つあたり 1〜2 本の残差」とし、`(JᵀJ + λI)Δ = −Jᵀf` を密行列のガウス消去で解く **Gauss–Newton + Levenberg–Marquardt**(自前実装、外部依存 0)。<br>**案 B(逐次: 拘束を 1 つずつ満たす)** は実装が小さいが、①「直角+等しい」のように 2 つの拘束が同じ変数を奪い合うと循環して収束しない、②満たす順序で結果が変わる(決定性が無い。`rules/04-設計の規律.md` の「同じ規約を 2 か所に書かない」以前に、同じ文書が開くたび違う形になる)ため**採らない**。<br>**案 C(外部ライブラリ)**: 候補は `cassowary`(線形の制約だけで、距離・角度・接線のような非線形を扱えない)、`kiwi.js`(同上)、`planegcs`(FreeCAD の GCS を WASM 化したもの。約 2MB、LGPL。**LGPL は要件§1.4 の配布形態と衝突する恐れがある**)。非線形を扱えるものは大きく、ライセンスも要確認なので**採らない**(依存追加は統括の承認が要る、`rules/02-禁止事項.md`)。<br>**案 A の根拠(規模):** 本製品の想定規模は 1 部品 200 フィーチャー(要件§5.2)。1 スケッチの拘束付き点が 100 個なら変数 200 個で、`JᵀJ` は 200×200、ガウス消去は 200³/3 ≒ 2.7×10⁶ 回の浮動小数演算で 1 反復あたり数 ms。反復 10 回でも NFR-PF-2(500ms)の内側に十分収まる(実測はタスク8 で取る)。 |
| 0.2 | **何を変数にし、何を定数にするか(既存の「式で座標を書く」流儀との両立)** | **「式で書かれた座標は定数、数値リテラルの座標は変数」を推奨する。** 判定は `evaluateExpression` を通す前の構文木で行い、`number` ノード 1 つ(前置の `-` を含む)だけの `ExpressionValue` を「数値リテラル」とみなす。`板厚 * 2`・`10 + π/2`・`sqrt(50)` はいずれも定数。<br>**根拠:** FR-202「式は文字列のまま保存され、フィーチャー編集時に元の式が再表示・再編集できる」。ソルバーが `板厚 * 2` と書かれた座標を動かすと、その式を壊すか、式と値が食い違うかのどちらかになる。数値リテラルなら `exactExpressionValueFromNumber`(P4 タスク35 で実装済み、丸めない最短 10 進表記)で往復できるので式を壊さない。要件§11 の表「座標・数式による指定を主とし、拘束は式に加えて使える位置づけ」とも一致する。<br>**併せて「固定」拘束を 1 種足すことを推奨する。** 要件が挙げる 9 種の幾何拘束に「固定」は無いが、**ソルバーには基準(動かない点)が要る**。基準が 1 つも無いと、たとえば「長さ 10」だけを付けた線分が空間のどこへでも移動でき、解が一意に決まらない。AutoCAD の「固定」・Inventor の「固定」に相当する道具で、利用者にも馴染みがある。 |
| 0.3 | **拘束を 2D スケッチだけにするか、3D スケッチ(FR-330)も含めるか** | **作図面のあるスケッチだけを対象にすることを推奨する**(3D スケッチ(`planeId` が `FREE_WORK_PLANE_ID`)には拘束を付けられない、と断る)。<br>**根拠:** ①要件 FR-313 の文言は「幾何拘束(水平・垂直・接線・一致等)」で、水平・垂直・平行・直角はいずれも**平面の中でしか意味が決まらない**(3D では「水平」がどの面の水平か決まらない)。②変数を作図面上の 2 変数 (u, v) に絞れると、変数の数が 3D の 2/3 になり、平面内での自由度の数え方(点 1 つ = 2)が教科書どおりになる。③3D スケッチに拘束を足すことは、後から `PlaneSpec` で拘束の基準面を指定する形で拡張できる(型を壊さない)。 |
| 0.4 | **解いた結果を保存するか** | **保存しないことを推奨する。** 拘束を解いた座標は「拘束+初期値」から決まるので、`rules/04-設計の規律.md`「導出できるものは保存しない」に従い `.pcad` へ書かない。ソルバーは決定性がある(初期値・反復回数・許容量が同じなら必ず同じ解)ので、開き直しても同じ形になる。<br>**例外は「引っぱったとき」だけ。** 利用者が要素をドラッグしたら、**引っぱった点の座標だけ**を新しい値へ書き換えて Undo の 1 段にする(それが次回の初期値になる)。ドラッグしていない他の点は書き換えない。 |
| 0.5 | **拘束の保存先** | **`SketchDocument.constraints: readonly SketchConstraint[]` を新設**することを推奨する(要件§8 が `document.json` の中身として「フィーチャー履歴、**拘束**、図面定義」を挙げており、拘束は保存対象と決まっている)。フィーチャーの履歴(`features`)とは別の配列にするのは、拘束が**順序を持たない**ため(履歴は順序が意味を持つ)。参照は既存の `SketchElementRef { featureId, index? }` をそのまま使う。 |
| 0.6 | **半径・角度も変数にするか** | **半径は変数にすることを推奨する**(「等しい」を 2 つの円に付ける、半径拘束・直径拘束を付ける、のいずれにも要る)。角度は独立した変数にせず、**2 つの点の座標から導く**(角度拘束は 2 本の線分の向きの式として書く)。理由: 角度を変数にすると、角度と端点座標の両方が同じ形を表す二重定義になり、どちらを正とするかで矛盾する。 |
| 0.7 | **拘束の表示のしかた【利用者に確認】** | 3 つを決める。<br>**①印の出し方**: 案 A = 要素の脇に小さな記号(`⊥` `∥` `=` `H` `V` など)を常時出す(AutoCAD / Inventor と同じ)/ 案 B = その要素を選んだときだけ出す / 案 C = 記号を出さず一覧パネルだけ。**推奨は案 A**(NFR-UX-7「操作ガイドを全ツールで欠かさない」。付いている拘束が見えないと、なぜ形が動かないのか分からない)。<br>**②色分け**: 案 A = 自由に動く要素は青、完全に拘束された要素は黒(Inventor 流)/ 案 B = 色を変えず記号だけ。**推奨は案 A**。<br>**③自由度の出し方**: 案 A = ステータスバーの帯に「あと 3 か所決まっていません」と数で出す / 案 B = 出さない。**推奨は案 A**(FR-313 の注記「足りない拘束の数を示し」)。 |
| 0.8 | **コマンドラインの置き場【利用者に確認】** | 案 A = **ステータスバーの左端に 1 行の入力欄を埋め込む**(区画は 5 つのまま)。案 B = ステータスバーの上に専用の 1 行の帯を足す(**区画が 6 つになる**)。案 C = ビューポート内に浮かぶ(NFR-UX-2 の「その場で」に近いが、既存のその場入力ポップオーバーと場所が競合する)。<br>**推奨は案 A。** `rules/04-設計の規律.md`「固定区画(ツールバー / ツリー / ビューポート+ビューキューブ / プロパティ / ステータスバー)を増やさない」と、要件 FR-208 の文言「画面下の入力欄」の両方を満たす。ステータスバーは実測 `packages/ui/src/shell/StatusBar.tsx`(260 行)で、左からファイル名・状況の 1 文・詰め物・選択の種類・作図面・吸着・単位の並び。入力欄はファイル名の右、状況の 1 文の左へ入れる(状況の 1 文は打っている間だけ幅を譲る)。 |
| 0.9 | **コマンドラインと既存の数値ポップオーバーの関係(共存 / 置き換え)** | **共存を推奨する。** コマンドラインは「道具を選ぶ」「いま開いている段の欄を埋めて Enter する」の 2 つだけを行い、**段の定義(`numericInput.ts` の `SKETCH_TOOL_STEPS` 等)には一切触らない**。打った値はポップオーバーの欄にそのまま映り、どちらから打っても同じ確定処理(`commitToStore.applySketchCommit`)を通る。<br>**根拠:** ①`numericInput.ts` は実測 3741 行で、段・欄・選択肢・つまみ・範囲検査・既定値がすべてここに集まっている。置き換えると同じ規則が 2 か所に生まれる。②NFR-UX-1「どちらの順でも成立させる」に沿う(マウスで始めてキーボードで終える、が自然にできる)。③FR-208 は「キーボードだけで作図を終えられる」ことを求めており、既存の欄を消すことは求めていない。 |
| 0.10 | **コマンドの語と短縮、焦点の入り方【利用者に確認】** | **①語**: 案 A = 日本語(「線分」)・英語(「LINE」)・短縮(「L」)の 3 通りすべてを受ける / 案 B = 英語と短縮だけ。**推奨は案 A**(要件 FR-208 の文言が「道具の名前(「線分」「LINE」、短縮の「L」など)」と 3 通りを挙げている)。大文字小文字は区別しない。<br>**②短縮の重複**: `C` は 円(Circle)・複写(Copy)・面取り(Chamfer)の 3 つが候補になる。案 A = 割り当て表を 1 か所(`commandLine.ts` の定数)に置き、`C` = 円、`CO` = 複写、`CHA` = 面取り(AutoCAD の慣習に合わせる)/ 案 B = 重複する短縮は作らず 2 文字以上にする。**推奨は案 A**。<br>**③焦点の入り方**: 案 A = `Space` キー(ビューポートに焦点があるとき)/ 案 B = `:`(Vim 風)/ 案 C = 欄をクリックするときだけ。**推奨は案 A**(AutoCAD が Space / Enter でコマンドを繰り返す慣習に近い)。`Esc` で抜ける。 |
| 0.11 | **コマンドラインの候補表示と履歴** | 打つたびに前方一致の候補を**最大 5 件**、入力欄の上へ小さく出す(FR-208「入力中は候補と次に打つものを表示する」)。`Tab` で 1 件目を採り、`↑` `↓` で直前に打った語をたどる(履歴は 20 件、保存しない)。**次に打つもの**の案内は、いま開いている段の欄名(`numericInput.ts` の `labelKey`)をそのまま出す(同じ文言を 2 か所に書かない)。 |
| 0.12 | **トラッキングの既定角度と既定の入切【利用者に確認】** | 案 A = 既定は**入**、刻みは **15°**(0/90 を含む)/ 案 B = 既定は入、刻みは 90°(直交だけ)/ 案 C = 既定は切。**推奨は案 A**(要件 FR-110 が「0°/90°(直交)や 15° 刻み」を並べており、15° 刻みは 0/90 を含む上位互換)。刻みは 5° / 10° / 15° / 30° / 45° / 90° から選べるようにし、設定は表示テーマ・拡大率と同じ `localStorage`(P4 タスク1 の `settings.ts`)へ入れる。 |
| 0.13 | **トラッキングを既存の `SnapKind` に足すか、別立てにするか** | **候補の型は分け、入切の一覧は 1 つに揃えることを推奨する。** 実測した `snapMath.ts` の `SnapCandidate` は `{ kind, position, featureId, elementId }` で、**必ず 1 点に決まる**候補しか持てない。トラッキングは「線の上のどこでもよい」候補なので、`TrackCandidate { kind, origin, direction, sourceFeatureId }` を別の型として足し、`chooseSnap` とは別の `chooseTrack` で選ぶ。<br>一方、**入切の一覧(ストアの `snapKinds`、ツールバーの `SnapKindsMenu`)は 1 つに揃える**。利用者から見れば「どこに吸い付くか」の設定は 1 か所であるべきで(NFR-UX-1)、`SnapKind` に `'polar'`(角度)・`'extension'`(延長線)・`'perpendicular'`(垂線)・`'parallel'`(平行線)の 4 つを足す。<br>**優先順位は点の候補が先。** 点は 1 点に決まるが向きは線なので、両方が判定半径に入ったら点を採る(`SNAP_PRIORITY` の末尾に 4 つを足す)。 |
| 0.14 | **案内線の見た目【利用者に確認】** | 案 A = 細い破線、色は吸着の印と同じアクセント色、長さは画面いっぱい(視錐台まで伸ばす)/ 案 B = 実線、吸着元の要素から吸着点までの区間だけ。**推奨は案 A**(AutoCAD / Inventor と同じで、どの向きに揃っているかが一目で分かる)。色はテーマのトークン(`--pcad-*`、P4 タスク1・2)から取り、5 テーマすべてで背景と 3:1 以上の明度差を持たせる。同時に出す案内線は**最大 2 本**(1 本目の向き+2 本目の向き。3 本以上は画面が読めなくなる)。 |
| 0.15 | **パラメータ表の置き場【利用者に確認】** | 案 A = **プロパティパネルにタブを足す**(「プロパティ」「パラメータ」の 2 つ)/ 案 B = ツールバーの畳んだボタンから開くポップオーバー(表示設定と同じ形)/ 案 C = 新しい区画を作る。<br>**推奨は案 A。** 区画を増やさない(`rules/04`)。パラメータ表は「一覧を見ながら値を打ち替える」道具なので、ポップオーバー(案 B)のように狭くて閉じやすい場所より、常に開いておける右の区画が合う。表示設定(テーマ・拡大率)がポップオーバーで足りたのは「一度決めたら滅多に触らない」設定だからで、パラメータは編集中に何度も往復する。 |
| 0.16 | **変数名に日本語を許すか(式エンジンの字句解析の変更が要る)** | **許すことを推奨する。** **実測(2026-09-04): `packages/expression/src/tokenize.ts` の `isIdentifierStart` は `A-Z` `a-z` `_` `π` しか認めず、`isIdentifierPart` はそれに数字を足しただけ。したがって `板厚 * 2` はいま `unexpectedCharacter`(「使えない文字があります」)で断られる。** 要件 FR-207 の例(「板厚・穴径など」)を素直に満たすには、この 2 関数を広げるほかない。<br>**広げる範囲**: ひらがな(U+3041〜U+309F)・カタカナ(U+30A0〜U+30FF、長音符 U+30FC を含む)・CJK 統合漢字(U+4E00〜U+9FFF)・全角英数(**は入れない**。`normalizeExpressionSource` が半角へ直すため)。**演算子・括弧・コンマ・空白と重ならない**ことを検査で固定する。<br>**`EXPRESSION_SYNTAX_VERSION` を 1 → 2 へ上げる**(記法が広がったので。ただし版 1 の式はすべて版 2 でも読めるため、読み手の互換は保たれる)。 |
| 0.17 | **パラメータ・拘束の保存先と `.pcad` のスキーマ版(P4 タスク31 との関係)** | **①保存先**: パラメータは `PartDocument.parameters`(部品文書に 1 つ。スケッチごとに持たない。要件 FR-207 の「どの数値欄からも名前で参照でき」は部品全体が対象のため)。拘束は §0.5 のとおり `SketchDocument.constraints`。<br>**②版**: **実測(2026-09-04)で `PART_SCHEMA_VERSION`(`packages/model/src/part/createPartDocument.ts:33`)も `PCAD_SCHEMA_VERSION`(`packages/io/src/pcad/schema.ts`)も 3 のままで、P4 タスク31(版 4)は未着手。** したがって次の 2 通りがある。<br>案 A = P4 タスク31 が先に版 4 を入れる前提で、P4b は**版 5** にする(`SCHEMA_MIGRATIONS[4]` を足す)。<br>案 B = P4 タスク31 が終わっていない時点で P4b に着手するなら、P4b が**版 4** を名乗り、点列の `layout` の包み直し(タスク31 の中身)も同時に行う。<br>**推奨は案 A**(P4 を先に閉じる)。ただし着手時に版が 3 のままなら、担当は**止めて統括へ報告する**(推測で版を決めない)。 |
| 0.18 | **タイムラインの置き場【利用者に確認】** | 案 A = **ステータスバーの上に薄い帯を足す**(要件 FR-507 の文言「画面下に…常時表示する」どおり。ただし**区画が 6 つになり `rules/04` の「区画を増やさない」と衝突する**)/ 案 B = フィーチャーツリー(左の区画)の中に、行の左端をなぞるつまみとして置く(区画は増えない)/ 案 C = プロパティパネルのタブ(§0.15 のパラメータ表と同居)。<br>**推奨は案 B。** 履歴の順序はすでにツリーが表しており(`FeatureTree.tsx` の「スケッチ / ソリッド」の 2 節)、同じものを 2 か所に描かずに済む。ただし**要件の文言とは違う**ので、利用者の決定を仰ぐ。案 A を選ぶなら `rules/04-設計の規律.md` の「固定区画を増やさない」を利用者の明示指示で上書きする形になり、その旨を規約の該当行へ注記する。 |
| 0.19 | **ロールバック(つまみ)の位置を保存するか** | **保存しないことを推奨する**(ストアの表示専用の状態 `timelineIndex: number | null`)。`rules/04`「導出できるものは保存しない」。つまみを戻したまま保存すると、開き直したとき「途中までしか作られていない部品」に見えてしまい、FR-504 の失敗表示と区別がつかない。開いた直後は常に末尾(全部作られた状態)にする。 |
| 0.20 | **基準ジオメトリ(`PartDocument.references`)をタイムラインに出すか** | **出すことを推奨する。** 実測どおり `PartDocument` は `references`(基準ジオメトリ)と `solids`(立体)の**2 本の履歴**を持ち、`resolveReferences.ts` が references を先に解いてから `resolvePart.ts` が solids を解く。タイムラインの帯は「references(順)→ solids(順)」の 1 本に並べ、つまみはその通し番号で持つ。基準ジオメトリだけを戻すことに意味は薄いが、**順序の入れ替えの妥当性検査は両方に要る**(作業平面 A がスケッチ S の点を使い、S が作業平面 A の上にある、という循環を `resolveReferences.ts` がすでに `circularReference` で断っている)。 |

### 0.a 統括の決定

**この表は統括が記入する。** 作業担当は記入された決定に従い、§0 の推奨案と食い違う場合は本表を優先する。**空欄の項目があるタスクには着手しない。**

| # | 決定(YYYY-MM-DD 統括) |
|---|---|
| 0.1 | 承認(2026-09-04): 案 A(自前の連立、Gauss–Newton + Levenberg–Marquardt、外部依存 0)を採用。変数はスケッチの点の作図面上の座標(u, v)と円弧・楕円の半径、式で書かれた座標は定数として扱う(§0.2)。解は保存せず、引っぱったときだけ丸めない値で書き戻す(§0.4)。過拘束・矛盾は日本語で断る(NFR-RE-1、止めずに警告)。案 B(逐次)は満たす順序で結果が変わり循環し得るため不採用、案 C(外部ライブラリ)は非線形拘束を扱えないか(cassowary・kiwi.js)、LGPL が要件§1.4 の配布形態と衝突する恐れがある(planegcs)ため不採用(依存追加は統括の承認が要る、rules/02-禁止事項.md)。条件: 反復回数の上限と収束判定の許容量(残差の許容量は 1e-9mm 見込み)はタスク6 で担当が実測して固定し、導出を報告に書く。 |
| 0.2 | 承認(2026-09-04): 推奨案採用。式で書かれた座標(構文木が `number` ノード 1 つだけでない `ExpressionValue`)は定数、数値リテラル(前置の `-` を含む)の座標だけを変数とする(FR-202「式は文字列のまま保存・再編集」と両立させるため)。あわせて「固定」拘束を 1 種新設する(基準となる動かない点が無いと解が一意に定まらないため。AutoCAD・Inventor の「固定」に相当し利用者にも馴染みがある)。 |
| 0.3 | 承認(2026-09-04): 推奨案採用。作図面のあるスケッチだけを拘束の対象にし、3D スケッチ(`planeId` が `FREE_WORK_PLANE_ID`)には拘束を付けられないと断る。水平・垂直・平行・直角は平面の中でしか意味が決まらないこと、変数を作図面上の 2 変数(u, v)に絞れば自由度の数え方が教科書どおりになることを根拠とする。3D スケッチへの拡張は `PlaneSpec` で拘束の基準面を指定する形で後から追加できる(型を壊さない)。 |
| 0.4 | 承認(2026-09-04): 推奨案採用。拘束を解いた座標は保存しない(`rules/04-設計の規律.md`「導出できるものは保存しない」)。例外は利用者が要素をドラッグしたときだけで、引っぱった点の座標だけを新しい値へ書き換えて Undo の 1 段にする(ドラッグしていない他の点は書き換えない)。 |
| 0.5 | 承認(2026-09-04): 推奨案採用。`SketchDocument.constraints: readonly SketchConstraint[]` を新設する。拘束は順序を持たないためフィーチャーの履歴(`features`)とは別配列にする。参照は既存の `SketchElementRef { featureId, index? }` をそのまま使う。 |
| 0.6 | 承認(2026-09-04): 推奨案採用。半径は変数にする(「等しい」・半径拘束・直径拘束のいずれにも必要)。角度は独立した変数にせず、2 つの点の座標から導く(角度拘束は 2 本の線分の向きの式として書く。角度を変数にすると端点座標と同じ形を表す二重定義になり矛盾するため)。 |
| 0.7 | **利用者確認済み(2026-09-04、`docs/報告記録.md` 実時計 21:55)。** ①印の出し方は案 A(要素の脇に `⊥` `∥` `=` `H` `V` 等の記号を常時表示)、②色分けは案 A(自由に動く要素は青、完全拘束は黒)、③自由度の出し方は案 A(ステータスバーの帯に「あと N か所決まっていません」)。いずれも推奨どおり決定。 |
| 0.8 | **利用者確認済み(2026-09-04、同上)。** 案 A(ステータスバーの左端に 1 行の入力欄を埋め込む。区画は 5 つのまま)。`StatusBar.tsx` のファイル名の右・状況の 1 文の左へ入れ、状況の 1 文は打っている間だけ幅を譲る。 |
| 0.9 | 承認(2026-09-04): 推奨案採用(共存)。コマンドラインは「道具を選ぶ」「いま開いている段の欄を埋めて Enter する」の 2 つだけを行い、`numericInput.ts` の段の定義(`SKETCH_TOOL_STEPS` 等)には一切触らない。打った値はポップオーバーの欄にそのまま映り、どちらから打っても同じ確定処理(`commitToStore.applySketchCommit`)を通る。 |
| 0.10 | **利用者確認済み(2026-09-04、同上)。** ①語は日本語・英語・短縮の 3 通りすべてを受け、大文字小文字は区別しない。②短縮の重複は割り当て表を 1 か所(`commandLine.ts` の定数)に置き、AutoCAD の慣習に合わせる(`C`=円、`CO`=複写、`CHA`=面取り)。③焦点の入り方は `Space` キー(ビューポートに焦点があるとき)、`Esc` で抜ける。 |
| 0.11 | 承認(2026-09-04): 推奨案採用。前方一致の候補を最大 5 件、入力欄の上へ表示する。`Tab` で 1 件目を採り、`↑` `↓` で履歴(20 件、保存しない)をたどる。次に打つものの案内は `numericInput.ts` の `labelKey` をそのまま出す(同じ文言を 2 か所に書かない)。 |
| 0.12 | **利用者確認済み(2026-09-04、同上)。** 案 A(既定は入、刻みは 15°)。刻みは 5° / 10° / 15° / 30° / 45° / 90° から選べるようにし、設定は `settings.ts` の `localStorage` へ保存する。 |
| 0.13 | 承認(2026-09-04): 推奨案採用。候補の型は分ける(`TrackCandidate { kind, origin, direction, sourceFeatureId }` を新設し、`SnapCandidate` とは別の型として持つ)。入切の一覧(`SnapKind`、ストアの `snapKinds`、`SnapKindsMenu`)は 1 つに揃え、`'polar'` / `'extension'` / `'perpendicular'` / `'parallel'` の 4 つを `SNAP_PRIORITY` の末尾に足す。優先順位は点の候補が先(両方が判定半径に入ったら点を採る)。 |
| 0.14 | **利用者確認済み(2026-09-04、同上)。** 案 A(細い破線、色は吸着の印と同じアクセント色、長さは画面いっぱい)。色は `themeColors.ts` のトークンから取り、5 テーマすべてで背景と 3:1 以上の明度差を持たせる。同時に出す案内線は最大 2 本。 |
| 0.15 | **利用者確認済み(2026-09-04、同上)。** 案 A(プロパティパネルに「プロパティ」「パラメータ」の 2 タブを足す)。区画は増やさない。 |
| 0.16 | 承認(2026-09-04): 推奨案採用。変数名に日本語を許す。`tokenize.ts` の `isIdentifierStart` / `isIdentifierPart` をひらがな(U+3041〜U+309F)・カタカナ(U+30A0〜U+30FF、長音符 U+30FC を含む)・CJK 統合漢字(U+4E00〜U+9FFF)へ広げる(全角英数は含めない。`normalizeExpressionSource` が半角へ直すため)。演算子・括弧・コンマ・空白と重ならないことを検査で固定する。`EXPRESSION_SYNTAX_VERSION` を 1 から **2** へ上げる(版 1 の式はすべて版 2 でも読めるため読み手の互換は保たれる)。 |
| 0.17 | 承認(2026-09-04): 案 A。P4 タスク31 が版 4 を入れる前提で、P4b は `PART_SCHEMA_VERSION` / `PCAD_SCHEMA_VERSION` を**版 5** にし(`SCHEMA_MIGRATIONS[4]` を追加)、パラメータ(`PartDocument.parameters`)と拘束(`SketchDocument.constraints`、§0.5)を版 5 の中身とする。**P5 はこれを受けて版 6 とする**(`docs/plans/P5-高度なソリッド・外観と測定.md` §0.a-0.15 の「版 5」は「版 6」に読み替え、同計画書にも 1 行追記済み)。条件: 担当は着手時に `PART_SCHEMA_VERSION` が 4 であることを Grep で確かめ、なお 3 のままなら P4 未完了として**止めて統括へ報告する**(推測で版を決めない)。 |
| 0.18 | **利用者確認済み(2026-09-04、同上)。** 案 B(フィーチャーツリーの中に、行の左端をなぞるつまみとして置く。区画は増やさない)。要件 FR-507 の文言「画面下に…常時表示する」とは異なる決定であり、要件の次の版で FR-507 の備考または §12 へ本決定への読み替えを反映する(本決定では要件文書自体は変更しない。§3「変更内容」参照)。 |
| 0.19 | 承認(2026-09-04): 推奨案採用。ロールバック(つまみ)の位置は保存しない(ストアの表示専用の状態 `timelineIndex: number | null`)。開いた直後は常に末尾(全部作られた状態)にする。 |
| 0.20 | 承認(2026-09-04): 推奨案採用。基準ジオメトリ(`PartDocument.references`)をタイムラインに出す。帯は「references(順)→ solids(順)」の 1 本に並べ、つまみはその通し番号で持つ。順序の入れ替えの妥当性検査は references・solids の両方に行う(`resolveReferences.ts` の既存の `circularReference` の検査と整合させる)。 |

**進め方(統括の決定、2026-09-04):** P4 の完了(タスク34 まで)の後に着手する(§前提のとおり)。着手は組 A(タスク1・4・15・17)から。担当のモデルは、数値解法・設計判断・原因究明を含むタスク(4〜9、12〜16、18〜20)は opus 中心、機械的な追随が主のタスク(1、2、3、10、17、21、22)は sonnet とする(「タスク一覧と依存関係」の「モデルの選び方」のとおり)。

---

## 1. 実在確認(2026-09-04 に Read / Grep で確かめた)

**推測で実名を書かない**(`rules/01-役割と委譲.md` §3-1)。下は本計画が名指しする既存の型・関数・ファイルを、実際に読んで確かめた結果である。**担当は着手時に同じファイルを Read し直す**(P4 の残タスクが並行して同じファイルを触っているため)。

### 1.1 `packages/expression`(式エンジン)

| 実名 | 場所 | 確かめたこと |
|---|---|---|
| `ExpressionValue { source, value, display }` | `src/evaluateExpression.ts:12` | 式文字列+評価値+表示用の 3 つ組。`.pcad` に保存される最小単位 |
| `EvaluateOptions { variables?: ReadonlyMap<string, number> }` | `src/evaluateExpression.ts:25` | **変数表の口はすでにある。** 注釈に「P1 の UI は渡さない(= 空として扱う)」 |
| `evaluateExpression(source, options)` | 同 `:40` | 例外を投げず `{ ok, value } | { ok: false, error }` を返す |
| `expressionValueFromNumber(value)` | 同 `:75` | 有効数字 12 桁へ丸めた source を作る |
| `exactExpressionValueFromNumber(value)` | 同 `:93` | **丸めない**最短 10 進表記(P4 タスク35 で新設)。拘束の解の書き戻しに使う |
| `EXPRESSION_SYNTAX_VERSION = 1` | `src/index.ts:11` | 記法の版 |
| `isIdentifierStart` / `isIdentifierPart` | `src/tokenize.ts:52` / `:61` | **`A-Z` `a-z` `_` `π` だけ。日本語の名前はいま断られる**(§0.16 の根拠) |
| `normalizeExpressionSource` | `src/tokenize.ts:37` | 全角の数字・記号を半角へ。1 文字 → 1 文字なので位置がずれない |
| `Token { type, text, position }` / `tokenize` | `src/tokenize.ts:11` / `:83` | 字句の型と分け方。変数名の書き換え(タスク1)はここを通す |
| `Node`(`number` / `constant` / `variable` / `unary` / `binary` / `call`) | `src/ast.ts` | 構文木。数値リテラルの判定(§0.2)はこの `kind` で行う |
| `pi` / `π` / `e` は `constant`、それ以外の識別子は `variable` | `src/parse.ts:125`〜`131` | **予約語は `pi` `π` `e`** |
| 関数は `sqrt` `cbrt` `abs` `rad` `root` の 5 つ | `src/evaluate.ts:35` の `FUNCTION_ARITY` | **予約語(パラメータ名に使えない)** |
| `subtractExpression` / `addExpression` | `src/combineExpression.ts:216` / `:246` | P4 タスク35 で新設。式のまま足し引きする |

### 1.2 `packages/model`(スケッチ・部品)

| 実名 | 場所 | 確かめたこと |
|---|---|---|
| `SketchDocument { id, name, features }` | `src/sketch/types.ts:467` | **`constraints` の欄はまだ無い**(タスク6 で足す) |
| `SketchFeature`(14 種) | 同 `:450` | point / line / arc / pointArray / face / rectangle / polygon / slot / ellipse / spline / offset / copy / projectedCurve / planeSection |
| `CoordinateInput`(absolute / relative / polar) | 同 `:50` | 座標の指定方法 |
| `PointReference`(origin / previous / point / vertex / subShape の 5 種) | 同 `:32` | 「1 kind = 1 case」で足せる形を保つ約束が注釈にある |
| `SketchElementRef { featureId, index? }` | 同 `:266` | 面の境界・オフセット元・トリムの対象が共有する参照。**拘束の対象にもそのまま使う** |
| `ResolvedPoint` / `ResolvedSegment` / `ResolvedArc` / `ResolvedEllipse` / `ResolvedSpline` | 同 `:474`〜`:536` | 解決済みの形 |
| `ResolvedSketch { points, segments, arcs, ellipses, splines, faces, errors, pendingOffsets, pendingProjections, curvesByFeature }` | 同 `:648` | **2 段の解決の型(`pending*`)がすでにある**(§2.2 の根拠) |
| `SketchErrorCode`(11 種) | 同 `:547` | `missingBase` / `invalidValue` / `degenerate` / `notClosed` / `notPlanar` / `collinear` / `tooFewPoints` / `mixedBoundary` / `constructionElement` / `missingSubShape` / `kernelFailed` |
| `resolveSketch(document, options)` | `src/sketch/resolveSketch.ts:856` | 履歴を先頭から順に解決する純関数(ファイル全体 1677 行) |
| `SketchResolveOptions { workPlane?, subShape?, offsetCurves?, projectedCurves? }` | 同 `:751` | **「外から解決済みの形を差し込む口」の前例が 3 つある**(§2.2 でこれに倣う) |
| `resolveCoordinate` / `resolvePointReference` / `ResolveContext` | `src/sketch/resolveCoordinate.ts:133` / `:70` / `:28` | 1 点の解決。`ResolveContext.plane` は 3D スケッチでは null |
| `WorkPlane { id, origin, axisU, axisV, normal }` / `WorkPlaneId = string` | `src/sketch/planeMath.ts:28` / `:26` | 作図面 |
| `worldToPlane(plane, world) → [u, v]` / `planeToWorld(plane, u, v)` | 同 `:160` / `:155` | **拘束の変数(u, v)と世界座標の往復に使う** |
| `FREE_WORK_PLANE_ID = 'free'` / `isFreeWorkPlaneId` / `isBaseWorkPlaneId` / `baseWorkPlane` | 同 `:64`〜`:81` | 3D スケッチの判定(§0.3) |
| `Vec3` と 15 の道具関数(`addVec3` / `subVec3` / `dotVec3` / `crossVec3` / `normalizeVec3` / `mirrorVec3` ほか) | `src/sketch/vec3.ts` | `SKETCH_TOLERANCE_MM = 1e-6` も同ファイル `:135` |
| `arcPointAt` / `curveStart` / `curveEnd` / `curveEvaluator` / `segmentSegmentIntersection` / `curveIntersections` / `traceCurveChain` | `src/sketch/intersectionMath.ts`(821 行) | 曲線の点・交点。`INTERSECTION_TOLERANCE_MM = 1e-3` も同ファイル `:60` |
| `reevaluateDocument(document, variables)` | `src/sketch/recomputeSketch.ts:440` | **スケッチ 1 本の全式を変数表つきで評価し直す。輸出されているが、`packages` / `apps` のどこからも呼ばれていない**(Grep で確認。呼び出しは `model/src/index.ts:111` の再輸出だけ)。部品文書の全域(ソリッド・基準ジオメトリ)を回す版は無い |
| `PartDocument { id, name, schemaVersion, sketches, activeSketchId, references, solids }` | `src/part/types.ts:447` | **`parameters` の欄はまだ無い**(タスク2 で足す) |
| `SolidFeature`(10 種)/ `ReferenceFeature`(4 種) | 同 `:331` / `:437` | 立体の履歴と基準ジオメトリの履歴 |
| `PART_SCHEMA_VERSION = 3` | `src/part/createPartDocument.ts:33` | **版はまだ 3。P4 タスク31 未着手**(§0.17) |
| `resolvePart(document, options)` / `ResolvedPart { sketches, references, steps, projections, errors, liveBodyIds }` | `src/part/resolvePart.ts:1930` / `:338` | 部品全体の解決(ファイル全体 2084 行) |
| `ResolvedSolidStep { featureId, name, key, plan, visible }` | 同 `:262` | カーネルへ渡す 1 段。**タイムラインの帯が並べるのはこれと `references`** |
| `PartErrorCode`(9 種。`circularReference` を含む) | 同 `:275` | 基準ジオメトリの循環はすでに断っている |
| `referencedSketchIds(feature)` | 同 `:1836` | **立体フィーチャーが参照するスケッチの id。順序の入れ替えの検査(タスク18)の材料** |
| `resolveReferences.ts`(736 行) | `src/part/resolveReferences.ts` | 基準ジオメトリの「遅延+記憶」の解決。前方参照と循環を断る |
| `UndoStack<T>` / `pushUndo` / `undo` / `redo` / `UNDO_LIMIT = 200` / `UNDO_COALESCE_MS = 800` | `src/history/undoStack.ts` | Undo の実装。**過去は配列で持つので、タイムラインのつまみとは別物**(§2.7) |
| `shiftOrigin` / `originShiftFor` / `shiftSketchDocument` | `src/part/shiftOrigin.ts` / `src/sketch/shiftCoordinate.ts` | P4 タスク35。**「文書の全 `ExpressionValue` を規則で書き換える」前例**。タスク3 の再評価はこの歩き方をなぞる |

### 1.3 `packages/ui`

| 実名 | 場所 | 確かめたこと |
|---|---|---|
| `SnapKind = 'endpoint' | 'intersection' | 'midpoint' | 'center' | 'grid'` | `src/sketch/snapMath.ts:18` | **5 種。ここへ 4 種足す**(§0.13) |
| `SNAP_PRIORITY` / `DEFAULT_SNAP_KINDS` / `SNAP_RADIUS_PIXELS = 12` | 同 `:26` / `:35` / `:38` | 優先順位と判定半径(画素) |
| `SnapCandidate { kind, position, featureId, elementId }` / `collectSnapCandidates` / `chooseSnap` / `ProjectToScreen` | 同 `:47` / `:85` / `:185` / `:61` | **候補は必ず 1 点。向きの候補は持てない**(§0.13 の根拠) |
| `nearestGridPoint(plane, pointOnPlane, spacing)` | 同 `:76` | 格子点への吸着 |
| `attachSketchInteraction(...)` / `isDrawingTool` / `picksSubShapes` | `src/viewport/attachSketchInteraction.ts:252` / `:131` / `:143` | ビューポートのマウス操作(873 行)。**ドラッグ(タスク13)とトラッキング(タスク15)の入口** |
| `numericInput.ts`(3741 行)の型: `SketchToolId` / `SolidToolId` / `ShapeToolId` / `EditToolId` / `ClickEditToolId` / `ReferenceToolId` / `NumericInputToolId` | `src/sketch/numericInput.ts:72`〜`:184` | 道具の id 一式。**コマンドラインの語の割り当て表(タスク16)はここを正とする** |
| `NumericInputStep`(スケッチ / ソリッド / 基準 / 整形の 4 群) | 同 `:319` | 段の型 |
| `NumericField { key, labelKey, tooltipKey, unit, defaultSource, range? }` / `NumericToggle` / `NumericFieldRange` | 同 `:341` / `:377` / `:331` | 欄の定義。**コマンドラインが埋めるのはこの `source`** |
| `applySketchCommit` / `applyEditCommit` | `src/sketch/commitToStore.ts` | 確定の共通入口(P4 タスク14 で新設) |
| `useAppStore`(1287 行)の欄: `document` / `documentVersion` / `undoStack` / `canUndo` / `canRedo` / `sketch` / `resolvedSketch` / `sketchMesh` / `sketchErrors` / `bodies` / `partErrors` / `selection` / `snapEnabled` / `snapKinds` / `numericInput` / `shapeDraft` / `referenceDraft` / `snapIndicator` / `freeSketchPlane` / `resolvedReferences` | `src/store/useAppStore.ts` | **状態はここ 1 本**(`rules/04`)。`applyDocument(next, { coalesceKey?, undoable? })` が唯一の差し替え口 |
| `AppShell` の 5 区画 | `src/shell/AppShell.tsx:59` の注釈 | 「画面の5区画(ツールバー / ツリー / ビューポート+ビューキューブ / プロパティ / ステータスバー)。区画は増やさない」 |
| `StatusBar`(260 行)/ `describeStatus` / `StatusLineKind` | `src/shell/StatusBar.tsx:82` / `src/shell/statusText.ts` | 帯の組み立て。**コマンドラインの置き場の候補**(§0.8) |
| `FeatureTree`(506 行)/ `buildTreeSections` / `TreeSectionKey = 'sketch' | 'solid'` | `src/shell/FeatureTree.tsx:157` / `src/solid/solidSummary.ts:1358` | ツリーの 2 節。**タイムラインの置き場の候補**(§0.18) |
| `PropertyPanel`(693 行) | `src/shell/PropertyPanel.tsx` | 右の区画。**パラメータ表の置き場の候補**(§0.15) |
| `Toolbar`(1700 行)/ `SHAPE_MENU_ITEMS` / `EDIT_MENU_ITEMS` / `triggerItemOf` / `rememberRecentTool` / `segmentedWidthPixels` / `ICON_BUTTON_WIDTH_PIXELS = 26` / `MENU_TRIGGER_WIDTH_PIXELS = 31` | `src/shell/Toolbar.tsx` / `src/shell/toolbarMenus.ts` | 畳んだボタンの仕組み(P4 タスク32)。**幅の実測関数がある** |
| `settings.ts` / `DisplaySettings` / `SettingsPanel.tsx` / `applyDisplaySettings.ts` | `src/settings/` / `src/shell/` | `localStorage` の 1 鍵に JSON。**トラッキングの設定もここへ入れる**(§0.12) |
| `themeColors.ts`(244 行) | `src/viewport/themeColors.ts` | CSS トークンを three.js の色へ。**案内線の色**(§0.14) |
| `createSketchLayer.ts`(538 行)/ `buildSketchGeometry.ts`(282 行)/ `createReferenceLayer.ts`(269 行) | `src/viewport/` | スケッチの描画。**案内線・拘束の印の描画先** |
| `t(key)` / `MessageKey` / `ja.json` / `i18n.test.ts` | `src/i18n/` | **UI 文字列は必ず `ja.json`**(NFR-MA-5。`.tsx` への日本語直書きは機械的に落ちる) |

### 1.4 `packages/io` と `packages/help-content`

| 実名 | 場所 | 確かめたこと |
|---|---|---|
| `PCAD_SCHEMA_VERSION = 3` / `SCHEMA_MIGRATIONS` / `PcadEnvelope` / `SchemaMigration` | `src/pcad/schema.ts` | **版はまだ 3。`SCHEMA_MIGRATIONS[2]` だけがある** |
| `serializePartDocument` / `serializeSketchFeature` / `readSketchFeature` / `readPointReference` ほか | `src/pcad/documentJson.ts`(3457 行) | 読み書き。種類の一覧を `SKETCH_FEATURE_KINDS` 等の定数で持つ |
| `HELP_TOPICS` | `packages/help-content/src/index.ts:14` | **実測 25 件**(`docs/ja/` の `.md` も 25 本)。`topics.test.ts` が目録と実ファイルの一致を検査する |

### 1.5 実在確認で見つかった前提のずれ(統括へ)

1. **`板厚 * 2` は現在の式エンジンでは断られる。** `tokenize.ts` の識別子が ASCII だけなので、要件 FR-207 の例そのままの名前が使えない。→ §0.16。**タスク1 の前提。**
2. **`reevaluateDocument` はどこからも呼ばれていない。** 変数の口は P1 で作られたが配線されておらず、しかもスケッチ 1 本ぶんしか回さない(ソリッド・基準ジオメトリの式を回す関数が無い)。→ タスク3 で部品文書全体の版を新設する。
3. **`.pcad` のスキーマ版はまだ 3。** P4 §0.24 の「版 4」はタスク31 が未着手のため入っていない。→ §0.17。
4. **P4 が未完了のまま。** HEAD `6084a56` の時点で P4 のタスク 22・24・25・31・33・34・35b・36 が残っている。P4b の着手は P4 の完了後にする(共有ファイル `resolveSketch.ts` / `numericInput.ts` / `useAppStore.ts` / `documentJson.ts` が P4 の残タスクと全面的に重なるため)。
5. **`SnapCandidate` は点しか持てない。** FR-110 の「向きへの吸着」を既存の型へ押し込むと、`position` に嘘の 1 点を入れることになる。→ §0.13 で型を分ける。
6. **区画は 5 つと決まっている。** FR-208(画面下の入力欄)と FR-507(画面下の帯)はどちらも新しい区画を求めているように読める。→ §0.8・§0.18 で利用者の決定を仰ぐ。

---

## 2. 技術方式

### 2.1 P0〜P4 から引き継ぐもの / P4b が足すもの

| 引き継ぐ骨 | P4b が足すもの |
|---|---|
| `SketchDocument` は不変のフィーチャー履歴 | `constraints` 配列(順序を持たない)を並べて足す |
| `resolveSketch` は OCCT を呼ばない純関数 | **拘束を解く純関数**を前段に足す(カーネルを呼ばない) |
| 「解決 → 外の計算 → 解決し直す」の 2 段(オフセット・投影) | **同じ形**で拘束を解く(§2.2) |
| `ExpressionValue` は式文字列+評価値 | 評価に**変数表**を渡す(既存の口 `EvaluateOptions.variables`) |
| 状態は Zustand ストア 1 本 | `parameters` は文書へ、つまみ(`timelineIndex`)とトラッキングの入切は**表示専用の状態**へ |
| 区画は 5 つ | **増やさない**(§0.8・§0.15・§0.18 の推奨案はいずれも既存区画の中) |
| 失敗しても落とさず理由を出す(FR-504) | 拘束が解けないことは**失敗として理由を出す**が、形は最後に解けた状態のまま描く |

### 2.2 拘束ソルバーの構造(FR-313)

**解決を 3 段にする。** 既存の 2 段(`pendingOffsets` → カーネル → 解決し直し)と同じ形で、カーネルの代わりにソルバーを挟む。

```
① resolveSketch(document)                      拘束を無視した解決 = ソルバーの初期値
② solveSketchConstraints(document, resolved)   連立を解く → 上書き表 Map<string, Vec3>
③ resolveSketch(document, { pointOverrides })  上書き表を差し込んで解決し直す
```

- ①と③は同じ純関数。②も純関数(乱数・時刻・DOM に触れない)。**全体として決定性がある。**
- 上書き表の鍵は `ResolvedPoint.id` と同じ規約(点フィーチャーなら `featureId`、点列の n 番目なら `featureId#3`、線分の端点は `featureId:start` / `featureId:end`、円弧の中心は `featureId:center`)。**`resolveCoordinate.ts` の `vertexKey(featureId, vertex)` がすでにこの形の鍵を作っている**ので、それをそのまま使う。
- ③で上書きを差し込む場所は `resolveCoordinate` の直後(絶対座標も相対座標も、解決し終えた世界座標を上書きする)。相対座標の基準になっている点が上書きされれば、その下流も自動的に動く。
- 半径の上書きは別の表(`Map<string, number>`、鍵は `featureId`)にする。

**変数の切り出し(タスク6)。** 1 つのスケッチについて、次を変数にする。

| 対象 | 変数 | 変数にしない条件 |
|---|---|---|
| 点・線分の端点・円弧/楕円の中心・スプラインの各点 | 作図面上の (u, v) の 2 つ | ①その座標が**式**(数値リテラル 1 つでない)、②「固定」拘束が付いている、③`relative` / `polar` 指定である(基準が動けば追従するので、独立した変数にすると二重定義になる) |
| 円弧・円・楕円の半径 | 1 つ(楕円は長半径・短半径の 2 つ) | 同上(式なら定数) |

- 3D スケッチ(`planeId` が `'free'`)は変数を作らない(§0.3)。
- **変数の総数の上限は 400**(点 200 個相当)。超えたら解かず「拘束を付けられる要素が多すぎます」と断る(NFR-PF-2 を守るため。`JᵀJ` のガウス消去が 400³/3 ≒ 2.1×10⁷ 回で 1 反復 20〜40ms、10 反復で 400ms が目安)。

**残差とヤコビアン(タスク7)。** 拘束 1 つが 1〜2 本の式を出す。すべて作図面上の 2 次元で書き、偏微分は**手で書いた解析式**にする(数値微分は精度と速度の両方で不利)。ただし**検査では中心差分(h = 1e-6)と突き合わせて相対誤差 1e-6 以下**を固定する。

| 拘束 | 式の数 | 残差 |
|---|---|---|
| 一致 coincident(点 p、点 q) | 2 | `pu − qu`、`pv − qv` |
| 水平 horizontal(線分の 2 端点) | 1 | `pv − qv` |
| 垂直 vertical(線分の 2 端点) | 1 | `pu − qu` |
| 平行 parallel(線分 2 本) | 1 | `cross(û₁, û₂)`(単位ベクトルの外積) |
| 直角 perpendicular(線分 2 本) | 1 | `dot(û₁, û₂)` |
| 接線 tangent(線分と円/円弧) | 1 | `cross(c − p, û) − r`(符号つき距離 − 半径) |
| 同心 concentric(円 2 つ) | 2 | `c₁u − c₂u`、`c₁v − c₂v` |
| 等しい equal(線分 2 本 / 円 2 つ) | 1 | 線分は `|d₁| − |d₂|`、円は `r₁ − r₂` |
| 対称 symmetric(点 2 つ+軸の線分) | 2 | 中点が軸上(軸への符号つき距離の和)、結ぶ線が軸に直交(`dot(p − q, â)`) |
| 固定 fix(§0.2) | 0 | 式を出さず、その点/半径を変数から外す |
| 距離 distance(点 2 つ、L) | 1 | `|p − q| − L` |
| 角度 angle(線分 2 本、θ) | 1 | `dot(û₁, û₂)·sin θ − cross(û₁, û₂)·cos θ` |
| 半径 radius(円、R) | 1 | `r − R` |
| 直径 diameter(円、D) | 1 | `2r − D` |

- **単位ベクトルにしてから外積・内積を取る**のは、線分の長さが残差の大きさに混ざるとヤコビアンの条件数が悪くなるため(長い線と短い線を同じ拘束でつなぐと、長い側だけが大きく動く)。
- 寸法拘束の目標値(L・θ・R・D)は `ExpressionValue` で持つ。**式で書ける**ので、パラメータ表の変数(FR-207)を寸法拘束に使える(2 つの機能がここで噛み合う)。
- 縮退(長さ 0 の線分、半径 0 の円)は残差の分母が 0 になるので、`SKETCH_TOLERANCE_MM`(1e-6)で先に断る。

**解き方(タスク8)。**

```
f = 残差ベクトル(m 本)、J = ヤコビアン(m × n)、λ = 減衰
繰り返し:
  ‖f‖∞ < 1e-9 なら収束
  (JᵀJ + λI) Δ = −Jᵀ f  を密行列のガウス消去(部分ピボット)で解く
  ‖f(x+Δ)‖ が減れば x ← x+Δ、λ ← λ/3  減らなければ λ ← λ×3 でやり直す
  50 回で打ち切り
λ の初期値 1e-6
```

- **λ を 0 でなく小さな正の数にするのが要**。式が足りない(自由度が残る)ときも `JᵀJ` が正則になり、**最小移動の解**(擬似逆に近い解)が得られる。これが「拘束を付けると形が**なるべく動かずに**整う」という利用者の期待に合う。
- 収束の判定を `1e-9`(mm・無次元が混ざるが、単位ベクトル化により無次元側も同程度の大きさ)にするのは、`SKETCH_TOLERANCE_MM = 1e-6` より 3 桁厳しくして、解いた座標を丸めずに保存しても誤差が見えないようにするため。
- **同じ入力からは必ず同じ解。** 変数の並び順は「フィーチャーの履歴順 → 端点の順(start, end, center)→ u, v」で決め打ちする(`Map` の反復順に頼らない)。

**診断(タスク9)。**

| 判定 | 見るもの | 画面に出すもの |
|---|---|---|
| 足りない | `n − rank(J) > 0` | 「あと N か所決まっていません」(FR-313 の注記) |
| ちょうど | `n − rank(J) === 0` かつ収束 | 「すべて決まりました」 |
| 足しすぎ(冗長) | `rank(J) < m`(行が線形従属) | 従属している行に対応する拘束を指して「同じ条件が重なっています」 |
| 矛盾 | 反復が尽きても `‖f‖∞ ≥ 1e-9` | 残差が大きい順に**上位 3 つの拘束**を指して「この拘束は同時には成り立ちません」 |

- `rank(J)` は**列ピボット付きの QR 分解**(ハウスホルダー)で数え、対角の絶対値が `1e-9 × 最大値` を下回ったところで打ち切る。ガウス消去とは別の実装が要るが、どちらも 100 行程度の純関数。
- 「足しすぎ」と「矛盾」は同時に起こりうる(長さ 10 と長さ 12 を同じ線分に付ける)。両方を出す。
- **解けなくてもアプリは落とさない**(NFR-RE-1)。③の解決には**最後に解けた上書き表**(無ければ空)を渡し、形は描いたまま理由を帯とツリーへ出す(FR-504)。

**引っぱると追従(タスク13)。** ドラッグは「引っぱった点を強制的にポインタの位置へ置く」一時的な固定を足して解き直すことで実現する。

```
押した瞬間: 引っぱる点を決める(吸着の候補と同じ当たり判定)
動かす間  : 一時的な「固定」を引っぱった点へ足し、②③だけをやり直す(文書は変えない)
離した瞬間: 引っぱった点の CoordinateInput だけを新しい値へ書き換えて applyDocument(Undo 1 段)
```

- 動かす間に文書を作り替えないので、`pointermove` ごとの負荷は②③だけ(カーネルを呼ばない)。P3 の実測で `pointermove` の描画間隔は中央値 16.6ms(`docs/報告記録.md` 2026-09-04 11:10)なので、②③を **8ms 以内**に収めることを目標にする(変数 100 個以下の実用規模で計測する)。
- 引っぱれるのは**変数になっている点だけ**(式で書かれた点・固定された点はドラッグできず、その理由を帯に出す)。

### 2.3 拘束と式の共存(FR-202 との両立)

- **式は常に勝つ。** `板厚 * 2` と書かれた座標はソルバーの定数で、どんな拘束を足しても動かない。動かせない座標に矛盾する拘束を足したら、②が「矛盾」と判定して原因の拘束を指す。
- **数値リテラルは拘束に譲る。** ソルバーが動かした結果は保存しない(§0.4)ので、`.pcad` の中身は利用者が打った数値のまま残る。開き直すと同じ拘束で同じ形へ整う。
- **引っぱったときだけ数値が書き換わる。** 書き換えには `exactExpressionValueFromNumber`(丸めない)を使う。有効数字 12 桁へ丸める `expressionValueFromNumber` を使うと、拘束が要求する精度(1e-9)より粗い値が保存され、開き直したときに 1 反復ぶん形が動く。
- **作図面が傾いていると、(u, v) → 世界座標の往復で無理数が出る。** 3 点で作った平面の上の点をドラッグすると `12.343456789012` のような長い数値が保存される。これは避けられない(P4 タスク35 が立体の頂点を原点にするときと同じ事情)ので、そのまま丸めずに保存する。

### 2.4 向きの吸着(FR-110)と既存の吸着の関係

**「点の候補」と「向きの候補」を分ける。** 既存の `SnapCandidate` は触らない。

```ts
// packages/ui/src/sketch/trackMath.ts(新規)
export type TrackKind = 'polar' | 'extension' | 'perpendicular' | 'parallel';

export interface TrackCandidate {
  readonly kind: TrackKind;
  /** 案内線が通る点(作図面上)。 */
  readonly origin: Vec3;
  /** 案内線の向き(単位ベクトル、作図面上)。 */
  readonly direction: Vec3;
  /** どの要素から来た候補か。極(角度)だけ null。 */
  readonly sourceFeatureId: string | null;
  /** 極の候補の角度(度)。他は null。案内の文言に出す。 */
  readonly angleDegrees: number | null;
}
```

| 種類 | 候補の作り方 | いくつ作るか |
|---|---|---|
| 極 polar | 起点(直前に置いた点)から `刻み角度 × k`(k = 0…360/刻み−1)の向き | ポインタに最も近い 1 本だけ作る(24 本すべてを判定に回さない) |
| 延長線 extension | 既存の線分の両端から、その線分の向きへ伸ばした半直線 | 線分の数 × 2。ただし**ポインタの近くにある要素だけ**(粗い当たり判定で絞る) |
| 垂線 perpendicular | 既存の線分の端点を通り、その線分に直交する直線 | 同上 |
| 平行線 parallel | 起点を通り、既存の線分に平行な直線 | 同上 |

- **判定は画面座標で行う**(既存の吸着と同じ理由。`snapMath.ts` 冒頭の注釈)。候補の直線上でポインタに最も近い点を求め、それを画面へ写した距離が `SNAP_RADIUS_PIXELS`(12)以内なら採る。
- **優先順位は「点の候補がすべて先」。** `SNAP_PRIORITY` の末尾へ `'polar'`, `'extension'`, `'perpendicular'`, `'parallel'` の順で足す。極を先にするのは、極が「起点からの角度」という利用者の意図に最も近いため。
- **交点も採る。** 2 本の案内線が同時に採れたとき(たとえば「45° の極」と「既存の線の延長線」)は、その**交点**を吸着点にする(AutoCAD のオブジェクトスナップトラッキングと同じ挙動)。同時に出す案内線は最大 2 本(§0.14)。
- 起点が無い(まだ 1 点も置いていない)ときは極の候補を作らない。

### 2.5 コマンドライン(FR-208)と既存の段の関係

**打った文字列を「道具の切替」か「いま開いている段への値」へ翻訳するだけ**にする。`numericInput.ts` の段の定義は 1 行も変えない。

```ts
// packages/ui/src/sketch/commandLine.ts(新規、純関数だけ)
export type CommandLineOutcome =
  | { readonly kind: 'tool'; readonly tool: NumericInputToolId }
  /** いま開いている段の座標の欄を埋める。 */
  | { readonly kind: 'coordinate'; readonly value: CoordinateInput }
  /** いま開いている段の名前付きの欄を埋める(r=5 / d=20 / a=30 / l=100)。 */
  | { readonly kind: 'field'; readonly fieldKey: string; readonly source: string }
  /** 段を確定する(空の Enter)。 */
  | { readonly kind: 'commit' }
  | { readonly kind: 'error'; readonly message: string; readonly suggestions: readonly string[] };
```

**構文(FR-208)。**

| 書き方 | 意味 | 作る `CoordinateInput` |
|---|---|---|
| `10,20` | 作図面上の絶対座標 | `absolute`。作図面の (u, v) を世界座標へ直す |
| `10,20,5` | 3D スケッチのときだけ 3 つ目を受ける | `absolute` |
| `@5,0` | 直前の点からのずれ | `relative`(`base: { kind: 'previous' }`) |
| `@10<45` | 直前の点から距離 10・角度 45° | `polar`(`base: { kind: 'previous' }`、`elevation: 0`) |
| `r=5` / `d=20` / `a=30` / `l=100` | 半径・直径・角度・長さの欄 | `field` |
| `LINE` / `L` / `線分` | 道具の切替 | `tool` |

- **各成分は式のまま `evaluateExpression` へ通す。** `10/2, 3^2` は (5, 9)、`@板厚*2,0` はパラメータ表の変数つきで評価する(タスク5 の変数表を渡す)。
- **区切りの `,` は括弧の外だけで数える。** `root(8,3), 5` を素朴に `,` で割ると `root(8` と `3)` と ` 5` の 3 つになる(式の文法が関数の引数に `,` を使うため。`packages/expression/src/tokenize.ts` の `comma`)。深さを数えながら分ける。
- **`<` は式の文法に無い**ので極の区切りに安全に使える。ただし角度も式でよいので、**最初の括弧の外の `<` だけ**で分ける(`@10<45+15` は距離 10・角度 60°)。
- 全角の `，` `＠` `＜` は `normalizeExpressionSource` と同じ考えで先に半角へ直す(`＠` `＜` は式エンジンの表に無いので、コマンドライン側で 2 文字だけ足す)。

### 2.6 パラメータ表(FR-207)と式の評価の流れ

```ts
// packages/model/src/parameters/types.ts(新規)
export interface Parameter {
  /** 式から参照される名前。文書の中で重ならない。 */
  readonly name: string;
  /** 値の式。他のパラメータを参照できる。 */
  readonly value: ExpressionValue;
  /** 単位。表示だけに使い、計算には効かせない(FR-207 の「名前・値(式)・説明」に単位を足す)。 */
  readonly unit: 'mm' | 'degree' | 'none';
  /** 説明(FR-207)。空でよい。 */
  readonly description: string;
}
```

**評価の順序。** パラメータどうしが参照し合うので、値を出す前に依存の順へ並べ替える。

```
① 各パラメータの式が参照する名前を集める(expression の collectVariables)
② 有向グラフを作り、トポロジカルソートする
③ 循環に含まれる名前は評価せず「循環」の印を付け、値は前回のまま据え置く
④ 循環の外を並び順に評価し、変数表 Map<string, number> を育てる
⑤ その変数表で部品文書の全 ExpressionValue を評価し直す(reevaluatePartDocument)
```

- ⑤は `shiftOrigin`(P4 タスク35)と同じ「文書を隅々まで歩く」関数で、スケッチのフィーチャー 14 種・立体のフィーチャー 10 種・基準ジオメトリ 4 種・拘束の目標値を回る。**既存の `reevaluateDocument`(スケッチ 1 本)はこの中から呼ぶ**(同じ規則を 2 か所に書かない)。
- **式文字列は変えない。** 変わるのは `value` と `display` だけ(FR-202)。
- **改名は式文字列を書き換える。** 素朴な文字列置換だと「板厚」を改名したときに「板厚さ」の一部まで置き換わる。**字句に分けてから `variable` の字句だけを差し替える**(`tokenize` の `Token.position` と `text` を使い、位置の後ろから差し替えれば位置がずれない)。
- **未使用の検出**: どのパラメータの式からも、文書のどの `ExpressionValue` の式からも参照されない名前に印を付ける(FR-207)。
- **削除**: 参照されている名前の削除は**断る**(参照元を数えて「3 か所から使われています」と出す)。参照を残したまま消すと、開き直すたびに `unknownVariable` が出続ける。

**名前の規則(§0.16 の変更が前提)。**

| 規則 | 理由 |
|---|---|
| 1 文字目は英字・`_`・ひらがな・カタカナ・漢字。数字で始められない | 字句解析が数として読むため |
| `pi` `π` `e` は使えない | `parse.ts` が定数として読むため |
| `sqrt` `cbrt` `abs` `rad` `root` は使えない | `evaluate.ts` の `FUNCTION_ARITY` にあるため |
| 空白・演算子・括弧・コンマを含められない | 字句が切れるため |
| 同じ名前は 1 つだけ | 変数表が `Map` のため |

### 2.7 タイムライン(FR-507)と履歴の順序

- **帯に並べるのは `references`(順)→ `solids`(順)の通し。** スケッチは順序を持たない(`PartDocument.sketches` は配列だが履歴ではない)ので帯に出さない。
- **つまみの位置は保存しない**(§0.19)。ストアの `timelineIndex: number | null`(null = 末尾)。
- **途中までの状態**は「`references` と `solids` をつまみの位置で切った部品文書」を作って `resolvePart` へ渡すだけで得られる。`resolvePart` は既存のまま使え、形状キャッシュ(`ResolvedSolidStep.key`)もそのまま効く(切っても前半の段の鍵は変わらないため、**巻き戻しても再計算が起きない**)。
- **途中への差し込み**: つまみが k 段目にあるとき、新しいフィーチャーは `solids` の添字 k へ入れる(末尾ではなく)。
- **順序の入れ替えの可否**(タスク18)は、次の 3 つを見る純関数で判定する。

| 依存 | 材料 |
|---|---|
| 立体 → 立体 | `targetFeatureId` / `toolFeatureId` / `sourceFeatureId`(`part/types.ts` の 4 種のフィーチャーが持つ) |
| 立体 → スケッチ → 立体 | `referencedSketchIds(feature)`(`resolvePart.ts:1836`)で参照スケッチを引き、そのスケッチの投影・交差フィーチャーが指す `bodyFeatureId` をたどる |
| 立体 / スケッチ → 基準ジオメトリ | `PlaneSpec` / `AxisSpec` / `SubShapeRef` が指す先(`resolveReferences.ts` がすでに前方参照を断っている) |

- **断るときは理由を日本語で出す**(FR-504)。「R 面取り1 は 穴1 の結果を使っているので、前へは動かせません。」

### 2.8 失敗の扱い(FR-504、NFR-RE-1)

| 何が起きたか | どう出すか | 形はどうなるか |
|---|---|---|
| 拘束が矛盾 | 帯に理由、ツリーの該当スケッチに赤い印、原因の拘束を一覧で赤く | **最後に解けた形のまま**描く(消さない) |
| 拘束が足しすぎ | 帯に「同じ条件が重なっています」 | 解けていれば整った形 |
| 変数が 400 を超えた | 帯に「拘束を付けられる要素が多すぎます」 | 拘束を無視した形 |
| パラメータが循環 | 表の該当行を赤く、値は据え置き | 参照している式も据え置き |
| パラメータの名前が未知 | 式の欄に既存の `unknownVariable` の赤表示(FR-204) | その式の値は前回のまま |
| コマンドラインの語が不明 | 欄の下に「その名前の道具はありません」と候補 3 件 | 何も起きない |
| 並べ替えが依存を壊す | 帯に理由、並べ替えを取り消す | 元の順のまま |

**どれもアプリを止めない。確認ダイアログも出さない**(NFR-UX-3。復元不能な操作ではないため)。

### 2.9 性能(NFR-PF-1〜3)

| 何 | 目標 | 根拠 |
|---|---|---|
| 拘束を解く(変数 100) | 8ms 以内 | ドラッグ中に毎フレーム回すため。P3 実測の `pointermove` 間隔 中央値 16.6ms の半分 |
| 拘束を解く(変数 400、上限) | 500ms 以内 | NFR-PF-2 |
| パラメータ 1 つの書き換え → 全再計算 | 5 秒以内(100 フィーチャー) | NFR-PF-3。`reevaluatePartDocument` は式の再評価だけで、形状キャッシュは鍵が変わった段だけ作り直す |
| トラッキングの候補集め | 1 フレーム(16ms)の 1/4 以内 | 候補を作る前にポインタ近傍で粗く絞る |
| タイムラインを 1 段戻す | 再計算を起こさない | 前半の段の鍵は変わらないのでキャッシュが全段当たる |

**新しい性能検査の段は増やさない**(`rules/03-品質ゲート.md` §7.1)。拘束・再評価の所要は既存の `pnpm run test` の中で測り、上限を超えたら落ちるようにする。**上限の数値は緩めない**(`rules/02-禁止事項.md`)。

---

## 3. ファイル構成

**新規**と明記したもの以外は既存ファイルの変更。既存ファイルはすべて 2026-09-04 に Read / Grep で実在を確認した(§1)。**着手時に各タスクの手順 1 で Read し直す。**

```
【expression: 変数名と名前の書き換え】
packages/expression/src/tokenize.ts                  変更: 識別子の文字集合(日本語)
packages/expression/src/tokenize.test.ts             変更
packages/expression/src/variableNames.ts             新規: 参照する変数名の一覧・名前の書き換え・名前の妥当性
packages/expression/src/variableNames.test.ts        新規
packages/expression/src/index.ts                     変更: 輸出と EXPRESSION_SYNTAX_VERSION

【model: パラメータ表】
packages/model/src/parameters/types.ts               新規: Parameter
packages/model/src/parameters/parameterTable.ts      新規: 追加・削除・改名・依存グラフ・循環・未使用・変数表
packages/model/src/parameters/parameterTable.test.ts 新規
packages/model/src/part/types.ts                     変更: PartDocument.parameters
packages/model/src/part/createPartDocument.ts        変更: 既定は空の配列
packages/model/src/part/reevaluatePart.ts            新規: 部品文書の全式を変数表つきで評価し直す
packages/model/src/part/reevaluatePart.test.ts       新規
packages/model/src/index.ts                          変更: 輸出

【model: 拘束】
packages/model/src/sketch/constraints/types.ts       新規: SketchConstraint(13 種+固定)
packages/model/src/sketch/constraints/variables.ts   新規: 変数の切り出し(何が自由か)
packages/model/src/sketch/constraints/residuals.ts   新規: 残差とヤコビアン
packages/model/src/sketch/constraints/solve.ts       新規: ガウス消去・QR・Levenberg–Marquardt
packages/model/src/sketch/constraints/diagnose.ts    新規: 自由度・冗長・矛盾の判定
packages/model/src/sketch/constraints/solveSketch.ts 新規: 3 段の入口(solveSketchConstraints)
packages/model/src/sketch/constraints/*.test.ts      新規(6 本)
packages/model/src/sketch/types.ts                   変更: SketchDocument.constraints、SketchErrorCode に 2 種
packages/model/src/sketch/resolveSketch.ts           変更: pointOverrides / radiusOverrides の口
packages/model/src/sketch/resolveCoordinate.ts       変更: 上書きの差し込み

【model: タイムライン】
packages/model/src/part/timelineOrder.ts             新規: 帯の並び・依存・入れ替えの可否・途中までの文書
packages/model/src/part/timelineOrder.test.ts        新規

【ui: パラメータ表】
packages/ui/src/parameters/parameterCommands.ts      新規: 追加・削除・改名・並べ替えの純関数
packages/ui/src/parameters/parameterCommands.test.ts 新規
packages/ui/src/parameters/ParameterPanel.tsx        新規: 表の描画と編集
packages/ui/src/shell/PropertyPanel.tsx              変更: タブ(§0.15 の決定次第)

【ui: 拘束】
packages/ui/src/sketch/constraintCommands.ts         新規: 選んだ要素から拘束を作る・消す
packages/ui/src/sketch/constraintCommands.test.ts    新規
packages/ui/src/sketch/constraintSummary.ts          新規: 一覧・印の位置・文言
packages/ui/src/sketch/constraintSummary.test.ts     新規
packages/ui/src/viewport/createConstraintLayer.ts    新規: 拘束の印の描画
packages/ui/src/viewport/dragSketch.ts               新規: 引っぱる操作の純関数
packages/ui/src/viewport/dragSketch.test.ts          新規

【ui: トラッキング】
packages/ui/src/sketch/trackMath.ts                  新規: 向きの候補と選択
packages/ui/src/sketch/trackMath.test.ts             新規
packages/ui/src/sketch/snapMath.ts                   変更: SnapKind に 4 種、優先順位
packages/ui/src/viewport/createTrackingLayer.ts      新規: 案内線の描画
packages/ui/src/settings/settings.ts                 変更: トラッキングの入切・刻み角度

【ui: コマンドライン】
packages/ui/src/sketch/commandLine.ts                新規: 構文解析と道具の語の表
packages/ui/src/sketch/commandLine.test.ts           新規
packages/ui/src/shell/CommandLine.tsx                新規: 1 行の入力欄と候補
packages/ui/src/shell/StatusBar.tsx                  変更: 入力欄の埋め込み(§0.8 の決定次第)

【ui: タイムライン】
packages/ui/src/shell/Timeline.tsx                   新規: 帯とつまみ
packages/ui/src/shell/FeatureTree.tsx                変更: つまみの行(§0.18 の決定次第)

【ui: 共有(直列)】
packages/ui/src/store/useAppStore.ts                 変更: parameters / constraints / timelineIndex / tracking / commandLine
packages/ui/src/store/useAppStore.test.ts            変更
packages/ui/src/i18n/ja.json                         変更: 文言
packages/ui/src/shell/Toolbar.tsx                    変更: 拘束の畳んだ一覧、パラメータ表のボタン
packages/ui/src/shell/icons.tsx                      変更: 拘束 13 種+パラメータ+タイムラインの図柄
packages/ui/src/shell/statusText.ts                  変更: 自由度・拘束の断り・トラッキングの案内
packages/ui/src/shell/appShell.css                   変更: 表・帯・入力欄の見た目
packages/ui/src/viewport/attachSketchInteraction.ts  変更: ドラッグとトラッキングの配線
packages/ui/src/sketch/numericInput.ts               変更: 拘束の道具の段(数値を聞くものだけ)
packages/ui/src/sketch/featureSummary.ts             変更: 拘束の要約

【io】
packages/io/src/pcad/schema.ts                       変更: 版と SCHEMA_MIGRATIONS
packages/io/src/pcad/documentJson.ts                 変更: parameters / constraints の読み書き
packages/io/src/pcad/documentJson.test.ts            変更

【help-content】
packages/help-content/docs/ja/constraints.md         新規: 形を条件で決める(拘束)
packages/help-content/docs/ja/parameters.md          新規: 名前を付けた数値(パラメータ)
packages/help-content/docs/ja/command-line.md        新規: キーボードだけで作図する
packages/help-content/docs/ja/tracking.md            新規: 向きをそろえる(直交・角度・延長線)
packages/help-content/docs/ja/timeline.md            新規: 作った順を見る・入れ替える
packages/help-content/src/index.ts                   変更: HELP_TOPICS(実測 25 → 30)

【e2e】
e2e/tests/sketch.spec.ts                             変更: P4b 完了条件の 5 検査
```

**テストはソースと同じ `src/` 配下に `*.test.ts` として置く**(P0〜P4 と同じ)。

---

## 4. 共通の作業規約(全タスク共通)

- **gitへ書き込まない。** 変更したファイルの一覧と検査結果を統括へ報告する(`rules/01-役割と委譲.md` §1)。
- **依存を勝手に足さない。** P4b で追加する外部依存は **0 件**。拘束ソルバーの外部ライブラリが要ると判断したら、**作業を止めて統括へ提案する**(`rules/02-禁止事項.md`、§0.1)。
- **`eslint-disable` / `@ts-ignore` / `@ts-expect-error` / `any` / `as` による強制変換で赤を消さない。** P4b は OCCT の列挙を 1 つも触らないので、P3・P4 で承認された述語ガードの新規追加は**想定していない**。要ると分かったら理由を添えて統括へ提案する(承認前に書かない)。
- **テストの期待値を緩めない。** 実測が期待値と違ったら、値を書き換えるのではなく**実測値と自分で検算した値を統括へ報告**する。性能の上限値(500ms / 5000ms / 8ms)も緩めない。
- **ブラウザの窓・Electron・開発サーバーを起動しない。** ヘッドレスのテスト実行(Vitest、Playwright の headless)は可。
- **`async` 関数に `await` が 1 つも無い形にしない**(`@typescript-eslint/require-await`)。**拘束ソルバーは同期の純関数**なので `async` にしない。
- **静的メソッドを値として渡さない**(`@typescript-eslint/unbound-method`)。
- **`switch` の各節を必ず `return` か `break` で閉じる**(`no-fallthrough`)。拘束 13 種・パラメータの検査など分岐が増えるので、1 節が長くなったら関数へ切り出す。
- **UI 文字列は `packages/ui/src/i18n/ja.json` に置く。** `.tsx` へ日本語を直書きしない(`i18n.test.ts` が機械的に落とす)。**並列で走っている相手が `ja.json` を触っていないことを確かめてから足し、報告に書く。**
- **数値の丸めは最終段だけ**(NFR-RE-4)。拘束の解を保存するとき(ドラッグの確定)は `exactExpressionValueFromNumber` を使い、`expressionValueFromNumber`(12 桁へ丸める)を使わない。
- 検査は `pnpm run typecheck` / `pnpm run lint` / `pnpm run test` / `pnpm run build` の 4 つ。**並列で作業しているときは `scripts/check.ps1` を担当が実行しない**(他担当の途中コードで一過性に落ちるため)。自分のパッケージの `pnpm --filter <名> run test` で足りる。
- 各タスクの最後に、統括が `git diff` を読むための報告(変更ファイル、検査の実行コマンドと出力の要点、実測値)を出す。
- **機能を足したタスクは、同じタスクでヘルプとテストも足す**(`rules/04-設計の規律.md`、NFR-MA-4)。ヘルプは**利用者の操作と画面表示だけ**を書き、内部用語(ソルバー、ヤコビアン、残差、収束、トポロジカルソート、B-rep、Worker)を出さない(`rules/05-リリース.md` §11.3)。
- **既存ファイルを変更する前に、そのファイルを Read して現在の内容を確かめる。** 計画書の記述と食い違っていたら**止めて統括へ報告**する。
- **変更ファイル数が 10 を超えそうなタスクは、着手前に統括へ相談する**(P3・P4 の実績に合わせた目安)。
- **撮影・一時ファイルはリポジトリ直下へ置かない。** 保存先はスクラッチパッドの絶対パスを指示書で受け取る(`docs/報告記録.md` 2026-09-04 18:30・19:30 の教訓)。

---

## タスク一覧と依存関係

**設計上の注意(P3・P4 の教訓):** P4 では `model/src/sketch/{types.ts,resolveSketch.ts}` と `ui/src/sketch/numericInput.ts` を多くのタスクが共有し、最長 15 段の直列の鎖ができた(P4 §6.5)。P4b は**新しい機能どうしが互いに独立している**(拘束・パラメータ・トラッキング・コマンドライン・タイムラインは、どれも他の 4 つを前提にしない)ため、**新規ファイルへ寄せて共有ファイルへの書き込みを各機能の最後の 1 タスクへ集約する**構成にした。共有ファイル(`useAppStore.ts` / `ja.json` / `Toolbar.tsx` / `icons.tsx` / `statusText.ts` / `appShell.css`)を触るのは ui の仕上げ側だけにする。

| # | タスク | 先行 | 主な要件 ID | 変更ファイル数 | ヘルプ文書 |
|---|---|---|---|---|---|
| 1 | `expression`: 変数名の文字集合を広げ、名前の一覧・書き換え・妥当性を足す | — | FR-207, FR-201 | 5 | なし |
| 2 | `model`: パラメータ表の型・依存グラフ(循環・未使用)・変数表 | 1 | FR-207 | 5 | なし |
| 3 | `model`: 部品文書の全式を変数表つきで評価し直す | 2 | FR-207, FR-502 | 3 | なし |
| 4 | `model`: 拘束の型・変数の切り出し・自由度の数え方 | — | FR-313 | 5 | なし |
| 5 | `model`: 拘束の残差とヤコビアン(13 種) | 4 | FR-313 | 2 | なし |
| 6 | `model`: 連立の解き方(ガウス消去・QR・Levenberg–Marquardt) | 4 | FR-313 | 2 | なし |
| 7 | `model`: 拘束の診断(足りない・足しすぎ・矛盾) | 5, 6 | FR-313, NFR-UX-5 | 2 | なし |
| 8 | `model`: 3 段の解決への差し込み(`solveSketchConstraints`) | 7 | FR-313, FR-504 | 5 | なし |
| 9 | `model`: 履歴の並べ替えの妥当性と途中までの文書 | — | FR-507, FR-506 | 3 | なし |
| 10 | `ui`: パラメータ表の操作の純関数(追加・削除・改名・並べ替え) | 3 | FR-207 | 3 | なし |
| 11 | `ui`: パラメータ表のパネルと配線(変数表を全式へ渡す) | 10 | FR-207, FR-201 | 7 | `parameters.md` |
| 12 | `ui`: 拘束を付ける・消すコマンドと要約の純関数 | 8 | FR-313 | 5 | なし |
| 13 | `ui`: 拘束の印・自由度・一覧の表示と配線 | 12, 11 | FR-313, NFR-UX-7 | 8 | `constraints.md` |
| 14 | `ui`: 要素を引っぱると追従(ドラッグ) | 13 | FR-313 | 5 | `constraints.md`(13 と同じファイルへ追記) |
| 15 | `ui`: 向きの吸着の純関数(極・直交・延長線・垂線・平行線) | — | FR-110 | 3 | なし |
| 16 | `ui`: 案内線の描画・入切・刻み角度の設定と配線 | 15, 14 | FR-110, NFR-UX-7 | 8 | `tracking.md` |
| 17 | `ui`: コマンドラインの構文解析と道具の語の表 | — | FR-208 | 3 | なし |
| 18 | `ui`: コマンドラインの欄・候補・段への流し込みと配線 | 17, 16, 11 | FR-208 | 7 | `command-line.md` |
| 19 | `ui`: タイムラインの帯・つまみ(ロールバック) | 9, 18 | FR-507, FR-506 | 7 | `timeline.md` |
| 20 | `ui`: 途中への差し込みと順序の入れ替えの操作 | 19 | FR-507, FR-504 | 5 | `timeline.md`(19 と同じファイルへ追記) |
| 21 | `io`: スキーマ版アップとパラメータ・拘束の読み書き | 2, 4, 8 | 要件§8, FR-801 | 3 | なし |
| 22 | `ui`: ツリー・プロパティ・ツールバーの対応とヘルプの仕上げ | 13, 14, 16, 18, 20 | FR-501〜504, FR-901 | 8 | 5 本の見直し |
| 23 | E2E の追加と全体検査 | 21, 22 | NFR-MA-2, 要件§9 P4b | 1 | なし |

### 並列に実施できる組(変更ファイルが 1 つも重ならないことを確認済み)

| 組 | タスク | 重ならない根拠 |
|---|---|---|
| **A** | **1・4・15・17** | 1 = `expression/src/**` のみ。4 = `model/src/sketch/constraints/**`(新規)+ `model/src/sketch/types.ts` + `model/src/index.ts`。15 = `ui/src/sketch/trackMath.*`(新規)のみ(`snapMath.ts` は触らず、型の追加はタスク16 で行う)。17 = `ui/src/sketch/commandLine.*`(新規)のみ。**4 つとも他の 3 つのパッケージ/ディレクトリに触れない。** |
| **B** | **5・6**(4 の後) | 5 = `constraints/residuals.*`(新規)。6 = `constraints/solve.*`(新規)。どちらも 4 が作った `constraints/types.ts` と `variables.ts` を**読むだけ**で、`model/src/index.ts` にも触らない(輸出はタスク7 でまとめる)。 |
| **C** | **2・9**(2 は 1 の後、9 は先行なし) | 2 = `model/src/parameters/**`(新規)+ `model/src/part/{types.ts,createPartDocument.ts}`。9 = `model/src/part/timelineOrder.*`(新規)。**`model/src/index.ts` への輸出の追記だけが重なるので、2 → 9 の順に足す**(1〜2 行の追記なので直列にしても待ちは短い)。 |
| **D** | **3・7**(3 は 2 の後、7 は 5・6 の後) | 3 = `model/src/part/reevaluatePart.*`(新規)。7 = `constraints/diagnose.*`(新規)。**`model/src/index.ts` は 3 → 7 の順**(C と同じ扱い)。 |

**直列にしかできない箇所(共有ファイル)。**

- `packages/model/src/sketch/types.ts` と `resolveSketch.ts`: タスク4 と 8 だけ(4 で欄を足し、8 で口を足す)。P4 と違い**中間のタスクは触らない**。
- `packages/model/src/index.ts`: 2 → 9 → 3 → 7 → 8 → 4 の順に 1〜2 行ずつ。**同時に開かない**。
- `packages/ui/src/store/useAppStore.ts` / `ja.json` / `Toolbar.tsx` / `icons.tsx` / `statusText.ts` / `appShell.css`: **タスク11 → 13 → 14 → 16 → 18 → 19 → 20 → 22 の一本道**(ui の仕上げ側の鎖)。
- `packages/ui/src/viewport/attachSketchInteraction.ts`: タスク14 → 16 → 18。
- `packages/help-content/src/index.ts`: タスク11 → 13 → 16 → 18 → 19 → 22(`topics.test.ts` が目録と実ファイルの一致を検査するため直列)。

**依存の図(循環なし)。**

```
1 → 2 → 3 ──────────────┐
        9 ──────────────┼──────────────────┐
4 → 5 ─┐                │                  │
    6 ─┼→ 7 → 8 ────────┼→ 12 ─┐           │
4 ─────┘                │      │           │
                        ├→ 10 → 11 → 13 → 14 → 16 → 18 → 19 → 20 → 22 → 23
15 ─────────────────────┘                  │                        │
17 ────────────────────────────────────────┘                        │
2, 4, 8 → 21 ───────────────────────────────────────────────────────┘
```

| 経路 | 段数 |
|---|---|
| `1 → 2 → 3 → 10 → 11 → 13 → 14 → 16 → 18 → 19 → 20 → 22 → 23` | **13(最長。P4b の所要時間を決める)** |
| `4 → 5 → 7 → 8 → 12 → 13 → 14 → 16 → 18 → 19 → 20 → 22 → 23` | 13 |
| `4 → 5 → 7 → 8 → 21 → 23` | 6 |

**最長 13 段は P4 の 15 段より短い**が、うち 8 段(11 以降)が ui の共有ファイルを 1 本ずつ通る鎖である。**共有ファイルへの書き込みを機能ごとの最後の 1 タスクへ集約した結果**で、model 側(1〜9、21)は 4 つの組で並列に進められる。

**モデルの選び方(`rules/01-役割と委譲.md` §2):** 数値解法・設計判断・原因究明を含むタスク(4〜9、12〜16、18〜20)は **opus**、機械的な追加が主のタスク(1、2、3、10、17、21、22)は **sonnet** を推奨する。**opus の並列は 3 まで**(P3・P4 の教訓)。

---

### タスク1: `expression` の変数名の文字集合と、名前の一覧・書き換え・妥当性

**先行タスク:** なし
**対応要件:** FR-207、FR-201、FR-204
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-02 15:09(全角空白 U+3000 をコメントに直書きすると `no-irregular-whitespace` に触れ、見た目で原因が分からなくなる)。文字の範囲を書くときは**必ずコードポイントのエスケープ**(バックスラッシュ u に続けて 4 桁の 16 進の形)を使い、文字そのものをソースへ書かない。
**必要なヘルプ文書:** なし(タスク11 で `parameters.md` を書く)

**ファイル:**
- 変更: `packages/expression/src/tokenize.ts`
- 変更: `packages/expression/src/tokenize.test.ts`
- 新規: `packages/expression/src/variableNames.ts`
- 新規: `packages/expression/src/variableNames.test.ts`
- 変更: `packages/expression/src/index.ts`

**実装内容:**

```ts
// tokenize.ts の isIdentifierStart / isIdentifierPart を広げる。
// 範囲はコードポイントで書く(文字そのものをソースへ書かない)。
const IDENTIFIER_RANGES: readonly (readonly [number, number])[] = [
  [0x3041, 0x309f], // ひらがな
  [0x30a0, 0x30ff], // カタカナ(長音符 U+30FC を含む)
  [0x4e00, 0x9fff], // CJK 統合漢字
];
```

```ts
// packages/expression/src/variableNames.ts(新規)
/** 式が参照する変数の名前(定数 pi / e と関数名は含まない)。並び順は最初に出た順。 */
export function collectVariableNames(source: string): readonly string[];

/** 式の中の変数 `from` を `to` へ書き換える。字句単位なので部分一致では置き換わらない。 */
export function renameVariable(source: string, from: string, to: string): string;

/** その式が「数値リテラル 1 つ」か(拘束の変数にしてよいか。P4b §0.2)。 */
export function isNumericLiteral(source: string): boolean;

/** パラメータの名前として使えるか(§2.6 の 5 つの規則)。使えない理由をコードで返す。 */
export type VariableNameIssue = 'empty' | 'startsWithDigit' | 'reserved' | 'invalidCharacter';
export function checkVariableName(name: string): VariableNameIssue | null;
```

- `collectVariableNames` は `tokenize` → `parse` を通し、構文木の `variable` ノードの名前を集める。読めない式は空を返す(例外を投げない)。
- `renameVariable` は `tokenize` の `Token` の `position` と `text` を使い、**後ろの字句から順に**差し替える(先頭から差し替えると位置がずれる)。`identifier` の字句のうち、**直後が `(` でないもの**(関数呼び出しでない)かつ `pi` / `π` / `e` でないものだけを対象にする。読めない式は元の文字列をそのまま返す。
- `isNumericLiteral` は構文木が `number` 1 つ、または `unary`(`+` / `-`)の中身が `number` 1 つのときだけ true。`10 + 0` は false(式なので定数扱い、§0.2)。
- `checkVariableName` の予約語は `pi` / `π` / `e` / `sqrt` / `cbrt` / `abs` / `rad` / `root`。**この一覧は `evaluate.ts` の `FUNCTION_ARITY` と `parse.ts` の定数から作り、2 か所に書かない**(名前の集合だけを新しい定数へ切り出して両方から使う)。
- `EXPRESSION_SYNTAX_VERSION` を **1 → 2** へ上げる(記法が広がった。版 1 の式はすべて版 2 でも読めるので読み手の互換は保たれる)。

**手順:**

- [ ] 1. `tokenize.ts` / `parse.ts` / `evaluate.ts` を Read し、識別子の判定と予約語の実際の置き場を確かめる。`normalizeExpressionSource` の表(全角 → 半角)と、広げる文字範囲が**重ならない**ことを確かめる(全角数字・全角記号は表で半角へ直るので、識別子の範囲へ入れてはいけない)。
- [ ] 2. `IDENTIFIER_RANGES` を足し、`isIdentifierStart` / `isIdentifierPart` を広げる。**数字だけは先頭に来られない**まま保つ。
- [ ] 3. `variableNames.ts` を書く。
- [ ] 4. `index.ts` の輸出と `EXPRESSION_SYNTAX_VERSION` を直す。
- [ ] 5. 検査を書く。`version.test.ts` が版を固定している場合は、その期待値も 2 へ直す(**これは緩和ではなく仕様の変更なので、報告に明記する**)。

**検証(期待値と導出):**

| 検査 | 期待 | 導出 |
|---|---|---|
| `evaluateExpression('板厚 * 2', { variables: new Map([['板厚', 3]]) })` | `ok: true`、`value: 6` | 3 × 2 |
| `evaluateExpression('板厚 * 2')`(変数表なし) | `ok: false`、`error.code: 'unknownVariable'` | 既存の挙動 |
| 全角空白を挟んだ `板厚　* 2`(変数表つき) | `ok: true`、`value: 6` | `normalizeExpressionSource` が U+3000 を半角空白へ直す |
| `tokenize('ｱ1')`(半角カタカナ) | `unexpectedCharacter` で断る | 範囲に入れない。**手順1 で決めて報告する** |
| `tokenize('2倍')` | `number`(`2`)+ `identifier`(`倍`)の 2 字句 | 数字で始まる名前は作れない |
| `collectVariableNames('板厚 * 2 + 穴径')` | `['板厚', '穴径']` | |
| `collectVariableNames('sqrt(板厚) + pi')` | `['板厚']` | 関数名と定数は含めない |
| `collectVariableNames('root(8, 3)')` | `[]` | |
| `renameVariable('板厚 * 2', '板厚', '板の厚み')` | `'板の厚み * 2'` | |
| `renameVariable('板厚さ + 板厚', '板厚', '厚み')` | `'板厚さ + 厚み'` | **字句単位なので `板厚さ` は変わらない**(素朴な文字列置換だと `厚みさ + 厚み` になる) |
| `renameVariable('sqrt(4)', 'sqrt', 'x')` | `'sqrt(4)'`(変わらない) | 直後が `(` の識別子は関数名 |
| `renameVariable('pi * r', 'pi', 'x')` | `'pi * r'`(変わらない) | `pi` は定数 |
| `isNumericLiteral('10')` / `('-2.5')` / `('.5')` | `true` | |
| `isNumericLiteral('10 + 0')` / `('板厚')` / `('sqrt(4)')` / `('10/2')` | `false` | 式は定数(§0.2) |
| `checkVariableName('板厚')` | `null` | |
| `checkVariableName('2倍')` | `'startsWithDigit'` | |
| `checkVariableName('sqrt')` / `('pi')` / `('e')` | `'reserved'` | |
| `checkVariableName('板 厚')` / `('a+b')` | `'invalidCharacter'` | |
| `checkVariableName('')` | `'empty'` | |
| `EXPRESSION_SYNTAX_VERSION` | `2` | 記法が広がった |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/expression run test` | 全件緑。**25 件以上増える** |

**受け入れ条件:** 日本語の名前を含む式が評価でき、既存の式(ASCII の名前・π・関数)の挙動が 1 つも変わっていない。字句の位置(`Token.position`)が入力の UTF-16 の添字のままである(入力欄のカーソル位置が `selectionStart` と揃う。`tokenize.ts` 冒頭の注釈)。

**落とし穴:**
- **サロゲートペアの漢字(U+20000 以降の拡張漢字)は範囲に入れない。** `charAt` で 1 単位ずつ進む既存の実装が半分に切ってしまう。入れるなら `characterAt`(コードポイント単位、`tokenize.ts:71`)で進む書き方へ全面的に直す必要があり、範囲が大きい。**今回は基本多言語面の範囲だけにする**と決めて報告する。
- **全角の `＋` `−` `（` などを識別子の範囲へ入れない。** `normalizeExpressionSource` が半角へ直した後に判定されるので入れる必要が無く、入れると演算子が名前の一部になる。
- コメントに文字範囲の実例を書くときも、文字そのものでなくコードポイントのエスケープで書く(上記の過去の失敗)。

---

### タスク2: `model` のパラメータ表の型・依存グラフ・変数表

**先行タスク:** 1
**対応要件:** FR-207、FR-206
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-04 15:20(P4 タスク6 の差し戻し。**必須の欄を足すと、旧いファイルを読み手が `missingField` で断ってしまい前方互換が壊れる**)。`PartDocument.parameters` も同じ問題を起こすので、**読み手は「無ければ空の配列」として読む**(タスク21)。
**必要なヘルプ文書:** なし(タスク11 で書く)

**ファイル:**
- 新規: `packages/model/src/parameters/types.ts`
- 新規: `packages/model/src/parameters/parameterTable.ts`
- 新規: `packages/model/src/parameters/parameterTable.test.ts`
- 変更: `packages/model/src/part/types.ts`(`PartDocument.parameters`)
- 変更: `packages/model/src/part/createPartDocument.ts`(既定は空の配列)
- 変更: `packages/model/src/index.ts`(輸出。**組 C の順序どおり 2 → 9**)

**実装内容:**

```ts
// packages/model/src/parameters/types.ts(新規)
export interface Parameter {
  readonly name: string;
  readonly value: ExpressionValue;
  readonly unit: 'mm' | 'degree' | 'none';
  readonly description: string;
}

/** 依存の解析の結果。画面はこれを見て赤い印と「未使用」の印を出す(FR-207)。 */
export interface ParameterAnalysis {
  /** 評価できた変数表。循環に含まれる名前は入らない。 */
  readonly variables: ReadonlyMap<string, number>;
  /** 循環に含まれる名前(FR-207「参照が循環している名前は画面上で示す」)。 */
  readonly circular: readonly string[];
  /** どこからも参照されない名前(FR-207「使われていない名前」)。 */
  readonly unused: readonly string[];
  /** 評価できなかった名前と理由。 */
  readonly failures: readonly { readonly name: string; readonly message: string }[];
}
```

```ts
// packages/model/src/parameters/parameterTable.ts(新規)
export function analyzeParameters(
  parameters: readonly Parameter[],
  /** 文書の中の全式(未使用の判定に使う)。タスク3 が集めて渡す。 */
  usedSources: Iterable<string>,
): ParameterAnalysis;

export function addParameter(parameters: readonly Parameter[], parameter: Parameter): readonly Parameter[];
export function removeParameter(parameters: readonly Parameter[], name: string): readonly Parameter[];
/** 改名。参照している他のパラメータの式も同時に書き換える(タスク1 の renameVariable)。 */
export function renameParameter(parameters: readonly Parameter[], from: string, to: string): readonly Parameter[];
export function replaceParameter(parameters: readonly Parameter[], name: string, next: Parameter): readonly Parameter[];
/** その名前を参照しているパラメータの名前。削除の可否の判断に使う。 */
export function referencesTo(parameters: readonly Parameter[], name: string): readonly string[];
/** 次の空き名(「パラメータ1」「パラメータ2」…)。`createSketchDocument.ts` の nextSerialName と同じ流儀。 */
export function nextParameterName(parameters: readonly Parameter[]): string;
```

- `analyzeParameters` の流れは §2.6 の①〜④。トポロジカルソートは**深さ優先で灰・黒に塗る**古典的な方法(訪問中に灰へ戻ったら循環)。
- **並び順は表の並び順(利用者が並べ替えた順)を保つ。** 評価の順序は内部で決めるが、`ParameterAnalysis` は表の順を変えない。
- **循環に含まれる名前は評価しない**(値は前回のまま据え置く)。循環の外にあって循環を参照している名前も評価できないので `failures` へ入れる。

**手順:**

- [ ] 1. `packages/model/src/part/types.ts` と `createPartDocument.ts` を Read し、`PartDocument` の欄の並びと既定値の作り方、`nextSerialName` の流儀を確かめる。`shiftOrigin.ts`(P4 タスク35)が `PartDocument` をどう歩いているかも見る(タスク3 でなぞるため)。
- [ ] 2. `parameters/types.ts` を書く。
- [ ] 3. `parameterTable.ts` を書く。トポロジカルソートと循環の検出を先に、追加・削除・改名を後に。
- [ ] 4. `PartDocument.parameters` を足し、`createPartDocument` の既定を空の配列にする。
- [ ] 5. `model/src/index.ts` へ輸出を足す(**組 C: タスク9 より先**)。
- [ ] 6. 検査を書く。

**検証(期待値と導出):**

| 検査 | 期待 | 導出 |
|---|---|---|
| `[板厚 = '3', 穴径 = '板厚 * 2']` を解析 | `variables` = `{板厚: 3, 穴径: 6}`、`circular` 空、`failures` 空 | 3 × 2 |
| 上の `板厚` を `'5'` に差し替えて解析 | `variables` = `{板厚: 5, 穴径: 10}` | **利用者の例そのまま** |
| `[A = 'B + 1', B = 'A + 1']` | `circular` = `['A', 'B']`、`variables` にどちらも入らない | 互いに参照 |
| `[A = 'A + 1']` | `circular` = `['A']` | 自己参照 |
| `[C = 'B * 3', B = 'A * 2', A = '1']`(逆順に並べる) | `variables` = `{A: 1, B: 2, C: 6}`、**返る並びは C, B, A のまま** | 1 → 2 → 6。評価は依存順、表示は表の順 |
| `[未使用 = '5']`、`usedSources` に参照なし | `unused` = `['未使用']` | |
| `[板厚 = '3']`、`usedSources` = `['板厚 * 2']` | `unused` 空 | 文書の式から参照されている |
| `[A = '未知 + 1']` | `failures` に `A`(理由に `未知`)、`variables` に `A` は入らない | `unknownVariable` |
| `renameParameter([板厚 = '3', 穴径 = '板厚 * 2'], '板厚', '板の厚み')` | `[板の厚み = '3', 穴径 = '板の厚み * 2']` | 参照が追従(タスク1) |
| `renameParameter` で `板厚さ` という別の名前がある場合 | `板厚さ` は変わらない | 字句単位 |
| `referencesTo([板厚, 穴径], '板厚')` | `['穴径']` | |
| `nextParameterName([パラメータ1, パラメータ3])` | `'パラメータ4'` | 最大連番 + 1(既存の流儀) |
| `analyzeParameters([], [])` | すべて空、例外を投げない | |
| パラメータ 200 件の連鎖(A1 → A2 → … → A200) | 解析が 50ms 以内、実測を報告 | トポロジカルソートは O(件数+辺数) |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/model run test` | 全件緑。**30 件以上増える** |

**受け入れ条件:** 循環があっても例外を投げず、循環の外は正しく評価される。改名で参照が追従する。`PartDocument` に `parameters` が足され、既存の検査が 1 件も落ちない。

**落とし穴:**
- **`ExpressionValue.value` は循環のとき「前回の値」のまま**にする。`0` や `NaN` を入れると、下流の形が一瞬つぶれる。
- **`usedSources` に拘束の目標値の式も含める**(FR-207 の「使われていない名前」の判定を正しくするため)。タスク3 が集める。
- 表の並び順を評価順で上書きしない。利用者が並べた順は保存対象(タスク21)。
- `removeParameter` は消すだけ。**参照されている名前を消してよいかの判断は呼び出し側(タスク10)が `referencesTo` を見て行う**(型の層で断らない)。

---

### タスク3: `model` の部品文書の全式を変数表つきで評価し直す

**先行タスク:** 2
**対応要件:** FR-207、FR-502、FR-202
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-04 21:05(P4 タスク21 の教訓。**「model の非同期経路を足すタスクは、部品文書の経路で実際に動くかまで確認条件に入れる」**。本タスクは同期だが、同じく「配線もれ」が起きやすい ── `reevaluateDocument` が P1 から一度も呼ばれていないのがまさにその例。§1.5-2)。
**必要なヘルプ文書:** なし

**ファイル:**
- 新規: `packages/model/src/part/reevaluatePart.ts`
- 新規: `packages/model/src/part/reevaluatePart.test.ts`
- 変更: `packages/model/src/index.ts`(輸出。**組 D の順序どおり 3 → 7**)

**実装内容:**

```ts
/** 部品文書の全ての ExpressionValue を、変数表つきで評価し直す(FR-207、FR-502)。
 *  式文字列は変えない。変わるのは value と display だけ(FR-202)。 */
export function reevaluatePartDocument(
  document: PartDocument,
  variables: ReadonlyMap<string, number>,
): PartDocument;

/** 文書の中の全ての式の文字列を集める(パラメータの「未使用」の判定に使う)。 */
export function collectExpressionSources(document: PartDocument): readonly string[];

/** パラメータを解析し、その変数表で文書全体を評価し直す。画面が呼ぶ入口。 */
export function applyParameters(document: PartDocument): {
  readonly document: PartDocument;
  readonly analysis: ParameterAnalysis;
};
```

歩く先(**1 つでも漏らすと「値を変えても追従しない欄」が生まれる**):

| 対象 | 場所 |
|---|---|
| スケッチ 14 種の全式 | 既存の `reevaluateDocument`(`sketch/recomputeSketch.ts:440`)をそのまま呼ぶ |
| 拘束の目標値(距離・角度・半径・直径) | `SketchDocument.constraints`(タスク4 が足す。**タスク4 より後に着手するなら含める。並列なら口だけ空けて報告する**) |
| 立体 10 種の全式 | `SolidFeature`。押し出しの距離、回転の角度、縫合の許容量、穴の径・深さ・傾き 2 つ、ねじ穴のピッチ・下穴径・深さ・ねじ長・傾き 2 つ、フィレットの半径、面取りの 3 種の寸法、パターンの間隔・個数・角度、ばねの 6 つの寸法 |
| 基準ジオメトリ 4 種の全式 | `ReferenceFeature`。`PlaneSpec` 7 種と `AxisSpec` が持つ距離・角度・座標 |
| パラメータ自身の式 | `analyzeParameters` が済ませるので二重に回さない |

- **`shiftOrigin.ts`(P4 タスク35)と同じ歩き方**にする。あちらは「絶対座標だけ」を書き換える規則、こちらは「全ての `ExpressionValue`」を評価し直す規則で、対象が違うだけ。**歩く骨(`switch` の網羅)は同じ形にして、片方に新しい種類が増えたらもう片方の `switch` も型検査で落ちるようにする。**
- 評価できない式(未知の変数など)は**元の値を残す**(`reevaluateDocument` の既存の作り。`recomputeSketch.ts:238` の注釈「評価できない式で文書を壊さない」)。

**手順:**

- [ ] 1. `shiftOrigin.ts` / `shiftCoordinate.ts` / `recomputeSketch.ts` の `reevaluateDocument` を Read し、歩き方をなぞる。`part/types.ts` の `SolidFeature` 10 種と `ReferenceFeature` 4 種、`geometry/planeSpec.ts` の `PlaneSpec` 7 種の**式を持つ欄をすべて数え上げて報告する**(数を報告に書く。漏れの検出のため)。
- [ ] 2. `reevaluatePartDocument` を書く。**`switch` の `default` を書かず、網羅を型検査に任せる。**
- [ ] 3. `collectExpressionSources` を書く(同じ歩き方の別の集め方)。
- [ ] 4. `applyParameters` を書く(タスク2 の `analyzeParameters` と組み合わせる)。
- [ ] 5. 検査を書く。
- [ ] 6. `model/src/index.ts` へ輸出を足す。

**検証(期待値と導出):**

| 検査 | 期待 | 導出 |
|---|---|---|
| 押し出しの距離 `'板厚 * 2'`、`板厚 = 3` | 距離の `value` が `6`、`source` は `'板厚 * 2'` のまま | 3 × 2、FR-202 |
| `板厚` を 5 にして再評価 | 距離の `value` が `10`、`source` は変わらない | |
| 穴の径 `'板厚 * 2'`、板厚 3 → 5 | 径 6 → 10 | **利用者の例そのまま** |
| 点の X を `'板厚'`、板厚 3 → 5 | 点の X の `value` が 3 → 5 | スケッチ側も回る |
| 基準平面のオフセット `'板厚'`、板厚 3 → 5 | オフセットの `value` が 3 → 5 | 基準ジオメトリも回る |
| ばねの巻数 `'巻 + 0.5'`、`巻 = 3` | 巻数の `value` が `3.5` | 3 + 0.5 |
| 面取りの 2 距離 `'板厚'` と `'板厚 / 2'`、板厚 = 6 | `6` と `3` | `ChamferSize` の `twoDistances` |
| 未知の変数を含む式 | `value` は元のまま、例外なし | 既存の作り |
| `collectExpressionSources` が返す件数 | 手順1 で数えた欄の数と一致 | **漏れの検出** |
| `applyParameters` で循環がある場合 | 文書は変わらず、`analysis.circular` が埋まる | タスク2 |
| 100 フィーチャーの文書の再評価 | 200ms 以内、実測を報告 | 式の再評価だけ(カーネルを呼ばない)。NFR-PF-3(5 秒)の内訳として十分小さい |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/model run test` | 全件緑。**25 件以上増える** |

**受け入れ条件:** 手順1 で数えた「式を持つ欄」の数と、`collectExpressionSources` が返す数が一致する(漏れが無い)。式文字列が 1 つも変わらない。

**落とし穴:**
- **`switch` に `default` を書かない。** 書くと将来フィーチャーが増えたときに黙って素通りし、「値を変えても追従しない欄」ができる。
- **`reevaluateDocument`(スケッチ 1 本)を作り直さない。** 既存を呼ぶ。同じ規則を 2 か所に書かない。
- **P4 の残タスク(24・25・36)が `SolidFeature` / `SketchFeature` に新しい種類を足している可能性がある。** 手順1 で必ず現物を読む。

---

### タスク4: `model` の拘束の型・変数の切り出し・自由度の数え方

**先行タスク:** なし
**対応要件:** FR-313
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-04 11:05(P4 タスク4。`SketchFeatureKind` に種類を足したら、網羅型 `Record` を持つ 3 か所(model の `createSketchDocument.ts`、ui の `FeatureTree.tsx` / `featureSummary.ts`)が型検査で落ち、他の担当のコミットを止めた)。**本タスクは `SketchErrorCode` に 2 種を足すので同じことが起きうる。** 手順1 で網羅箇所を Grep する。
**必要なヘルプ文書:** なし(タスク13 で書く)

**ファイル:**
- 新規: `packages/model/src/sketch/constraints/types.ts`
- 新規: `packages/model/src/sketch/constraints/variables.ts`
- 新規: `packages/model/src/sketch/constraints/variables.test.ts`
- 変更: `packages/model/src/sketch/types.ts`(`SketchDocument.constraints`、`SketchErrorCode` に 2 種)
- 変更: `packages/model/src/index.ts`(輸出)

**実装内容:**

```ts
// packages/model/src/sketch/constraints/types.ts(新規)

/** 拘束が指す先。鍵は resolveCoordinate.ts の vertexKey / ResolvedPoint.id と揃える。 */
export type ConstraintTarget =
  | { readonly kind: 'point'; readonly pointId: string }
  | { readonly kind: 'vertex'; readonly featureId: string; readonly vertex: 'start' | 'end' | 'center' }
  | { readonly kind: 'curve'; readonly element: SketchElementRef };

export type SketchConstraintKind =
  | 'coincident' | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular'
  | 'tangent' | 'concentric' | 'equal' | 'symmetric' | 'fix'
  | 'distance' | 'angle' | 'radius' | 'diameter';

interface ConstraintBase {
  readonly id: string;
  /** 一覧に出す名前(FR-501 と同じ流儀。「直角1」など)。 */
  readonly name: string;
}

export type SketchConstraint =
  | (ConstraintBase & { readonly kind: 'coincident'; readonly a: ConstraintTarget; readonly b: ConstraintTarget })
  | (ConstraintBase & { readonly kind: 'horizontal' | 'vertical'; readonly target: ConstraintTarget })
  | (ConstraintBase & { readonly kind: 'parallel' | 'perpendicular' | 'equal'; readonly a: ConstraintTarget; readonly b: ConstraintTarget })
  | (ConstraintBase & { readonly kind: 'tangent'; readonly line: ConstraintTarget; readonly circle: ConstraintTarget })
  | (ConstraintBase & { readonly kind: 'concentric'; readonly a: ConstraintTarget; readonly b: ConstraintTarget })
  | (ConstraintBase & { readonly kind: 'symmetric'; readonly a: ConstraintTarget; readonly b: ConstraintTarget; readonly axis: SketchElementRef })
  | (ConstraintBase & { readonly kind: 'fix'; readonly target: ConstraintTarget })
  | (ConstraintBase & { readonly kind: 'distance'; readonly a: ConstraintTarget; readonly b: ConstraintTarget; readonly length: ExpressionValue })
  | (ConstraintBase & { readonly kind: 'angle'; readonly a: ConstraintTarget; readonly b: ConstraintTarget; readonly angle: ExpressionValue })
  | (ConstraintBase & { readonly kind: 'radius' | 'diameter'; readonly target: ConstraintTarget; readonly size: ExpressionValue });
```

```ts
// packages/model/src/sketch/constraints/variables.ts(新規)

export type ConstraintVariable =
  | { readonly kind: 'u' | 'v'; readonly pointKey: string }
  | { readonly kind: 'radius'; readonly featureId: string };

export interface VariableSet {
  /** 決め打ちの順(履歴順 → start / end / center → u, v)。ソルバーの列の順でもある。 */
  readonly variables: readonly ConstraintVariable[];
  /** 初期値(①の解決から取る)。variables と同じ並び。 */
  readonly initial: readonly number[];
  /** 変数にしなかった点/半径と、その理由。画面が「なぜ動かないか」を出すのに使う。 */
  readonly frozen: ReadonlyMap<string, 'expression' | 'fixed' | 'derived'>;
  /** 変数でない点/半径の作図面上の値(残差が定数として読む)。 */
  readonly constants: ReadonlyMap<string, number>;
}

export function collectVariables(
  document: SketchDocument,
  resolved: ResolvedSketch,
  plane: WorkPlane,
): VariableSet;

/** 変数の上限(§2.2)。超えたら解かずに断る。 */
export const MAX_CONSTRAINT_VARIABLES = 400;
```

`SketchErrorCode` に足す 2 種:

| コード | いつ出るか | 文言 |
|---|---|---|
| `constraintConflict` | 反復が尽きても残差が残る、または冗長な拘束がある | 「この拘束は同時には成り立ちません: ○○1、○○2」 |
| `constraintTooMany` | 変数が `MAX_CONSTRAINT_VARIABLES` を超えた | 「拘束を付けられる要素が多すぎます(上限 200 点)。スケッチを分けてください。」 |

**手順:**

- [ ] 1. `sketch/types.ts` の `SketchDocument` / `SketchErrorCode` / `SketchElementRef` を Read する。`SketchErrorCode` を網羅している箇所を `packages/**` で Grep し、**足したときに型検査で落ちる場所を先に洗い出して報告する**(過去の失敗の再発防止)。`resolveCoordinate.ts` の `vertexKey` と `ResolvedPoint.id` の規約も確かめる。
- [ ] 2. `constraints/types.ts` を書く。
- [ ] 3. `constraints/variables.ts` を書く。**「式かどうか」の判定はタスク1 の `isNumericLiteral` を使う**(並列に走るときは model 側の暫定判定で始め、タスク1 の完了後に寄せて報告する)。
- [ ] 4. `SketchDocument.constraints` と `SketchErrorCode` の 2 種を足す。
- [ ] 5. 検査を書く。
- [ ] 6. `model/src/index.ts` へ輸出を足す。

**検証(期待値と導出):**

| 検査 | 期待 | 導出 |
|---|---|---|
| 線分 1 本(両端とも数値リテラルの絶対座標) | 変数 4 個(`line-1:start` の u, v と `line-1:end` の u, v) | 平面上の点 2 つ × 2 |
| 上の始点を `'10 + 0'`(式)にする | 変数 2 個、`frozen` に始点(`'expression'`) | 式は定数(§0.2) |
| 上の始点に `fix` 拘束 | 変数 2 個、`frozen` に始点(`'fixed'`) | |
| 線分の終点が `relative` 指定 | 変数 2 個(始点のみ)、`frozen` に終点(`'derived'`) | 基準が動けば追従する |
| 円弧 1 本(中心が数値リテラル) | 変数 3 個(中心の u, v と半径) | §2.2 の表 |
| 楕円 1 本 | 変数 4 個(中心 2 + 長半径 + 短半径) | |
| 点列(`pointArray`)の 5 点 | 変数 0 個、`frozen` に 5 点(`'derived'`) | 基準+間隔+個数から導かれる |
| 3D スケッチ(`planeId` が `'free'`) | 変数 0 個 | §0.3 |
| 変数の並び順(線分 2 本) | 履歴順に `line-1:start.u, line-1:start.v, line-1:end.u, line-1:end.v, line-2:...` | 決め打ち |
| 同じ文書から 10 回集める | 10 回とも同じ並び | 決定性(`Map` の反復順に頼らない) |
| 作図面 XY 上の点 (3, 4, 0) | 初期値 `[3, 4]` | `worldToPlane` |
| 作図面 XZ 上の点 (3, 0, 4) | 初期値 `[3, 4]` | XZ 面は axisU=(1,0,0)、axisV=(0,0,1) |
| 作図面 YZ 上の点 (0, 3, 4) | 初期値 `[3, 4]` | YZ 面は axisU=(0,1,0)、axisV=(0,0,1) |
| 点 201 個(変数 402) | `variables.length` が 402(上限の判定はタスク7) | |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/model run test` | 全件緑。**20 件以上増える** |

**受け入れ条件:** 型が足され、`SketchErrorCode` の追加で落ちる網羅箇所がすべて直っている。変数の並び順が決定的である。

**落とし穴:**
- **`SketchDocument.constraints` を必須の欄にすると、旧いファイルが読めなくなる**(P4 タスク6 の差し戻し)。型は必須にしてよいが、**読み手(タスク21)は「無ければ空の配列」として読む**。
- **点列(`pointArray`)と複製(`copy`)が生む点・曲線は変数にしない。** 基準+規則から導かれるので、n 番目だけを動かすと式と食い違う。`frozen` に `'derived'` で入れる。
- **オフセット・投影・交差が生む曲線も変数にしない**(同じ理由。形はカーネルが決める)。

---

### タスク5: `model` の拘束の残差とヤコビアン(13 種)

**先行タスク:** 4
**対応要件:** FR-313
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-04 11:35(P4 タスク19。OCCT の数値解法だとフィレットの接点が 5.000000045 になり、プロパティの 12 桁表示で見えた)。**本タスクの偏微分は解析式で書き、数値微分に頼らない。**
**必要なヘルプ文書:** なし

**ファイル:**
- 新規: `packages/model/src/sketch/constraints/residuals.ts`
- 新規: `packages/model/src/sketch/constraints/residuals.test.ts`

**実装内容:**

```ts
/** 残差 1 本と、その偏微分(変数の添字 → 値。0 の項は入れない)。 */
export interface ResidualRow {
  readonly constraintId: string;
  readonly value: number;
  readonly gradient: ReadonlyMap<number, number>;
}

/** 全ての拘束から残差の行を作る。変数の現在値 x を受け取る。 */
export function buildResiduals(
  constraints: readonly SketchConstraint[],
  variableSet: VariableSet,
  x: readonly number[],
): readonly ResidualRow[];
```

残差の式は §2.2 の表のとおり。**単位ベクトルにしてから外積・内積を取る。**

**手順:**

- [ ] 1. `constraints/types.ts` と `variables.ts` を Read する。`vec3.ts` の `SKETCH_TOLERANCE_MM`(1e-6)と `intersectionMath.ts` の `INTERSECTION_TOLERANCE_MM`(1e-3)を確かめ、縮退の判定にどちらを使うか決めて報告する。
- [ ] 2. 拘束 13 種(`fix` を除く)の残差を書く。1 種 = 1 関数にして `switch` は 1 か所だけにする。
- [ ] 3. 偏微分を手で導いて書く。**単位ベクトルの微分に注意**(`d(a/|a|)/da = (I − ââᵀ)/|a|`)。
- [ ] 4. 縮退(長さ 0 の線分、半径 0 の円)を `SKETCH_TOLERANCE_MM` で先に断る。
- [ ] 5. 検査を書く。**13 種すべてで、解析式の偏微分と中心差分(h = 1e-6)の相対誤差が 1e-6 以下**であることを固定する。

**検証(期待値と導出):**

残差の値(すべて作図面 XY 上、長さは mm、向きの残差は無次元):

| 拘束 | 入力 | 残差 | 導出 |
|---|---|---|---|
| 一致 | p = (3, 4)、q = (7, 1) | `[-4, 3]` | 3−7、4−1 |
| 水平 | 線分 (0,0)–(7,4) | `-4` | 0 − 4 |
| 垂直 | 線分 (0,0)–(7,4) | `-7` | 0 − 7 |
| 平行 | d1 = (10, 0)、d2 = (6, 8) | `0.8` | û1=(1,0)、û2=(0.6,0.8)、cross = 1·0.8 − 0·0.6 |
| 直角 | 同上 | `0.6` | dot = 1·0.6 + 0·0.8 |
| 接線 | 円 中心 (0,0) 半径 5、線分 (0,10)–(10,10) | `5` | 中心から直線までの符号つき距離 10 − 半径 5 |
| 同心 | c1 = (0,0)、c2 = (3,4) | `[-3, -4]` | |
| 等しい(線分) | 長さ 10 と 6 | `4` | 10 − 6 |
| 等しい(円) | r1 = 3、r2 = 7 | `-4` | |
| 対称 | p = (2,3)、q = (2,−9)、軸 = 線分 (0,0)–(10,0) | `[-3, 0]` | 中点の軸からの距離 (3−9)/2 = −3、結ぶ線 (0,−12) と軸 (1,0) の内積 0 |
| 距離 | p = (0,0)、q = (3,4)、L = 10 | `-5` | 5 − 10 |
| 角度 | û1 = (1,0)、û2 = (0,1)、θ = 30° | `-0.866025403784` | dot·sinθ − cross·cosθ = 0·0.5 − 1·(√3/2) |
| 半径 | r = 3、R = 8 | `-5` | |
| 直径 | r = 3、D = 20 | `-14` | 2·3 − 20 |

| 検査 | 期待 | 導出 |
|---|---|---|
| 13 種すべての偏微分 vs 中心差分(h = 1e-6) | 相対誤差 1e-6 以下 | 実装の誤りを機械的に捕まえる |
| 長さ 0 の線分に平行拘束 | `degenerate` の断り(残差を作らない) | 単位ベクトルが作れない |
| 半径 0 の円に接線拘束 | `degenerate` | |
| 角度 θ = 0° と θ = 180°(同じ 2 本の線分) | 残差が別の値になる | `dot·0 − cross·1` と `dot·0 − cross·(−1)` |
| 水平拘束の `gradient` | 2 項だけ(始点の v と終点の v) | 0 の項を入れない(疎な行) |
| 直角拘束の `gradient` | 最大 8 項(2 本の線分の 4 点 × 2) | |
| 存在しない要素を指す拘束 | 残差を作らず、その拘束の id を「材料が足りない」として返す | FR-504(消された要素を指したまま) |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/model run test` | 全件緑。**40 件以上増える**(13 種 × 残差・勾配・縮退) |

**受け入れ条件:** 13 種すべてで、残差の値が上の表と一致し(誤差 1e-12 以下)、偏微分が中心差分と 1e-6 以下で一致する。

**落とし穴:**
- **角度拘束を `atan2` の差で書かない。** ±180° をまたぐと不連続になり、Newton が発散する。§2.2 の `dot·sinθ − cross·cosθ` の形は連続。
- **平行・直角の残差を正規化せずに書くと、長い線と短い線を混ぜたときに条件数が悪化する**(§2.2)。
- **対称拘束の軸が変数になっている場合**(軸の線分自身が動く)も勾配を出す。軸を定数と決めつけない。
- `Math.hypot` は `Math.sqrt(x*x+y*y)` より遅い。残差は毎フレーム回るので 2 次元では素朴な `Math.sqrt` を使う(精度の差は 2 次元では実用上出ない)。**どちらを使ったか報告に書く。**

---

### タスク6: `model` の連立の解き方(ガウス消去・QR・Levenberg–Marquardt)

**先行タスク:** 4
**対応要件:** FR-313、NFR-PF-2
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-04 11:20(P4 タスク8。「ガウス消去は点数の 3 乗なので上限 100」という判断の前例)。**同じ考え方で変数の上限 400 を守る。** また `rules/06-過去の失敗と対策.md` 10.3(並列の検査中に性能検査が CPU 競合で落ちた)。**性能の実測は静かな環境で取り、並列中なら「参考」と明記する。**
**必要なヘルプ文書:** なし

**ファイル:**
- 新規: `packages/model/src/sketch/constraints/solve.ts`
- 新規: `packages/model/src/sketch/constraints/solve.test.ts`

**実装内容:**

```ts
/** 連立を部分ピボット付きガウス消去で解く。特異なら null。 */
export function solveLinearSystem(matrix: readonly (readonly number[])[], rhs: readonly number[]): number[] | null;

/** 列ピボット付きハウスホルダー QR で階数を数える(診断に使う)。 */
export function matrixRank(rows: readonly (readonly number[])[], columns: number): number;

export interface SolveOutcome {
  readonly x: readonly number[];
  /** 収束したか(残差の最大値が CONSTRAINT_TOLERANCE 未満)。 */
  readonly converged: boolean;
  readonly iterations: number;
  readonly maxResidual: number;
}

export function solveLevenbergMarquardt(
  initial: readonly number[],
  evaluate: (x: readonly number[]) => readonly ResidualRow[],
  options?: { readonly maxIterations?: number; readonly tolerance?: number },
): SolveOutcome;

export const CONSTRAINT_TOLERANCE = 1e-9;
export const CONSTRAINT_MAX_ITERATIONS = 50;
export const CONSTRAINT_INITIAL_DAMPING = 1e-6;
```

反復は §2.2 の擬似コードのとおり。**λ を 0 にしない**(自由度が残るときも `JᵀJ + λI` が正則になり、最小移動の解が得られる)。

**手順:**

- [ ] 1. `constraints/types.ts` と `variables.ts` を Read する。**タスク5 と並列に走る場合は `ResidualRow` の型だけを先に決めて両者で共有する**(組 B の前提)。
- [ ] 2. `solveLinearSystem` を書く。部分ピボット、対角の絶対値が `1e-12` を下回ったら null。
- [ ] 3. `matrixRank` を書く。列ピボット付きハウスホルダー QR。対角の絶対値が `1e-9 × 最大値` を下回ったところで打ち切る。
- [ ] 4. `solveLevenbergMarquardt` を書く。`JᵀJ` は疎な `gradient` から組み立てる(全要素を走らない)。
- [ ] 5. 検査を書く。**反復回数と所要時間を実測して報告する。**

**検証(期待値と導出):**

行列の道具:

| 検査 | 期待 | 導出 |
|---|---|---|
| `solveLinearSystem([[2,1],[1,3]], [5,10])` | `[1, 3]` | 2·1+1·3=5、1·1+3·3=10 |
| `solveLinearSystem([[1,2],[2,4]], [3,6])`(特異) | `null` | 2 行目 = 1 行目 × 2 |
| `matrixRank([[1,0],[0,1]], 2)` | `2` | |
| `matrixRank([[1,0],[2,0]], 2)` | `1` | 2 行目 = 1 行目 × 2 |
| `matrixRank([[1,0],[0,1],[1,1]], 2)` | `2` | 行 3 本だが列は 2 |
| `matrixRank([], 2)` | `0` | |

拘束を解く(すべて作図面 XY 上、括弧内は (u, v)):

| 拘束の組 | 初期値 | 期待 | 導出 |
|---|---|---|---|
| 水平+長さ 10。始点 (0,0) 固定 | 終点 (7,4) | 終点 `(10, 0)`、収束、反復 ≤ 8 | v=0 かつ u²=100、初期値が u>0 側 |
| 垂直+長さ 10。始点 (0,0) 固定 | 終点 (4,9) | 終点 `(0, 10)` | u=0 かつ v=+10 |
| 一致(両方自由) | p=(3,4)、q=(7,1) | 両方 `(5, 2.5)` | 最小移動なので中点 |
| 距離 10。p=(0,0) 固定 | q=(3,4) | q = `(6, 8)`、反復 1〜2 | 方向を保って 5 → 10 の 2 倍 |
| 等しい(2 円) | r1=3、r2=7 | 両方 `5`(誤差 1e-9 以下)、反復 ≤ 10 | 最小移動 |
| 対称。軸 = (0,0)–(10,0) 固定 | p=(2,3)、q=(2,−9) | p=`(2, 6)`、q=`(2, −6)` | 最小移動で v を ±3 ずつ |
| 同心。円A 中心 (0,0) 固定 | 円B 中心 (3,4) | 円B 中心 `(0, 0)`、反復 1 | 線形 |
| 接線+水平。円 中心 (0,0) 半径 5 固定 | 線分 (0,10)–(10,10) 両端自由 | 両端 `(0, 5)` と `(10, 5)`。**u は動かない** | 残差の勾配に u の成分が無い |
| 平行+長さ 10。A=(0,0)–(10,0) 固定、B の始点 (0,5) 固定 | B の終点 (8,9) | B の終点 `(10, 5)` | 平行 → v=5、長さ 10 → u=10 |
| 直角+等しい+一致。A=(0,0)–(10,0) 固定 | B=(12,3)–(16,8) | B = `(10, 0)`–`(10, 10)`、反復 ≤ 6 | 一致で始点 (10,0)、直角で向きが ±Y、等しいで長さ 10、初期の v 成分が正 |
| 角度 30°+長さ 10。A=(0,0)–(10,0) 固定、B の始点 (0,0) 固定 | B の終点 (10,10) | B の終点 `(8.660254038, 5)` | 10cos30°、10sin30° |
| 半径拘束 R=8 | r=3 | r = `8` | |
| 直径拘束 D=20 | r=3 | r = `10` | 2r = 20 |
| 矛盾: 同じ線分に水平と垂直(両端自由) | (0,0)–(7,4) | `converged: false`、反復 50 で尽きる、例外なし | 長さ 0 でなければ両立しない |
| 足しすぎ: 同じ線分に長さ 10 と長さ 12 | | `converged: false` | |
| 重複(矛盾しない): 同じ線分に長さ 10 を 2 つ | | `converged: true`、長さ `10` | 冗長だが解ける |
| 初期値がすでに解 | | `iterations: 0` | 余分な計算をしない |

| 性能の検査 | 期待 | 根拠 |
|---|---|---|
| 変数 100・拘束 100 の格子 | **8ms 以内**、実測値を報告 | §2.9(ドラッグ中に毎フレーム回すため) |
| 変数 200・拘束 200 の格子 | 500ms 以内、実測値を報告 | NFR-PF-2 |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/model run test` | 全件緑。**35 件以上増える** |

**受け入れ条件:** 上の 16 個の拘束の組の解がすべて期待値と 1e-9 以下で一致する。矛盾する組で 50 回の反復に達しても例外を投げない。変数 100 で 8ms 以内(実測を報告)。

**落とし穴:**
- **`JᵀJ` を素朴な `n×n` の二重ループで組むと、変数 400 で 16 万回 × 行数になり遅い。** `gradient` が疎(1 行あたり 2〜8 項)なので、行ごとに非ゼロの組み合わせだけを足す。
- **λ が大きすぎると 1 歩が小さくなって収束しない。** 減ったら `/3`、増えたら `×3` の古典的な調整で十分。**`×10` にすると振動しやすい。**
- **`matrixRank` と `solveLinearSystem` は別の分解**(QR とガウス消去)なので、片方の結果をもう片方の判定に使わない。
- **性能の実測は静かな環境で取る**(`rules/06` 10.3)。並列で走っているときは「参考」と明記して報告する。**上限は緩めない。**

---

### タスク7: `model` の拘束の診断(足りない・足しすぎ・矛盾)

**先行タスク:** 5、6
**対応要件:** FR-313、NFR-UX-5、FR-504
**関係する過去の失敗:** 該当なし。
**必要なヘルプ文書:** なし

**ファイル:**
- 新規: `packages/model/src/sketch/constraints/diagnose.ts`
- 新規: `packages/model/src/sketch/constraints/diagnose.test.ts`
- 変更: `packages/model/src/index.ts`(`constraints/` の輸出をまとめて。**組 D の順序どおり 3 → 7**)

**実装内容:**

```ts
export interface ConstraintDiagnosis {
  /** 残った自由度。0 なら完全に決まっている(FR-313 の「足りない拘束の数を示し」)。 */
  readonly degreesOfFreedom: number;
  /** 冗長(線形従属)な拘束の id。 */
  readonly redundant: readonly string[];
  /** 同時に成り立たない拘束の id(残差の大きい順に最大 3 つ)。 */
  readonly conflicting: readonly string[];
  /** 材料が足りない拘束の id(指していた要素が消えた)。 */
  readonly dangling: readonly string[];
  /** 動けない要素と理由(画面が「なぜ動かないか」を出す)。 */
  readonly frozen: ReadonlyMap<string, 'expression' | 'fixed' | 'derived'>;
}

export function diagnoseConstraints(
  variableSet: VariableSet,
  rows: readonly ResidualRow[],
  outcome: SolveOutcome,
): ConstraintDiagnosis;
```

- `degreesOfFreedom = variables.length − matrixRank(J)`。
- **冗長の見つけ方**: まず `matrixRank(J) < 行数` かどうかだけを見る。従属があるときだけ、行を 1 本ずつ抜いて階数が変わらない行を探す(通常は冗長が無いので追加の計算は起きない)。
- **矛盾の見つけ方**: `outcome.converged === false` のとき、最後の残差の絶対値が大きい順に拘束の id を最大 3 つ返す。
- **同じ拘束が冗長と矛盾の両方に入ることがある**(長さ 10 と長さ 12)。両方に入れる。

**手順:**

- [ ] 1. `variables.ts` / `residuals.ts` / `solve.ts` を Read する。
- [ ] 2. `diagnoseConstraints` を書く。
- [ ] 3. 検査を書く。**矩形のように手で数えにくい例は、担当が階数を実測し、その値を期待値として固定したうえで導出の説明を報告に書く**(推測で期待値を書かない)。
- [ ] 4. `model/src/index.ts` へ `constraints/` の輸出(タスク4〜7 のぶん)をまとめて足す。

**検証(期待値と導出):**

| 検査 | 期待 | 導出 |
|---|---|---|
| 線分 1 本(両端自由)、拘束なし | 自由度 `4` | 点 2 つ × 2 |
| 上に水平拘束 | 自由度 `3` | 4 − 1 |
| さらに長さ 10 | 自由度 `2` | 4 − 2 |
| さらに始点を原点へ一致(原点は定数) | 自由度 `0` | 4 − 4 |
| 円 1 つ(中心自由・半径自由)、拘束なし | 自由度 `3` | 中心 2 + 半径 1 |
| 上に半径拘束 | 自由度 `2` | |
| 線分 1 本に長さ 10 を 2 つ | 自由度 `3`、`redundant` に 1 つ、`conflicting` 空 | 階数 1 < 行数 2、残差は 0 |
| 線分 1 本に長さ 10 と長さ 12 | `redundant` に 1 つ、`conflicting` に 2 つ | 階数 1 < 行数 2、残差が残る |
| 線分 1 本に水平と垂直(両端自由) | `conflicting` に 2 つ、`redundant` 空 | 階数 2 = 行数 2 だが解が無い |
| 両端が式で書かれた線分に水平拘束(残差が残る) | 自由度 `0`、`frozen` に 2 点(`'expression'`)、`conflicting` に水平 | 変数が 0 個 |
| 消えた要素を指す拘束 | `dangling` に 1 つ、他の拘束は正しく解ける | FR-504 |
| 矩形の 4 辺(8 変数)+ 4 つの一致 + 2 つの水平 + 2 つの垂直 | **担当が階数を実測して固定し、導出を報告に書く**(見込みは自由度 2 = 平面内の平行移動) | |
| 変数 402 個 | 診断を行わず `constraintTooMany` の合図を返す | `MAX_CONSTRAINT_VARIABLES` |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/model run test` | 全件緑。**20 件以上増える** |

**受け入れ条件:** 自由度の数え方が上の表と一致する。冗長と矛盾を区別して返す。

**落とし穴:**
- **階数の閾値が緩いと自由度を数え間違える。** 変数の単位が mm(座標)と無次元(半径は mm、向きの残差は無次元)で混ざるので、混ざりが問題になったら**列を正規化**(各列を最大値で割る)してから階数を数える。**そうしたら報告に書く。**
- 冗長の 1 本ずつの検査は行数が多いと O(行数) 回の QR になる。**冗長があるときだけ**走らせる。

---

### タスク8: `model` の 3 段の解決への差し込み

**先行タスク:** 7
**対応要件:** FR-313、FR-504、NFR-RE-1
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-04 21:05(P4 タスク21。**UI の経路 `recomputePart → resolvePart` が `offsetCurves` を渡しておらず、オフセットのカーネル往復が一度も呼ばれていなかった**)。**部品文書の経路まで配線し、部品の検査で拘束が効くことを固定する。**
**必要なヘルプ文書:** なし(タスク13 で書く)

**ファイル:**
- 新規: `packages/model/src/sketch/constraints/solveSketch.ts`
- 新規: `packages/model/src/sketch/constraints/solveSketch.test.ts`
- 変更: `packages/model/src/sketch/resolveSketch.ts`(`SketchResolveOptions` に 2 つの口)
- 変更: `packages/model/src/sketch/resolveCoordinate.ts`(上書きの差し込み)
- 変更: `packages/model/src/part/resolvePart.ts`(部品文書の経路への配線)

**実装内容:**

```ts
// SketchResolveOptions への追加(既存の workPlane / subShape / offsetCurves / projectedCurves に並ぶ)
  /** 拘束を解いた後の点の位置(FR-313)。鍵は ResolvedPoint.id / vertexKey の規約。 */
  readonly pointOverrides?: ReadonlyMap<string, Vec3>;
  /** 拘束を解いた後の半径。鍵は featureId。 */
  readonly radiusOverrides?: ReadonlyMap<string, number>;
```

```ts
// packages/model/src/sketch/constraints/solveSketch.ts(新規)
export interface ConstrainedSketch {
  readonly resolved: ResolvedSketch;
  readonly diagnosis: ConstraintDiagnosis;
  /** 拘束の失敗。resolved.errors とは別に持ち、呼び出し側が両方を並べる。 */
  readonly errors: readonly SketchError[];
  /** 解けた変数の値(ドラッグの確定で書き戻すのに使う。タスク14)。 */
  readonly solution: ReadonlyMap<string, Vec3>;
}

/** 3 段の解決の入口(§2.2)。拘束が 0 個なら 1 段で返す(余分な計算をしない)。 */
export function resolveConstrainedSketch(
  document: SketchDocument,
  options?: SketchResolveOptions,
): ConstrainedSketch;
```

- **拘束が 0 個なら `resolveSketch` を 1 回呼ぶだけ**にする(既存の文書の性能を 1 ミリ秒も落とさない)。
- ②が収束しなかったときも③は行う(**最後に得られた x で上書きする**。形は最も近い状態で描かれ、理由は `errors` に入る)。
- `resolvePart.ts` の中でスケッチを解いている箇所を `resolveConstrainedSketch` へ差し替える。**`subShape` / `offsetCurves` / `projectedCurves` の受け渡しを壊さない**(既存の口をそのまま素通しする)。

**手順:**

- [ ] 1. `resolveSketch.ts`(1677 行)の `SketchResolveOptions` と、`resolveCoordinate` を呼んでいる箇所をすべて Grep する。`resolvePart.ts`(2084 行)でスケッチを解いている箇所を Grep し、**何か所あるかを報告する**(P4 タスク21 の教訓。数を先に数えてから配線する)。
- [ ] 2. `pointOverrides` / `radiusOverrides` の口を `SketchResolveOptions` へ足し、`resolveCoordinate` の直後で差し込む。
- [ ] 3. `solveSketch.ts` を書く(3 段)。
- [ ] 4. `resolvePart.ts` の該当箇所を差し替える。
- [ ] 5. 検査を書く。**スケッチ単体の検査と、部品文書の経路の検査の両方**を書く(教訓)。

**検証(期待値と導出):**

| 検査 | 期待 | 導出 |
|---|---|---|
| 拘束 0 個の文書 | 結果が `resolveSketch(document)` と完全に一致、`resolveSketch` の呼び出しは 1 回 | 余分な計算をしない |
| 線分 (0,0)–(7,4) に水平+長さ 10(始点は固定) | `segments[0].to` = `(10, 0, 0)` | タスク6 |
| 上の線分の終点を基準にした相対座標の点 `+(0, 5)` | 点の位置 `(10, 5, 0)` | ③で上書きが下流へ伝わる |
| 円弧の半径 3 に半径拘束 8 | `arcs[0].radius` = `8` | `radiusOverrides` |
| 矛盾する拘束 | `errors` に `constraintConflict` 1 件、`resolved` は最後の x の形、例外なし | FR-504、NFR-RE-1 |
| 変数 402 個 | `errors` に `constraintTooMany` 1 件、`resolved` は拘束を無視した形 | |
| XZ 面上のスケッチに水平拘束 | 作図面の第 1 軸(X)に沿う。世界の Y ではなく面の中で水平 | `worldToPlane` / `planeToWorld` |
| 傾いた任意平面(3 点)の上のスケッチに水平+長さ 10 | 線分の長さが `10`(誤差 1e-9 以下)、点が平面の上に乗る(平面までの距離 1e-9 以下) | 変数は (u, v) |
| 3D スケッチに拘束を足した文書 | `errors` に断り 1 件、形は拘束を無視 | §0.3 |
| **部品文書の経路**: 40×30 の枠(4 本の線分に水平・垂直・一致・長さ拘束)から面を張って距離 10 で押し出す | 体積 `12000` | 40 × 30 × 10 |
| 上の長さ拘束を 40 → 50 に変える | 体積 `15000` | 50 × 30 × 10 |
| 上の長さ拘束の式を `'幅'`(パラメータ)にして 幅 = 40 → 50 | 体積 `12000` → `15000` | **拘束とパラメータが噛み合う**(タスク3 と併せた検査) |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/model run test` | 全件緑。**25 件以上増える** |

**受け入れ条件:** 部品文書の経路(`resolvePart`)で拘束が効くことが検査で固定されている(手順1 で数えた箇所がすべて差し替わっている)。拘束 0 個の既存の文書で、解決の結果も所要も変わらない。

**落とし穴:**
- **`resolveSketch` を 2 回呼ぶので、拘束のあるスケッチの解決は約 2 倍になる。** 拘束が 0 個のときに 1 回で済ませるのが要。
- **上書きの鍵の規約を 1 か所に置く。** `vertexKey`(`resolveCoordinate.ts:23`)と `ResolvedPoint.id` の作り方を借り、`solveSketch.ts` の中に別の規約を作らない。
- **`resolvePart.ts` は 2084 行で、投影・交差(P4 タスク25)が同時に触っている可能性がある。** 手順1 で必ず現物を読み、食い違ったら止めて報告する。

---

### タスク9: `model` の履歴の並べ替えの妥当性と途中までの文書

**先行タスク:** なし
**対応要件:** FR-507、FR-506、FR-504
**関係する過去の失敗:** 該当なし。ただし `resolveReferences.ts`(P4 タスク9)がすでに「自分より前のものだけを参照できる」制約と `circularReference` の断りを持っている。**同じ規約を 2 か所に書かない。**
**必要なヘルプ文書:** なし(タスク19 で書く)

**ファイル:**
- 新規: `packages/model/src/part/timelineOrder.ts`
- 新規: `packages/model/src/part/timelineOrder.test.ts`
- 変更: `packages/model/src/index.ts`(輸出。**組 C の順序どおり 2 → 9**)

**実装内容:**

```ts
/** タイムラインの帯に並べる 1 つ。references(順)→ solids(順)の通し。 */
export interface TimelineEntry {
  readonly index: number;
  readonly section: 'reference' | 'solid';
  readonly featureId: string;
  readonly name: string;
  readonly kind: string;
  readonly suppressed: boolean;
}

export function buildTimeline(document: PartDocument): readonly TimelineEntry[];

/** そのフィーチャーが参照している(自分より前になければならない)フィーチャーの id。 */
export function dependenciesOf(document: PartDocument, featureId: string): readonly string[];

export type ReorderOutcome =
  | { readonly ok: true; readonly document: PartDocument }
  | { readonly ok: false; readonly reason: string; readonly blockingFeatureId: string };

/** from の位置のものを to の位置へ動かす。依存を壊すなら理由つきで断る(FR-507)。 */
export function reorderTimeline(document: PartDocument, from: number, to: number): ReorderOutcome;

/** つまみを index に置いたときの「途中までの文書」。index が null なら文書そのもの(=== を保つ)。 */
export function documentUpTo(document: PartDocument, index: number | null): PartDocument;

/** つまみが index にあるとき、新しいフィーチャーを差し込む配列の位置(FR-507)。 */
export function insertPositionAt(
  document: PartDocument,
  index: number | null,
  section: 'reference' | 'solid',
): number;
```

`dependenciesOf` が見るもの(§2.7 の表):

| 依存 | 材料 |
|---|---|
| 立体 → 立体 | `targetFeatureId`(穴・ねじ穴・フィレット・面取り)、`toolFeatureId`(ブーリアン)、`sourceFeatureId`(パターン)、`SubShapeRef.bodyFeatureId`(面・辺・頂点の参照) |
| 立体 → スケッチ → 立体 | `referencedSketchIds(feature)`(`resolvePart.ts:1836`)でスケッチを引き、そのスケッチの `projectedCurve` / `planeSection` が指す `bodyFeatureId` をたどる |
| 立体 / 基準ジオメトリ → 基準ジオメトリ | `PlaneSpec` / `AxisSpec` / `PointReference` / `SubShapeRef` が指す先 |

**手順:**

- [ ] 1. `part/types.ts` の `SolidFeature` 10 種・`ReferenceFeature` 4 種、`geometry/planeSpec.ts` の `PlaneSpec` / `AxisSpec`、`resolvePart.ts` の `referencedSketchIds`、`resolveReferences.ts` の前方参照の判定を Read する。**「他のフィーチャーを指す欄」を数え上げて報告する**(漏れの検出)。
- [ ] 2. `buildTimeline` / `dependenciesOf` を書く。
- [ ] 3. `reorderTimeline` を書く。**動かした後の並びで「すべてのフィーチャーの依存先が自分より前にある」かを確かめる**(1 件ずつ場当たりに判定せず、並び全体を検査する)。
- [ ] 4. `documentUpTo` / `insertPositionAt` を書く。
- [ ] 5. 検査を書く。
- [ ] 6. `model/src/index.ts` へ輸出を足す(**組 C: タスク2 の後**)。

**検証(期待値と導出):**

文書の例(以下すべて共通): 作業平面1 → スケッチ1 の面 → 押し出し1 → 穴1(押し出し1 が対象)→ R面取り1(穴1 が対象)→ 押し出し2(独立)。帯は `[作業平面1, 押し出し1, 穴1, R面取り1, 押し出し2]` の 5 件(通し 0〜4)。

| 検査 | 期待 | 導出 |
|---|---|---|
| `buildTimeline` の件数と `section` | 5 件、`['reference','solid','solid','solid','solid']` | references が先 |
| `dependenciesOf('R面取り1')` | `['穴1']` | `targetFeatureId` |
| `dependenciesOf('穴1')` | `['押し出し1']` | `targetFeatureId` と面の `SubShapeRef.bodyFeatureId` |
| `dependenciesOf('押し出し2')` | `[]` | 独立 |
| 穴1 と R面取り1 を入れ替え | `ok: false`、`blockingFeatureId` = `'R面取り1'`、理由に「穴1」の名前を含む | R面取り1 が穴1 を参照 |
| 押し出し2 を穴1 の前へ | `ok: true` | 独立 |
| 押し出し1 を押し出し2 の後ろへ | `ok: false` | 穴1 が押し出し1 を参照 |
| ブーリアン(押し出し1 + 押し出し2)がある文書で押し出し2 をブーリアンの後ろへ | `ok: false` | `toolFeatureId` |
| 作業平面1 を押し出し1 の後ろへ | `ok: false` | スケッチ1 が作業平面1 の上にある |
| 投影(押し出し1 を投影)を含むスケッチを使う押し出し3 を押し出し1 の前へ | `ok: false` | **立体 → スケッチ → 立体の経路**(最も見落としやすい) |
| `documentUpTo(document, 2)` | `references` 1 件、`solids` 2 件(押し出し1、穴1) | 通し 0,1,2 の 3 件 |
| `documentUpTo(document, null)` | 文書そのもの(`===` で同じ) | 複製を作らない |
| `documentUpTo(document, 0)` | `references` 1 件、`solids` 0 件 | |
| `documentUpTo` の後の `solids[0]` | 元の `solids[0]` と `===` | **形状キャッシュの鍵を変えない** |
| `insertPositionAt(document, 2, 'solid')` | `2` | 通し 2 は solids の 1 番目なので、その次 |
| `insertPositionAt(document, null, 'solid')` | `4` | 末尾 |
| 抑制された段を含む帯 | 抑制された段も出る(`suppressed: true`) | FR-503。抑制は削除ではない |
| 100 フィーチャーの並べ替えの判定 | 20ms 以内、実測を報告 | 依存グラフの構築 O(件数 × 欄数) |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/model run test` | 全件緑。**25 件以上増える** |

**受け入れ条件:** 手順1 で数えた「他のフィーチャーを指す欄」がすべて `dependenciesOf` に反映されている。断りの理由に**相手のフィーチャーの名前が入る**(FR-504、NFR-UX-5)。

**落とし穴:**
- **スケッチをまたぐ依存(立体 → スケッチ → 立体)を忘れやすい。** P4 の投影・交差(FR-325)で、スケッチが立体を参照する経路ができている(`SketchProjectedCurveFeature.source` の `bodyFeatureId`)。この経路を通した依存が最も見落とされる。
- **`documentUpTo` は形状キャッシュの鍵を変えてはいけない。** `solids` の配列を切るだけで、中身のフィーチャーは複製しない(`===` を保つ)。複製すると鍵が変わり、巻き戻すたびに全段が再計算になる(NFR-PF-3 に反する)。
- **`documentUpTo` の切り方は抑制を無視して通し番号で切る**(帯の見た目と一致させるため)。

---

### タスク10: `ui` のパラメータ表の操作の純関数

**先行タスク:** 3
**対応要件:** FR-207、NFR-UX-5
**関係する過去の失敗:** 該当なし。
**必要なヘルプ文書:** なし(タスク11 で書く)

**ファイル:**
- 新規: `packages/ui/src/parameters/parameterCommands.ts`
- 新規: `packages/ui/src/parameters/parameterCommands.test.ts`
- 変更: `packages/ui/src/i18n/ja.json`(断りの文言。**並列の相手が触っていないことを確かめてから足す**)

**実装内容:**

DOM にも React にも触れない純関数だけを置く(`numericInput.ts` と同じ流儀。§1.3)。文言は `MessageKey` で返す。

```ts
export type ParameterCommandOutcome =
  | { readonly ok: true; readonly document: PartDocument }
  | { readonly ok: false; readonly messageKey: MessageKey }
  /** 限界値や参照元の名前を差し込む文が要るとき(describeRange と同じ事情)。 */
  | { readonly ok: false; readonly message: string };

export function commitAddParameter(document: PartDocument, name: string, source: string): ParameterCommandOutcome;
export function commitRemoveParameter(document: PartDocument, name: string): ParameterCommandOutcome;
export function commitRenameParameter(document: PartDocument, from: string, to: string): ParameterCommandOutcome;
export function commitEditParameter(document: PartDocument, name: string, patch: Partial<Parameter>): ParameterCommandOutcome;
export function commitReorderParameters(document: PartDocument, from: number, to: number): ParameterCommandOutcome;
```

- どの関数も **`applyParameters`(タスク3)を最後に通してから返す**。文書の全式が新しい変数表で評価し直された状態になる。
- 断る条件:

| 操作 | 断る条件 | 文言 |
|---|---|---|
| 追加・改名 | `checkVariableName` が理由を返す | 「名前は数字で始められません」「その名前は使えません(計算に使う言葉です)」「名前に使えない文字が入っています」 |
| 追加・改名 | 同じ名前がすでにある | 「その名前はすでにあります」 |
| 削除 | `referencesTo` が空でない | 「この名前は 3 か所から使われています。先にそちらを直してください。」(**件数を差し込む**) |
| 値の書き換え | 式が読めない | 既存の式の欄の赤表示に任せる(ここでは断らない) |

**手順:**

- [ ] 1. `numericInput.ts` の文言の返し方(`MessageKey` と `describeRange`)と、`referenceCommands.ts` / `shapeCommands.ts` の確定の書き方を Read してなぞる。`ja.json` を並列の相手が触っていないことを確かめる。
- [ ] 2. 5 つの確定関数を書く。
- [ ] 3. 検査を書く。

**検証(期待値と導出):**

| 検査 | 期待 | 導出 |
|---|---|---|
| `commitAddParameter(doc, '板厚', '3')` | `ok: true`、`parameters` に 1 件、値 3 | |
| 続けて `commitAddParameter(doc, '穴径', '板厚 * 2')` | 値 6 | 3 × 2 |
| 続けて `commitEditParameter(doc, '板厚', { value: '5' })` | 穴径の値が 10、**押し出しの距離 `'板厚 * 2'` の値も 10** | `applyParameters` を通す |
| `commitAddParameter(doc, '板厚', '4')`(重複) | `ok: false`、「その名前はすでにあります」 | |
| `commitAddParameter(doc, '2倍', '3')` | `ok: false`、「名前は数字で始められません」 | `checkVariableName` |
| `commitAddParameter(doc, 'sqrt', '3')` | `ok: false`、「計算に使う言葉です」 | 予約語 |
| `commitRemoveParameter(doc, '板厚')`(穴径が参照) | `ok: false`、文に「1 か所」を含む | `referencesTo` |
| `commitRemoveParameter(doc, '穴径')`(誰も参照しない) | `ok: true` | |
| `commitRenameParameter(doc, '板厚', '板の厚み')` | 穴径の式が `'板の厚み * 2'`、値 6 のまま | タスク1・2 |
| `commitRenameParameter(doc, '板厚', '穴径')`(重複) | `ok: false` | |
| `commitReorderParameters(doc, 0, 2)` | 並びが変わり、値は変わらない | 評価は依存順 |
| 循環を作る書き換え(`A = 'B + 1'` があるところへ `B = 'A + 1'`) | `ok: true`(**断らない**)、`analysis.circular` に 2 件 | FR-207 は「循環している名前を画面上で示す」であり、作らせない、ではない |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/ui run test` | 全件緑。**20 件以上増える** |

**受け入れ条件:** 5 つの確定関数がすべて `applyParameters` を通した文書を返す(値の追従が確定の中で起きる)。断りが `ja.json` の文言で返る。

**落とし穴:**
- **循環を作ることは断らない。** 途中で必ず循環する瞬間があるので(A を作り B を作る間)、断ると表が編集できなくなる。**印を出すだけ**にする。
- **`applyParameters` は文書全体を歩くので、1 文字打つごとに呼ぶと重い。** 呼ぶのは確定(Enter / フォーカスが外れる)のときだけにし、打っている途中は式の欄の評価(1 本だけ)にとどめる。これはタスク11 の配線の責任。

---

### タスク11: `ui` のパラメータ表のパネルと配線

**先行タスク:** 10
**対応要件:** FR-207、FR-201、FR-502
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-04 15:40(P4 タスク2 の仕上げ③。**文書がまるごと差し替わったとき、焦点のある欄が書きかけの値を保持して古い値を見せ続ける**。`documentVersion` と `fieldDraft.reconcileDraftVersion` で解決済み)。**パラメータの表も同じ問題を持つので、`reconcileDraftVersion` を必ず使う。**
**必要なヘルプ文書:** `parameters.md`(新規)

**ファイル:**
- 新規: `packages/ui/src/parameters/ParameterPanel.tsx`
- 変更: `packages/ui/src/shell/PropertyPanel.tsx`(タブ。**§0.15 の決定次第**)
- 変更: `packages/ui/src/store/useAppStore.ts`(`parameterAnalysis` の控えと確定の口)
- 変更: `packages/ui/src/store/useAppStore.test.ts`
- 変更: `packages/ui/src/i18n/ja.json`
- 変更: `packages/ui/src/shell/appShell.css`
- 新規: `packages/help-content/docs/ja/parameters.md`
- 変更: `packages/help-content/src/index.ts`(目録 25 → 26)

**実装内容:**

- ストアに `parameterAnalysis: ParameterAnalysis` の控えを持つ(**文書から導けるので保存しない**。`resolvedReferences` と同じ扱い)。`applyDocument` の中で作り直す。
- **式の欄が変数表を使えるようにする。** 実測した `ExpressionField.tsx`(95 行)と `numericInput.ts` の `evaluateExpression` の呼び出しに `{ variables }` を渡す。**渡し忘れると「表では 6 なのに欄では unknownVariable」という食い違いが起きる**ので、手順1 で `evaluateExpression(` の呼び出しをすべて Grep して数え、報告する。
- 表の列は **名前・式・値・単位・説明**(FR-207)。値は読み取り専用(式から導かれる)。
- 循環の行は赤く、未使用の名前には薄い印。行の右に「使われている数」を出す。
- 追加は表の下の「+」、削除は行の右の「×」、改名は名前の欄をその場で編集。
- **確定は 1 つの Undo**(`applyDocument`)。1 文字ごとの書き換えは `coalesceKey`(`パラメータ:板厚:式` の形)で 1 段にまとめる(`UNDO_COALESCE_MS = 800`)。

**手順:**

- [ ] 1. `PropertyPanel.tsx`(693 行)と `ExpressionField.tsx`、`fieldDraft.ts` を Read する。**`evaluateExpression(` の呼び出しを `packages/ui/**` で Grep して数え、報告する**(変数表を渡す先の一覧)。§0.15 の決定を確かめる。
- [ ] 2. ストアに `parameterAnalysis` と確定の口を足す。
- [ ] 3. `ParameterPanel.tsx` を書く。**`useState` は表示専用の一時状態(開いているタブ、編集中の行)だけ**(`rules/04`)。
- [ ] 4. 手順1 で数えた `evaluateExpression` の呼び出しすべてに変数表を渡す。
- [ ] 5. `parameters.md` を書く。**内部用語(トポロジカルソート、変数表、依存グラフ)を出さない**(`rules/05` §11.3)。
- [ ] 6. 検査を書く。

**検証(期待値と導出):**

| 検査 | 期待 | 導出 |
|---|---|---|
| ストアで `板厚 = 3` を足し、押し出しの距離を `'板厚 * 2'` にする | 距離の表示が `6` | 3 × 2 |
| `板厚` を 5 にする | 距離の表示が `10`、**立体の再計算が走る** | FR-502 |
| 1 文字ずつ `3` → `35` → `5` と打つ | Undo 1 回で `3` に戻る | `coalesceKey` |
| 循環を作る | 2 行が赤く、値は据え置き、アプリは落ちない | FR-504 |
| 未使用の名前 | 薄い印が出る | FR-207 |
| 参照されている名前を消そうとする | 断りの文が出て消えない | タスク10 |
| ファイルを開き直す(`documentVersion` が進む) | 表の編集中の書きかけが捨てられ、保存済みの値が出る | `reconcileDraftVersion`(過去の失敗) |
| `evaluateExpression` の呼び出しのうち変数表を渡している数 | 手順1 で数えた数と一致 | **配線もれの検出** |
| 区画の数 | 5 のまま | `rules/04` |
| ヘルプの目録 | 26 件、`topics.test.ts` が緑 | 25 + 1 |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/ui run test` | 全件緑。**15 件以上増える** |
| `pnpm --filter @pointercad/help-content run test` | 全件緑 |

**受け入れ条件:** 「板厚 = 3、穴径 = 板厚 * 2 で、板厚を 5 にすると穴径が 10、その穴径を使った穴の直径も 10 になる」が画面の操作で確かめられる(統括の目視は §5)。手順1 で数えた `evaluateExpression` の呼び出しにすべて変数表が渡っている。

**落とし穴:**
- **`ja.json` は並列の相手も触る。** 足す前に確かめ、報告に書く(§4)。
- **表の中の日本語を `.tsx` へ直書きしない**(`i18n.test.ts` が落とす)。ただし**利用者が付けた名前(「板厚」)は文言ではなくデータ**なのでそのまま出してよい。
- **1 文字打つごとに `applyParameters`(文書全体を歩く)を呼ばない**(タスク10 の落とし穴)。

---

### タスク12: `ui` の拘束を付ける・消すコマンドと要約の純関数

**先行タスク:** 8
**対応要件:** FR-313、NFR-UX-1、NFR-UX-5
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-04 11:10 の (b)(条件が揃っていないとき道具を押しても種類が変わらず、理由も出なかった)。**「押したら必ず何かが起きる(できないなら理由が出る)」を守る。**
**必要なヘルプ文書:** なし(タスク13 で書く)

**ファイル:**
- 新規: `packages/ui/src/sketch/constraintCommands.ts`
- 新規: `packages/ui/src/sketch/constraintCommands.test.ts`
- 新規: `packages/ui/src/sketch/constraintSummary.ts`
- 新規: `packages/ui/src/sketch/constraintSummary.test.ts`
- 変更: `packages/ui/src/i18n/ja.json`

**実装内容:**

```ts
/** 選ばれている要素から、その拘束を付けられるか。ツールバーのボタンの入り切りに使う。 */
export interface ConstraintReadiness {
  readonly ready: boolean;
  /** 付けられない理由。ready のときは null。 */
  readonly messageKey: MessageKey | null;
}
export function constraintReadiness(
  resolved: ResolvedSketch,
  selection: readonly string[],
  kind: SketchConstraintKind,
): ConstraintReadiness;

/** 選ばれている要素から拘束を作って足す。数値を聞くもの(距離・角度・半径・直径)は
 *  numericInput の段を経由するので、その段の確定値を受け取る形にする。 */
export function commitConstraint(
  document: SketchDocument,
  resolved: ResolvedSketch,
  selection: readonly string[],
  kind: SketchConstraintKind,
  size?: ExpressionValue,
): { ok: true; document: SketchDocument } | { ok: false; messageKey: MessageKey };

export function removeConstraint(document: SketchDocument, constraintId: string): SketchDocument;

/** 一覧・印に出す要約(FR-501 と同じ流儀)。 */
export interface ConstraintSummary {
  readonly id: string;
  readonly label: string;      // 「直角1」
  readonly detail: string;     // 「線分1 と 線分2」
  readonly symbol: string;     // 印の記号の鍵(図柄は icons.tsx)
  /** 印を置く画面上の位置のもと(ワールド座標)。 */
  readonly anchors: readonly Vec3[];
  readonly state: 'ok' | 'conflicting' | 'redundant' | 'dangling';
}
export function summarizeConstraints(
  document: SketchDocument,
  resolved: ResolvedSketch,
  diagnosis: ConstraintDiagnosis,
): readonly ConstraintSummary[];
```

選択の要件(NFR-UX-1「対象を選んでから操作」「操作を選んでから対象」のどちらでも成立させる):

| 拘束 | 選ぶもの | 数値を聞くか |
|---|---|---|
| 一致 | 点 2 つ | いいえ |
| 水平 / 垂直 | 線分 1 本、または点 2 つ | いいえ |
| 平行 / 直角 / 等しい | 線分 2 本(等しいは円 2 つも) | いいえ |
| 接線 | 線分 1 本+円/円弧 1 つ | いいえ |
| 同心 | 円/円弧 2 つ | いいえ |
| 対称 | 点 2 つ+線分 1 本(軸) | いいえ |
| 固定 | 点 1 つ以上 | いいえ |
| 距離 | 点 2 つ、または線分 1 本(その長さ) | **はい**(既定値は現在の距離) |
| 角度 | 線分 2 本 | **はい**(既定値は現在の角度) |
| 半径 / 直径 | 円/円弧 1 つ | **はい**(既定値は現在の半径/直径) |

- **既定値は「いま測った値」**(NFR-UX-4「Enter 連打だけでも意味のある結果になる」)。距離拘束を付けて Enter だけ押すと、いまの距離のまま固まる。
- 名前は `nextSerialName`(`createSketchDocument.ts:86`)と同じ流儀で「直角1」「距離2」。

**手順:**

- [ ] 1. `sketchCommands.ts` / `shapeCommands.ts` / `solidCommands.ts` の `solidToolReadiness` を Read し、「選択から可否を判定する」書き方をなぞる。`pickMath.ts` の `elementId` の規約(`featureId#n`)も確かめる。
- [ ] 2. `constraintReadiness` を書く(13 種)。
- [ ] 3. `commitConstraint` / `removeConstraint` を書く。
- [ ] 4. `constraintSummary.ts` を書く。
- [ ] 5. 検査を書く。

**検証(期待値と導出):**

| 検査 | 期待 | 導出 |
|---|---|---|
| 線分 2 本を選んで `perpendicular` | `ready: true` | |
| 線分 1 本を選んで `perpendicular` | `ready: false`、「線を 2 本選んでください」 | |
| 円 2 つを選んで `equal` | `ready: true` | 等しいは線分でも円でもよい |
| 線分 1 本と円 1 つを選んで `equal` | `ready: false`、「同じ種類のものを 2 つ選んでください」 | |
| 何も選ばずに `horizontal` | `ready: false`、「線を 1 本、または点を 2 つ選んでください」 | |
| 線分 (0,0)–(3,4) を選んで距離拘束 | 既定値が `5` | √(9+16) |
| 円(半径 7)を選んで直径拘束 | 既定値が `14` | 2 × 7 |
| 線分 (0,0)–(10,0) と (0,0)–(0,10) を選んで角度拘束 | 既定値が `90` | 直角 |
| `commitConstraint` で足した拘束の名前 | 「直角1」、2 つ目は「直角2」 | `nextSerialName` |
| 構築線を選んで拘束 | `ready: true`(**構築線にも拘束を付けられる**) | FR-320 の構築線は「対称の基準や当たり取りに使う」ので拘束の対象になる |
| 3D スケッチの要素を選んで拘束 | `ready: false`、「3D スケッチでは拘束を使えません」 | §0.3 |
| `summarizeConstraints` の `state` | 診断の `conflicting` / `redundant` / `dangling` が反映される | タスク7 |
| 水平拘束の `anchors` | 線分の中点 1 つ | 印を線の真ん中に置く |
| 一致拘束の `anchors` | 一致させた点 1 つ | |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/ui run test` | 全件緑。**30 件以上増える** |

**受け入れ条件:** 13 種すべてで、選択の条件と断りの文言が上の表と一致する。既定値が「いま測った値」になる。

**落とし穴:**
- **「押したら必ず何かが起きる」**(過去の失敗)。条件が揃っていなくても、押したら理由が帯に出るようにする(タスク13 の配線)。
- **選択の順序に意味を持たせない拘束と、持たせる拘束を分ける。** 接線(線分+円)と対称(点 2 つ+軸)は**種類で見分ける**ので順序は不問。角度は「1 本目から 2 本目へ測る」ので順序が意味を持つ。**どちらかを報告に明記する。**
- 拘束は `SketchDocument` に属するので、**選ばれた要素が別のスケッチのものだったら断る**(複数スケッチの文書で起きる)。

---

### タスク13: `ui` の拘束の印・自由度・一覧の表示と配線

**先行タスク:** 12、11
**対応要件:** FR-313、NFR-UX-7、FR-504
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-04 18:30(P4 タスク12。**担当が見つけて直した欠落 3 件 ── 描画・当たり判定・面の囲みが新しい種類を扱っていなかった**)。**新しく描くものを足すときは、描画・当たり判定・選択の 3 つを必ず揃える。**
**必要なヘルプ文書:** `constraints.md`(新規)

**ファイル:**
- 新規: `packages/ui/src/viewport/createConstraintLayer.ts`
- 変更: `packages/ui/src/viewport/createSketchLayer.ts`(自由/完全拘束の色分け。**§0.7 の決定次第**)
- 変更: `packages/ui/src/store/useAppStore.ts`(`constraintDiagnosis` の控え、拘束の確定の口)
- 変更: `packages/ui/src/shell/Toolbar.tsx`(拘束の畳んだ一覧)
- 変更: `packages/ui/src/shell/icons.tsx`(13 種+一覧の図柄)
- 変更: `packages/ui/src/shell/statusText.ts`(自由度の案内、断り)
- 変更: `packages/ui/src/i18n/ja.json`
- 新規: `packages/help-content/docs/ja/constraints.md`
- 変更: `packages/help-content/src/index.ts`(目録 26 → 27)

**実装内容:**

- **ツールバー**: P4 タスク32 の「図柄付きの畳んだボタン」(`toolbarMenus.ts` の `SHAPE_MENU_ITEMS` / `EDIT_MENU_ITEMS` と同じ形)で「拘束 ▾」を 1 つ足す。**区画は増やさず**、スケッチ区画の畳んだ一覧を 2 つ(作図・編集)から 3 つ(作図・編集・拘束)にする。**幅を実測し、1440px で 1 段(68.5px)に収まることを確かめる**(`segmentedWidthPixels`。P4 の完了条件 12)。
- **印**: `createConstraintLayer.ts` が `ConstraintSummary.anchors` の位置へ小さな記号を描く。**ビルボード**(常に画面を向く)にして、視点を回しても読めるようにする。色はテーマのトークン(`themeColors.ts`)。
- **色分け**: 自由に動く要素は青、完全に拘束された要素は既定色(§0.7 の②)。判定は `ConstraintDiagnosis.degreesOfFreedom` ではなく**要素ごと**に必要なので、`frozen` と「その要素の変数がすべて拘束の式に現れるか」で決める。**単純には決まらないので、①スケッチ全体の自由度が 0 なら全部を完全拘束の色、②そうでなければ `frozen` の要素だけを完全拘束の色、の 2 段の近似にする**(実装の負担と分かりやすさの釣り合い。**この近似を報告に明記する**)。
- **自由度**: ステータスバーの帯に「あと N か所決まっていません」/「すべて決まりました」(§0.7 の③)。`statusText.ts` の `describeStatus` へ 1 分岐足す。
- **一覧**: 拘束の一覧は**プロパティパネル**に出す(スケッチが選ばれているとき)。区画を増やさない。行をクリックすると印が光り、「×」で消せる。

**手順:**

- [ ] 1. `Toolbar.tsx` の畳んだ一覧の作り(`ToolMenuItem` / `triggerItemOf` / `rememberRecentTool`)、`createSketchLayer.ts` の色の付け方、`statusText.ts` の `describeStatus` を Read する。**ツールバーの幅をヘッドレスで実測してから足す**(P4 タスク32 の手順)。
- [ ] 2. `icons.tsx` へ 13 種の図柄を足す。
- [ ] 3. `createConstraintLayer.ts` を書く。**描画・当たり判定(印をクリックして選ぶ)・選択の 3 つを揃える**(過去の失敗)。
- [ ] 4. ストアへ控えと確定の口を足す。
- [ ] 5. `statusText.ts` へ自由度の案内を足す。
- [ ] 6. `constraints.md` を書く。**内部用語(ソルバー、残差、自由度の「次元」、ヤコビアン)を出さない。**「あと何か所決まっていないか」は利用者に見える言葉なので書いてよい。
- [ ] 7. 検査を書く。ヘッドレスで撮影し、統括へ渡す(**保存先はスクラッチパッドの絶対パス**)。

**検証(期待値と導出):**

| 検査 | 期待 | 導出 |
|---|---|---|
| ツールバーの幅(1440px、拘束の一覧を足した後) | **1 段(68.5px)** | P4 の完了条件 12。畳んだボタンは 1 つぶん(31px)しか増えない |
| 拘束の一覧を開く | 13 種が図柄+名前で並ぶ | P4 タスク32 と同じ形 |
| 線分 2 本を選んで「直角」 | 拘束が付き、形が整い、印が 2 か所に出る | |
| 線分 1 本だけを選んで「直角」 | 帯に「線を 2 本選んでください」、形は変わらない | 過去の失敗の再発防止 |
| 自由度の表示(線分 1 本、拘束なし) | 「あと 4 か所決まっていません」 | タスク7 |
| 全部決まった矩形 | 「すべて決まりました」 | |
| 矛盾する拘束 | 帯が赤く理由が出て、原因の拘束が一覧で赤い | FR-504 |
| 印をクリック | その拘束が一覧で選ばれる | 当たり判定(過去の失敗) |
| 一覧の「×」 | 拘束が消え、形が緩む(Undo 1 回で戻る) | NFR-UX-3 |
| 5 テーマすべてで印が読める | 背景と 3:1 以上の明度差 | §0.14 と同じ基準 |
| ヘルプの目録 | 27 件、`topics.test.ts` が緑 | |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/ui run test` | 全件緑。**20 件以上増える** |

**受け入れ条件:** ツールバーが 1440px で 1 段のまま。印の描画・当たり判定・選択が揃っている。区画が 5 つのまま。

**落とし穴:**
- **印が増えると 3D の描画が重くなる。** 拘束が 200 個あれば印も 200 個。**1 つの `InstancedMesh` か 1 枚のスプライトの集合にまとめる**(個別の `Mesh` を 200 個作らない。NFR-PF-1 の 60fps)。
- **色分けの近似を利用者向けの文書に書かない**(内部の都合)。ヘルプには「まだ動かせるところは青く見えます」とだけ書く。
- **`ja.json` / `icons.tsx` / `Toolbar.tsx` は ui の鎖の共有ファイル。** タスク11 のコミットが HEAD に載ってから書き込む。

---

### タスク14: `ui` の要素を引っぱると追従(ドラッグ)

**先行タスク:** 13
**対応要件:** FR-313(「要素を動かすと条件を保ったまま追従」)、NFR-UX-2、NFR-PF-1
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-04 20:30(P4 タスク14。**頂点で終点を決めた線分が長さ 0 になる不具合**。確定のときに「どの点を書き換えるか」を取り違えた)。**書き換える対象を実測で確かめる。**
**必要なヘルプ文書:** `constraints.md`(タスク13 と同じファイルへ追記)

**ファイル:**
- 新規: `packages/ui/src/viewport/dragSketch.ts`
- 新規: `packages/ui/src/viewport/dragSketch.test.ts`
- 変更: `packages/ui/src/viewport/attachSketchInteraction.ts`
- 変更: `packages/ui/src/store/useAppStore.ts`(ドラッグ中の一時的な解、確定の口)
- 変更: `packages/ui/src/i18n/ja.json`
- 変更: `packages/help-content/docs/ja/constraints.md`(追記)

**実装内容:**

```ts
/** 引っぱっている最中の状態(表示専用。文書は変えない)。 */
export interface SketchDrag {
  /** 引っぱっている点の鍵(vertexKey / ResolvedPoint.id の規約)。 */
  readonly pointKey: string;
  /** そのフィーチャーの id と、書き換える欄(確定のときに使う)。 */
  readonly featureId: string;
  readonly field: 'at' | 'from' | 'to' | 'center';
  /** 押した瞬間の作図面上の位置。 */
  readonly startUv: readonly [number, number];
}

/** 引っぱれるか。式で書かれた点・固定された点・導かれる点は引っぱれない。 */
export function draggableAt(
  document: SketchDocument,
  variableSet: VariableSet,
  elementId: string,
): SketchDrag | { readonly reason: 'expression' | 'fixed' | 'derived' } | null;

/** 引っぱっている間の解。一時的な固定を足して解き直す(文書は変えない)。 */
export function solveWithDrag(
  document: SketchDocument,
  drag: SketchDrag,
  targetUv: readonly [number, number],
  options?: SketchResolveOptions,
): ConstrainedSketch;

/** 離したときの確定。引っぱった点の座標だけを書き換える(Undo 1 段)。 */
export function commitDrag(
  document: SketchDocument,
  drag: SketchDrag,
  solution: ReadonlyMap<string, Vec3>,
): SketchDocument;
```

- ドラッグ中は `document` を作り替えない(`pointermove` ごとに Undo の段が増えるのを防ぐ)。ストアに `sketchDrag` と `dragResolved` の表示専用の状態を置く。
- `commitDrag` の書き換えは **`exactExpressionValueFromNumber`**(丸めない)を使う(§2.3)。
- 書き換える欄は `field` で決める(`point.at` / `line.from` / `line.to` / `arc.center`)。**線分の終点を引っぱったのに始点を書き換える、といった取り違えを検査で固定する**(過去の失敗)。

**手順:**

- [ ] 1. `attachSketchInteraction.ts`(873 行)の押す・動かす・離すの流れと、`pickMath.ts` の当たり判定、`commitToStore.ts` の確定の入口を Read する。**`elementId` から「どのフィーチャーのどの欄か」を引く既存の道具があるかを Grep し、無ければ作る**(あれば使う)。
- [ ] 2. `dragSketch.ts` を書く。
- [ ] 3. `attachSketchInteraction.ts` へ配線する。**選択の道具のときだけ**引っぱれるようにする(作図中の道具ではポインタは点を置く)。
- [ ] 4. ストアへ表示専用の状態を足す。
- [ ] 5. `constraints.md` へ「引っぱって形を変える」の節を追記する。
- [ ] 6. 検査を書く。**ドラッグ中の 1 フレームの所要を実測して報告する。**

**検証(期待値と導出):**

| 検査 | 期待 | 導出 |
|---|---|---|
| 水平拘束の線分 (0,0)–(10,0)、終点を (14, 6) へ引っぱる | 終点が `(14, 0)`、始点は動かない | 水平が保たれる |
| 上で始点を (−3, 5) へ引っぱる | 始点 `(−3, 5)`、**終点も `(14, 5)` へ動く** | 水平は「2 点の v が等しい」なので終点が追従(最小移動) |
| 水平+長さ 10 の線分、終点を (30, 6) へ引っぱる | 終点が `(10, 0)` のまま(長さが固定されているので動かない)、始点が `(20, 0)` へ動く…**担当が実測して固定し、導出を報告に書く** | 最小移動の解が「どちらが動くか」を決めるため |
| 式で書かれた点を引っぱる | 引っぱれない。帯に「この点は式で決まっているので動かせません」 | §0.2 |
| `fix` 拘束の点を引っぱる | 引っぱれない。帯に「この点は固定されています」 | |
| 点列の n 番目を引っぱる | 引っぱれない。帯に「点列の点は基準と間隔で決まります」 | `'derived'` |
| 線分の終点を引っぱって離す | `line.to` だけが書き換わり、`line.from` は `===` で同じ | **過去の失敗の再発防止** |
| 離した後の `source` | 丸めない 10 進表記(`exactExpressionValueFromNumber`) | §2.3 |
| 離した後の Undo | 1 回で元の位置に戻る | NFR-UX-3 |
| ドラッグ中に文書が変わらない | `document` が `===` で同じ | Undo の段が増えない |
| ドラッグ中の 1 フレーム(変数 100) | **16ms 以内**、実測を報告 | NFR-PF-1(60fps) |
| 拘束が 0 個のスケッチで点を引っぱる | ふつうに動く(拘束の計算は走らない) | 拘束が無い文書の性能を落とさない |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/ui run test` | 全件緑。**20 件以上増える** |

**受け入れ条件:** 引っぱると拘束を保ったまま追従し、離すと引っぱった点の座標だけが書き換わる。式・固定・導かれる点は引っぱれず理由が出る。

**落とし穴:**
- **「長さ 10 が固定された線分の終点を引っぱるとどちらが動くか」は最小移動の解が決める。** 直感と合わないことがあるので、**担当が実測して期待値を固定し、その挙動を報告に書く**(推測で期待値を書かない)。合わなければ「引っぱっている点の重みを上げる」(その点の一時的な固定の残差に大きな重みを掛ける)方法を検討し、統括へ提案する。
- **`pointermove` ごとに `resolveSketch` を 2 回呼ぶ。** 拘束が多いスケッチでは 16ms を超えうる。**超えたら `requestAnimationFrame` で間引く**(毎回解かず、フレームごとに最後の位置だけ解く)。実測して報告する。
- **ドラッグ中はカーネル(面のテッセレーション)を呼ばない。** 面が張られたスケッチを引っぱるたびに Worker を往復すると確実に間に合わない。離したときだけ再計算する。

---

### タスク15: `ui` の向きの吸着の純関数(極・直交・延長線・垂線・平行線)

**先行タスク:** なし
**対応要件:** FR-110
**関係する過去の失敗:** 該当なし。`snapMath.ts` 冒頭の注釈「判定はワールド座標ではなく**画面座標**で行う。ワールド座標で測ると、遠くにある要素にも近くの要素と同じ距離で吸い付いてしまう」を守る。
**必要なヘルプ文書:** なし(タスク16 で書く)

**ファイル:**
- 新規: `packages/ui/src/sketch/trackMath.ts`
- 新規: `packages/ui/src/sketch/trackMath.test.ts`
- 変更: `packages/ui/src/i18n/ja.json`(案内の文言)

**実装内容:**

```ts
export type TrackKind = 'polar' | 'extension' | 'perpendicular' | 'parallel';

export interface TrackCandidate {
  readonly kind: TrackKind;
  /** 案内線が通る点(ワールド座標、作図面の上)。 */
  readonly origin: Vec3;
  /** 案内線の向き(単位ベクトル、作図面の上)。 */
  readonly direction: Vec3;
  /** どの要素から来た候補か。極だけ null。 */
  readonly sourceFeatureId: string | null;
  /** 極の候補の角度(度)。他は null。案内の文言に出す。 */
  readonly angleDegrees: number | null;
}

export interface TrackResult {
  /** 吸い付いた位置。 */
  readonly position: Vec3;
  /** 採った案内線(1 本か、交点なら 2 本)。 */
  readonly candidates: readonly TrackCandidate[];
}

/** 刻み角度の候補(§0.12)。 */
export const TRACK_ANGLE_STEPS: readonly number[] = [5, 10, 15, 30, 45, 90];
export const DEFAULT_TRACK_ANGLE_STEP = 15;

/** ポインタに最も近い極の向きを 1 本だけ作る(24 本を全部作らない)。 */
export function polarCandidate(
  plane: WorkPlane,
  origin: Vec3,
  pointOnPlane: Vec3,
  stepDegrees: number,
): TrackCandidate | null;

/** 既存の要素から、延長線・垂線・平行線の候補を集める。 */
export function collectTrackCandidates(
  sketch: ResolvedSketch,
  plane: WorkPlane,
  origin: Vec3 | null,
  pointOnPlane: Vec3,
  stepDegrees: number,
  enabled: ReadonlySet<TrackKind>,
): readonly TrackCandidate[];

/** 画面距離で 1〜2 本を選び、吸い付く位置を返す。2 本採れたらその交点。 */
export function chooseTrack(
  candidates: readonly TrackCandidate[],
  project: ProjectToScreen,
  pointer: readonly [number, number],
  radiusPixels: number,
  pointOnPlane: Vec3,
): TrackResult | null;
```

- `polarCandidate` は `origin` から `pointOnPlane` への向きの角度を測り、`Math.round(角度 / 刻み) * 刻み` へ丸めた 1 本だけを作る。
- 候補を作る前に**ポインタ近傍で粗く絞る**(§2.9)。線分の両端・中点のいずれかが画面上でポインタから 200 画素以内のものだけを対象にする。**この 200 という数は担当が実測して決め、報告に書く**(狭すぎると吸着が効かず、広すぎると遅い)。
- `chooseTrack` は、判定半径内の候補のうち §0.13 の優先順位で 1 本目を採り、**その線の上でポインタに最も近い点**を求める。2 本目が別の種類で採れて、かつ 2 本が平行でなければ**交点**を返す。

**手順:**

- [ ] 1. `snapMath.ts`(217 行)を Read し、`ProjectToScreen` の形・画面距離の測り方・`SNAP_RADIUS_PIXELS` をなぞる。`planeMath.ts` の `worldToPlane` / `planeToWorld` / `directionInPlane` を確かめる。
- [ ] 2. `polarCandidate` を書く。
- [ ] 3. `collectTrackCandidates` を書く(延長線・垂線・平行線)。
- [ ] 4. `chooseTrack` を書く(交点を含む)。
- [ ] 5. 検査を書く。**候補集めの所要を実測して報告する。**

**検証(期待値と導出):**

すべて作図面 XY 上、`project` は「(x, y) をそのまま画面座標にする」検査用の関数(1mm = 1 画素)を渡す。

| 検査 | 期待 | 導出 |
|---|---|---|
| 極: 起点 (0,0)、刻み 15°、ポインタ 20∠17° = (19.126,5.848) | 吸着位置 `(19.318516526, 5.176380902, 0)`、角度 `15` | 20cos15° = 19.318516526、20sin15° = 5.176380902 |
| 極: 刻み 15°、ポインタの角度 7.4° | 角度 `0` | 7.5° 未満は 0 へ丸まる |
| 極: 刻み 15°、ポインタの角度 7.6° | 角度 `15` | |
| 極: 刻み 15°、ポインタの角度 88°、距離 20 | 吸着位置 `(0, 20, 0)`、角度 `90` | 90 は 15 の倍数 |
| 極: 刻み 90°、ポインタの角度 44° / 46° | 角度 `0` / `90` | 直交モード |
| 極: 起点が無い | `null` | 基準が無い |
| 極: 刻み 15°、ポインタの角度 −17°(= 343°) | 角度 `345` | 負の角も 0〜360 へ正規化 |
| 延長線: 線分 (0,0)–(10,0)、ポインタ (14, 0.3) | 吸着位置 `(14, 0, 0)`、`kind: 'extension'` | 延長線 v=0 へ落とす |
| 延長線: ポインタ (14, 20) | 候補は作るが判定半径(12 画素)の外なので `chooseTrack` は `null` | 20 > 12 |
| 垂線: 線分 (0,0)–(10,0) の終点 (10,0) を通る垂線、ポインタ (10.2, 7) | 吸着位置 `(10, 7, 0)`、`kind: 'perpendicular'` | u=10 の直線へ落とす |
| 平行線: 線分 (0,0)–(10,10)、起点 (0,5)、ポインタ (6.2, 11) | 吸着位置 `(6.1, 11.1, 0)`、`kind: 'parallel'` | û=(1,1)/√2、d=(6.2,6)、(d·û)û=(6.1,6.1)、起点 (0,5)+(6.1,6.1) |
| 交点: 極 0°(起点 (0,0))と 線分 (5,−10)–(5,10) の延長線、ポインタ (5.1, 0.2) | 吸着位置 `(5, 0, 0)`、`candidates` が 2 本 | 2 本の交点 |
| 交点: 平行な 2 本 | 1 本目だけを採る(交点を作らない) | 平行 |
| 優先順位: 極と延長線が両方半径内 | 極を採る | §0.13 |
| `enabled` から `'polar'` を外す | 極の候補が作られない | 種別のフィルタ(FR-107 と同じ) |
| 候補集め(線分 200 本、うちポインタ近傍 10 本) | 4ms 以内、実測を報告 | §2.9(1 フレームの 1/4) |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/ui run test` | 全件緑。**30 件以上増える** |

**受け入れ条件:** 上の吸着位置がすべて期待値と 1e-9 以下で一致する。判定が画面座標で行われる(遠くの要素へ同じ距離で吸い付かない)。

**落とし穴:**
- **角度の丸めの境界(刻みの半分)で振動しないようにする。** ちょうど 7.5° のときにどちらへ丸めるかを決め打ちする(`Math.round` は 0.5 を上へ丸めるので 15° 側)。**決めた側を報告に書く。**
- **`origin`(極の起点)は「直前に置いた点」。** `attachSketchInteraction.ts` の `lastCreatedPoint`(実測 `:210`)がすでにこれを求めているので、**同じ関数を使う**(2 か所に書かない)。
- **円弧・楕円・スプラインからは延長線・垂線・平行線を作らない**(向きが 1 つに決まらない)。線分だけを対象にする。**この限定を報告に書く。**

---

### タスク16: `ui` の案内線の描画・入切・刻み角度の設定と配線

**先行タスク:** 15、14
**対応要件:** FR-110、NFR-UX-7、NFR-PF-1
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-04 15:40(P4 タスク2 の仕上げ①。**ビューキューブの面に固定色が焼き込まれていてテーマに追従しなかった**)。**案内線の色は必ず `themeColors.ts` から読む。**
**必要なヘルプ文書:** `tracking.md`(新規)

**ファイル:**
- 新規: `packages/ui/src/viewport/createTrackingLayer.ts`
- 変更: `packages/ui/src/sketch/snapMath.ts`(`SnapKind` に 4 種、`SNAP_PRIORITY`)
- 変更: `packages/ui/src/viewport/attachSketchInteraction.ts`(候補集めと選択の配線)
- 変更: `packages/ui/src/settings/settings.ts`(入切・刻み角度)
- 変更: `packages/ui/src/settings/SettingsPanel.tsx`(刻み角度の選択)
- 変更: `packages/ui/src/store/useAppStore.ts`(`trackIndicator`)
- 変更: `packages/ui/src/shell/statusText.ts`(案内の文言)
- 変更: `packages/ui/src/i18n/ja.json`
- 新規: `packages/help-content/docs/ja/tracking.md`
- 変更: `packages/help-content/src/index.ts`(目録 27 → 28)

**実装内容:**

- **`SnapKind` に 4 種を足す**(§0.13)。`SNAP_PRIORITY` の末尾へ `'polar'`, `'extension'`, `'perpendicular'`, `'parallel'` の順。`DEFAULT_SNAP_KINDS` は `SNAP_PRIORITY` そのままなので**既定で全部入**(§0.12 の推奨)。**ツールバーの `SnapKindsMenu`(実装済み)に 4 つの札が自動で増える**ので、一覧の作りは変えない。
- **刻み角度**は `settings.ts` の `DisplaySettings` へ `trackAngleStep: number` を足す(`localStorage` の 1 鍵、P4 タスク1)。設定ポップオーバーに 6 択のセグメントを足す。
- **案内線の描画**: `createTrackingLayer.ts` が採れた候補(最大 2 本)の線を描く。**破線**、色は `themeColors.ts` のトークン、長さは視錐台まで(§0.14)。ポインタが動くたびに位置を更新するが、**線の本数は最大 2 なので `Line` を 2 本だけ作って使い回す**(毎フレーム作り直さない。NFR-PF-1)。
- **案内の文言**: 帯に「15° に合わせています」「線分1 の延長線」「線分1 に垂直」「線分1 に平行」(NFR-UX-7)。`statusText.ts` の `describeStatus` に `trackIndicator` を足す(既存の `snapIndicator` と同じ扱い)。

**手順:**

- [ ] 1. `snapMath.ts` / `attachSketchInteraction.ts` / `settings.ts` / `SettingsPanel.tsx` / `themeColors.ts` / `statusText.ts` を Read する。**`SnapKind` を網羅している箇所を Grep して報告する**(P4 タスク4 の教訓と同じ。`SnapKindsMenu` の札の表・`ja.json` のキー・図柄が該当するはず)。
- [ ] 2. `SnapKind` に 4 種を足し、網羅箇所を直す。
- [ ] 3. `settings.ts` に `trackAngleStep` を足す(既定 15、範囲は `TRACK_ANGLE_STEPS`。壊れた値なら既定へ)。
- [ ] 4. `createTrackingLayer.ts` を書く。
- [ ] 5. `attachSketchInteraction.ts` へ配線する。**点の吸着(`chooseSnap`)を先に試し、採れなかったときだけ `chooseTrack` を試す**(§0.13 の優先順位)。
- [ ] 6. `statusText.ts` へ案内を足す。
- [ ] 7. `tracking.md` を書く。**内部用語(候補、判定半径、単位ベクトル)を出さない。**
- [ ] 8. 検査を書く。ヘッドレスで撮影(**スクラッチパッドの絶対パス**)。

**検証(期待値と導出):**

| 検査 | 期待 | 導出 |
|---|---|---|
| `SNAP_PRIORITY` の並び | `['endpoint','intersection','midpoint','center','grid','polar','extension','perpendicular','parallel']` | 点が先(§0.13) |
| `DEFAULT_SNAP_KINDS` の件数 | 9 | 5 + 4 |
| 端点と極が両方半径内 | 端点を採る | 優先順位 |
| 設定の `trackAngleStep` の既定 | `15` | §0.12 |
| `trackAngleStep` に `7` を入れる(範囲外) | 既定の `15` へ戻る | NFR-UX-4 |
| 再読込後 | 刻み角度が保たれる | `localStorage` |
| `SnapKindsMenu` の札 | 9 つ、4 つの新しい札が入切できる | 既存の作りのまま |
| 案内線の色 | 5 テーマすべてで背景と 3:1 以上の明度差、テーマを変えると即座に変わる | 過去の失敗(ビューキューブ) |
| 案内線の本数 | 最大 2 本。`Line` オブジェクトは 2 個のまま増えない | NFR-PF-1 |
| 帯の文言(極 15°) | 「15° に合わせています」 | NFR-UX-7 |
| 帯の文言(延長線) | 「線分1 の延長線」(**要素の名前が入る**) | NFR-UX-7 |
| 吸着を切る | 案内線も出ない | FR-107 の入切と揃える |
| ヘルプの目録 | 28 件、`topics.test.ts` が緑 | |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/ui run test` | 全件緑。**20 件以上増える** |

**受け入れ条件:** 4 種の案内線が出て吸着し、5 テーマで読め、入切と刻み角度が保存される。点の吸着が向きの吸着より優先される。

**落とし穴:**
- **案内線を毎フレーム作り直さない。** `BufferGeometry` の頂点だけを書き換える(`createSketchLayer.ts` の既存のやり方をなぞる)。
- **`SnapKind` を網羅している箇所の見落とし**(P4 タスク4 の教訓)。手順1 の Grep を省かない。
- **案内線は 3D の奥行きに埋もれる。** `depthTest: false` と描画順(`renderOrder`)で常に手前に出す(`createSketchLayer.ts` に前例がある)。

---

### タスク17: `ui` のコマンドラインの構文解析と道具の語の表

**先行タスク:** なし
**対応要件:** FR-208
**関係する過去の失敗:** 該当なし。ただし式の文法との噛み合いに注意(§2.5 の `,` と `<`)。
**必要なヘルプ文書:** なし(タスク18 で書く)

**ファイル:**
- 新規: `packages/ui/src/sketch/commandLine.ts`
- 新規: `packages/ui/src/sketch/commandLine.test.ts`
- 変更: `packages/ui/src/i18n/ja.json`(断りの文言)

**実装内容:**

```ts
/** 道具 1 つの語(日本語・英語・短縮)。一覧はこのファイルの 1 か所だけ。 */
export interface CommandWord {
  readonly tool: NumericInputToolId;
  /** 表示に使う名前。ツールバーの labelKey と同じものを指す。 */
  readonly labelKey: MessageKey;
  /** 打てる語。すべて小文字で持ち、判定は小文字へ直してから行う。 */
  readonly words: readonly string[];
}
export const COMMAND_WORDS: readonly CommandWord[] = [ /* ... */ ];

export type CommandLineOutcome =
  | { readonly kind: 'tool'; readonly tool: NumericInputToolId }
  | { readonly kind: 'coordinate'; readonly value: CoordinateInput }
  | { readonly kind: 'field'; readonly fieldKey: string; readonly source: string }
  | { readonly kind: 'commit' }
  | { readonly kind: 'error'; readonly message: string; readonly suggestions: readonly string[] };

export function parseCommandLine(
  input: string,
  context: {
    readonly plane: WorkPlane | null;   // 3D スケッチなら null
    readonly variables: ReadonlyMap<string, number>;
    readonly hasPrevious: boolean;      // 直前の点があるか(@ の可否)
  },
): CommandLineOutcome;

/** 打ちかけの語に前方一致する道具(最大 5 件)。 */
export function suggestCommands(input: string, limit?: number): readonly CommandWord[];
```

語の割り当て(§0.10 の②。**AutoCAD の慣習に合わせる**):

| 道具 | 語 |
|---|---|
| 線分 | `線分` `line` `l` |
| 円 | `円` `circle` `c` |
| 円弧 | `円弧` `arc` `a` |
| 点 | `点` `point` `po` |
| 矩形 | `矩形` `長方形` `rectangle` `rec` |
| 正多角形 | `正多角形` `多角形` `polygon` `pol` |
| 長穴 | `長穴` `slot` `sl` |
| 楕円 | `楕円` `ellipse` `el` |
| スプライン | `スプライン` `spline` `spl` |
| 複写 | `複写` `copy` `co` |
| ミラー | `ミラー` `鏡像` `mirror` `mi` |
| オフセット | `オフセット` `offset` `o` |
| トリム | `トリム` `trim` `tr` |
| 延長 | `延長` `extend` `ex` |
| フィレット | `フィレット` `fillet` `f` |
| 面取り | `面取り` `chamfer` `cha` |
| 面 | `面` `face` `fa` |

**この表は網羅ではない**(数値を聞かない道具・基準ジオメトリの 7 種・ソリッドの 10 種も対象になりうる)。**担当が `numericInput.ts` の `NumericInputToolId` を全部数え、どこまで語を割り当てるかを決めて報告する。** 推奨は「スケッチと整形系(`SketchToolId` + `ShapeToolId` + `EditToolId` + `ClickEditToolId`)だけ」(FR-208 の目的が作図なので)。

**手順:**

- [ ] 1. `numericInput.ts` の `NumericInputToolId` の全種類を数え、`ja.json` の道具名のキーを確かめる。**同じ短縮が 2 つの道具に当たらないことを検査で固定する**設計にする。
- [ ] 2. `COMMAND_WORDS` を書く。
- [ ] 3. `parseCommandLine` を書く。**括弧の深さを数えながら `,` で分ける**、**括弧の外の最初の `<` で極を分ける**(§2.5)。
- [ ] 4. `suggestCommands` を書く。
- [ ] 5. 検査を書く。

**検証(期待値と導出):**

| 入力 | 期待 | 導出 |
|---|---|---|
| `LINE` / `line` / `L` / `l` / `線分` | `tool: 'line'` | 大文字小文字を区別しない |
| `CIRCLE` / `C` / `円` | `tool: 'circle'` | |
| `CO` | `tool: 'copy'` | `C` は円、`CO` は複写(§0.10) |
| `10,20`(作図面 XY) | `coordinate`、絶対 (10, 20, 0) | `planeToWorld(XY, 10, 20)` |
| `10,20`(作図面 XZ) | 絶対 (10, 0, 20) | XZ の axisV = (0,0,1) |
| `10,20,5`(作図面あり) | `error`、「値が多すぎます」 | 2 軸しかない |
| `10,20,5`(3D スケッチ) | 絶対 (10, 20, 5) | |
| `@5,0` | `relative`、`base: { kind: 'previous' }`、dx=5、dy=0 | |
| `@5,0`(直前の点なし) | `error`、「直前の点がありません」 | `hasPrevious` |
| `@10<45` | `polar`、距離 10、角度 45、仰角 0 | |
| `@10<45+15` | 角度 `60` | 角度も式。括弧の外の最初の `<` で分ける |
| `10/2, 3^2` | 絶対 (5, 9, 0) | 式を評価 |
| `root(8,3), 5` | 絶対 (2, 5, 0) | **括弧の中の `,` で分けない**。8 の 3 乗根 = 2 |
| `@板厚*2,0`(板厚 = 3) | 相対 dx = 6 | 変数表を使う |
| `r=5` | `field`、`fieldKey: 'radius'`、`source: '5'` | |
| `d=20` | `field`、`fieldKey: 'diameter'` | |
| `a=30` / `l=100` | `field`、角度 / 長さ | |
| `R=5`(大文字) | `field`、`fieldKey: 'radius'` | 区別しない |
| (空文字) | `commit` | 空の Enter は確定(NFR-UX-4) |
| `LL` | `error`、`suggestions` に `l`(線分)を含む | 前方一致 |
| `<45` | `error`、「距離を先に打ってください」 | 距離が無い |
| `10,` | `error`、「値が足りません」 | |
| `10,,20` | `error` | 空の成分 |
| `１０，２０`(全角) | 絶対 (10, 20, 0) | 全角を半角へ直してから解く |
| `＠５，０`(全角) | 相対 (5, 0, 0) | `＠` も半角へ |
| `suggestCommands('c')` | `円` が 1 件目、最大 5 件 | 前方一致 |
| `COMMAND_WORDS` の語の重複 | 0 件(検査で固定) | 同じ短縮が 2 つの道具に当たらない |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/ui run test` | 全件緑。**35 件以上増える** |

**受け入れ条件:** 上の表がすべて通る。`root(8,3), 5` が正しく 2 成分に分かれる(式の文法と噛み合う)。語の重複が無い。

**落とし穴:**
- **`,` を素朴に `split(',')` しない**(§2.5)。`root(8,3)` が壊れる。
- **`-` を極の区切りと取り違えない。** `@10<-45` は角度 −45°(`<` の後ろの `-` は符号)。
- **`@` と `<` は式の文法に無い**ので、式へ渡す前に取り除く。渡すと `unexpectedCharacter` になる。
- **全角の `＠` `＜` は `normalizeExpressionSource` の表に無い**(式の文法に無い記号なので当然)。コマンドライン側で 2 文字だけ足して半角へ直す。
- **道具の語を `ja.json` に置かない。** 語は「打つ文字列」でデータであり、翻訳の対象ではない(道具の**表示名**は `labelKey` で `ja.json` から引く)。**この区別を報告に書く。**

---

### タスク18: `ui` のコマンドラインの欄・候補・段への流し込みと配線

**先行タスク:** 17、16、11
**対応要件:** FR-208、NFR-UX-1、NFR-UX-7
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-04 14:05 の 9b(焦点のある欄がファイルを開き直しても古い値を保持した)。**コマンドラインの欄も `documentVersion` で書きかけを捨てる。**
**必要なヘルプ文書:** `command-line.md`(新規)

**ファイル:**
- 新規: `packages/ui/src/shell/CommandLine.tsx`
- 変更: `packages/ui/src/shell/StatusBar.tsx`(欄の埋め込み。**§0.8 の決定次第**)
- 変更: `packages/ui/src/store/useAppStore.ts`(打っている文字列・履歴・焦点)
- 変更: `packages/ui/src/shell/AppShell.tsx`(`Space` / `Esc` の割り当て。**§0.10 の③の決定次第**)
- 変更: `packages/ui/src/viewport/attachSketchInteraction.ts`(焦点がコマンドラインにあるときはビューポートの当たり判定を飛ばす)
- 変更: `packages/ui/src/shell/appShell.css`
- 変更: `packages/ui/src/i18n/ja.json`
- 新規: `packages/help-content/docs/ja/command-line.md`
- 変更: `packages/help-content/src/index.ts`(目録 28 → 29)

**実装内容:**

- 打った値の行き先は 3 つ。①`tool` → `setActiveTool`(既存)。②`coordinate` / `field` → **いま開いているその場入力の欄へ流し込む**(`numericInput` の状態の `fields[i].source` を差し替える)。③`commit` → その段を確定する(`applySketchCommit` などの既存の入口)。
- **道具を打った直後にその場入力が開いていなければ、道具の 1 段目を開く**(`attachSketchInteraction.ts` の `FIRST_STEP` を使う)。
- **候補**は入力欄の**上**へ出す(下はステータスバーの外)。`Tab` で 1 件目を採る。
- **次に打つもの**の案内は、いま開いている段の欄名(`NumericField.labelKey`)をそのまま出す。
- **履歴**は `↑` `↓` で 20 件。保存しない。
- 焦点がコマンドラインにあるときは、ビューポートのキー割り当て(`1`〜`4` の選択の種類など)を効かせない(`AppShell.tsx` の `isTextEntry` がすでにこの判定を持つ。**同じ関数を使う**)。

**手順:**

- [ ] 1. `StatusBar.tsx`(260 行)の並びと `AppShell.tsx` のキー割り当て、`numericInput.ts` の状態の形(`NumericInputState`)、`commitToStore.ts` の確定の入口を Read する。**§0.8 と §0.10 の③の決定を確かめる。**
- [ ] 2. ストアに打っている文字列・履歴・焦点の状態を足す。
- [ ] 3. `CommandLine.tsx` を書く。
- [ ] 4. `StatusBar.tsx` へ埋め込む。**帯の 1 文が幅を譲る**(打っている間だけ)。
- [ ] 5. `AppShell.tsx` へ `Space` / `Esc` を足す。**入力欄に焦点があるときは `Space` を横取りしない**(`isTextEntry`)。
- [ ] 6. `command-line.md` を書く。**打てる語の一覧を表で載せる**(利用者が見る情報なので載せてよい)。
- [ ] 7. 検査を書く。ヘッドレスで撮影(**スクラッチパッドの絶対パス**)。

**検証(期待値と導出):**

| 検査 | 期待 | 導出 |
|---|---|---|
| `L` + Enter | 道具が線分になり、1 段目(始点)が開く | `FIRST_STEP` |
| 続けて `0,0` + Enter | 始点が (0,0,0) で確定し、2 段目(終点)が開く | |
| 続けて `@40,0` + Enter | 終点が (40,0,0)、線分ができる | 相対 |
| 続けて `@30<90` + Enter | 次の線分の終点が (40,30,0) | 極。連続描画(FR-307) |
| `C` + Enter、`0,0` + Enter、`r=20` + Enter | 半径 20 の円ができる | |
| 空の Enter(既定値のまま) | その段が既定値で確定する | NFR-UX-4 |
| `LL` + Enter | 帯の下に「その名前の道具はありません」と候補 | FR-204 と同じ流儀 |
| 打っている途中の候補 | `c` で「円」が 1 件目、最大 5 件 | |
| `Tab` | 1 件目の語が欄に入る | |
| `↑` | 直前に打った語が出る | 履歴 20 件 |
| `Esc` | 欄が空になり焦点がビューポートへ戻る | |
| 欄に焦点があるとき `1` を打つ | 選択の種類が変わらず、`1` が欄に入る | `isTextEntry` |
| ファイルを開き直す | 欄が空になる | `documentVersion`(過去の失敗) |
| 区画の数 | 5 のまま | `rules/04`(§0.8 が案 A のとき) |
| ツールバーの幅 | 変わらない | ツールバーを触らない |
| ヘルプの目録 | 29 件、`topics.test.ts` が緑 | |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/ui run test` | 全件緑。**15 件以上増える** |

**受け入れ条件:** 「`L` → `0,0` → `@40,0` → `@30<90` → `Esc`」でマウスに触れずに L 字の 2 本の線が引ける(統括の目視は §5)。既存のその場入力ポップオーバーの操作が 1 つも変わっていない。

**落とし穴:**
- **`Space` を横取りするとビューポートの操作を壊しうる。** P0〜P1 で `Space` に別の割り当てが無いことを Grep で確かめる。あれば §0.10 の③を統括へ差し戻す。
- **打った値をポップオーバーの欄へ「映す」のを忘れない。** 映さないと、コマンドラインとポップオーバーで見えている値が食い違う(NFR-UX-1 に反する)。
- **帯の 1 文の幅を欄が奪いすぎない。** 幅の実測(1440px と 1280px)を報告に書く。

---

### タスク19: `ui` のタイムラインの帯・つまみ(ロールバック)

**先行タスク:** 9、18
**対応要件:** FR-507、FR-506、NFR-PF-3
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-04 20:30(P4 タスク14。**「作図」「編集」の一覧がスケッチ区画の 2 段目に積まれツールバーが 2 段相当になった**)。**新しいものを画面へ足したら必ず高さ・幅を実測する。**
**必要なヘルプ文書:** `timeline.md`(新規)

**ファイル:**
- 新規: `packages/ui/src/shell/Timeline.tsx`
- 変更: `packages/ui/src/shell/FeatureTree.tsx`(つまみの行。**§0.18 の決定次第**)
- 変更: `packages/ui/src/store/useAppStore.ts`(`timelineIndex` と、途中までの文書での再計算)
- 変更: `packages/ui/src/shell/statusText.ts`(「途中まで戻しています」の案内)
- 変更: `packages/ui/src/shell/icons.tsx`
- 変更: `packages/ui/src/shell/appShell.css`
- 変更: `packages/ui/src/i18n/ja.json`
- 新規: `packages/help-content/docs/ja/timeline.md`
- 変更: `packages/help-content/src/index.ts`(目録 29 → 30)

**実装内容:**

- ストアに `timelineIndex: number | null`(null = 末尾)。**保存しない**(§0.19)。文書を開く・新規・復元のときは必ず `null` へ戻す。
- 再計算の入口(`attachPartRecompute` 相当)へ渡す文書を `documentUpTo(document, timelineIndex)` にする。**`timelineIndex` が `null` のときは `document` そのもの**(`===`)なので、既存の経路が 1 ミリ秒も変わらない。
- つまみを動かしても**文書は変わらない**(Undo の段を作らない)。
- **つまみが末尾でないとき**は、ステータスバーの帯に「途中まで戻しています(5 件のうち 3 件目)」と常に出す(NFR-UX-7。戻したままだと「作ったはずのものが消えた」と見えるため)。
- 帯の 1 件は「図柄・名前・抑制の印・失敗の赤」。クリックでつまみをそこへ置く。ダブルクリックで末尾へ戻す。
- **§0.18 が案 B(ツリーの中)なら `FeatureTree.tsx` に行の左端のつまみを描く。案 A(新しい帯)なら `Timeline.tsx` を `AppShell.tsx` へ足し、区画が 6 つになることを規約へ注記する。**

**手順:**

- [ ] 1. `FeatureTree.tsx`(506 行)の節と行の作り、`useAppStore.ts` の再計算の入口、`buildTreeSections`(`solidSummary.ts:1358`)を Read する。**§0.18 の決定を確かめる。**
- [ ] 2. ストアに `timelineIndex` を足し、再計算の入口へ `documentUpTo` を挟む。
- [ ] 3. つまみの表示を書く。
- [ ] 4. `statusText.ts` へ案内を足す。
- [ ] 5. `timeline.md` を書く。**内部用語(キャッシュ、段、解決)を出さない。**
- [ ] 6. 検査を書く。**高さ・幅を実測して報告する**(過去の失敗)。ヘッドレスで撮影。

**検証(期待値と導出):**

文書の例: 作業平面1 → 押し出し1 → 穴1 → R面取り1 → 押し出し2(帯 5 件)。

| 検査 | 期待 | 導出 |
|---|---|---|
| 起動直後の `timelineIndex` | `null`(末尾) | §0.19 |
| つまみを 2(押し出し1 まで)へ | 立体が 1 つだけ見える(穴もフィレットも無い) | `documentUpTo` |
| つまみを 3(穴1 まで)へ | 穴の開いた立体が見える | |
| つまみを末尾へ戻す | 元どおり | |
| つまみを動かしたときの `document` | `===` で同じ(変わらない) | Undo の段を作らない |
| つまみを 3 → 4 → 3 と動かす | **再計算が起きない**(`cacheHits` が段の数ぶん増える) | 鍵が変わらない(§2.7) |
| ファイルを開く / 新規 / 復元 | `timelineIndex` が `null` へ戻る | §0.19 |
| Undo / Redo | `timelineIndex` が `null` へ戻る | 履歴の件数が変わりうるため |
| つまみが末尾でないときの帯 | 「途中まで戻しています(5 件のうち 3 件目)」 | NFR-UX-7 |
| 抑制された段 | 帯に出るが薄い | FR-503 |
| 失敗した段 | 帯に赤い印 | FR-504 |
| 区画の数 | **§0.18 が案 B なら 5、案 A なら 6**(決定を報告に明記) | `rules/04` |
| ツールバーの高さ(1440px) | **68.5px のまま** | 過去の失敗 |
| ヘルプの目録 | 30 件、`topics.test.ts` が緑 | |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/ui run test` | 全件緑。**15 件以上増える** |

**受け入れ条件:** つまみを戻すと途中の状態が見え、戻しても再計算が起きない(`cacheHits` で確かめる)。つまみが末尾でないことが常に画面に出る。

**落とし穴:**
- **つまみを戻したまま保存しない。** `savePart` は必ず `document`(全体)を書く。`documentUpTo` の結果を保存すると、フィーチャーが消えたファイルになる。**検査で固定する。**
- **つまみを戻したまま新しいフィーチャーを作ると、末尾ではなく途中へ入る**(タスク20 の範囲)。本タスクでは**戻したままの作成を禁じる**(帯に「途中まで戻しています。新しく作るには末尾へ戻してください」)。タスク20 で解禁する。
- **画面へ何かを足したら高さを実測する**(過去の失敗)。

---

### タスク20: `ui` の途中への差し込みと順序の入れ替えの操作

**先行タスク:** 19
**対応要件:** FR-507、FR-504、NFR-UX-3
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-04 11:10 の (a)(確定の後に道具を選択へ戻す順序が逆で、選択が消えた)。**確定と選択の順序に気をつける。**
**必要なヘルプ文書:** `timeline.md`(タスク19 と同じファイルへ追記)

**ファイル:**
- 変更: `packages/ui/src/shell/Timeline.tsx`(または `FeatureTree.tsx`。§0.18 の決定次第)
- 変更: `packages/ui/src/store/useAppStore.ts`(差し込み位置、並べ替えの確定)
- 変更: `packages/ui/src/shell/statusText.ts`(断りの文言)
- 変更: `packages/ui/src/i18n/ja.json`
- 変更: `packages/help-content/docs/ja/timeline.md`(追記)

**実装内容:**

- **差し込み**: つまみが k 段目のとき、新しい立体・基準ジオメトリは `insertPositionAt(document, k, section)` の位置へ入れる(タスク9)。既存の「末尾へ足す」経路(`createPartDocument.ts` の `appendSolid` 相当)へ位置の引数を足す。**確定した後、つまみを 1 つ進める**(作ったものが見える位置にする)。
- **並べ替え**: 帯の中でドラッグして順序を変える。離したときに `reorderTimeline`(タスク9)を呼び、`ok: false` なら**元の位置へ戻して理由を帯に出す**(FR-504)。`ok: true` なら `applyDocument`(Undo 1 段)。
- 並べ替えの間は**予告**を出す(挿入位置に線を引く)。**できない位置では線を赤くする**(NFR-UX-5「実行してから失敗させない」)。

**手順:**

- [ ] 1. `useAppStore.ts` の「立体を足す」経路と `createPartDocument.ts` の追加関数を Read し、**位置の引数を足す先を数えて報告する**。タスク19 の「戻したままの作成の禁止」を解く。
- [ ] 2. 差し込みを配線する。
- [ ] 3. 並べ替えを配線する(ドラッグ・予告・断り)。
- [ ] 4. `timeline.md` へ追記する。
- [ ] 5. 検査を書く。

**検証(期待値と導出):**

文書の例: 押し出し1 → 穴1 → R面取り1(帯 3 件、作業平面なし)。

| 検査 | 期待 | 導出 |
|---|---|---|
| つまみを 1(押し出し1 まで)にして押し出し2 を作る | `solids` が `[押し出し1, 押し出し2, 穴1, R面取り1]`、つまみが 2 へ進む | `insertPositionAt` |
| 上で作ったものが画面に見える | つまみが進んだので見える | 過去の失敗(作ったものが選ばれない) |
| 穴1 を R面取り1 の後ろへドラッグ | 予告の線が赤く、離しても順序が変わらず、帯に「R面取り1 は 穴1 の結果を使っています」 | タスク9、FR-504 |
| 押し出し1 と 押し出し2(独立)を入れ替え | 順序が変わり、体積が変わらない | 独立 |
| 並べ替えの後の Undo | 1 回で元の順序に戻る | NFR-UX-3 |
| 並べ替えの後の再計算 | 変わった段から後ろだけが作り直される(`cacheHits` で確かめる) | NFR-PF-3 |
| つまみが末尾のときに新しく作る | 末尾へ足される(既存の挙動と同じ) | 後方互換 |
| 抑制された段をまたぐ並べ替え | 通し番号どおりに動く | |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/ui run test` | 全件緑。**15 件以上増える** |

**受け入れ条件:** 途中へ差し込めて、依存を壊す並べ替えが理由つきで断られる。断りが「実行してから失敗」ではなく**ドラッグ中の予告**で分かる(NFR-UX-5)。

**落とし穴:**
- **差し込みの位置を `references` と `solids` で取り違えない。** 帯は通し番号だが、配列は 2 本ある(タスク9 の `insertPositionAt` が section を取るのはこのため)。
- **並べ替えを 1 件ずつ場当たりに判定しない**(タスク9 の手順3)。並び全体を検査する。
- **確定と選択の順序**(過去の失敗)。差し込んだ後に「つまみを進める → 作ったものを選ぶ」の順にする。

---

### タスク21: `io` のスキーマ版アップとパラメータ・拘束の読み書き

**先行タスク:** 2、4、8
**対応要件:** 要件§8、FR-801、FR-802
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-04 15:20(P4 タスク6 の**差し戻し**。読み手が旧いファイルの点列と `construction` 無しを `missingField` で断り、前方互換が壊れた)。**同じことを繰り返さない。読み手は「無ければ既定値」で読む。**
**必要なヘルプ文書:** なし

**ファイル:**
- 変更: `packages/io/src/pcad/schema.ts`(版と `SCHEMA_MIGRATIONS`)
- 変更: `packages/io/src/pcad/documentJson.ts`(3457 行)
- 変更: `packages/io/src/pcad/documentJson.test.ts`

**実装内容:**

- **版は §0.17 の決定に従う**(案 A なら 4 → 5、案 B なら 3 → 4)。着手時に `PART_SCHEMA_VERSION` と `PCAD_SCHEMA_VERSION` の実際の値を読み、**決定と食い違ったら止めて統括へ報告する。**
- 足すもの:
  - `PartDocument.parameters`(`Parameter` の配列)。**読み手は無ければ空の配列**。
  - `SketchDocument.constraints`(`SketchConstraint` の配列)。**読み手は無ければ空の配列**。
- `documentJson.ts` の既存の流儀に合わせる:
  - 種類の一覧を定数で持つ(`SKETCH_CONSTRAINT_KINDS`、`CONSTRAINT_TARGET_KINDS`、`PARAMETER_UNITS`)。
  - `serializeParameter` / `readParameter`、`serializeConstraint` / `readConstraint`、`serializeConstraintTarget` / `readConstraintTarget` を足す。
  - `serializePartDocument` / 読み手の入口へ 1 行ずつ。
- **移行(`SCHEMA_MIGRATIONS`)は版の数字の書き換えだけ**(欄の追加なので既存の欄は 1 つも変えない。`SCHEMA_MIGRATIONS[2]` と同じ形)。
- **保存するのは式のまま。** `Parameter.value` と拘束の目標値は `ExpressionValue`(source + value + display)で往復する(FR-202)。

**手順:**

- [ ] 1. `schema.ts` と `documentJson.ts` の該当箇所を Read し、`PART_SCHEMA_VERSION` / `PCAD_SCHEMA_VERSION` の**現在の値を報告する**。§0.17 の決定と照らす。既存の「無ければ既定値」の書き方(`readConstructionFlag`、P4 タスク6 の修正)をなぞる。
- [ ] 2. 版を上げ、`SCHEMA_MIGRATIONS` へ 1 段足す。
- [ ] 3. パラメータの読み書きを足す。
- [ ] 4. 拘束の読み書きを足す(14 種 × 対象 3 種)。
- [ ] 5. 検査を書く。**旧い版のフィクスチャ(版 3・版 4)をそのまま開ける**ことを固定する。

**検証(期待値と導出):**

| 検査 | 期待 | 導出 |
|---|---|---|
| `PART_SCHEMA_VERSION` と `PCAD_SCHEMA_VERSION` | 同じ値(§0.17 の決定どおり) | `documentJson.test.ts` が既に一致を検査している |
| パラメータ 3 件を保存 → 読む | 名前・式・単位・説明・**並び順**が一致 | 並び順は保存対象 |
| `板厚 = '板の厚み * 2'` のような日本語の名前 | そのまま往復する | JSON は UTF-8 |
| 拘束 14 種を 1 つずつ保存 → 読む | すべて往復する | |
| 拘束の目標値 `'幅 / 2'` | `source` が `'幅 / 2'` のまま | FR-202 |
| 版 3 のフィクスチャを開く | 開ける。`parameters` = `[]`、`constraints` = `[]` | **前方互換(過去の失敗)** |
| 版 4 のフィクスチャを開く(§0.17 が案 A のとき) | 開ける | |
| `parameters` の欄が無い JSON | 空の配列として読む(`missingField` にしない) | 過去の失敗 |
| `constraints` の欄が無いスケッチ | 空の配列として読む | 同上 |
| 知らない拘束の種類が入った JSON | 理由つきで断る(`unknownKind`) | 既存の流儀 |
| 保存 → 読む → 保存 でバイト列が一致 | 一致(正規化された形) | 既存の往復の検査と同じ |
| 拘束付きの部品の `.pcad` の大きさ | 実測値を報告 | 参考(P3 実測は穴+パターンで 58,033 バイト) |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/io run test` | 全件緑。**25 件以上増える** |

**受け入れ条件:** 版が上がり、旧い版のファイルがそのまま開ける。パラメータと拘束が式のまま往復する。

**落とし穴:**
- **新しい欄を必須にして読み手を厳しくしない**(過去の失敗そのもの)。
- **`documentJson.ts` は 3457 行**で、P4 の残タスク(31)が同じファイルを触る可能性がある。手順1 で必ず現物を読み、食い違ったら止めて報告する。
- **拘束の `id` は文書の中で重ならない**ことを読み手が確かめる(重なると一覧と印が混ざる)。重複を見つけたら理由つきで断る。

---

### タスク22: `ui` のツリー・プロパティ・ツールバーの対応とヘルプの仕上げ

**先行タスク:** 13、14、16、18、20
**対応要件:** FR-501〜504、FR-901、NFR-MA-4、NFR-UX-7
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-04 19:30(P4 タスク13。**木・プロパティに基準ジオメトリが出ない**という申し送りが、後のタスクへ持ち越された)。**P4b では持ち越さず、このタスクで全部そろえる。**
**必要なヘルプ文書:** 5 本の見直し(`constraints.md` / `parameters.md` / `command-line.md` / `tracking.md` / `timeline.md`)

**ファイル:**
- 変更: `packages/ui/src/shell/FeatureTree.tsx`(拘束の節、パラメータの行)
- 変更: `packages/ui/src/solid/solidSummary.ts`(`buildTreeSections` へ節を足す)
- 変更: `packages/ui/src/shell/PropertyPanel.tsx`(拘束の一覧、パラメータのタブ)
- 変更: `packages/ui/src/sketch/featureSummary.ts`(拘束の要約)
- 変更: `packages/ui/src/shell/Toolbar.tsx`(幅の最終実測)
- 変更: `packages/ui/src/shell/statusText.ts`
- 変更: `packages/ui/src/i18n/ja.json`
- 変更: `packages/help-content/docs/ja/*.md`(5 本の見直し)

**実装内容:**

- **ツリー**: スケッチの節の下に「拘束」の小節を出す(節そのものは増やさない。`TreeSectionKey` は `'sketch' | 'solid'` のまま)。**§0.18 が案 B ならつまみもここ。**
- **プロパティ**: スケッチが選ばれているとき拘束の一覧、パラメータのタブ(§0.15)。拘束の目標値(距離・角度・半径・直径)を**式のまま再編集できる**(FR-202、FR-311)。
- **ツールバー**: 拘束の畳んだ一覧を足した後の幅を**1440px と 1280px で最終実測**し、1440px で 1 段(68.5px)であることを固定する(P4 の完了条件 12)。
- **ヘルプ 5 本の見直し**: `rules/05-リリース.md` §11.3 に照らし、**内部用語が 1 語も残っていないこと**を確かめる。禁じ手の語の一覧: ソルバー、残差、ヤコビアン、収束、反復、自由度の「次元」、トポロジカルソート、依存グラフ、変数表、キャッシュ、Worker、B-rep、テッセレーション、正規化、構文解析、字句。
  - ただし**利用者に見える言い方への言い換えは可**: 「あと 3 か所決まっていません」「同じ条件が重なっています」「この名前は 3 か所から使われています」。

**手順:**

- [ ] 1. `FeatureTree.tsx` / `solidSummary.ts` / `PropertyPanel.tsx` / `featureSummary.ts` を Read する。**P4b で足した種類(拘束 14 種、パラメータ)を網羅すべき `Record` を Grep して数え、報告する。**
- [ ] 2. ツリーとプロパティを直す。
- [ ] 3. ツールバーの幅をヘッドレスで実測する(1440px / 1280px、5 テーマ、拡大率 100% / 110% / 125% / 150%)。
- [ ] 4. ヘルプ 5 本を読み直し、内部用語を落とす。**画面の見た目が変わったので、既存のスクリーンショットが古くなっていないかも確かめて報告する**(`rules/05` §11.1。撮り直しは統括の作業)。
- [ ] 5. 検査を書く。ヘッドレスで撮影(**スクラッチパッドの絶対パス**)。

**検証(期待値と導出):**

| 検査 | 期待 | 導出 |
|---|---|---|
| ツリーにスケッチの拘束が並ぶ | 「直角1」「距離2」…、赤い印が診断と一致 | FR-501 |
| ツリーの節の数 | 2 のまま(スケッチ / ソリッド) | 区画も節も増やさない |
| プロパティで距離拘束の値を `'20'` → `'幅'` へ | 式のまま保存され、形が追従 | FR-202、FR-311 |
| プロパティのパラメータのタブ | 表が出る(§0.15 が案 A のとき) | |
| ツールバーの幅(1440px、100%) | **1 段 68.5px** | P4 の完了条件 12 |
| ツールバーの幅(1440px、125% / 150%) | 2 段(P4 タスク2 の仕上げで許容済み) | 実測は 142.3 / 156.5px |
| ツールバーの幅(1280px) | 2 段(P3 実測と同じ)。実測値を報告 | |
| ヘルプ 5 本の内部用語 | 0 語(禁じ手の一覧で Grep して 0) | `rules/05` §11.3 |
| ヘルプの目録 | 30 件、`topics.test.ts` が緑 | |
| `i18n.test.ts` | 緑(`.tsx` に日本語の直書きが無い、キーが網羅されている) | NFR-MA-5 |
| 区画の数 | **§0.18 の決定どおり**(案 B なら 5) | `rules/04` |

| コマンド | 期待 |
|---|---|
| `pnpm --filter @pointercad/ui run test` | 全件緑 |
| `pnpm --filter @pointercad/help-content run test` | 全件緑 |

**受け入れ条件:** 手順1 で数えた網羅箇所がすべて対応済み。ツールバーが 1440px で 1 段。ヘルプに内部用語が 1 語も無い。**申し送りを次のフェーズへ持ち越さない**(過去の失敗)。

**落とし穴:**
- **拘束は `SketchFeature` ではないので、既存のツリーの行の作り(フィーチャーの配列を並べる)にそのままは乗らない。** 小節として別に作る。
- **ヘルプの言い換えを機械的にやらない。** 「ソルバー」を「計算」に置き換えるだけでは文が通らないことがある。**利用者が何をするかの文へ書き直す。**

---

### タスク23: E2E の追加と全体検査

**先行タスク:** 21、22
**対応要件:** NFR-MA-2、要件§9 の P4b 完了条件
**関係する過去の失敗:** `docs/報告記録.md` 2026-09-04 11:10(P3 タスク30。**E2E で不具合 3 件が見つかった**)。**E2E は「動くはず」を実際に確かめる最後の網。**
**必要なヘルプ文書:** なし

**ファイル:**
- 変更: `e2e/tests/sketch.spec.ts`(**新規 spec ファイルは作らない**。現行の 3 ファイル構成を保つ)

**実装内容:**

P4b の完了条件(要件§9)を直接検証する 5 本:

| # | 検査 | 完了条件のどこ |
|---|---|---|
| (a) | 矩形をかき、4 辺に水平・垂直・一致の拘束を付け、辺の 1 本に長さ拘束 40 を付ける。**1 つの頂点を引っぱると、直角を保ったまま形が整う。** | 「拘束を付けた輪郭が、1 つの要素を動かすだけで条件を保ったまま整い」 |
| (b) | コマンドラインだけで `L` → `0,0` → `@40,0` → `@30<90` → `Esc` と打ち、L 字の 2 本の線ができる。 | 「キーボードだけで作図でき」 |
| (c) | パラメータ表に `板厚 = 3` を作り、押し出しの距離を `'板厚 * 2'` にする。**板厚を 5 にすると立体の高さが 6 → 10 になる。** | 「名前を付けた数値を 1 か所変えると全体が追従し」 |
| (d) | 押し出し → 穴 → R 面取り の 3 段を作り、**つまみを 2 段目へ戻すと穴だけの立体が見え、末尾へ戻すと元どおりになる。** 穴と R 面取りの入れ替えが理由つきで断られる。 | 「履歴を途中まで戻して確かめられる」 |
| (e) | 直交・極トラッキング: 起点から 17° の向きへポインタを動かすと 15° へ吸着し、案内線が出る。刻みを 45° に変えると 17° → 0° になる。 | FR-110 |

**手順:**

- [ ] 1. `e2e/tests/sketch.spec.ts` の既存の書き方(P4 で 4 本追加済み)を Read する。**着手時の E2E の件数を報告する。**
- [ ] 2. 5 本を追記する。
- [ ] 3. **3 回連続で緑になる**ことを確かめる(P3 タスク30 と同じ基準。ゆらぎを排除する)。
- [ ] 4. 全体検査を実行する。**並列で他の担当が動いていないことを確かめてから。**
- [ ] 5. 実測値を報告する。

**検証(期待値と導出):**

| 検査 | 期待 | 導出 |
|---|---|---|
| E2E の件数 | 着手時の件数 + 5 | |
| E2E が 3 回連続で緑 | 緑 | ゆらぎの排除 |
| (a) 引っぱった後の矩形 | 直角が保たれ、長さ拘束の辺が 40 のまま | |
| (b) L 字の 2 本 | 1 本目が (0,0)–(40,0)、2 本目が (40,0)–(40,30) | `@40,0` と `@30<90` |
| (c) 板厚 3 → 5 の立体の体積 | 40×30×6 = `7200` → 40×30×10 = `12000` | |
| (d) つまみを戻した立体の体積 | 穴だけ(R 面取り無し)の値。**担当が実測して固定する** | |
| (e) 17° → 15° の吸着 | 案内線が出て、置いた点の角度が 15° | タスク15 |
| `pnpm run typecheck` | エラー 0 | |
| `pnpm run lint` | 警告 0 | |
| `pnpm run test`(モノレポ全体) | 全件緑。**着手時からの増分を報告** | `rules/03` §7 |
| `pnpm run build` | 成功。**主チャンクが 500kB 未満**(P3 実測 473.77kB)。増分を報告 | |
| 性能検査(`POINTERCAD_PERF_STRICT=1`) | 全 11 項目が上限内 | **上限は緩めない** |
| 禁止パターン(`eslint-disable` / `@ts-ignore` / `@ts-expect-error` / `: any` / `as unknown as`) | **新しい混入 0 件** | `rules/02` |
| `package.json` / `pnpm-lock.yaml` の差分 | **0**(P4b の追加依存は 0 件) | §1 |

| コマンド | 期待 |
|---|---|
| `pnpm run test`(全体) | 全件緑 |
| `pnpm run test:e2e` | 全件緑(3 回連続) |

**受け入れ条件:** 5 本の E2E が 3 回連続で緑。モノレポ全体の検査が通る。依存が 1 件も増えていない。性能検査の上限がすべて守られている。

**落とし穴:**
- **統括が `scripts/check.ps1` を実行するのは並列作業が止まってから**(`rules/06` 10.2・10.3)。担当は自分のパッケージの検査だけを走らせる。
- **E2E は 50MB の WASM を含むビルドを伴う**ので、1 回あたり十数秒〜数分かかる(P3 実測: 16 件で約 3 分)。3 回連続の確認には時間を見込む。
- **ゆらぎのある検査を「たまたま緑」で通さない。** 3 回連続が条件。

---

## 5. P4b 完了の確認手順(統括が手動で行う)

作業担当が全タスクを終えた後、**統括だけ**が次を実行して要件§9 の P4b 完了条件を確かめる。アプリの起動と終了は統括の担当(`rules/01-役割と委譲.md` §1)。二重起動を避けるため、起動前に該当プロセスと待受ポートを確認する(`rules/02-禁止事項.md`)。

### 5.1 事前確認

- [ ] `git status --porcelain --untracked-files=no` が空である。
- [ ] `scripts/check.ps1`(既定 = `-Level Push`)が `[OK] 全ての検査に合格しました` で終わる。
- [ ] `git diff --cached` の全文を読み、**`package.json` / `pnpm-workspace.yaml` / `pnpm-lock.yaml` に依存の差分が無い**(P4b の追加依存は 0 件)。
- [ ] `eslint-disable` / `@ts-ignore` / `@ts-expect-error` / `: any` / `as unknown as` が**新しく混入していない**(P3・P4 で承認済みの箇所以外に増えていない)。
- [ ] テストの期待値を緩めた形跡が無い。性能検査の上限(5000ms / 500ms)が下げられていない。拘束の許容量(1e-9)と上限(400 変数)が緩められていない。
- [ ] `packages/help-content/src/index.ts` の目録件数が **30**(実測 25 + 5)で `topics.test.ts` が緑。
- [ ] `PART_SCHEMA_VERSION` / `PCAD_SCHEMA_VERSION` が §0.17 の決定どおりの値になっている。
- [ ] `EXPRESSION_SYNTAX_VERSION` が **2** になっている。
- [ ] `rules/03-品質ゲート.md` §7.1・`rules/00-施行の仕組み.md` の表が `scripts/check.ps1` の実装と食い違っていない(検査の段が増えていない)。
- [ ] **§0.18 が案 A(新しい帯)だった場合**、`rules/04-設計の規律.md` の「固定区画を増やさない」の行へ、利用者の決定による例外として注記が入っている。

### 5.2 Web 版の確認

```
Get-NetTCPConnection -LocalPort 4180 -ErrorAction SilentlyContinue
node apps/web/node_modules/vite/bin/vite.js preview --port 4180 --host 127.0.0.1
```

**拘束(FR-313、P4b 完了条件の核心)**

- [ ] 線分を 1 本引き、「水平」を押すと水平になる。帯に「あと N か所決まっていません」が出る。
- [ ] 線分に「距離」を押すと、いまの長さが既定値として入った欄が開く。40 を入れると長さ 40 になる。
- [ ] 矩形の 4 辺に水平・垂直・一致を付け、**1 つの頂点をマウスで引っぱると直角を保ったまま形が変わる。**
- [ ] 引っぱった後に Undo 1 回で元に戻る。
- [ ] 2 本の線分に「直角」と「等しい」を付けると、L 字が同じ長さの直角になる。
- [ ] 円と線分に「接線」を付けると線が円に接する。
- [ ] 同じ線分に「水平」と「垂直」を付けると、**赤い理由が出てアプリは落ちない。原因の 2 つの拘束が一覧で赤い。**
- [ ] 式で書いた座標(`10 + 5`)の点は引っぱれず、理由が出る。
- [ ] 拘束を一覧の「×」で消すと形が緩む。
- [ ] 拘束の印が要素の脇に出て、クリックすると一覧で選ばれる。5 テーマすべてで読める。

**パラメータ表(FR-207、Must)**

- [ ] 表に `板厚 = 3` を足す。押し出しの距離の欄に `板厚 * 2` と打つと 6 になる。
- [ ] **表の板厚を 5 に変えると、立体の高さが 10 になる**(1 か所変えると全部追従)。
- [ ] `板厚` を `板の厚み` へ改名すると、押し出しの式が `板の厚み * 2` になり値は 10 のまま。
- [ ] `A = B + 1`、`B = A + 1` を作ると 2 行が赤くなり、アプリは落ちない。
- [ ] どこからも使われていない名前に薄い印が出る。
- [ ] 使われている名前を消そうとすると「N か所から使われています」と断られる。
- [ ] `2倍` や `sqrt` という名前は断られる。

**コマンドライン(FR-208)**

- [ ] `Space`(または §0.10 の決定のキー)で欄に焦点が入る。
- [ ] `L` → `0,0` → `@40,0` → `@30<90` → `Esc` で L 字の 2 本の線が**マウスに触れずに**引ける。
- [ ] `C` → `0,0` → `r=20` で半径 20 の円ができる。
- [ ] `@10<45+15` で角度 60° の点が置ける。
- [ ] `root(8,3), 5` で (2, 5) の点が置ける(括弧の中の `,` で壊れない)。
- [ ] `板厚 * 2, 0` でパラメータを使った座標が置ける。
- [ ] `LL` と打つと「その名前の道具はありません」と候補が出る。
- [ ] 打っている間、候補と「次に打つもの」が出る。`Tab` と `↑` が効く。
- [ ] 既存のその場入力ポップオーバーの操作が変わっていない。

**直交・極トラッキング(FR-110)**

- [ ] 線を引く途中、17° の向きへポインタを動かすと 15° へ吸着し、破線の案内線と「15° に合わせています」が出る。
- [ ] 既存の線の延長線・垂線・平行線に吸着し、どの要素から来た案内かが帯に出る。
- [ ] 2 本の案内線が交わるところで交点に吸着する。
- [ ] 設定で刻みを 45° に変えると 17° が 0° へ吸着する。再読込後も刻みが保たれる。
- [ ] 吸着の一覧(ツールバーの札)に 4 つの新しい種別があり、個別に切れる。
- [ ] 端点と案内線が両方近いときは端点に吸着する。
- [ ] 5 テーマすべてで案内線が読める。

**タイムライン(FR-507)**

- [ ] 押し出し → 穴 → R 面取り の 3 段を作り、つまみを 2 段目へ戻すと**穴だけの立体**が見える。
- [ ] 戻している間、帯に「途中まで戻しています(3 件のうち 2 件目)」が出る。
- [ ] 末尾へ戻すと元どおりになる。**戻したり進めたりしても、計算し直しの待ちが起きない。**
- [ ] 戻したまま新しい押し出しを作ると、その位置に差し込まれる。
- [ ] 穴と R 面取りをドラッグで入れ替えようとすると、**予告の線が赤くなり、離しても順序が変わらず、理由が出る。**
- [ ] 独立した 2 つの押し出しは入れ替えられる。Undo 1 回で戻る。
- [ ] 戻したまま保存して開き直すと、**全部作られた状態**で開く。

**画面と土台**

- [ ] 区画の数が §0.18 の決定どおり(案 B なら 5 のまま)。
- [ ] ツールバーが 1440px の窓で **1 段(68.5px)**。
- [ ] 表示テーマ 5 種と拡大率 90〜150% で、拘束の印・案内線・パラメータの表・タイムラインの帯が崩れない。

**失敗しても落ちない(FR-504、NFR-RE-1)**

- [ ] 矛盾する拘束、循環するパラメータ、依存を壊す並べ替え、不明なコマンドのいずれでもアプリは落ちず、理由が読める。
- [ ] 拘束の対象にしていた線を消すと、その拘束が一覧で赤くなる。アプリは落ちない。

**履歴と保存(FR-501〜505、FR-801)**

- [ ] 拘束・パラメータを含む部品を保存し、開き直すと**同じ形**になり、式のまま再編集できる。
- [ ] **P4 で保存した `.pcad`(旧い版)が開ける**(前方互換)。

**性能(NFR-PF-1〜3)**

- [ ] 拘束を 50 個付けたスケッチの点を引っぱっても、引っかからずに追従する。
- [ ] パラメータを 1 つ変えたときの再計算が 100 フィーチャー規模で 5 秒以内。
- [ ] タイムラインのつまみを動かしても再計算の待ちが出ない。

### 5.3 デスクトップ版の確認

```
Get-Process electron -ErrorAction SilentlyContinue
apps/desktop/node_modules/electron/dist/electron.exe apps/desktop
```

- [ ] 窓が開き、タイトルが「PointerCAD」。
- [ ] §5.2 の「拘束」「パラメータ表」「コマンドライン」を同じ手順でもう一度行い、同じ結果になる(要件§1.5「機能差を作らない」)。
- [ ] **日本語の変数名(「板厚」)が Electron の入力欄でも打てる**(IME の変換確定と `Enter` の扱いが Web 版と同じか)。
- [ ] 開発者ツール(Ctrl+Shift+I)のコンソールにエラーが出ていない。`crossOriginIsolated` が `true`。

確認後、窓を閉じて `Get-Process electron` でプロセスが残っていないことを確かめる。`preview` も Ctrl+C で終了する。

### 5.4 記録

- [ ] `docs/報告記録.md` へ、確認した日時(`Get-Date -Format 'yyyy-MM-dd HH:mm'`)、上記の結果、実測値(テスト件数、E2E の所要、ツールバーの幅、拘束を解く所要、ヘルプ目録の件数、`.pcad` の大きさ)、残った課題を記録する。
- [ ] §0 の確認事項に対して下した判断を §0.a へ書き、`docs/報告記録.md` にも残す。
- [ ] タスクごとにコミットする(`rules/03-品質ゲート.md` §6)。

### 5.5 P4b の完了条件(すべて満たすこと)

| # | 条件 | 確認方法 |
|---|---|---|
| 1 | 寸法拘束 4 種(距離・角度・半径・直径)を付けられ、値を式で書ける | §5.2「拘束」 |
| 2 | 幾何拘束 9 種(一致・水平・垂直・平行・直角・接線・同心・等しい・対称)を付けられる | 同上 |
| 3 | **拘束を付けると形が自動で整う** | 同上 |
| 4 | **1 つの要素を引っぱると、条件を保ったまま他が追従する** | 同上 |
| 5 | 過拘束・矛盾は日本語で断り、原因の拘束を指す。アプリは落ちない | §5.2「失敗しても落ちない」 |
| 6 | 足りない拘束の数が画面に出る | §5.2「拘束」 |
| 7 | 式で書いた座標は拘束で動かない(既存の流儀と両立) | 同上 |
| 8 | 名前を付けた数値の一覧が作れ、名前・式・値・単位・説明を編集できる | §5.2「パラメータ表」 |
| 9 | **1 か所変えると参照しているところが全て追従する** | 同上 |
| 10 | 改名で参照が追従する。未使用と循環が画面に出る | 同上 |
| 11 | **キーボードだけで作図を終えられる**(道具名・絶対・相対・極・寸法) | §5.2「コマンドライン」 |
| 12 | 入力中に候補と次に打つものが出る | 同上 |
| 13 | 0/90° と 15° 刻みへの吸着、延長線・垂線・平行線への吸着、案内線の表示 | §5.2「トラッキング」 |
| 14 | 入切と刻み角度を切り替えられ、設定が保たれる | 同上 |
| 15 | **履歴を途中まで戻して確かめられ、その位置に差し込める** | §5.2「タイムライン」 |
| 16 | 順序を入れ替えられ、依存を壊す入れ替えは理由つきで断られる | 同上 |
| 17 | 失敗しても落ちず、理由がツリーと帯に出る | §5.2「失敗しても落ちない」 |
| 18 | `.pcad` で保存し式のまま再編集できる。旧い版のファイルも開ける | §5.2「履歴と保存」 |
| 19 | Web 版とデスクトップ版で同じことができる | §5.3 |
| 20 | **区画の数が §0.18 の決定どおり、ツールバーが 1440px で 1 段** | §5.2「画面と土台」 |
| 21 | `scripts/check.ps1` が合格する(E2E・性能検査を含む) | §5.1 |
| 22 | CI(Windows / Linux)が緑になる | push 後に GitHub 上の実際の結果を見る。手元の合格を「CI に通った」と報告しない(`rules/03` §7.2)。**remote が未設定なら利用者の作業待ち** |
| 23 | 追加した機能すべてにヘルプがある | 目録 30 件、`topics.test.ts` が緑 |
| 24 | 追加した外部依存が 0 件 | §5.1 |

---

## 6. 自己点検の結果

計画を書き終えた後に、要件・規約・既存コードと突き合わせて確認した点。**§0.a 全件記入済み(2026-09-04)。**

### 6.1 要件 ID とタスクの対応

| 要件 ID | 内容 | 満たすタスク |
|---|---|---|
| **FR-313** | **完全な拘束(寸法 4 種+幾何 9 種)、Must** | **4(型・変数)、5(残差)、6(ソルバー)、7(診断)、8(解決への差し込み)、12(コマンド)、13(表示)、14(引っぱる)、21(保存)、22(ツリー・プロパティ)** |
| FR-313 の「形が自動で整う」 | 拘束を付けると整う | 8(3 段の解決) |
| FR-313 の「動かすと追従」 | 引っぱると追従 | 14 |
| FR-313 の「足りない数を示す」 | 自由度の表示 | 7(数える)、13(出す) |
| FR-313 の「原因の拘束を指して断る」 | 矛盾・過拘束の診断 | 7(見つける)、13(出す) |
| **FR-207** | **パラメータ表、Must** | **1(名前の字句)、2(型・依存グラフ)、3(全式の再評価)、10(操作)、11(パネルと配線)、21(保存)、22(プロパティ)** |
| FR-207 の「1 か所変えると全部追従」 | 全式の再評価 | 3、11 |
| FR-207 の「未使用と循環を示す」 | 依存グラフ | 2、11 |
| FR-206 | ユーザー定義パラメータ(FR-207 が具体化) | 同上 |
| **FR-208** | **コマンドライン入力** | **17(構文)、18(欄と配線)、11(変数表を式へ渡す)** |
| FR-208 の「候補と次に打つものを表示」 | 候補・案内 | 17(候補)、18(表示) |
| **FR-110** | **直交・極トラッキング** | **15(向きの候補)、16(案内線・設定・配線)** |
| FR-110 の「入切と刻み角度」 | 設定 | 16 |
| **FR-507** | **タイムライン** | **9(順序の妥当性・途中までの文書)、19(帯とつまみ)、20(差し込み・入れ替え)** |
| FR-506 | ロールバックバー(FR-507 が具体化) | 9、19 |
| FR-201 / FR-204 | すべての数値欄で式、不正は即時に理由 | 1(名前の字句)、11(変数表の配線) |
| FR-202 | 式は文字列のまま保存・再編集 | 3(式を変えない)、21(往復)、22(プロパティ) |
| FR-203 / NFR-RE-4 | 任意精度、丸めは最終段 | 14(`exactExpressionValueFromNumber`) |
| FR-501〜504 | ツリー・編集・削除・再計算エラー | 13、19、20、22 |
| FR-505 | Undo / Redo | 14(引っぱる 1 段)、20(並べ替え 1 段) |
| FR-801 / 要件§8 | `.pcad` の保存とスキーマ版 | 21 |
| NFR-PF-1 | 60fps | 13(印を 1 つのメッシュに)、14(ドラッグ 16ms)、16(案内線を作り直さない) |
| NFR-PF-2 | 単一操作 500ms | 6(変数 400 で 500ms)、8 |
| NFR-PF-3 | 100 フィーチャー 5 秒 | 3(再評価 200ms)、9(`documentUpTo` が鍵を変えない)、19 |
| NFR-RE-1 | 落ちない | 7、8、13、19、20(すべての失敗の経路) |
| NFR-MA-1 | 依存方向 `apps → ui → model → kernel/expression` | **P4b は逆流を作らない**(拘束は model、トラッキングとコマンドラインは ui、変数の字句は expression)。§6.2 |
| NFR-MA-2 | ユニット必須・主要フローは E2E | 全タスク、23 |
| NFR-MA-4 | ヘルプとテストの同時追加 | 11、13、16、18、19、22 |
| NFR-MA-5 | `ja.json` | 全 ui タスク |
| NFR-UX-1 | 操作文法の一貫性 | 12(どちらの順でも)、18(マウスとキーボードが同じ確定を通る) |
| NFR-UX-2 | 直接操作優先、モーダルにしない | 11(パネル)、13(印)、18(帯の欄)、19(帯) |
| NFR-UX-3 | すべて Undo 可能 | 14、20 |
| NFR-UX-4 | 妥当な既定値 | 12(いま測った値)、16(刻み 15°)、18(空の Enter) |
| NFR-UX-5 | 実行前に赤表示+理由 | 10、12、20(ドラッグ中の予告) |
| NFR-UX-7 | 操作ガイドを全ツールで | 13(自由度)、16(案内)、18(次に打つもの)、19(戻している旨) |
| 要件§12 の未決「拘束の解き方」 | **§0.1 で案 A(連立)を推奨し、統括の決定を仰ぐ** | §0.1、§0.a |

**P4b の範囲外(明示):** 3D スケッチの拘束(§0.3)。アセンブリの合致拘束(FR-603、P7)。図面の寸法(FR-701〜、P8)。スケッチどうしをまたぐ拘束(1 つのスケッチの中だけ)。曲線(楕円・スプライン)を対象にした接線・等しい拘束(**線分と円/円弧だけ**。§6.6 の懸念 4)。

### 6.2 規約(`rules/`)との整合

| 規約 | 本計画での扱い |
|---|---|
| `rules/01` §1 作業担当は git へ書き込まない | §4 と各タスクへ明記 |
| `rules/01` §3 指示書の 7 項目 | 各タスクに 先行タスク / 対応要件 / 過去の失敗 / ヘルプ文書 / ファイル(実名)/ 実装内容(実名)/ 手順 / 検証(数値)/ 受け入れ条件 / 落とし穴 を揃えた |
| `rules/02` 依存の無断変更 | **P4b の追加依存は 0 件**(§1 の技術構成)。外部の拘束ソルバーが要ると判断したら止めて提案(§0.1・§4) |
| `rules/02` 期待値・上限の緩和 | §4・§5.1 に明記。拘束の許容量(1e-9)と変数の上限(400)も緩めない |
| `rules/02` 警告封じ | §4 で禁止。**P4b は OCCT の列挙を触らないので、新しい述語ガードは想定していない** |
| `rules/02` ブラウザ・Electron を担当が起動しない | §4。撮影はヘッドレス、起動は統括(§5) |
| `rules/03` §7.1 検査の一覧 | **段を増やさない**。`scripts/check.ps1` と `rules/03` を変えない(§2.9) |
| `rules/04` 数値精度 | 式は文字列のまま保存、拘束の解の書き戻しは `exactExpressionValueFromNumber`(丸めない)。§2.3 |
| `rules/04` 状態はストア 1 本 | `parameterAnalysis` / `constraintDiagnosis` / `timelineIndex` / `sketchDrag` / `trackIndicator` はすべてストア。`useState` は表示専用(タブ・編集中の行)だけ |
| `rules/04` 依存方向 | **逆流なし。** 拘束は model、トラッキングとコマンドラインは ui(model を読むだけ)、変数名の字句は expression。ui が kernel を直接呼ぶ経路は増えない |
| `rules/04` 幾何カーネルは Worker 内 | **P4b はカーネルを 1 度も呼ばない**(拘束・トラッキング・コマンドライン・パラメータ・タイムラインはすべて座標と式の計算) |
| `rules/04` 導出できるものは保存しない | 拘束の解(§0.4)・つまみの位置(§0.19)・`parameterAnalysis` は保存しない。保存するのは拘束の定義とパラメータの式だけ(要件§8 の「拘束」と一致) |
| `rules/04` 区画を増やさない | §0.8・§0.15・§0.18 の推奨案はいずれも既存区画の中。**§0.18 が案 A になったら規約へ利用者の決定による例外を注記する**(§5.1) |
| `rules/04` 止めずに警告する | §2.8 の表。すべての失敗で形を描いたまま理由を出す |
| `rules/04` ヘルプとテストの同時追加 | 各タスクの「必要なヘルプ文書」欄 |
| `rules/04` Web / デスクトップに機能差を作らない | **P4b は `apps/` を 1 行も触らない。** §5.3 で同じ操作を確認(**特に日本語の変数名の IME**) |
| `rules/05` §11.1 見た目が変わったらヘルプの画像を撮り直す | タスク22 手順4 で古くなった画像を洗い出し、撮り直しは統括の作業(リリース準備時) |
| `rules/05` §11.3 ヘルプに内部用語を出さない | タスク22 に**禁じ手の語の一覧**を置き、Grep で 0 件を確かめる |
| `rules/06` 失敗の記録 | 各タスクの「関係する過去の失敗」に `docs/報告記録.md` の日時と項目、または `rules/06` の節番号を引用した(該当なしのタスクは 4 件) |
| `rules/06` 10.2・10.3 並列と性能検査 | §4 と タスク6・23 に明記(担当は `scripts/check.ps1` を実行しない、性能の実測は静かな環境で) |

### 6.3 実在確認

| 対象 | 確認 |
|---|---|
| 既存ファイル | §3 に挙げた変更対象は 2026-09-04 に Read / Grep で実在を確認した(§1)。それ以外は「新規」と明記 |
| 既存の型・関数の実名 | §1 の 4 つの表に**行番号つきで**挙げた(expression 13 件、model 26 件、ui 24 件、io / help-content 3 件)。すべて実際に読んで確かめた |
| 行数 | `resolveSketch.ts` 1677 / `resolvePart.ts` 2084 / `numericInput.ts` 3741 / `documentJson.ts` 3457 / `useAppStore.ts` 1287 / `Toolbar.tsx` 1700 / `snapMath.ts` 217 / `StatusBar.tsx` 260 / `FeatureTree.tsx` 506 / `PropertyPanel.tsx` 693 / `attachSketchInteraction.ts` 873 は `wc -l` の実測 |
| **推測で書いていないこと** | OCCT の API は 1 つも使わないので `opencascade.full.d.ts` の Grep は不要。代わりに**式エンジンの字句解析**(§1.5-1)と**スキーマ版**(§1.5-3)を実測で確かめた |

### 6.4 共有ファイルの衝突と並列

| 共有ファイル | 触るタスク | 扱い |
|---|---|---|
| `packages/expression/src/index.ts` | 1 のみ | 単独 |
| `packages/model/src/sketch/types.ts` | 4 のみ | **P4 と違い中間のタスクが触らない**(拘束の型は `constraints/types.ts` に置く) |
| `packages/model/src/sketch/resolveSketch.ts` | 8 のみ | 口を 2 つ足すだけ |
| `packages/model/src/part/types.ts` | 2 のみ | `parameters` を足すだけ |
| `packages/model/src/index.ts` | 2、9、3、7、8、4 | **1〜2 行の追記が 6 回。順序は 2 → 9 → 3 → 7 → 8 → 4**(組 C・D の前提)。同時に開かない |
| `packages/model/src/part/resolvePart.ts` | 8 のみ | 単独。ただし**P4 タスク25 が並行している可能性がある**(§1.5-4) |
| `packages/ui/src/store/useAppStore.ts` | 11、13、14、16、18、19、20 | **直列(ui の鎖)** |
| `packages/ui/src/i18n/ja.json` | 10、11、12、13、15、16、17、18、19、20、22 | **直列。足す前に相手が触っていないことを確かめる**(§4) |
| `packages/ui/src/shell/Toolbar.tsx` | 13、22 | 13(拘束の一覧)→ 22(幅の最終実測) |
| `packages/ui/src/shell/icons.tsx` | 13、19 | 直列 |
| `packages/ui/src/shell/statusText.ts` | 13、16、19、20 | 直列 |
| `packages/ui/src/shell/StatusBar.tsx` | 18 のみ | 単独 |
| `packages/ui/src/shell/appShell.css` | 11、18、19 | 直列 |
| `packages/ui/src/viewport/attachSketchInteraction.ts` | 14、16、18 | 直列 |
| `packages/ui/src/shell/FeatureTree.tsx` | 19、22 | 直列 |
| `packages/ui/src/shell/PropertyPanel.tsx` | 11、22 | 直列 |
| `packages/help-content/src/index.ts` | 11、13、16、18、19、22 | **直列**(`topics.test.ts` が目録と実ファイルの一致を検査するため) |
| `packages/io/src/pcad/documentJson.ts` | 21 のみ | 単独 |
| `e2e/tests/sketch.spec.ts` | 23 のみ | 単独 |

**P4 との違い:** P4 は `model/src/sketch/types.ts` を 13 タスクが共有して 15 段の鎖を作った。P4b は**拘束の型を新しいディレクトリへ隔離した**ので、model 側の共有は `model/src/index.ts` への 1〜2 行の追記だけになり、4 つの組で並列に進められる。代わりに ui 側の鎖(11 → 13 → 14 → 16 → 18 → 19 → 20 → 22)が 8 段と長い。

### 6.5 依存順序に循環が無いこと

「タスク一覧と依存関係」の図のとおり**循環なし**。最長 13 段。model 側(1〜9、21)と ui 側(10〜20、22)がタスク11・12 で合流する。

### 6.6 1 タスクあたりの変更ファイル数

最大はタスク13・16・22 の 8、次いでタスク11・18・19 の 7。**すべて §4 の目安(10 ファイル)以内。** 10 を超えそうになったら担当が止めて統括へ報告する。

### 6.7 数値の導出根拠

期待値にはすべて導出を併記した。主なもの:

| 数値 | 導出 |
|---|---|
| 水平+長さ 10 → 終点 (10, 0) | v=0 かつ u²=100、初期値の u が正 |
| 直角+等しい+一致 → B = (10,0)–(10,10) | A が +X 向き、B が ⊥ かつ長さ 10、初期の v 成分が正 |
| 角度 30°+長さ 10 → (8.660254038, 5) | 10cos30° = 10·(√3/2)、10sin30° = 10·0.5 |
| 距離 10(原点固定、(3,4)から) → (6, 8) | 方向を保って 5 → 10 の 2 倍 |
| 等しい(r=3 と r=7)→ 両方 5 | 最小移動(擬似逆に近い解)、(3+7)/2 |
| 対称((2,3) と (2,−9))→ (2,6) と (2,−6) | 最小移動で v を ±3 ずつ。(3−9)/2 = −3 |
| 一致((3,4) と (7,1))→ 両方 (5, 2.5) | 最小移動なので中点 |
| 平行+長さ 10 → B の終点 (10, 5) | 平行 → v=5、長さ 10 → u=10 |
| 極 15°、距離 20 → (19.318516526, 5.176380902) | 20cos15°、20sin15° |
| 角度拘束の残差(û1=(1,0)、û2=(0,1)、θ=30°)= −0.866025403784 | 0·sin30° − 1·cos30° = −√3/2 |
| 平行の残差(d1=(10,0)、d2=(6,8))= 0.8 | 単位化してから外積: 1·0.8 − 0·0.6 |
| 直角の残差(同上)= 0.6 | 単位化してから内積: 1·0.6 + 0·0.8 |
| 平行線への吸着 → (6.1, 11.1) | û=(1,1)/√2、d=(6.2,6)、(d·û)û = ((6.2+6)/2, (6.2+6)/2) = (6.1, 6.1)、起点 (0,5) を足す |
| `root(8,3)` = 2 | 8 の 3 乗根 |
| 板厚 3 → 5 で穴径 `板厚 * 2` が 6 → 10 | 利用者の例 |
| 押し出しの体積 40×30×10 = 12000、長さ拘束 50 で 15000 | 直方体 |
| 自由度: 線分 1 本 = 4、+水平 = 3、+長さ = 2、+一致 = 0 | 変数 4 − 独立な式の数 |
| 変数 400 のガウス消去 ≒ 2.1×10⁷ 回 | n³/3 |
| 変数 200 のガウス消去 ≒ 2.7×10⁶ 回 | 同上 |

**自分で検算できない数は期待値に書かず、「担当が実測して固定し、導出を報告に書く」と明記した。** 具体的には次の 4 つ。

1. **矩形(8 変数)に一致 4・水平 2・垂直 2 を付けたときの階数**(タスク7)。手で数えると従属の有無が確定しない。
2. **長さが固定された線分の終点を引っぱったとき、始点と終点のどちらがどれだけ動くか**(タスク14)。最小移動の解が決めるので、実装の λ の値にも依存する。
3. **タイムラインを 2 段目へ戻したときの立体の体積**(タスク23 の (d))。穴の位置と径に依存する。
4. **トラッキングの候補を絞る画面距離(200 画素の見込み)**(タスク15)。狭すぎると効かず広すぎると遅いので実測で決める。

### 6.8 未確認のまま残した点(一覧)

いずれも**該当タスクの手順 1 で実測して報告する**。推測でコードを書かない。

| # | 事項 | 確かめる場所 |
|---|---|---|
| 1 | 半角カタカナ(U+FF66〜)を変数名に許すか | タスク1 手順1 |
| 2 | `version.test.ts` が `EXPRESSION_SYNTAX_VERSION` を固定しているか | タスク1 手順5 |
| 3 | `SolidFeature` / `ReferenceFeature` / `PlaneSpec` の「式を持つ欄」の総数 | タスク3 手順1 |
| 4 | `SketchErrorCode` を網羅している箇所の一覧 | タスク4 手順1 |
| 5 | `Math.hypot` と `Math.sqrt` のどちらを残差に使うか | タスク5 手順1 |
| 6 | 階数の判定で列の正規化が要るか(変数の単位が mm と無次元で混ざる) | タスク7 の落とし穴 |
| 7 | `resolvePart.ts` でスケッチを解いている箇所の数 | タスク8 手順1 |
| 8 | 「他のフィーチャーを指す欄」の総数 | タスク9 手順1 |
| 9 | `packages/ui/**` の `evaluateExpression(` の呼び出しの数(変数表を渡す先) | タスク11 手順1 |
| 10 | 角度拘束の選択の順序に意味を持たせるか | タスク12 の落とし穴 |
| 11 | 拘束の印を 1 つのメッシュにまとめる方法(`InstancedMesh` かスプライト) | タスク13 の落とし穴 |
| 12 | ドラッグ中の 1 フレームが 16ms に収まるか(収まらなければ間引く) | タスク14 手順6 |
| 13 | トラッキングの候補を絞る画面距離 | タスク15 の落とし穴 |
| 14 | `SnapKind` を網羅している箇所の一覧 | タスク16 手順1 |
| 15 | `Space` に既存の割り当てが無いか | タスク18 の落とし穴 |
| 16 | どの道具までコマンドラインの語を割り当てるか | タスク17 手順1 |
| 17 | 着手時の `PART_SCHEMA_VERSION` / `PCAD_SCHEMA_VERSION` の実際の値 | タスク21 手順1 |
| 18 | 着手時の E2E の件数とヘルプ目録の件数 | タスク23 手順1、タスク22 |

### 6.9 統括への確認事項

§0 に **20 件**、うち**利用者の好みに関わるもの 7 件**(§0.7、§0.8、§0.10、§0.12、§0.14、§0.15、§0.18)。優先順位(依存が多く・後続への影響が大きい順):

1. **§0.1(拘束の解き方)** ── 要件§12 の未決事項そのもの。タスク4〜8 のすべての前提で、**これが決まらないと P4b の半分が着手できない**。
2. **§0.2(何を変数にするか)・§0.4(解を保存するか)** ── 拘束と既存の「式で座標を書く」流儀の関係を決める。タスク4・8・14 の設計の骨格。
3. **§0.16(変数名に日本語を許すか)** ── **式エンジンの字句解析の変更を伴う**(記法の版が上がる)。タスク1 の着手可否。**要件 FR-207 の例そのままの名前がいま使えない**(§1.5-1)ので、許さない決定なら要件の例の書き換えが要る。
4. **§0.17(スキーマ版)** ── **P4 タスク31(版 4)が未着手**(§1.5-3)。P4 を先に閉じるかどうかの判断を含む。
5. **§0.8・§0.15・§0.18(コマンドライン・パラメータ表・タイムラインの置き場)【利用者に確認】** ── **§0.18 は `rules/04` の「固定区画を増やさない」と要件 FR-507 の「画面下に」が正面から衝突する**ので、利用者の決定が要る。
6. **§0.3(2D だけにするか)・§0.5(保存先)・§0.6(半径も変数にするか)** ── タスク4 の型を決める。
7. **§0.7・§0.12・§0.14【利用者に確認】** ── 見た目の好み。タスク13・16 の着手前。
8. **§0.10【利用者に確認】** ── 打つ語と焦点のキー。タスク17 の着手前。
9. その他(§0.9、§0.11、§0.13、§0.19、§0.20)は各タスクの着手前に個別に読み直せば足りる。

### 6.10 懸念(統括へ)

1. **P4 が未完了のまま P4b の計画を書いている。** HEAD `6084a56` の時点で P4 のタスク 22・24・25・31・33・34・35b・36 が残っており、そのうち 25(投影・交差)は `resolvePart.ts` を、31 は `documentJson.ts` を、33 は `FeatureTree.tsx` / `PropertyPanel.tsx` / `featureSummary.ts` を触る。**P4b のタスク8・21・22 と正面から重なる。** P4b は P4 の完了後に着手する前提で書いたが、着手時に §1 の実在確認をやり直すことを各タスクの手順1 に入れた。

2. **拘束ソルバーは P4b で最もリスクが高い。** 理由は 3 つ。①**自前の数値解法**なので、収束しない・遅い・直感と違う動きをするといった問題が実装してみないと分からない。②**期待値のいくつかが「最小移動の解」に依存**しており、λ の値や実装の細部で変わりうる(§6.7 の自分で検算できない数 2)。③**引っぱる操作は毎フレーム解く**ので、性能の余裕が小さい。**タスク6 の実測(変数 100 で 8ms)が通らなければ、変数の上限を下げるか、ドラッグ中は間引くかの判断が要る。**

3. **`rules/04` の「固定区画を増やさない」と要件 FR-507 / FR-208 の「画面下に」が衝突する。** §0.8 は既存のステータスバーへ埋め込む案で回避できるが、§0.18(タイムライン)は帯としての高さが要るので、案 B(ツリーの中)にしないと区画が 6 つになる。**利用者の決定次第では規約の該当行を書き換える必要がある**(利用者の明示指示 > `rules/` の優先順位、`CLAUDE.md`)。

4. **拘束の対象を線分と円/円弧に限った。** 楕円・スプラインに接線・等しいを付けることは §6.1 で範囲外にした。理由は、楕円の「半径」が 2 つあり「等しい」の意味が決まらず、スプラインには半径が無いため。**利用者が楕円へ拘束を付けようとしたときに「この形には付けられません」と断る**ことになるので、ヘルプ(タスク13)へ明記する。

5. **パラメータ表が部品文書に 1 つなので、複数のスケッチ・複数の部品をまたいだ共有はできない。** アセンブリ(P7)で部品どうしが同じ寸法を共有したくなったとき、この設計では足りない。**P7 の着手時に見直す前提で、`Parameter` の型は「文書に属する」以外の前提を持たせない**(id ではなく名前で引く形にしてある)。

6. **日本語の変数名は IME との噛み合いが未確認。** Electron のレンダラで「板厚」と打つとき、変換の確定の `Enter` が式の欄の確定を横取りしないか。P4 までの欄はすべて半角の式だけを打つ前提だったので、この経路は一度も通っていない。**§5.3 の目視で必ず確かめる。** 問題があれば `compositionstart` / `compositionend` を見る対処が要る(タスク11 の範囲外なので、見つかったら別タスクへ切り出す)。

7. **`documentUpTo` が形状キャッシュの鍵を変えないことが、タイムラインの体験のすべてを決める。** 複製を作ってしまうと、つまみを動かすたびに 100 段の再計算が走り(P3 実測で初回 953ms〜12.6 秒)、「途中まで戻して確かめる」という機能の意味が失われる。**タスク9 の落とし穴に書いたが、実装で最も外しやすい点。**

8. **ヘルプ 5 本は「内部用語を出さない」という規約と相性が悪い題材である。** 拘束・パラメータ・タイムラインはどれも仕組みの説明をしたくなる。タスク22 に禁じ手の語の一覧を置いたが、**書き上がったものを統括が読んで判断する**のが確実。

---

## 7. P5 への申し送り

P4b で作るもののうち、P5(高度なソリッド・外観と測定)以降に関わる点。**P4b のタスクにこれらの実装は 1 つも含めない。**

| # | 何を残すか | 該当タスク | なぜ P4b で決めたか |
|---|---|---|---|
| (a) | `PartDocument.parameters` と `reevaluatePartDocument`(文書の全式を歩く関数) | 2、3 | P5 が足す基本形状・切断・外観のフィーチャーも `ExpressionValue` を持つので、**`reevaluatePart.ts` の `switch` に 1 case 足すだけ**で変数が使えるようになる。逆に足し忘れると「値を変えても追従しない欄」ができるので、**P5 の各タスクの受け入れ条件に「`reevaluatePartDocument` の網羅を更新した」を入れる**。 |
| (b) | `timelineOrder.ts` の `dependenciesOf`(他のフィーチャーを指す欄の一覧) | 9 | P5 の切断(FR-432)・直接編集(FR-433)は新しい依存の欄を作る。**同じく 1 case 足すだけ**で並べ替えの検査に乗る。 |
| (c) | 拘束の型を `sketch/constraints/` へ隔離したこと | 4〜8 | P7 のアセンブリの合致拘束(FR-603)は「部品どうしの拘束」で、変数が剛体変換(6 自由度)になる。**残差とソルバー(`residuals.ts` / `solve.ts`)は変数の意味に依存しない**ので、`solve.ts` はそのまま使い回せる見込み。ただし**設計は P7 の計画で判断する**。 |
| (d) | `SnapKind` に向きの種別を足した形 | 16 | P5 の球面グリッド(FR-431)の交点への吸着も同じ一覧に並ぶ。**候補の型を「点」と「向き」に分けた**ので、球面上の点は「点の候補」として素直に足せる。 |
| (e) | コマンドラインの語の表(`COMMAND_WORDS`) | 17 | P5 以降で道具が増えるたびに 1 行足す。**短縮の重複を検査で固定してある**ので、重複する短縮を足すと落ちる。 |
| (f) | 変数名に日本語を許した(記法の版 2) | 1 | P6 のテンプレートと単位(FR-814)、P8 の図面の寸法もパラメータを参照する。**版 1 のファイルは版 2 でも読める**ので互換の心配は無い。 |

**P4b の担当への注意:** 上記 (a)〜(f) 以外は P5 以降の設計に踏み込まない。基本形状・切断・直接編集・アセンブリの合致拘束の実装は P4b のどのタスクにも含めない。

---
