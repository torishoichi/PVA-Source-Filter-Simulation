# 付録 (Appendices)

## Appendix 1: Madde Explorations (Maddeによる探求)

### Madde Exploration 1: The Unresonated Voice Source (共鳴のない音源)
「Show formants/partials（フォルマント/部分音を表示）」ボックス（キーボードのすぐ右上、右下）にチェックを入れます。
「formants（フォルマント）」ボックス（左上、F1[Hz], F2[Hz]...とある箇所）のチェックを外します。
キーボードの中央C（黒い点でマークされたC4）以下のピッチをクリックして、倍音セットを鳴らします。
キーボードのすぐ上に、選択したピッチの倍音を表す番号付きの線が表示されます（図18.1参照）。
再生矢印（左上）をアクティブにします。
これは、共鳴のない倍音セットが、開放空間にさらされた場合にどのように聞こえるか（ピッチのあるバズ音）を近似しています。
おそらく、この魅力のない音をすぐに止めたくなるでしょう。

### Madde Exploration 2: The Effect of Mode of Phonation and Range on Source Harmonics (発声モードと音域が音源倍音に与える影響)
Madde Exploration 1と同様に、フォルマントボックスを無効化（チェックを外す）します。
喉頭レジスターが音源に与える影響を体験するために、ソーススペクトルエリア（右上）にある「Tilt [dB/oct]（傾き）」レベルを調整します。Tiltボックスをクリックし、キーボードの上下矢印キーを使用します。
Tiltは、倍音のオクターブあたりのパワーのロールオフ（減衰率）を表します。負の数字が大きいほど、傾きは急になります。
デフォルトのTiltは、1オクターブあたり6デシベルの減衰（つまり -6）に設定されています。
*   より「ヘディ（Headier）」なトーンは、より急なロールオフを持ちます（-12を試してください）。
*   「プレス（Pressed）」されたトーンは、より浅いロールオフを持ちます（-3を試してください）。（著者は、少なくともフォルマントが無効な状態では、正の数字を試さないことをお勧めします。）（図18.2）

これらのそれぞれについて、再生矢印（左上）をアクティブにします。
Tilt（ロールオフ）が急なほど、高い倍音が弱くなるため、音源はよりマイルドに聞こえます。
私たちの耳はまさに高い周波数の強度に最も敏感であるため、急なTilt（-12）では信号はより静かに聞こえ、浅いTilt（-3）ではより大きく（そしてより不快に！）聞こえます。
再び、音を止めたくなるでしょう。

ピッチが利用可能な倍音の数に与える影響を見るために、ソプラノのハイC（C6）まで順に高いピッチをクリックしてください。
Maddeのキーボードは、トップC（C8）がディスプレイから欠けているため、そのピッチでは3つの倍音しか表示しません。
ハイソプラノが、非トレブルボイス（高音域以外の声）とは全く異なる共鳴の課題/状況に直面していることが劇的に明らかです。

**(図18.1 キャプション)** Madde音声シンセサイザー。声道フォルマントのチェックを外し、共鳴のない倍音周波数セットを表示・再生している状態。

### Madde Exploration 3: Formant Resonation of Source Harmonics; Harmonic:formant Crossings (音源倍音のフォルマント共鳴：倍音とフォルマントの交差)
「Show formants/partials」ボックス（右下）にチェックが入っていることを確認します。
「formants」ボックス（左上）にチェックを入れます。
キーボードのすぐ上に、各フォルマントの周波数中心に対応する赤い帯が表示されることに気づくでしょう。
様々な声種や母音に合わせてフォルマント周波数を設定できます。
例えば、バスバリトンの [e] 母音のフォルマントは次のように設定できます：F1 440; F2 1400; F3 2200; F4 2500; F5 2800。
これらを設定し、スケール C3-D3-E3-F3-G3 を弾いてください。
演奏を続けると、倍音がフォルマント（キーボードのすぐ上に見える）を通過する際に、特に第1フォルマントを通過する際に、音色の変化に気づくかもしれません（これについては後述）。
声道によって共鳴された倍音は、フォルマントを取り除いた時よりもかなり心地よいことに間違いなく気づくでしょう。
他の母音は、最初の2つのフォルマントの周波数を変えることでモデル化できます（後述）。

**(図18.2 キャプション)** Madde音声シンセサイザーのTilt機能（右上のソーススペクトルボックス内）。Tiltは音源のロールオフを反映する。より急なTilt（大きな負の値）はヘディな喉頭レジストレーションをモデル化し、浅いTilt（小さな負の値）はチェスティな喉頭レジストレーションをモデル化する。

### Madde Exploration 4: Open and Close Timbre (オープンティンバーとクローズティンバー)
「Show formants/partials」ボックス（右下）がアクティブであることを確認します。
Exploration 3のバスバリトンの [e] 母音の設定（図18.3）を使用します。この例の第1フォルマント（F1）は A440 に設定されています。
以下の探求を試してください：
オープンティンバーを体験するために、F1より1オクターブ以上低いピッチを弾きます。
中央Cの1オクターブ下の C3 から始まる上昇スケールを弾きます。
第3倍音（3fo）がF1を上昇して通過するとき（つまり C3 から E3 付近）、そしてさらに顕著なのは **第2倍音（2fo）がF1を上昇して通過するとき**（G3 から B3、声の一次的な「ターニング」）に、音色の「閉鎖（Closure）」に気づくかもしれません（図18.4）。

### Madde Exploration 5: Whoop Timbre and Beyond (フープ音色とその先)
「Show formants/partials」ボックス（右下）がアクティブであることを確認します。
上記の例3, 4と同様に、バスバリトンの [e] 母音の設定を使用します。F1は A440 です。
以下の探求を続けてください：

1.  C4 から半音階で上昇します。フォルマントは調整しません。
    *   フォルマントをそのままにするということは、「歌手」が声道（喉/母音）の形を全く変えていないことを意味します。
    *   第1倍音（1fo＝基本周波数）がF1に近づくにつれて、音色はますます「クローズ（Close）」になります。
    *   そして、A4 での F1:1fo の結合（Juncture）で、完全な「フープ（Whoop）」音色が達成されます。
    *   このかなりファルセット/女性的な音色は、ソーススペクトルのTiltを調整せず、したがって音源の変化なしに、完全に倍音：共鳴（フィルター）の相互作用の変化によって、つまり**共鳴の変化のみによって**達成されたことに注目してください。
    *   これは、音源の変化（喉頭レジストレーションの変化）がこの音色に必ずしも必要ではないことを示唆しています。ただし、人間においては、これらの共鳴変化に伴って音源の変化が起こる可能性が高いことにも留意すべきです。

2.  もし 1fo を F1 (A4) より上に上げ続けると、今やカウンターテナーの「フープ」音色となったものは急速に細くなり、このポイントより上でのフォルマント・トラッキングの必要性を実証します。

**(図18.4 キャプション)** 2foがF1を超えて上昇するときの、声の一次音響レジスター移行である「ターニング・オーバー」の探求。

3.  シンセサイザーに D5 を「歌わせ」ます。F1[Hz] ボックスをクリックします。コンピュータのキーボードの上矢印を繰り返しクリックして、F1の周波数を D5 に一致するまで（赤いF1帯がピッチ D5 上の 1fo に重なるまで）徐々に上げます。音色の豊かさ/深さが戻ってくることに気づくでしょう。

4.  キーボードの下矢印をクリックして F1 を A440 に戻し、音を消します（図18.5）。

### Further Madde Explorations (さらなるMaddeの探求)
**モデリング練習とボカリーズ**
上記の練習（「母音のターニングを探求する」p.125、「fR1:1fo 移行とトラッキングを探求する」p.131 を参照）のいずれも、Madde上でモデル化できます。
これにより、主要な F1:2fo 交差、またはいかなる二次的な交差（F1:3fo, F1:4fo など）に伴う受動的な母音移行、そして F1:1fo トラッキングの音色の豊かさを近似的に実証できます。

**(図18.5 キャプション)** 1fo が F1 より上に上昇すると、音色の希薄化（Thinness）を引き起こす。

**F1/F2 Map (F1/F2 マップ)**
「Settings」メニューの下にある「Show F1/F2 map」を選択すると、母音をより流動的にモデル化し変更できます。
横軸にF1、縦軸にF2を表示するチャートが表示されます。
このマップ上でカーソルをクリック＆ドラッグすると、「声」が出ている間でも F1 と F2 の位置を操作できます。
この機能により、母音だけでなく、「歌っている」ピッチの 2fo を横切るように母音の第1フォルマントを移動させることで、母音のオープン化（Opening）とクローズ化（Closing）を探求することも可能になります。（図18.6）

**Modeling Student Voices (生徒の声のモデリング)**
もし生徒のフォルマント（音域の快適な部分から）が、おそらく VoceVista を使用して導き出されれば、さらなる探求のためにその生徒の声を Madde でモデル化できます。
例えば、非トレブル歌手の一次レジスター移行における、様々な母音での受動的母音修正をモデル化できます。
受動的修正を理解し始めるために特定の声をモデル化することは通常必要ありませんが、一部の人には役立つかもしれません。
多くの場合、同じ声種の一般的なモデルで十分です。
また、トレブルボイスの fR1:1fo トラッキングと、その結果として必要な能動的母音修正も説得力を持って実証できます。

**(図18.6 キャプション)** F1/F2 マップ（母音フォルマントマップ）。

---

## Appendix 2: Approximate F1 Locations by Voice (声種別のおよそのF1位置)

### Why Approximate First Formant Locations? (なぜおよその第1フォルマント位置なのか？)
次ページのチャートは、一般的な声種ごとの、およその第1フォルマント位置を示しています。
フォルマントのボックスは、いくつかの理由から意図的に非特定的（複数のピッチをカバーする）にされています：
一般的な声種には、ある程度の声道長の多様性に対応する様々なサブ区分があり、それらは隣接する声種やサブ区分と重複します。
例えば、ハイ・リリックバリトンはヘルデンテノールよりも高いフォルマントを持つかもしれませんし、深みのあるメゾソプラノはレッジェーロテノールよりも低いフォルマントを持つかもしれません。
声は個性的であり、そのフォルマント位置も同様です。
しかし、第1フォルマントの位置は、与えられたおよその位置からそれほど大きく外れることはなく、ある母音から別の母音へのフォルマント位置の一般的な輪郭（Contour）は比較的安定しています。
もし特異性が望まれるなら、VoceVistaを使用して特定の話声フォルマントや、話し声の音域近くで歌われた母音のフォルマントを特定することができます。
しかし、音響レジスターイベントの位置を洗練させるためには、通常、教師の耳と発声機能の安楽さと効率性で十分です。
教師が声種別のおよその位置、これらのイベントに伴う受動的母音修正、そしてこれらのイベント全体を通しての音色の一貫性（つまり、チューブの安定性）を促進する戦略を知っていれば、生徒の発声機能がさらなる調整を導いてくれるでしょう。

**(図19.1 参照)** 声種別のおよその第1フォルマント位置チャートについては、著者のウェブサイト (www.kenbozeman.com) または https://faculty.lawrence.edu/bozemank/664-2/ を参照してください。

---

## Appendix 3: Events Surrounding the Lower Passaggio (下方パッサッジョ周辺のイベント)

**(図20.1 参照)** 下方パッサッジョ周辺の音響イベントについては、著者のウェブサイト (www.kenbozeman.com) または https://faculty.lawrence.edu/bozemank/644-2/ を参照してください。

---

## Appendix 4: Recorded Exercise Examples (録音された練習例)

以下のURLで入手可能: http://www.kenbozeman.com/appendix-4---video-contents.php

これらのサンプル探求は、初版の出版年に、様々な発達段階にある学部生たちと共に作成されました。
これらは議論されている音響現象を合理的に良くモデル化していますが、彼らも著者も、トレーニングが完了した歌手を代表しているとは主張しません。
著者は、教育目的のモデルとして協力してくれた彼らの意欲に非常に感謝しています。

**Exploring Vowel Turning (母音のターニングを探求する - 第14章 p.125 参照)**
*   Example 1. Leaps across the turn (ターンを跨ぐ跳躍)
*   Example 2. Leaping and stepping across the turn (ターンを跨ぐ跳躍と順次進行)
*   Example 3. Levels of turning (ターニングのレベル)
*   Example 4. Repeated note from close to open to close (同音反復：クローズからオープンへ、そしてクローズへ)
*   Example 5. Same vowel across multiple levels (複数のレベルにわたる同じ母音)
*   Example 6. Turning with agility (アジリティを伴うターニング)
*   Example 7. Descending and ascending through the turn (ターンを通る下降と上昇)
*   Example 8. Ascending and descending through the turn (ターンを通る上昇と下降)

**Exploring fR1:1fo Transition and Tracking (fR1:1fo 移行とトラッキングを探求する - 第14章 p.131 参照)**
*   Example 9. Repeated note (同音反復)
*   Example 10. Leap up to open vowel, repeated to close vowel (オープン母音への跳躍、クローズ母音への反復)
*   Example 11. Leap up on same vowel (同じ母音での跳躍)
*   Example 12. Stepwise Ascent and Descent (順次進行の上昇と下降)

---

## Appendix 5: YouTube Examples (YouTubeの例)

入手先: http://www.kenbozeman.com

YouTubeの例を引用することには、引用された場所の不安定さ（削除される可能性など）を含む固有のリスクがあります。
この印刷の時点で、これらの引用された場所は数年間安定して利用可能でした。
その教育的価値は、潜在的な不安定さに対する著者の懸念を上回りました。
引用された録音のほとんどは、他の形式でも見つけることができます。（太字はYouTubeのタイトル）

*   **Example 1:** Leontyne Price “Beim Schlafengehen” Strauss’ Vier Letzte Lieder
    *   https://www.youtube.com/watch?v=ItAmRzPTEdY&t=590s
*   **Example 2:** Nicolai Gedda canta Rachmaninov II
    *   http://www.youtube.com/watch?v=AFa9hgb0tmI&t=2m50s
*   **Example 3:** José Van Dam sings Kaddish by Ravel
    *   http://www.youtube.com/watch?v=IAiWPrhxlpc&t=3m45s
*   **Example 4:** Jussi Björling, Ah, Love But A Day
    *   Piano version: https://www.youtube.com/watch?v=WCElu55_Efc
    *   Orchestral version: Jussi Björling sings “Ah Love, but a day”
    *   http://www.youtube.com/watch?v=4TWoHdA085g&t=0m23s
*   **Example 5:** Jussi Björling—“Ombra mai fu”—Atlanta 1959
    *   https://www.youtube.com/watch?v=pyHaucoWd4Q&t=112s
*   **Example 6:** George London sings Schubert—“An die Musik”
    *   https://www.youtube.com/watch?v=YUxZlDekIk4
*   **Example 7:** Pavarotti about covered sound
    *   https://www.youtube.com/watch?v=3JIVs9FZ8sQ
*   **Example 8:** How to sing bel canto 2/2 (see 0:30–1:15):
    *   http://www.youtube.com/watch?v=XPplK22nSXY&t=0m30s
*   **Example 9:** How to sing bel canto 1/2 (see 3:14–3:55):
    *   https://www.youtube.com/watch?v=3nH54BdqWpg&t=194s
*   **Example 10:** Rockwell Blake describes dark timbre and passaggio
    *   (残念ながら、Example 10 は現在利用できません)
