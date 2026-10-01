# gitwiki

团队 Wiki：用 GitHub 账号登录，在浏览器里写文档、整理目录、多人一起编辑，写好的内容还可以发布成网站。

![演示](docs/screenshot.png)

## 能做什么

- 写文档：工具栏、表格、代码块、公式和流程图都有；粘贴图片或拖入文件就成了附件；输入 `[[` 可以链接到其他页面
- 整理目录：页面下面可以有子页面，在侧栏拖动就能换位置；改名、移动后，指向它的链接自动跟着更新
- 不怕写丢：没保存的修改留在浏览器里，下次打开可以接着写；每个版本都能查看和恢复；删掉的页面可以在首页的“最近更新”里找回
- 一起写：看得到谁在看同一页，别人改了你正在看的页面会提醒你；两个人改到同一处时，并排对比后再保存
- 找内容：按标题和正文搜索，标题匹配的排在前面；也可以按标签浏览
- 首页：展示团队最近更新的页面
- 权限：有编辑权限的人可以修改，其他人只能阅读；没登录时打开的链接，登录后回到原页面

## 部署

要求：Go 1.24+、Bun、git。

```bash
cp config.yaml.example config.yaml
# 填 github client_id/secret/session_secret/repos
bun --cwd web install
bun --cwd web run build
go build -o gitwiki ./cmd/gitwiki
./gitwiki -config config.yaml
```

打开 `http://localhost:8080`。

### 配置

```yaml
listen: ":8080"
github:
  client_id: "..."
  client_secret: "..."
session_secret: "..."   # openssl rand -hex 32
repos:
  - slug: las-wiki         # URL 中的短名
    github: qbox/las       # GitHub 仓库
    branch: wiki
    workdir: ./data/repos/las-wiki   # 本地工作副本
    content_dir: content
    title: LAS Wiki
    site_url: https://wiki.example.com  # 可选：发布后的站点地址，页面上显示“在站点中查看”
```

谁能读、谁能改跟着 GitHub 仓库的权限走：有读权限的人可以浏览，有 push 权限的人才能修改。

### 发布站点

文档保存在仓库的 `content/` 下，就是普通的 Hugo 页面，发布交给 Hugo server、GitHub Pages、Cloudflare Pages 等现有的站点流程，gitwiki 不负责构建。站点需要下面几项设置，显示才能和 gitwiki 里一样：

- 页面间链接写成页面在站点上的路径，例如 `[安装](/getting-started/install)`。站点部署在子路径下（例如 GitHub Pages 的项目站点）时，启用 Hugo 内置的链接渲染钩子：`markup.goldmark.renderHooks.link.useEmbedded = 'fallback'`（主题自带链接钩子时以主题为准）
- 公式：gitwiki 按 `$…$`（行内）和 `$$…$$`（独立成块）渲染。站点要开启 goldmark 的 passthrough 扩展并用同样的分隔符（`markup.goldmark.extensions.passthrough.delimiters` 里 `inline = [['$', '$']]`、`block = [['$$', '$$']]`），再由主题加载 KaTeX 或 MathJax。Hugo 文档推荐的 `\(…\)` 写法 gitwiki 不渲染
- 提示块（`> [!NOTE]`）需要 Hugo 0.132+ 和支持 blockquote 渲染钩子的主题；流程图需要主题支持 `mermaid` 代码块。Hextra 等文档主题都已内置
- 标成草稿的页面（`draft: true`）Hugo 默认不发布

## 实现说明

用户看到的是页面、版本和附件；下面这些是它们在仓库里的样子，只有开发和运维需要知道。

- 登录：GitHub OAuth，scope `repo user:email`。读写权限取自 GitHub 仓库的 pull / push 权限，结果缓存 5 分钟
- 页面：`content/foo.md`（leaf）与 `content/foo/_index.md`（bundle）。页面有了子页面或附件时自动从 leaf 转成 bundle；首页是 `content/_index.md`。页面 id 就是相对 `content/` 的路径，URL 是 `/<仓库>/<页面 id>`
- 属性栏改的是 front matter 的 `tags`、`draft`、`date`、`description`，其他字段原样保留
- 附件存到页面的 `assets/` 目录，文件名转成小写并带上内容哈希（`需求说明-0d94338dc05f.pdf`）；界面上显示去掉哈希的名字
- 链接：页面间链接写成站点路径（`[标题](/a/b)`）。移动页面时，同一个提交里改写所有指向它和它子页面的 markdown 链接（`[文字](/路径)` 和 `[id]: /路径`），代码块里的不动；HTML `<a href>` 和 Hugo 的 `ref` 短代码不处理
- 保存：每次有变更的保存，在服务器的工作副本里以用户身份产生一个 commit，立即返回。保存时若 HEAD 已前进，用 `git merge-file` 三方合并；冲突时把两边内容交给前端并排对比
- 同步：后台循环把 commit 推到 origin，失败自动重试（5 秒起，最长 5 分钟一次）。origin 上有绕过 gitwiki 的提交时先 rebase 再推；改到同一处时停止推送，界面上提示“同步失败”，需要在工作副本里手动处理。同一个循环每分钟从 origin 拉取一次，本地没有待推送的提交时快进，并通知正在看相关页面的人。拉取用最近一次保存者的 token；服务重启后到第一次保存前，用工作副本里记下的远端地址
- 历史与最近更新：取自 `git log`。调整顺序、为放附件把页面转成 bundle 这类整理提交不算页面改动；移动页面只算被移动的页面，其他页面记为“更新了链接”。删除的页面可以从删除前的提交恢复
- 搜索：每次查询读一遍所有页面，多个词需同时命中，标题命中加权，中文连写的词按两字拆开再匹配。适合几千页以内
- 在场感知：WebSocket，同一页面的人互相看到头像，页面被改时收到通知
- 前端构建产物通过 `internal/web` 嵌入二进制，改了前端要先 `bun run build` 再 `go build`

## 开发

```bash
# 前端 dev server (proxy /api → 127.0.0.1:8080)
bun --cwd web run dev
# 后端
go run ./cmd/gitwiki -config config.yaml
```

```
cmd/gitwiki        # main
internal/auth      # GitHub OAuth + session cookie + 仓库权限
internal/config    # yaml config
internal/gitstore  # 本地 git 工作副本、页面抽象、合并、同步、历史、链接、搜索
internal/presence  # WebSocket 在场感知
internal/server    # HTTP API + SPA
web                # React + Vite + Tailwind + md-editor-rt
```
