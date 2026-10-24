# Browser Translate

[English](README.md) | [简体中文](README.zh-Hans.md) | 日本語

Chrome と Firefox 向けの対訳ウェブページ翻訳拡張機能です。テキストは自分で設定したモデルにだけ送られます。

## 特徴

- 対訳表示と訳文のみの表示。訳文は各段落の下に表示され、リンクや文中の書式も保たれます。
- 本文だけを翻訳し、ナビゲーション、広告、ツールチップ、ユーザー名、日時は翻訳しません。
- スクロールに合わせて翻訳し、後から読み込まれた内容にも対応します。翻訳をやめるとページは元どおりに戻ります。
- 段落ひとつ（ポインタを合わせて Ctrl を軽く押す）、選択したテキスト、入力欄に書いた文（スペースを 3 回押す）だけを翻訳することもできます。
- OpenRouter、OpenAI、Anthropic、Gemini、DeepSeek、Ollama、LM Studio、OpenAI または Anthropic 互換のエンドポイントに対応し、ChatGPT でサインインしてプランの利用枠を使うこともできます。
- サービスごとの設定は翻訳向けに調整済みです。推論の強さや OpenRouter のプロバイダー優先度などを変更できます。
- 用語集、カスタム指示、13 種類の訳文スタイル、常に翻訳するサイト。
- アカウント、テレメトリ、リモート設定はありません。リクエストはブラウザから設定したエンドポイントへ直接送られ、サイトへのアクセスはサイトごとに許可を求めます。配布するコードは圧縮していません。
- 表示言語は英語、簡体字中国語、繁体字中国語、日本語に対応しています。

## インストール

[Releases](../../releases) からブラウザに合った zip をダウンロードします。

- Chrome / Edge：zip を展開し、`chrome://extensions` を開いてデベロッパーモードをオンにし、「パッケージ化されていない拡張機能を読み込む」で展開したフォルダを選びます。
- Firefox 128 以降：`about:debugging#/runtime/this-firefox` を開き、「一時的なアドオンを読み込む」で zip を選びます。一時的なアドオンは Firefox の再起動時に削除されます。

ソースからビルドする場合（Node.js 22.18 以降）：

```bash
npm ci
npm run build
```

`dist/chrome` と `dist/firefox` が作られるので、同じ方法で読み込みます。

## 使い方

インストールすると設定ページが開きます。サービスを追加し、API キー、ChatGPT のサインイン、またはローカルサーバーで接続してから、モデルを選んで「テスト」を押します。

Alt+T でページを翻訳または原文に戻し、Alt+O で対訳と訳文のみを切り替え、Alt+P でポインタの下の段落を翻訳します。キーは設定で変更できます。

Ollama でリクエストが拒否される場合は、`OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*` を設定して Ollama を再起動してください。

## 開発

```bash
npm test
npm run typecheck
CHROMIUM=/path/to/chromium npm run e2e
```

## ライセンス

[MIT](LICENSE)
