# 決定事項（2026-10-10）

要項書の未決事項のうち、実装に先立って決めた内容です。用途は「個人利用／卒業制作」を前提にしています。受託・販売になった場合は「用途が変わったとき」を見直してください。

| 論点 | 決定 | 理由 |
|---|---|---|
| ホスティング | Vercel Hobby（静的サイト） | 個人・非商用であれば無料。バックエンドなし |
| 重みの配信元 | Phase 0〜2 は Hugging Face CDN。Phase 4 で自前配信（Vercel 同梱または R2）に切り替えるか判断する | 初期は設定不要で動かすことを優先する |
| onnxruntime の wasm | ビルドに同梱（Transformers.js v4 は `dist/assets` に出力する） | 外部 CDN に依存しない |
| ヘッダ | COOP `same-origin` + COEP `credentialless`、CSP、`/assets` は `immutable` | WASM マルチスレッド用の cross-origin isolation。CSP で外部への通信先を限定する |
| データ保持 | `navigator.storage.persist()`、zip エクスポート/インポート、PWA 化（Phase 2） | Safari はしばらく使われていないサイトの保存データを消すことがある |
| 入力形式 | JPEG / PNG / WebP。HEIC は読めない環境で変換を案内する | Safari 以外では HEIC をデコードできないことがある |
| EXIF | canvas に描き直して再エンコードし、EXIF を丸ごと捨てる。撮影日時だけは Phase 2 で読み取り、日付の初期値にする | 位置情報を確実に消せる |
| 方式B（SHARP） | Phase 3 まで保留。`.ply` などはリポジトリに入れず、ローカルからインポートする | 重みのライセンスが未確定。重みと出力を再配布しない |
| アクセス解析 | 入れない | 「外部に送信しない」を守る |
| アルバム操作 | 削除と撮影日順の並びを MVP に追加する | 要項書から漏れていた |

## 用途が変わったとき

- **受託・販売**: Vercel Pro か Cloudflare Pages + R2 に移す。方式Bは使わない
- **贈り物**: zip エクスポート/インポートを「受け渡し機能」として必須にする

## 要確認（実装中に確かめる）

- Vercel Hobby の転送量上限と、1ファイルあたりのサイズ上限（重みを同梱する場合）
- Safari の COEP `credentialless` 対応。非対応なら WASM はシングルスレッドで動く
- iPhone の Safari でファイルを選んだとき、HEIC が JPEG に変換されて渡されるか
- 要項書に書いた対応ブラウザのバージョン（MDN / caniuse で確認）
