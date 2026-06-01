# Contributing

PVA Source-Filter Simulation への貢献を歓迎します。バグ報告・機能提案・PR、どれも大歓迎です。

## 開発環境

ビルド不要・依存ゼロ。ローカルサーバーを立てるだけで動きます。

```bash
cd docs && python3 -m http.server 8081
# http://localhost:8081 を開く
```

## プロジェクト構成

| ファイル | 役割 |
|---|---|
| `docs/index.html` | PC 版 UI |
| `docs/mobile.html` | モバイル版 UI |
| `docs/main.js` | **PC・モバイル共有**の全ロジック |
| `docs/style.css` / `docs/mobile.css` | 各版のスタイル |
| `docs/recordings-db.js` | IndexedDB 録音ストア |
| `docs/sw.js` | Service Worker |

## コーディング規約

- **`main.js` は PC・モバイル両方から読み込まれます。** 片方にしか存在しない DOM 要素は `if (els.xxx)` で **null チェック必須**。
- `<input type="range">` には `touch-action: none` を付与（iOS Safari のスクロール横取り対策）。
- `mobile.html` のインラインスクリプトで `const` をグローバルに置くと `main.js` の同名変数と衝突してクラッシュします。**ブロックスコープ `{}` または IIFE で囲む**こと。
- コメントは英語、UI は日英混在（セクション名＝英語、説明＝日本語）。
- 外部ライブラリへの依存は原則追加しない（素の HTML/CSS/JS を維持）。

## 動作確認

変更は **PC 版とモバイル版の両方**で確認してください。マイク入力・録音再生・解析に関わる変更は、**実機（特に iOS Safari）での確認**を推奨します。

## プルリクエストの流れ

1. 大きな変更は、まず Issue で議論
2. ブランチを切って変更
3. PC / モバイル両方で動作確認
4. PR テンプレートに沿って PR を作成

## バージョニング

セマンティックバージョニング（`vMAJOR.MINOR.PATCH`）。リリース時は `docs/sw.js` の `VERSION` と `docs/main.js` の `APP_VERSION` を更新します（Service Worker のキャッシュ更新のため）。
