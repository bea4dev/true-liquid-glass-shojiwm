# LiquidIslandQS

QuickShell / Qt 6 用の、半透明の島がクリックで分離・合体するデモです。
小さい形が主形状の内側から右へ移動・成長し、滑らかな接続が細くなって分離します。
クリックごとに島が「1個 → 2個 → 3個 → 2個 → 1個」と変化します。
２つ目の子は１つ目の子から右へ派生し、右端から逆順に収納されます。
途中でクリックしても現在の位置・サイズから次の状態へ向かいます。ShojiWM設定の変更は不要です。
ただし右端の子を回収中は、その幅・高さが元の10%以下になるまで親の回収クリックを無視します。
クリックの予約はしません。条件を満たした後に再度クリックすると回収します。
`recoveryRemainingRatio` で許可する残りサイズの割合を調整できます。
回収中の子は親の現在位置にも追従し、親が動いても縮小途中の子を取り残しません。

## 起動

QuickShell、Qt Quick、Qt 6 Shader Tools (`qsb`) が必要です。

```sh
cd ~/Documents/development/LiquidIslandQS
bash run.sh
```

画面上部に表示されます。島をクリックして切り替え、起動した端末で Ctrl+C で終了します。
既存のQuickShell設定とは別のパス・namespaceで起動します。
ウィンドウ外のクリックは透過します。島の周囲と島同士の間は、小さな長方形の操作領域です。
このデモは画面領域を予約せず、通常は既定の画面に１つだけ表示します。

## 構成・調整

- `components/LiquidShape.qml`: グループ内座標の `x`, `y`, `width`, `height`, `radius`, `presence`。
- `components/LiquidLabel.qml`: `shape` に所属する中央揃えの文字。形状の `retiring` がtrueになると即座に非表示。
- `components/LiquidGroup.qml`: 最大８形状を滑らかに合成。`shapes` リスト、`blendRadius`、`tint` を指定。
- `components/IslandDemo.qml`: 個別アニメーションとクリック処理。`duration`、`easingType`、`easingBezierCurve`、`blendRadius` を調整可能。
- `shell.qml`: 表示位置、サイズ、入力領域、namespace (`liquid-island-qs`)。
- `shaders/liquid.frag`: 丸角長方形の距離関数をsmooth minimumで合成し、境界をアンチエイリアス処理。

デモの遷移時間は1000ms、曲線は `cubicBezier(0.1, 0.9, 0.2, 1.0)` です。
QMLでは `Easing.BezierSpline` と `[0.1, 0.9, 0.2, 1.0, 1.0, 1.0]`（末尾は終点）で指定しています。
子の島は幅・高さ0から現れ、復帰時も0へ縮みます。移動と拡大の時間・曲線を揃え、
移動より先に拡大して主形状を膨らませるのを抑えています。

`LiquidShape` は描画しない形状データです。QMLの `Behavior` / `NumberAnimation` を各プロパティに
設定して個別に動かせます。共通の進行度から各プロパティを計算する使い方もできます。
丸は `width == height`、`radius == width / 2` で表現します。
`presence` は0〜1で中心へ縮める値で、0では合成から除外します。色の透明度とは別です。
角丸半径はシェーダー側で幅・高さの半分までに制限します。

形状はグループ内に十分な余白を取って配置してください。滑らかな合成は元の輪郭より膨らみます。
複数形状の合成はリスト順で行うため、３つ以上の形状では順序によって接続部が変わり得ます。
移動途中の再クリックで位置は連続ですが、速度まで連続にする物理アニメーションではありません。
半透明の色は重なりを合成した後で１回だけ塗るので、接続部だけ濃くなりません。
文字は背景形状とは独立したQML要素です。
主島自体は回収しないため「Liquid Island」は表示を維持します。子島へ文字を追加する場合も
`LiquidLabel { shape: 対象のLiquidShape; text: "..." }` とすれば回収開始時に即座に消えます。

## ShojiWMとの関係

このプロジェクトは背景屈折・Liquid Glassを実装せず、半透明の動的シルエットを提供します。
既存のShojiWM設定で全レイヤーに背景ブラーが付いている場合、本デモにも既存のブラーは適用されます。
面のアルファは既定で0.58、外側は0なので、後から `layerSource()` でマスクとして取得できます。
ラベルも同じサーフェスに含まれます。専用マスク検証時はラベルを外すか別サーフェスへ分離してください。
Qt QuickのGPUバックエンドが必要です（softwareバックエンドはShaderEffect非対応）。
