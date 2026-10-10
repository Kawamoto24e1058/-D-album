# 思い出アルバム3D

1枚の写真を、傾けて覗き込める3Dにする Web アプリです。現在は **Phase 0（品質検証）** の段階です。

- 写真は端末の中だけで処理し、サーバーに送信しません
- 深度推定: Depth Anything V2 Small（Transformers.js、WebGPU / WASM）
- 表示: three.js

## 開発

```sh
npm ci --ignore-scripts   # onnxruntime-node のネイティブバイナリ取得を省く（ブラウザでは不要）
npm run dev
npm run build
```

スマホ実機でジャイロを試すときは `HTTPS=1 npm run dev -- --host` で起動します。

## ドキュメント

- [決定事項](docs/decisions.md)
- [Phase 0 の手順](docs/phase0.md)
- [ライセンス一覧](docs/licenses.md)

## デプロイ

Vercel に静的サイトとしてデプロイします。ヘッダ（COOP/COEP、CSP、キャッシュ）は `vercel.json` で設定しています。
