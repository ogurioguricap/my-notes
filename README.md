# 我的笔记 · 纯前端笔记站

> 🌐 **在线地址：https://ogurioguricap.github.io/my-notes/**（已发布，手机 / 平板 / 电脑直接打开）
> 📦 仓库：https://github.com/ogurioguricap/my-notes

一个**没有后端、没有框架、没有构建依赖**的个人笔记网站。内容写成 Markdown，一条命令生成网页，推到 GitHub 就有一个手机/平板/电脑都能打开的网址。

## 它长什么样

- **三栏阅读**：左边分类导航，中间正文，右边本页目录（滚动自动高亮）
- **实时搜索**：标题 / 正文 / 标签 / 分类，**连图片里的文字和 PDF 正文也能搜到**
- **知识图谱**：笔记之间的 `[[双链]]` 和同标签关系可视化，节点可拖动整理
- **时间线**：按时间倒序翻笔记
- **三套排版随时切换**：极简 / 技术 / 杂志（记住你的选择）
- **深浅色**：浅 / 深 / 跟随系统（记住你的选择）
- **手机适配**：抽屉式导航、字号与行距自动调整、图片点击放大、可加桌面图标离线看

## 目录结构

```text
notes-site/
├── content/                    ← 只改这里
│   ├── home.md                 首页置顶说明
│   ├── 01-markdown-语法速查.md
│   ├── 02-随机过程-马尔可夫链建模.md
│   ├── 03-数模方法速查卡.md
│   ├── 04-GitHub-Pages部署与更新.md
│   ├── assets/                 图片、PDF 等附件
│   └── _extracted.json         附件文字提取结果（图片 OCR / PDF 文本）
│
├── tools/
│   ├── update.mjs              一键更新：提取 → 构建 → 自检 → 测试 → 提交 → 推送
│   ├── deploy-github.mjs       授权后自动部署：建仓库 → 推送 → 开 Pages
│   ├── build.mjs               Markdown → 网页数据（零依赖）
│   ├── extract-attachments.mjs 附件文字提取
│   ├── make-demo-image.mjs     生成演示图（自写 PNG 编码器）
│   ├── selfcheck.mjs           静态自检（DOM 契约 + 产物完整性）
│   └── test-search.mjs         检索功能实测（28 项断言）
│
├── docs/                       ← 构建产物，GitHub Pages 直接托管这一层
│   ├── index.html
│   ├── css/style.css
│   ├── js/{app,search,graph,highlight}.js
│   ├── data/index.json         所有笔记的 HTML + 目录 + 搜索索引
│   ├── assets/                 附件副本（自动复制）
│   ├── sw.js                   离线缓存
│   └── manifest.webmanifest    可"添加到主屏幕"
│
└── README.md
```

## 三步更新笔记

```bash
# 1) 新增/修改 content/ 里的 .md（图片放 content/assets/）
# 2) 生成网页数据
node tools/build.mjs
# 3) 发布
git add -A && git commit -m "notes: 新增 xxx" && git push
```

推送后约一分钟，GitHub Pages 自动重新发布，刷新手机即见。

### 或者只记一条命令

```bash
node tools/update.mjs
```

它按顺序做完全部事情，任何一步失败都不会提交：

| 步骤 | 做什么 | 失败时 |
| --- | --- | --- |
| 1 | 附件文字提取（图片 / PDF） | 跳过，不阻断 |
| 2 | 构建 `docs/data/index.json` | **中止**，不提交坏产物 |
| 3 | 静态自检 17 项（DOM 契约、标签配平、锚点、路径） | **中止** |
| 4 | 检索实测 28 项断言 | **中止** |
| 5 | `git add` + `git commit` | 报错退出 |
| 6 | `git push` | 给出三种认证方案的可复制命令，本地提交保留 |

常用参数：

```bash
node tools/update.mjs -m "新增马尔可夫链笔记"   # 自定义提交信息
node tools/update.mjs --no-push                # 只提交不推送
node tools/update.mjs --check-only             # 只检查，不碰仓库
node tools/update.mjs --print-git              # 只打印该执行的 git 命令
```

> 说明：`update.mjs` 的 1~4 步都在同一个 Node 进程内直接执行（不启动子进程），
> 因此在受限环境里也能跑完构建与检查；只有 git 操作需要子进程，若环境不允许，
> 它会自动改为打印可复制的命令，而不是报错中止。

> 改样式不用碰 JS：`docs/css/style.css` 顶部是全部变量（配色、字号、行高、内容宽度、圆角），一处改动全站生效。

## 本地预览

```bash
cd site
python -m http.server 8877 --directory docs
# 打开 http://127.0.0.1:8877
```

> ⚠️ 不要直接双击 `index.html`：浏览器对 `file://` 的 fetch 有限制，页面会提示读不到数据。必须走本地服务器或线上地址。

## 让图片 / PDF 里的文字也能被搜到

搜索的覆盖面分三层：

| 层级 | 覆盖内容 | 怎么实现 |
| --- | --- | --- |
| 1 | 标题、正文、标签、分类 | `build.mjs` 直接抽取 |
| 2 | 代码块内容（函数名、命令） | `build.mjs` 额外索引 |
| 3 | 图片里的文字、PDF 正文 | `content/_extracted.json` |

第 3 层用法：

```bash
node tools/extract-attachments.mjs   # 扫描 content/assets/，写 _extracted.json
node tools/build.mjs                 # 重建索引，文字进入正文末尾的「附件文字」区块 + 检索
```

- **PDF**：脚本内置极简解析器（解压 FlateDecode 流 + 抽文本算子），对常规 PDF 有效；扫描件需要 OCR。
- **图片**：零依赖环境无法可靠 OCR。做法是让脚本标记 `pending-ocr`，你把文字补进 `content/_extracted.json` 的 `text` 字段——补完即可被搜索命中。想全自动可以自行接入 `tesseract.js`（中文包 `chi_sim`）或第三方 OCR 接口，脚本里的注释标了接入位置。

## 笔记写法（frontmatter）

```markdown
---
title: 标题
slug: optional-slug          # 不写则取文件名
category: 分类               # 侧边栏分组 + 图谱配色
tags: [标签一, 标签二]
date: 2026-02-18             # 不写取文件修改时间
pinned: true                 # 可选，置顶首页
summary: 卡片上显示的一句话摘要
related: [home]              # 可选
---

# 正文从一级标题开始

## 二级标题会进右侧目录

正文支持：表格、任务清单 `- [x]`、代码块（自动高亮）、公式 `$...$` / `$$...$$`、
提示框 `> [!NOTE]`（支持 NOTE/TIP/IMPORTANT/WARNING/CAUTION/TODO）、
双链 `[[另一篇的标题或 slug]]`、图片放大、附件链接。

## 目录

- 标题写成「## 目录」时，紧跟的列表会渲染成卡片式索引
```

## 部署到 GitHub Pages

### 一次性设置

1. 在 GitHub 建一个仓库（建议 **Public**，免费账号的 Pages 需要公开仓库）
2. 推送代码：

```bash
git init
git add -A
git commit -m "init: 个人笔记站"
git branch -M main
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```

3. 仓库 **Settings → Pages → Source: Deploy from a branch → 分支 `main`、目录 `/site`** → Save

4. 约一分钟后的访问地址：

```text
https://<用户名>.github.io/<仓库名>/
```

> 站在任何子路径下都能正常工作：站内所有资源都用相对路径，路由用 hash（`#/note/xxx`），不需要改 base 配置。
> 如果仓库名就叫 `<用户名>.github.io`，地址则是 `https://<用户名>.github.io/`。

### 每次更新

```bash
node tools/build.mjs && git add -A && git commit -m "update" && git push
```

### 用令牌全自动部署（连仓库一起建）

如果本机没装 `gh`、也没有存好的 git 凭据，可以用一条命令完成「建仓库 → 推送 → 开 Pages」：

1. 生成令牌：github.com/settings/tokens/new
   - 经典令牌勾选 **`repo`**
   - 细粒度令牌需要 **Contents: Read and write** + **Administration: Read and write**
2. 运行：

```powershell
# PowerShell
$env:GITHUB_TOKEN="ghp_你的令牌"
node tools/deploy-github.mjs --repo my-notes

# 想先看会做什么，不真正改动远端：
node tools/deploy-github.mjs --repo my-notes --dry-run
```

脚本做的事：校验令牌 → 建公开仓库（已存在则复用）→ 推送 `main` → 调 API 开启 Pages（分支 `main`、目录 `/site`）→ 打印访问网址。
推送用的临时 remote 地址在推送后会自动恢复为不含令牌的安全地址；令牌只存在于环境变量里，不会写进任何文件。

> 也可以不用脚本：在网页上建空仓库，然后 `git remote add origin <地址>` + `git push -u origin main`，
> 再到 Settings → Pages 手动选择分支 `main`、目录 `/site`。

## 自检与测试

```bash
node tools/selfcheck.mjs      # 静态契约：JS↔HTML 元素对账、产物标签配平、锚点可达、路径安全
node tools/test-search.mjs    # 检索实测：标题/正文/标签/附件文字/多词/边界/性能，共 28 项断言
```

## 设计取舍

- **零依赖**：构建脚本只用 Node 内置模块，不装 `node_modules`，十年后也能跑。
- **构建期渲染**：Markdown 在构建时转成 HTML，页面打开即显示内容，不闪、不依赖前端解析。
- **搜索在前端**：索引和一个 JSON 一起下载（几万字也就几十 KB），检索耗时 < 1ms，输入的每个字符都能立刻出结果。
- **KaTeX 走 CDN**：公式渲染依赖外部 CDN，断网时自动降级为等宽文本，正文不丢。
- **关于"绝对路径"**：站内一律相对路径，因此无论放在根目录还是子目录（GitHub Pages 项目页）都不会 404。

## 常见问题

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 打开是 404 | Pages 目录选了 `/root` | 改成 `/site` |
| 页面提示读不到 `index.json` | 直接双击了 html，或忘了构建 | 用本地服务器；先跑 `node tools/build.mjs` |
| 改了 md 但网页没变 | 没重新构建 | 跑 `node tools/build.mjs` 后重新推送 |
| 公式显示成方括号文本 | 断网或 CDN 被墙 | 内容不受影响；需要离线公式可把 KaTeX 下载到 `docs/vendor/` |
| 推送要密码 | GitHub 已停用密码认证 | 用 Personal Access Token 或 `gh auth login` |
