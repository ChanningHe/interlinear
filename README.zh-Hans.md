# Browser Translate

[English](README.md) | 简体中文 | [日本語](README.ja.md)

适用于 Chrome 和 Firefox 的网页双语翻译扩展，文本只发送给你配置的模型。

## 特性

- 双语对照或仅显示译文。译文显示在每个段落下方，保留链接和行内格式。
- 只翻译正文，不翻译导航、广告、悬浮提示、用户名和时间。
- 随滚动翻译，后加载的内容也会补上；关闭翻译后页面完全恢复原样。
- 可以只翻译一个段落（鼠标指向时轻按 Ctrl）、选中的文字，或输入框里刚写的内容（连按三次空格）。
- 支持 OpenRouter、OpenAI、Anthropic、Gemini、DeepSeek、Ollama、LM Studio 以及任意 OpenAI 或 Anthropic 兼容接口，也可以用 ChatGPT 账号登录，使用订阅额度。
- 每种服务有自己的设置，默认值针对翻译调整，例如推理强度和 OpenRouter 的服务商偏好。
- 术语表、自定义指令、13 种译文样式，以及总是翻译的网站。
- 没有账号、遥测和远程配置。请求从浏览器直接发往你的接口，网站访问权限按网站逐个申请，发布的代码未经压缩。
- 界面支持英语、简体中文、繁体中文和日语。

## 安装

从 [Releases](../../releases) 下载对应浏览器的 zip。

- Chrome / Edge：解压后打开 `chrome://extensions`，开启开发者模式，点击“加载已解压的扩展程序”，选择解压出的文件夹。
- Firefox 128+：打开 `about:debugging#/runtime/this-firefox`，点击“临时载入附加组件”，选择 zip 文件。Firefox 重启后会移除临时附加组件。

从源码构建（需要 Node.js 22.18 或更高版本）：

```bash
npm ci
npm run build
```

生成的 `dist/chrome` 和 `dist/firefox` 按同样的方式加载。

## 开始使用

安装后会打开设置页。添加一个服务，用 API Key、ChatGPT 登录或本机服务连接，选择模型后点击“测试”。

Alt+T 翻译页面或恢复原文，Alt+O 在双语和仅译文之间切换，Alt+P 翻译鼠标所在的段落。快捷键可以在设置中修改。

使用 Ollama 时如果请求被拒绝，设置 `OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*` 后重启 Ollama。

## 开发

```bash
npm test
npm run typecheck
CHROMIUM=/path/to/chromium npm run e2e
```

发布新版本时运行 `just release 1.2.3`：它会修改版本号、运行检查、提交并打上 `v1.2.3` 标签，推送标签后会自动发布。

## 许可证

[MIT](LICENSE)
