# Lineo 线描小画家

给 3 到 10 岁孩子用的涂色线稿生成器。在 iPad 或手机上拍一张照片（或上传图片），AI 会去掉背景，把主体重新画成干净的黑白涂色线稿。生成后可以：

- 用橡皮擦掉多余的线，用画笔补线，随时撤销
- 拖动、双指缩放图案，选择竖版或横版（A4 比例）
- 在左上角显示彩色原图小样，方便孩子对照涂色
- 保存为 PNG，在相册里打印或用涂色 App 打开

## 工作方式

```
iPad / 手机浏览器  ──照片──▶  Lineo 后台（本仓库 server/）  ──照片 + API key──▶  OpenAI 或 Google Gemini
                   ◀─线稿──                                ◀──────线稿──────
```

API key 只保存在后台服务器的环境变量里，网页拿不到。提示词也固定在后台，别人无法借你的 key 生成其他内容。后台不保存任何照片。

## 本地运行

需要 Node.js 20.6 或更新版本，没有其他依赖。

```bash
cp .env.example .env      # 填入 OPENAI_API_KEY 或 GEMINI_API_KEY，并设置 APP_PASSCODE
npm run dev               # 打开 http://localhost:8787
```

同一个 Wi-Fi 下的 iPad 可以用 `http://电脑的局域网IP:8787` 访问。

## 配置项

| 变量 | 说明 |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI 的 API key |
| `GEMINI_API_KEY` | Google Gemini 的 API key（两个都填时，网页上可以选择） |
| `AI_PROVIDER` | 默认服务：`openai` 或 `gemini` |
| `OPENAI_MODEL` | 默认 `gpt-image-2` |
| `OPENAI_QUALITY` | `low` / `medium` / `high`，默认 `medium`，越高越贵 |
| `GEMINI_MODEL` | 默认 `gemini-3.1-flash-image` |
| `APP_PASSCODE` | 访问口令。设置后网页要输入口令才能生成，**部署到公网时一定要设置** |
| `RATE_LIMIT_PER_HOUR` | 每个 IP 每小时最多生成几张，默认 30 |
| `TRUST_PROXY` | 部署在 Render、Railway、Fly.io 等平台时设为 `1` |
| `PORT` | 端口，默认 8787 |

## 部署到公网（让 iPad 随时能用）

任何能跑 Node.js 或 Docker 的平台都可以，例如：

- **Render**：New → Web Service → 选这个仓库，Build Command 留空，Start Command 填 `npm start`，在 Environment 里填上面的变量。
- **Railway / Fly.io / 自己的服务器**：用仓库里的 `Dockerfile` 构建即可。

部署后用 iPad 的 Safari 打开网址，点“分享 → 添加到主屏幕”，就能像 App 一样使用。

## 测试

```bash
npm test
```

测试用一个假的 OpenAI / Gemini 服务跑完整的后台流程，不需要 API key，也不会产生费用。

## 文件结构

```
public/index.html   网页（单文件，包含编辑工具）
server/server.js    后台服务，零依赖
test/               自动测试
```
