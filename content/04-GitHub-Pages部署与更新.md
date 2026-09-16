---
title: GitHub Pages 部署与更新笔记
slug: deploy
category: 工具链
tags: [GitHub, 部署, 命令, 踩坑]
date: 2026-02-10
summary: 从零把站点推上 GitHub Pages，以及每次更新笔记要做的三条命令和常见坑。
---

# GitHub Pages 部署与更新笔记

## 一次性配置（只做一次）

```bash
git init
git add -A
git commit -m "init: 个人笔记站"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

然后在 GitHub 网页端：**Settings → Pages → Source 选 `Deploy from a branch` → 分支 `main`、目录 `/site`** → Save。

一分钟左右，访问：

```text
https://<你的用户名>.github.io/<仓库名>/
```

> [!WARNING] 目录必须选 /site
> 网站文件在 `docs/` 子目录里，Pages 的目录选成 `/root` 会显示 404。

## 每次更新笔记（三条命令）

```bash
node tools/build.mjs
git add -A && git commit -m "notes: 新增 xxx"
git push
```

`build.mjs` 会把 `content/*.md` 重新生成到 `docs/data/index.json`，Pages 收到推送后自动重新发布。

> [!TIP] 只改文字不用重新构建？
> 不行。正文渲染在构建时完成，改了 `.md` 必须重跑 `node tools/build.mjs`，否则网页还是旧的。

## 本地预览（改样式时必用）

```bash
cd site
python -m http.server 8080
# 打开 http://127.0.0.1:8080
```

或者：

```bash
npx serve site
```

> [!CAUTION] 不要直接双击 index.html
> 浏览器对 `file://` 的 fetch 有限制，页面会提示「没能加载 data/index.json」。必须走本地服务器或线上地址。

## 常见坑速查

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 打开是 404 | Pages 目录选了 `/root` | 改成 `/site` |
| 页面样式全丢 | 仓库名与路径层级不符 | 本站全部用相对路径，正常不会有；若自行加了绝对路径 `/css/...` 必须去掉前导斜杠 |
| 数据不更新 | 忘了跑构建 | `node tools/build.mjs` 后重新推送 |
| 中文文件名乱码 | 系统编码 | 文件名尽量用英文或加 `slug` 字段 |
| 图片 404 | 图片没放 `content/assets/` | 图片统一放该目录，正文写 `assets/xxx.png` |
| 推送要密码 | GitHub 已停用密码认证 | 用 Personal Access Token 或 `gh auth login` |

## 想用自定义域名

1. 域名 DNS 加一条 CNAME 指向 `<用户名>.github.io`
2. 仓库 Settings → Pages → Custom domain 填入域名
3. 勾选 Enforce HTTPS

> [!NOTE] 免费额度的边界
> 公开仓库的 Pages 免费；单仓库建议不超过 1 GB，单文件不超过 100 MB——所以图片记得压缩后再放 `assets/`。
