---
name: source-filter-web-analytics-status
description: source-filter アプリのアクセス計測状況と本番デプロイ構成
metadata:
  type: project
---

**2026-05-31: simulation(Workers) に本番一本化し、Web Analytics 計測を開始した。**

- 本番 URL: `source-filter-simulation.tori-shoichi.workers.dev`（Workers / Static Assets / GitHub `PVA-Source-Filter-Simulation` 連携で自動デプロイ）
- Cloudflare Web Analytics beacon（**siteTag: `2279b3f22c82463ba5687550c972e9a8`**）を `docs/index.html`・`docs/mobile.html` の `</head>` 直前に設置。v1.9.0 として push→自動デプロイ済み。これ以降のアクセス（PV・訪問者・国・参照元・デバイス）が記録される。

**デプロイ構成の真相（ハマりどころ）**: 当初 `recording.pages.dev` と `simulation.workers.dev` の2デプロイがあり「別アプリ」と認識されていたが、実体は**同一 GitHub リポジトリ `PVA-Source-Filter-Simulation`・同一 `docs/` ソースの2系統デプロイ**（Workers=GitHub連携自動 / Pages=ローカルから wrangler direct upload）。ビルドなしの素HTMLで siteTag を出し分けられないため simulation に一本化。recording(Pages) は今後不使用で、その Web Analytics サイト登録は削除予定。

**Workers Static Assets はリクエストメトリクスが出ない**（ダッシュボードに "Metrics is unavailable for Workers with only static assets"）。だからアクセス計測は Web Analytics(beacon) が唯一の手段だった。

**アクセス数の CLI 取得**: `rumPageloadEventsAdaptiveGroups(filter: {siteTag: "2279b3f22c82463ba5687550c972e9a8", datetime_geq, datetime_lt}) { count sum { visits } dimensions { countryName } }`。取得手順の詳細は [[cloudflare-analytics-cli-access]]。データ反映は beacon 動作から数分ラグ、Workers analytics の遡及は最大32日。

アクション傾向（操作イベント）の計測は PV が貯まってから最小限を設計する方針（後回し）。送るなら匿名集計のみ・録音内容は送らない前提。デプロイ事情は [[deploy_cloudflare_pages_direct_upload]]。
