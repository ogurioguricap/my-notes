# 我的笔记 · 纯前端笔记站

> 🌐 **在线地址：https://ogurioguricap.github.io/my-notes/**（已发布，手机 / 平板 / 电脑直接打开）
> 📦 仓库：https://github.com/ogurioguricap/my-notes

一个**没有后端、没有框架、没有构建依赖**的个人笔记网站。内容写成 Markdown，一条命令生成网页，推到 GitHub 就有一个手机/平板/电脑都能打开的网址。

## 在线编辑（点按钮排版，不见 Markdown 符号）

打开任意笔记 → 右上角 **✎ 编辑**，默认就是**可视化模式**：像手账 App 一样选字改样式。

| 想做什么 | 怎么做 |
| --- | --- |
| 改字号 | 选中文字 → 工具栏「字号」：小 / 正常 / 大 / 特大 / 超大 / 标题级 |
| 加粗、斜体、删除线、荧光笔高亮 | 选中文字 → B / I / S / 🖍 |
| 大标题、小标题、列表、引用、代码块 | 光标放在某行 → 点对应按钮 |
| 对齐 | ⬅ ↔ ➡ |
| 插图片 | 🖼 图片 → 选文件，自动上传到仓库并插入 |
| 插公式 / 表格 / 提示框 / 自动目录 / 双链 | ∑ ∫ ▦ 💡 📑 🔗 按钮 |
| 保存发布 | Ctrl / Cmd + S，或右下「保存并发布」（约 1 分钟后线上生效） |

- **右栏永远显示"线上效果"**：预览用的是构建脚本同一份渲染代码
- **两种模式随时互换**：❓帮助旁的「⌨ 源码」可直接改 Markdown，切回来内容等价
- **草稿自动保存**：每 0.8 秒存进浏览器，"未发布"也不会丢
- **冲突检测**：远端被改过会先提示，不会静默覆盖

> 保存链路：浏览器把 HTML→Markdown 转换（`lib/html-to-md.mjs`）→ 提交 `content/xxx.md` →
> 浏览器重建 `docs/data/index.json` → Pages 自动发布。**这条转换链有 33 项往返测试保命**，
> 保证"排版一次不会毁掉已有笔记"。

## 手写标注（画笔 / 荧光笔 / 橡皮）

笔记页点 **✍ 标注**，正文上就会浮出一支笔：

- **✏️ 画笔**：自由手写，6 种颜色 × 3 种粗细
- **🖍 荧光笔**：半透明勾画重点（multiply 混合，压在文字上不糊字）
- **🧽 橡皮**：点中哪条线擦哪条
- **↶ 撤销 / 🗑 清空 / 保存标注**：笔画存成 `content/ink/<笔记>.json`，随仓库走
- 坐标按**比例**存储，所以手机、平板、电脑上位置都对齐；打印时自动隐藏工具栏

## 它长什么样

打开站点 → 任意笔记页右上角 **✎ 编辑这篇**，或侧栏 **＋新建笔记**，就能在全屏编辑器里写：

- **左写右预览**：预览用的是 `lib/markdown.mjs`（与构建脚本同一份代码），**所见即线上**
- **元数据表单**：标题、分类、标签、日期、置顶、摘要，不用手写 frontmatter
- **18 个工具栏按钮**：标题、粗体、表格、代码块、公式、提示框、双链……点一下插入
- **上传图片**：选图即上传到 `content/assets/` 并自动插入引用
- **草稿自动保存**：写的东西每 0.8 秒存进浏览器，刷新、关标签页都不丢
- **冲突检测**：如果这篇在别处被改过，保存前会提示，不会静默覆盖

**保存后会做什么**：

```
浏览器里点「保存并发布」
   → 用 GitHub API 提交 content/xxx.md
   → 同时用 lib/site-build.mjs 在浏览器里重建 docs/data/index.json 并提交
   → GitHub Pages 约 1 分钟后自动更新线上
```

所以**不需要本地构建、不需要命令行**，手机上也能改笔记。

### 首次使用要填一次令牌

点编辑器右上角 **⚙** → 填 Personal Access Token（`repo` 权限，生成地址 github.com/settings/tokens/new）→ 验证 → 保存。

> 🔒 令牌**只存在你这台设备的浏览器 localStorage**，只发往 `api.github.com`，不经过任何第三方服务器，也不会写进仓库（`.gitignore` 已排除 `.env`/`*.token`/`*.pem`）。公用电脑上用完点「清除令牌」即可。
> 侧栏「＋新建笔记」现在直接打开可视化编辑器；想按固定模板手写 `.md` 自己提交也可以（`content/` 里随便加文件）。

## 它长什么样

界面语言参考「笔记本 App」的思路：**每篇笔记是一本笔记本，封面按分类自动上色**。

- **资料库（主页）**：横向滑动的「收藏 / 最近更新 / 含图表文字」书架 + 分类卡片 + 全部笔记本网格
- **笔记本封面**：每本笔记自动生成彩色封面（分类定色 + 标题首字标记），网格 / 列表视图一键切换
- **书架侧栏**：全部笔记本、收藏（⭐）、我的笔记本（按分类）、最近打开，底部显示计数
- **速览浮层**：不用离开资料库就能看摘要、目录、出链入链，再决定是否打开
- **右键 / 长按菜单**：打开、速览、复制链接、只看某分类、按标签搜索、复制 Markdown 文件名
- **新建笔记**：内置 4 套模板（标准 / 推导 / 会议复盘 / 读书），一键复制 frontmatter 骨架
- **实时搜索**：标题 / 正文 / 代码 / 标签 / 分类，**连图片里的文字和 PDF 正文也能搜到**
- **笔记本内阅读**：三栏布局，右侧本页目录随滚动高亮
- **知识图谱**：笔记之间的 `[[双链]]` 和同标签关系可视化，节点可拖动整理
- **时间线**：按月份倒序，左侧色条对应封面配色
- **三套排版随时切换**：极简（暖白纸感）/ 技术（冷灰等宽）/ 杂志（衬线卡片）
- **深浅色**：浅 / 深 / 跟随系统（记住你的选择）
- **手机适配**：抽屉式书架、封面上色、字号行距自适应、长按呼出菜单、图片点击放大、可加桌面图标离线看

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
├── lib/                        Markdown 渲染内核（构建脚本与浏览器共用，保证预览＝线上）
│   ├── markdown.mjs            frontmatter / 块级行内解析 / 公式与代码块
│   └── site-build.mjs          站点数据构建（浏览器在线保存时重建索引用）
│
├── tools/
│   ├── update.mjs              一键更新：提取 → 构建 → 自检 → 测试 → 提交 → 推送
│   ├── deploy-github.mjs       授权后自动部署：建仓库 → 推送 → 开 Pages
│   ├── build.mjs               Markdown → 网页数据（零依赖）
│   ├── extract-attachments.mjs 附件文字提取
│   ├── make-demo-image.mjs     生成演示图（自写 PNG 编码器）
│   ├── selfcheck.mjs           静态自检（DOM 契约 + 产物完整性）
│   ├── test-modules.mjs        模块链接测试（import/export 对账 + 真实加载启动）
│   ├── test-search.mjs         检索功能实测（28 项断言）
│   └── test-ui-lib.mjs         资料库界面数据契约（23 项断言）
│
├── docs/                       ← 构建产物，GitHub Pages 直接托管这一层
│   ├── index.html
│   ├── css/style.css
│   ├── js/{app,editor,search,graph,highlight}.js
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

## 桌面上放一个快捷方式

项目根目录已经准备好三样东西，**你只需要双击一次 `创建桌面快捷方式.bat`**，桌面上就会出现快捷方式：

图标用的是 `我的笔记.ico`（7 种尺寸 16→256，从一张 860×860 的头像裁切生成；网页 favicon、安卓主屏图标、PWA 图标也都用同一张）。

| 快捷方式 | 打开什么 | 用途 |
| --- | --- | --- |
| 我的笔记 | 线上站点（带自定义图标） | 内容最新，手机电脑通用；建议拖到任务栏 |
| 我的笔记（离线便携版） | `dist/我的笔记-离线版.html` | 不联网、不起服务，双击即开 |
| 我的笔记（使用说明） | `打开我的笔记.html` | 一页列出所有打开方式 + 使用说明 |

不想跑脚本的话，手动也行：

1. 打开 `D:\harness2\notes-site`
2. 右键 `我的笔记.url` → **发送到 → 桌面快捷方式**
3. 或者：桌面空白处右键 → 新建 → 快捷方式 → 粘贴 `https://ogurioguricap.github.io/my-notes/`

> `.bat` / `.ps1` 都没反应时，用这个最原始的办法：桌面右键 → 新建 → 快捷方式 → 位置填线上地址 → 下一步 → 命名「我的笔记」→ 完成。
> （脚本只往桌面写文件，不动注册表、不动系统设置，不想要了直接删快捷方式。）

### 离线便携版（单文件）

```bash
node tools/build-portable.mjs      # 生成 dist/我的笔记-离线版.html
```

把 `docs/css`、`docs/js`、`docs/data/index.json` 全部内联进一个 HTML，断网双击就能看；发到手机或别人的电脑也能直接打开（图片通过相对路径指向 `docs/assets/`，所以整个项目文件夹一起拷过去最稳）。正文里的 KaTeX 公式在离线版会降级为等宽文本，内容不丢。

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
node tools/selfcheck.mjs      # 静态契约 22 项：JS↔HTML 元素对账、关键 class 覆盖、产物标签配平、锚点可达、路径安全
node tools/test-modules.mjs   # 模块链接 11 项：import/export 对账 + 真跑一遍启动流程（防「页面卡在载入中」）
node tools/test-search.mjs    # 检索实测 28 项：标题/正文/代码/标签/附件文字/多词/边界/性能
node tools/test-ui-lib.mjs    # 界面契约 23 项：封面配色、卡片渲染、书架分组、速览字段、封面亮度可读性
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
