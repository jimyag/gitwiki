<h1 align="center">gitwiki</h1>

<p align="center">
  <strong>团队 Wiki：GitHub 登录、Git 版本化、可一键发布成静态站点。</strong>
</p>

<p align="center">
  <a href="https://github.com/jimyag/gitwiki/actions/workflows/check.yaml"><img src="https://github.com/jimyag/gitwiki/actions/workflows/check.yaml/badge.svg" alt="Check"></a>
  <a href="https://github.com/jimyag/gitwiki/actions/workflows/release.yaml"><img src="https://github.com/jimyag/gitwiki/actions/workflows/release.yaml/badge.svg" alt="Release"></a>
  <a href="https://codecov.io/gh/jimyag/gitwiki"><img src="https://codecov.io/gh/jimyag/gitwiki/branch/main/graph/badge.svg" alt="Codecov"></a>
  <a href="https://github.com/jimyag/gitwiki/releases"><img src="https://img.shields.io/github/v/release/jimyag/gitwiki" alt="Latest Release"></a>
</p>

<p align="center">
  <a href="#能做什么">能做什么</a> ·
  <a href="#安装">安装</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#开发">开发</a> ·
  <a href="#发布">发布</a>
</p>

---

gitwiki 把文档直接存进 Git 仓库，登录、权限和协作都基于 GitHub。后端是一个 Go HTTP 服务，前端是 Vite + React，构建产物通过 `go:embed` 打进一个二进制，部署即单文件。

## 能做什么

- 写文档：工具栏、表格、代码块、公式和流程图；粘贴图片或拖入文件即成附件；从 Word / 飞书 / 网页粘贴的富文本会转成 Markdown；输入 `[[` 可链接到其他页面
- 评论：每页有自己的评论区（内容存仓库的 `.comments/` 目录，不混进正文）；选中文字再评论可带上引用；每页可看反链（谁链接到我）
- 整理目录：页面下面可以有子页面，侧栏拖动换位置；改名、移动后，指向它的链接自动跟着更新；可一键复制一页再改
- 导入导出：仓库配置 `source: [markdown, mediawiki]` 后侧栏出现“导入”按钮，把本地 `.md`、`.wiki` 直接放进来；任何页面地址后加 `.md` 看源码、加 `.pdf` 打开打印视图
- 不怕写丢：未保存修改留在浏览器；每个版本可查看恢复；删除页面在“回收站”集中管理，也能在首页“最近更新”找回
- 一起写：看到谁在看、谁正在编辑同一页；“编辑”按钮会在有人编辑时提醒；两人改到同一处时并排列对比
- 找内容：按标题和正文搜索，标题命中靠前；按标签浏览
- 权限：有 GitHub push 权限的人才能修改；`read_public: true` 后未登录也可阅读（写仍需登录）

## 安装

第一次部署请阅读 [从零部署和使用文档](docs/usage.md)，包括文档仓库初始化、GitHub OAuth、systemd、HTTPS 和部署验收。

服务器运行时需要安装 Git；Go 和 Bun 只用于源码构建。

### 从 Release 下载

到 [GitHub Releases](https://github.com/jimyag/gitwiki/releases/latest) 下载对应平台的二进制和 `checksums.txt`。产物名为：

```text
gitwiki_<os>_<arch>
```

目前只发布裸二进制，不发布容器镜像。

首个版本为 [v0.1.0](https://github.com/jimyag/gitwiki/releases/tag/v0.1.0)，使用文档中提供了下载和校验命令。

### 从源码构建

要求：Go 1.24+、Bun 1.3+。

```bash
cd web && bun install --frozen-lockfile && bun run build && cd ..
go build -trimpath -ldflags "-s -w" -o gitwiki ./cmd/gitwiki
```

## 快速开始

拷贝配置并填上 GitHub OAuth App（[创建地址](https://github.com/settings/developers)，回调 URL 形如 `http://localhost:8080/auth/callback`）：

```bash
cp config.yaml.example config.yaml
# 填 github.client_id / client_secret、session_secret、repos
./gitwiki -config config.yaml
```

打开 `http://localhost:8080`。

文档仓库需要有首个提交和配置的分支；建议先创建 `content/_index.md` 作为首页。私有仓库启用公开阅读时，先登录打开 Wiki 完成首次克隆，再让未登录访客访问含仓库短名的路径。

配置示例：

```yaml
listen: "127.0.0.1:8080"

github:
  client_id: "..."
  client_secret: "..."

# openssl rand -hex 32
session_secret: "..."

repos:
  - slug: my-wiki             # URL 中的短名
    github: owner/repo        # GitHub 仓库
    branch: main
    workdir: ./data/repos/my-wiki   # 本地工作副本
    content_dir: content
    title: My Wiki
    # site_url: https://wiki.example.com  # 可选：发布后页面上会出现“在站点中查看”
    # read_public: true                   # 可选：不登录也能阅读
    # source: [markdown, mediawiki]       # 可选：侧栏出现“导入”按钮
```

读写权限直接跟着仓库走：有 GitHub 读权限可浏览，有 push 权限才能修改。

## 开发

两个终端分别启动前后端：

```bash
task dev-frontend   # Vite dev server，/api 代理到 127.0.0.1:8080
task dev-backend    # go run ./cmd/gitwiki -config config.yaml
```

常用任务：

```bash
task deps               # 安装前端依赖
task lint               # golangci-lint
task test               # go test -race，生成 coverage.txt
task check              # 前端 typecheck + go vet
task build              # 构建前端，再嵌入后端二进制
task release-snapshot   # 本地跑 GoReleaser 快照，验证发布配置
```

前端改动后需要先 `bun --cwd web run build`（或 `task build`），Vite 直接将产物输出到 `internal/web/dist`，再由 `go:embed` 打进二进制。

## 发布

发布工作流由 `v*` tag 触发，配置为验证后由 GoReleaser 产出 Linux / macOS / Windows 裸二进制和 `checksums.txt`，生成 GitHub Release。发布说明基于两个 tag 之间的 commit。例如下一个版本：

```bash
git tag v0.2.0
git push origin v0.2.0
```

发布前可用 `task release-snapshot` 本地验证 GoReleaser 配置和 artifact。

工作流先构建前端，再执行 Go 检查。Release 的 lint 以 `v0.1.0` 为基线，只检查之后新增的问题。在 Actions 中手动运行 Release 并选择 `main`，会验证并构建快照，不发布新版本；`v*` tag 触发正式发布。`v0.1.0` 是本地验证后上传的产物，详细验证和限制见 [使用文档](docs/usage.md#本轮验证记录)。

## 实现说明

给开发和运维参考，使用者可以跳过。

- 登录：GitHub OAuth，scope `repo user:email`；读写权限取自仓库的 pull / push，结果缓存 5 分钟
- 页面：`content/foo.md`（leaf）与 `content/foo/_index.md`（bundle）。有子页面或附件时自动从 leaf 转成 bundle；首页是 `content/_index.md`。页面 id 即相对 `content/` 的路径，URL 形如 `/<仓库>/<页面 id>`
- 属性栏改的是 front matter 的 `tags`、`draft`、`date`、`description`，其他字段原样保留
- 附件：存到页面的 `assets/` 目录，文件名转小写并带内容哈希；界面显示去掉哈希的名字
- 链接：页面间 Markdown 链接写成站点路径（`[标题](/a/b)`）。移动页面时同一提交改写所有指向它和它子页面的链接（`[文字](/路径)` 和 `[id]: /路径`），代码块不动；HTML `<a href>` 和 Hugo `ref` 短代码不处理
- 保存：每次变更的保存以当前用户身份产生一个 commit 立即返回；HEAD 已前进则用 `git merge-file` 三方合并，冲突时交给前端并排对比
- 同步：后台循环把 commit 推到 origin，失败自动重试（5 秒起、最长 5 分钟一次）。origin 上有绕过 gitwiki 的提交时先 rebase；改到同一处时停止推送，界面提示“同步失败”，需要在工作副本里手动处理。同一循环每分钟从 origin 拉取，本地无待推送提交时快进，并通知正在看相关页面的人
- 历史与最近更新：取自 `git log`；调整顺序、为附件把页面转成 bundle 这类不算页面改动；删除的页面可从删除前的提交恢复
- 搜索：每次查询读一遍所有页面，多词同时命中、标题加权、中文连写的词按两字拆开匹配。适合几千页以内
- 在场感知：WebSocket，同一页面的人互相看到头像，页面被改时收到通知

### 用 Hugo 发布站点

文档存在仓库的 `content/` 下，就是普通 Hugo 页面，发布交给 Hugo / GitHub Pages / Cloudflare Pages 等现有流程。站点要与 gitwiki 渲染一致，需要：

- 页面间链接写成站点路径，例如 `[安装](/getting-started/install)`；部署在子路径下时启用 Hugo 内置链接渲染钩子 `markup.goldmark.renderHooks.link.useEmbedded = 'fallback'`（主题自带时以主题为准）
- 公式按 `$…$`（行内）和 `$$…$$`（独立成块）渲染；站点要开 goldmark 的 passthrough 扩展并用同样的分隔符（`markup.goldmark.extensions.passthrough.delimiters` 里 `inline = [['$', '$']]`、`block = [['$$', '$$']]`），再用主题加载 KaTeX 或 MathJax；Hugo 推荐的 `\(…\)` 写法 gitwiki 不渲染
- 提示块（`> [!NOTE]`）需 Hugo 0.132+ 和支持 blockquote 渲染钩子的主题；流程图需主题支持 `mermaid` 代码块。Hextra 等文档主题已内置
- `draft: true` 的页面 Hugo 默认不发布
