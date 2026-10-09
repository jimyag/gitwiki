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

- 写文档：工具栏、表格、代码块、公式和流程图；行首输入 `/` 插入标题、表格、提示块、Mermaid 图等；粘贴图片或拖入文件即成附件；从 Word / 飞书 / 网页粘贴的富文本会转成 Markdown；输入 `[[` 可链接到其他页面；可打开分屏预览，在编辑器右侧看到和阅读页一致的渲染
- 评论：每页有自己的评论区（内容存仓库的 `.comments/` 目录，不混进正文）；选中文字再评论可带上引用；每页可看反链（谁链接到我）
- 整理目录：页面下面可以有子页面，父页面正文后自动列出子页面；侧栏拖到页面中间成为它的子页面，拖到页面上下边缘调整顺序；移动时子页面、附件、评论和已连接浏览器中的收藏、最近浏览、本机草稿一起迁移，指向它的链接自动更新，旧地址写入 Hugo 的 `aliases`，发布的站点会跳转到新地址；可一键复制一页再改
- 导入导出：Wiki 设置里写 `source: [markdown, mediawiki]` 后侧栏出现“导入”按钮，把本地 `.md`、`.wiki` 直接放进来；任何页面地址后加 `.md` 看源码、加 `.pdf` 打开打印视图
- 不怕写丢：未保存修改留在浏览器；每个版本可查看恢复；删除页面在“回收站”集中管理，也能在首页“最近更新”找回
- 一起写：看到谁在看、谁正在编辑同一页；“编辑”按钮会在有人编辑时提醒；两人改到同一处时并排列对比
- 找内容：⌘K / Ctrl K 或 `/` 打开搜索，未输入时列出最近看过的页面；按标题和正文搜索，标题命中靠前；可组合目录、标签、最后更新时间和草稿状态筛选，也可只筛选不输入关键词；从搜索结果打开的页面会标出命中的词并滚到第一处；鼠标停在站内链接上可预览目标页；收藏常驻侧栏；页面展示最后更新时间
- 维护文档：自动检查失效的 Markdown 页面链接、缺失图片附件和无效锚点，只在有问题时显示提示，点击可查看详情并定位正文；页面可指定负责人，超过一定天数（默认 180 天）没有更新的页面也列入问题，内容仍正确时可直接标记“内容仍有效”；旧文档可标记废弃并指定替代页面，搜索结果也显示废弃状态；标签可重命名、删除，或给选中的多个页面批量添加、移除
- 模板：从文档仓库根目录的 `.gitwiki/templates/*.md` 读取模板，新建页面时选择并预览；提供[模板示例](examples/templates)
- 多个 Wiki：GitHub App 装到哪个仓库，哪个仓库就是一个 Wiki，地址是 `/<owner>/<repo>/<页面路径>`，不用在服务配置里登记；每个 Wiki 的标题、公开阅读、导入格式等设置写在它自己仓库的 `.gitwiki/config.yaml` 里
- 权限：有 GitHub push 权限的人才能修改；Wiki 设置里 `read_public: true` 后未登录也可阅读（写仍需登录）
- 同步：侧栏 Wiki 名称旁的云朵图标打开“同步状态”，显示最近成功拉取时间、待推送提交数和失败原因；推送或拉取失败时云朵变红，顶栏也会出现“同步失败”。有写权限的人可点“立即同步”，重试推送并拉取 GitHub 更改
- 外观：浅色、深色或跟随系统，在侧栏底部的账号菜单切换；页面可用单页宽度或铺满宽度，阅读和编辑一起生效，在页面右上角“更多操作”菜单或编辑器工具栏切换。两项选择和分屏预览开关都只记在当前浏览器
- 快捷键：`E` 编辑当前页面，`/` 搜索，`?` 查看全部快捷键（也在账号菜单里）

## 安装

第一次部署请阅读 [从零部署和使用文档](docs/usage.md)，包括文档仓库初始化、注册 GitHub App、systemd、HTTPS 和部署验收。

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

先注册一个 GitHub App（[创建地址](https://github.com/settings/apps/new)），它同时负责登录和读写文档仓库：Callback URL 形如 `http://localhost:8080/auth/callback`，Repository permissions 里 Contents 选 Read and write，不需要 Webhook；创建后在 Optional features 里把 User-to-server token expiration 设为 Opt-out，生成 client secret 和私钥，再把 App 安装到文档仓库。详细步骤见[使用文档](docs/usage.md#注册-github-app)。然后拷贝配置：

```bash
cp config.yaml.example config.yaml
# 填 github.client_id / client_secret / private_key_file、session_secret
./gitwiki -config config.yaml
```

打开 `http://localhost:8080`，登录后侧栏列出你能访问的 Wiki，也可以直接打开 `http://localhost:8080/<owner>/<repo>`。

服务配置只有服务自己的事，不登记仓库：

```yaml
listen: "127.0.0.1:8080"

github:                       # 同一个 GitHub App：用户从它登录，服务以它读写仓库
  client_id: "..."
  client_secret: "..."
  private_key_file: /etc/gitwiki/github-app.pem

# openssl rand -hex 32
session_secret: "..."

# data_dir: ./data/repos      # 可选：工作副本放在 <data_dir>/<owner>/<repo>
```

文档仓库需要有首个提交；建议先创建 `content/_index.md` 作为首页。仓库有 `wiki` 分支时 Wiki 用这个分支（文档和代码可以分开），否则用默认分支；页面放在 `content/` 下。每个 Wiki 自己的设置写在仓库的 `.gitwiki/config.yaml`，和页面模板放在一起，都可省略：

```yaml
title: 团队文档                # 侧栏显示的名称，默认是仓库名
read_public: true             # 不登录也能阅读，默认 false；写始终要求有 push 权限的 GitHub 账号
source: [markdown, mediawiki] # 侧栏出现“导入”按钮，把这些格式转成 Markdown
site_url: https://docs.example.com  # 发布的站点，页面上出现“在站点中查看”；默认取仓库在 GitHub 上填的 Website
stale_days: 180               # 多少天没更新算“长期未更新”，0 关闭
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

- Wiki：App 装到的每个仓库都是一个 Wiki，第一次被访问时向 GitHub 查询仓库信息、用 App 的安装 token 克隆到 `<data_dir>/<owner>/<repo>`，并启动后台同步；服务重启时，磁盘上已有的工作副本会先被接上，没推完的提交继续推。分支：仓库有 `wiki` 分支时用它，否则用默认分支；已有工作副本沿用它当前的分支。登录用户的 Wiki 列表来自 GitHub（用户能看到的 App 安装下的仓库），按用户缓存 5 分钟
- Wiki 设置：每次使用时从工作副本读 `.gitwiki/config.yaml`，保存或拉取改了它就按新内容生效；文件解析失败时写日志并按默认值处理。匿名访问时，无论仓库没装 App、克隆失败还是没开公开阅读，都只返回 401，不透露是哪种情况
- 登录：GitHub App 的用户授权（和 OAuth 相同的网页流程）。登录拿到的用户 token 只用来识别用户和检查权限：读写权限取自用户在仓库的 pull / push，按账号、仓库和凭据缓存 5 分钟；App 没装到的仓库对用户不可见。新登录凭据立即重新检查权限；GitHub 返回 401 时清除登录 cookie，提示重新登录。cookie 有效期为 7 天，使用必填的 `session_secret` 签名
- 仓库读写：克隆、推送和拉取都用 App 的安装 token，与谁登录无关。服务用 App 私钥签 JWT 换取 token，只授权到当前仓库，1 小时有效，剩 5 分钟内重新换取；提交作者仍是实际修改的用户，GitHub 上显示的推送者是这个 App
- 页面：`content/foo.md`（leaf）与 `content/foo/_index.md`（bundle）。有子页面或附件时自动从 leaf 转成 bundle；首页是 `content/_index.md`。页面 id 即相对 `content/` 的路径，URL 形如 `/<owner>/<repo>/<页面 id>`
- 文件名：新页面按标题命名，全仓库只有一条规则：转小写（和 Hugo 发布路径一致），保留各种文字的字母和数字，其余字符连成一个 `-`，最长 60 个字，例如“安装 指南”存为 `安装-指南.md`。同一目录里不分大小写重名，或与 `index`、`_index`、`assets` 冲突时依次加 `-2`、`-3`；标题没有可用字符时用 `page`。之后改标题不改文件名，页面地址保持不变
- 属性栏改的是 front matter 的 `tags`、`draft`、`date`、`owner`（负责人）、`deprecated`、`replaced_by` 和 `description`，其他字段原样保留；“内容仍有效”写入 `reviewed` 日期
- 附件：存到页面的 `assets/` 目录，文件名按页面文件名的同一规则处理并带内容哈希；界面显示去掉哈希的名字
- 链接：页面间 Markdown 链接写成站点路径（`[标题](/a/b)`）。移动时同一提交更新 Markdown 链接、图片、引用式链接、HTML `href` / `src` / `poster` 和 Hugo `ref` / `relref` 的目标；保留锚点和查询参数，重算相对路径，行内代码和围栏代码块不动。反链使用相同的引用识别逻辑
- 移动：页面、子页面、附件和已保存评论在同一提交迁移，内存中的待保存评论也随迁。被移动的每个页面把旧地址（`/旧路径/`）写入 front matter 的 `aliases`，移回原处时去掉当前地址；设置了 `url` 的页面地址不随位置变化，不写。目标存在页面或评论记录、相关文件有未提交改动时拒绝移动；写入、暂存或提交失败时恢复文件和 Git index。已连接的浏览器收到移动事件后跟到新地址并迁移本机记录，未保存修改会保留为草稿供恢复；离线设备、浏览器书签里 gitwiki 自己的旧地址不会自动更新
- 排序：侧栏拖到页面上下边缘时写入同级页面的 `weight`；没有页面文件的目录不能带 `weight`，排在最后
- 标签：重命名、删除和批量修改在一个提交里改写相关页面 front matter 的 `tags`；改成已有的标签名即合并
- 长期未更新：文档检查按最后一次修改页面文件的提交时间计算，草稿和已废弃页面不算；天数由 Wiki 设置的 `stale_days` 决定，默认 180，0 关闭
- 保存：每次变更的保存以当前用户身份产生一个 commit 立即返回；HEAD 已前进则用 `git merge-file` 三方合并，冲突时交给前端并排对比
- 同步：后台循环把 commit 推到 origin，失败自动重试（5 秒起、最长 5 分钟一次）。origin 上有绕过 gitwiki 的提交时先 rebase；改到同一处时停止推送，界面提示“同步失败”，需要在工作副本里手动处理。同一循环每分钟从 origin 拉取，本地无待推送提交时快进，并通知正在看相关页面的人。每次推送或拉取后把结果（推送失败优先，其次拉取失败）推给已连接的浏览器，页面打开时也会先读一次当前状态
- 历史与最近更新：取自 `git log`；调整顺序、为附件把页面转成 bundle 这类不算页面改动；删除的页面可从删除前的提交恢复
- 搜索：每次查询读一遍所有页面，多词同时命中、标题加权、中文连写的词按两字拆开匹配。适合几千页以内
- 在场感知：WebSocket，同一页面的人互相看到头像，页面被改时收到通知

### 用 Hugo 发布站点

文档存在仓库的 `content/` 下，就是普通 Hugo 页面，发布交给 Hugo / GitHub Pages / Cloudflare Pages 等现有流程。站点要与 gitwiki 渲染一致，需要：

- 页面间链接写成站点路径，例如 `[安装](/getting-started/install)`；部署在子路径下时启用 Hugo 内置链接渲染钩子 `markup.goldmark.renderHooks.link.useEmbedded = 'fallback'`（主题自带时以主题为准）
- 公式按 `$…$`（行内）和 `$$…$$`（独立成块）渲染；站点要开 goldmark 的 passthrough 扩展并用同样的分隔符（`markup.goldmark.extensions.passthrough.delimiters` 里 `inline = [['$', '$']]`、`block = [['$$', '$$']]`），再用主题加载 KaTeX 或 MathJax；Hugo 推荐的 `\(…\)` 写法 gitwiki 不渲染
- 提示块（`> [!NOTE]`）需 Hugo 0.132+ 和支持 blockquote 渲染钩子的主题；流程图需主题支持 `mermaid` 代码块。Hextra 等文档主题已内置
- `draft: true` 的页面 Hugo 默认不发布
