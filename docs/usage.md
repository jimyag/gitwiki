# 从零部署和使用 gitwiki

gitwiki 是文档编辑服务：页面、附件和已保存的评论存入 Git 仓库，写入后在后台同步到 GitHub。它不会自动安装 Hugo，也不会自动发布静态站点。只有需要独立的静态阅读站点时，才需要另建 Hugo 发布流程。

本文以一台新的 Ubuntu 24.04 服务器为例，使用单个 gitwiki 进程、systemd 和 Nginx。先准备 GitHub 文档仓库，下载程序，在本机验证，再接入 HTTPS。示例域名 `wiki.example.com`、仓库 `OWNER/wiki-content` 都需要替换。

## 准备服务器和文档仓库

服务器需要能通过 HTTPS 访问 `github.com`、`api.github.com`、Go 模块源及 Bun 包源。正式部署需要一个指向服务器的域名，以及可从公网访问的 80、443 端口。8080 仅监听本机，供 Nginx 转发。

安装运行和代理所需工具：

```bash
sudo apt update
sudo apt install -y git ca-certificates curl unzip openssl nginx certbot python3-certbot-nginx
git --version
```

Git 是运行时依赖。即使使用预编译的二进制，也必须保留 Git。Go 和 Bun 只用于构建，运行服务器可以不安装它们。

在 GitHub 创建一个专门存文档的仓库，例如 `OWNER/wiki-content`。勾选「Add a README file」，确保仓库有首次提交，并确认默认分支名为 `main`。完全空的 GitHub 仓库没有 `main` 分支，gitwiki 的首次克隆会失败。

在 GitHub 网页中创建 `content/_index.md`，内容如下，并提交到 `main`：

```markdown
---
title: 团队 Wiki
---

欢迎使用团队 Wiki。
```

这会同时建立首页和内容目录。只有 README 的仓库也能克隆，但没有上述文件时首页读取会返回 404。

为编辑者授予文档仓库的 Write 或更高权限。gitwiki 按 GitHub 的 pull / push 权限判断读写能力；有仓库读取权限的人可以阅读，具有 push 权限的人可以修改。分支保护规则仍可能阻止后台直接 push，因此选用允许这些编辑者直接推送的文档分支。

## 下载程序

[v0.1.0 Release](https://github.com/jimyag/gitwiki/releases/tag/v0.1.0) 提供 Linux、macOS、Windows 的 amd64 和 arm64 二进制，以及 `checksums.txt`。运行服务器只需要 Git，无需 Go、Bun 或 Node.js。当前没有官方容器镜像。

在 Linux x86_64 服务器执行：

```bash
set -eu
uname -m
mkdir gitwiki-install
cd gitwiki-install
curl --fail --location --remote-name https://github.com/jimyag/gitwiki/releases/download/v0.1.0/gitwiki_linux_amd64
curl --fail --location --remote-name https://github.com/jimyag/gitwiki/releases/download/v0.1.0/checksums.txt
sha256sum --ignore-missing -c checksums.txt
chmod +x gitwiki_linux_amd64
mv gitwiki_linux_amd64 gitwiki
./gitwiki -h
```

`uname -m` 为 `x86_64` 时使用上述文件，为 `aarch64` 时将命令中的 `gitwiki_linux_amd64` 改为 `gitwiki_linux_arm64`。校验应显示下载的文件 `OK`，帮助输出应包含 `-config`；失败时停止安装。macOS 的文件名以 `darwin` 开头，Windows 文件名带 `.exe`。

后续安装命令在此目录执行。需要自己构建时，使用下一节；下载二进制后可以直接跳到「注册 GitHub OAuth App」。

## 从源码构建

在构建机器上按照 [Go 官方安装说明](https://go.dev/doc/install) 安装 Go 1.24 或更新版本，按照 [Bun 官方安装说明](https://bun.sh/docs/installation) 安装 Bun。`web/package.json` 声明的版本为 Bun 1.4.2；本轮也验证了 Bun 1.3.14 可以构建当前锁文件。

```bash
set -eu
go version
bun --version
git clone https://github.com/jimyag/gitwiki.git
cd gitwiki
git rev-parse HEAD
cd web
bun install --frozen-lockfile
bun run build
cd ..
go build -trimpath -ldflags '-s -w' -o gitwiki ./cmd/gitwiki
./gitwiki -h
```

成功信号是 `internal/web/dist/index.html` 和根目录的 `gitwiki` 二进制均存在，帮助输出包含 `-config`。Vite 直接输出到 `internal/web/dist`，Go 将该目录嵌入二进制；不要把产物另拷到 `web/dist`。

构建机器和运行机器的系统、架构需要匹配。若从其他机器为 Linux 构建，在前端构建完成后执行：

```bash
# x86_64 服务器；ARM64 服务器将 amd64 改为 arm64
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags '-s -w' -o gitwiki-linux ./cmd/gitwiki
```

将生成的 Linux 二进制传到运行服务器。后续安装命令假定在服务器上执行，且当前目录中已有适用于该服务器的 `gitwiki`；交叉构建的文件需要先改名。

## 注册 GitHub OAuth App

在 [GitHub Developer settings](https://github.com/settings/developers) 的 OAuth Apps 中创建应用，不能用 GitHub App 的配置替代：

- Application name：例如 `Team GitWiki`。
- Homepage URL：`https://wiki.example.com`。
- Authorization callback URL：`https://wiki.example.com/auth/callback`。

记录 Client ID，生成 Client secret，稍后填入配置。若创建界面启用了「Expire user access tokens」，关闭该选项：当前代码没有刷新短期 access token 的流程。[GitHub 官方创建说明](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) 也要求未支持短期 token 的应用关闭此选项。

本地登录调试使用 `http://localhost:8080` 和 `http://localhost:8080/auth/callback`。浏览器访问地址、协议、端口和回调必须对应；不要混用 `localhost` 与 `127.0.0.1`，否则 OAuth state cookie 可能无法带回。

登录请求的 scope 是 `repo user:email`。组织如果限制第三方 OAuth App，需由组织管理员批准应用访问，单纯拥有仓库 Write 权限还不够。

## 安装和配置

以下命令仅用于新服务器；如果已经存在 `gitwiki` 用户或部署目录，先检查原有部署，再决定是否复用。

```bash
sudo useradd --system --create-home --home-dir /var/lib/gitwiki --shell /usr/sbin/nologin gitwiki
sudo install -d -m 750 -o root -g gitwiki /etc/gitwiki
sudo install -d -m 700 -o gitwiki -g gitwiki /var/lib/gitwiki/repos
sudo install -m 755 gitwiki /usr/local/bin/gitwiki
openssl rand -hex 32
```

用最后一条命令的输出作为 `session_secret`。执行 `sudoedit /etc/gitwiki/config.yaml`，填入：

```yaml
listen: "127.0.0.1:8080"

github:
  client_id: "填入 Client ID"
  client_secret: "填入 Client secret"

session_secret: "填入生成的随机字符串"

repos:
  - slug: team
    github: OWNER/wiki-content
    branch: main
    workdir: /var/lib/gitwiki/repos/team
    content_dir: content
    title: 团队 Wiki
    read_public: false
    source: [markdown, mediawiki]
    # site_url: https://docs.example.com
```

设置文件权限：

```bash
sudo chown root:gitwiki /etc/gitwiki/config.yaml
sudo chmod 640 /etc/gitwiki/config.yaml
```

`slug` 是访问路径中的短名，必须唯一，建议仅使用字母、数字和连字符。`github` 使用 `owner/repo`，不是完整 URL；`branch` 必须已经存在。`workdir` 是服务独占的 Git 工作副本，不要指向自己的开发目录，也不要让多个服务进程共用同一工作副本。

`content_dir` 相对于工作副本，默认 `content`；不设置 `branch` 时默认 `main`。`source` 可省略；设置后允许导入列出的 `markdown`、`mediawiki` 格式。`site_url` 只提供「在站点中查看」链接，不会启动发布任务。修改配置后需要重启进程。

`read_public: true` 会公开整个 Wiki 的读取接口，包括历史、评论、附件和草稿页面；`draft: true` 只影响 Hugo 发布，不会隐藏 gitwiki 中的页面。私有仓库开启公开阅读时，先由有读取权限的账号登录并打开该 Wiki，完成首次克隆，然后再做匿名访问验收。全新的工作副本没有访问私有仓库的凭据，匿名首次访问会返回 `clone failed`。

配置和工作副本都按凭据文件保护：会话 cookie 含有签名但未加密的 GitHub token，克隆和推送还会将 token 写入工作副本的 Git remote URL。不要公开 `.git/config`，也不要把 `git remote -v` 的原始输出发到日志或问题单。保持 `session_secret` 稳定；重启本身不会使现有 cookie 失效，更换 secret 才会使已有会话失效。

登录 cookie 有效期为 7 天，仓库权限按账号、仓库和凭据缓存 5 分钟。新登录凭据会立即重新检查权限。如果 GitHub 返回 401，gitwiki 会清除本地登录 cookie：刷新根路径后显示登录页，私有 Wiki 的读取及写入接口返回 401，公开 Wiki 仍可匿名阅读。重新登录可恢复有效凭据，不会继续使用旧凭据的拒绝结果。

## 验证本机启动

在服务器前台运行服务：

```bash
sudo -u gitwiki /usr/local/bin/gitwiki -config /etc/gitwiki/config.yaml
```

另一个终端执行：

```bash
curl --fail --silent --show-error http://127.0.0.1:8080/api/me
curl --fail --silent --show-error http://127.0.0.1:8080/ -o /tmp/gitwiki-index.html
```

预期日志出现 `listening on 127.0.0.1:8080`，未登录的 `/api/me` 返回 `{"user":null}`，HTML 文件包含前端资源引用。此时还没有证明仓库克隆和 GitHub 登录成功：服务在首次读取仓库时才克隆。

验证后在前台终端按 Ctrl+C 停止该测试进程，再配置 systemd，避免争抢端口。

## 用 systemd 常驻运行

执行 `sudoedit /etc/systemd/system/gitwiki.service`，填入：

```ini
[Unit]
Description=GitWiki
Wants=network-online.target
After=network-online.target

[Service]
User=gitwiki
Group=gitwiki
WorkingDirectory=/var/lib/gitwiki
ExecStart=/usr/local/bin/gitwiki -config /etc/gitwiki/config.yaml
Environment=PATH=/usr/local/bin:/usr/bin:/bin
UMask=0077
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemd-analyze verify /etc/systemd/system/gitwiki.service
sudo systemctl daemon-reload
sudo systemctl enable --now gitwiki
sudo systemctl status gitwiki --no-pager
sudo journalctl -u gitwiki -n 50 --no-pager
curl --fail --silent --show-error http://127.0.0.1:8080/api/me
```

应显示服务 active，HTTP 请求成功。后台 Git 操作使用服务用户的环境，因此不能用管理员终端中一次成功的 Git 操作替代服务用户的验证。

## 配置 HTTPS 和 WebSocket 代理

以下配置面向全新的 Nginx。先让域名指向服务器，确认 80、443 端口可达。执行 `sudoedit /etc/nginx/sites-available/gitwiki`，填入：

```nginx
server {
    listen 80;
    server_name wiki.example.com;
    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/gitwiki /etc/nginx/sites-enabled/gitwiki
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d wiki.example.com --redirect
sudo nginx -t
curl --fail --silent --show-error https://wiki.example.com/api/me
sudo certbot renew --dry-run
```

Certbot 会交互询问邮箱等信息，签发证书并为此站点加入 HTTPS 和 HTTP 跳转。最后一个命令验证续期流程。证书签发失败时先检查域名解析和 80 端口，不要绕过浏览器证书错误登录。

Nginx 必须显式转发 WebSocket 的 Upgrade 和 Connection 头；其默认空闲超时是 60 秒，上例加长了超时。[Nginx 官方说明](https://nginx.org/en/docs/http/websocket.html) 描述了这两个要求。HTTP 服务本身不提供 TLS，因此对外通过 HTTPS 代理访问，不开放 8080。

当前会话 cookie 没有 `Secure` 标记。HTTP 跳转不能阻止 cookie 随第一个 HTTP 请求发出，这是当前版本的安全缺口；开放公网登录前应补上安全 cookie 配置。下面的 HTTPS 命令不代表该缺口已经修复。

用根路径提供服务，例如 `https://wiki.example.com/team`。当前前端和 API 使用绝对路径，不要部署到 `/gitwiki/` 子路径。gitwiki 不依赖 Vite 开发服务器；正式环境只需要二进制、配置、Git 和工作副本。

## 第一次登录和写作

1. 打开 `https://wiki.example.com/team`，点击 GitHub 登录。授权后应回到 Wiki，显示自己的账号。私有仓库首次打开时会克隆，等待页面树和首页出现。
2. 使用有 push 权限的账号新建「部署验收」页面。进入编辑模式，输入一个标题、一段正文和一条列表，点击保存。刷新页面，确认正文仍在。
3. 在 GitHub 查看文档仓库的目标分支，确认新增了页面文件和对应提交。界面「已保存」表示本地 commit 完成，不能单独证明 GitHub 已收到提交。
4. 在页面下新建子页面，上传一张小图片，保存并刷新，确认子页面、图片和附件链接可打开。服务会自动安排页面和附件的存储位置。
5. 添加评论并使用界面的保存操作，然后刷新确认评论仍在。只暂存在服务内存中的评论会在重启后丢失。
6. 搜索正文中的关键字，打开搜索结果；打开页面历史，确认能查看刚才的版本。需要删除测试页面时，可从回收站恢复。

导入入口需要配置 `source`，支持导入 `.md` 和 `.wiki`。页面 URL 后加 `.md` 显示带标题的 Markdown 正文，不是包含所有 front matter 的原始文件；加 `.pdf` 返回 HTML 打印页，通过浏览器另存为 PDF，不是服务端生成的 PDF 文件。

页面草稿保存在当前浏览器，不能当作服务器备份。多人编辑在保存时做三方合并；同一处出现冲突时，需在界面对比处理。

搜索同时匹配标题、正文和页面路径，标题命中优先；空格分开的多个关键词需要全部匹配。可组合目录（含子页面）、标签、最近 7 / 30 / 90 天更新、草稿 / 非草稿筛选，也可不输入关键词直接筛选，最多显示 50 个匹配页面。这里的草稿状态指页面属性中的草稿标记，与浏览器未保存的修改不同。

页面标题下显示最后更新时间，按浏览器本地时区展示。该时间和搜索中的更新时间均取自最后一次修改页面文件的 Git 提交，不使用 front matter 的发布日期；尚未提交的文件不参与更新时间筛选。

移动页面可在右上角菜单选择「移动到…」，或在侧栏拖到另一页面下面。子页面、附件、已保存评论和待保存评论一起迁移；相关 Markdown 链接、图片、引用式链接、HTML 的 `href` / `src` / `poster`、Hugo 的 `ref` / `relref` 自动更新，锚点和查询参数保留，行内代码与围栏代码示例保持原样。目标已有页面或评论记录、涉及文件有未提交修改时，移动会被拒绝；写入或提交失败会回滚本次改动。

保持连接的浏览器会跟到新地址，并更新收藏、最近浏览和本机草稿。其他人移动了正在编辑的页面时，未保存内容会保留为本机草稿，需恢复并检查后再保存。离线设备的本机记录、浏览器书签及其他站点保存的旧地址无法通过实时通知更新，需使用新地址。

## 文档健康、废弃状态和模板

打开 Wiki 后会自动检查当前已保存文档，保存或页面树更新后再次检查 Markdown 页面链接、图片、附件、标题锚点和替代页面。发现问题时顶部显示「文档问题」及数量，点击查看页面、问题类型、正文行号和原文；没有问题时不显示提示。点击问题后，有编辑权限的用户进入对应行，无编辑权限的用户定位到阅读视图的对应段落。修复后提示会自动更新，也可在详情中点击「重新检查」。检查失败会显示失败提示，避免将未完成检查误认为没有问题。检查不请求外部网址；代码示例、原始 HTML 和 Hugo 短代码不在检查范围内。标题锚点以 gitwiki 预览为准，自定义 Hugo 渲染规则可能不同。

编辑页面时勾选「已废弃」，可选择一个替代页面；保存后正文顶部出现提示，搜索结果也会显示「已废弃」。取消勾选会同时清除替代页面。该标记不会删除正文或隐藏页面，也不会自动修改 Hugo 主题的展示。替代页面移动时引用一起更新；删除后，原页面提示替代页面不存在，健康检查会列出该问题。

模板放在文档仓库根目录的 `.gitwiki/templates/`，与 `content_dir` 平级或独立，读取该目录下直接存放的 `.md` 文件。例如：

```text
文档仓库/
├── .gitwiki/templates/
│   ├── runbook.md
│   └── troubleshooting.md
└── content/
```

模板使用普通 Markdown，可用 front matter 的 `title` 设置选择器中的名称，`description` 说明用途，`tags` 和 `draft` 设置新页面的初始属性。创建时使用用户输入的新标题，复制正文、标签、描述和草稿标记，不继承模板日期、废弃状态、替代页面或自定义 URL。模板中的站内链接建议使用 `/页面路径`；图片和附件不会随模板复制。

可将本项目 [examples/templates](../examples/templates/) 中的操作手册、故障排查、设计方案复制到文档仓库的 `.gitwiki/templates/`，提交后通过现有 Git 同步更新。新建页面对话框会显示模板选择和内容预览；目录不存在时仍可创建空白页面。修改或删除模板不影响此前创建的文档。

## 部署验收

完成以下检查，才算验证了实际部署：

- 未登录且 `read_public: false`：页面读取接口返回 401；首页 HTML 返回 200 并不表示有文档读取权限。
- 开启公开阅读并完成必要的首次克隆：在无痕窗口直接访问 `/team` 可阅读；根路径 `/` 仍可能显示登录页，应分享含仓库 slug 的 URL。
- 未登录尝试写入：POST / PUT / DELETE 页面接口以及评论、附件上传接口返回 401。
- 登录但仅有仓库读取权限：可通过明确的 `/team` 地址阅读，写入返回 403。非公开的只读仓库当前不会列在仓库选择器中。
- 有 push 权限：完成新建、编辑、附件、评论操作，刷新后内容存在，GitHub 的目标分支也能看到提交。
- 两个已登录的浏览器窗口打开同一页面：能看到在线成员；浏览器 Network 中 `/ws` 返回 101，协作提示正常。
- 重启服务后继续阅读；登录状态在 secret 不变且会话未过期时保留，已保存页面和评论存在。
- 检查 HTTPS 证书、HTTP 跳转和证书续期；从外部网络访问，排除只在服务器本机能访问的情况。

匿名权限可用命令复核，以下检查不会创建页面：

```bash
# 默认未公开时预期 401；公开并完成克隆时预期 200
curl --silent --show-error -o /dev/null -w '%{http_code}\n' \
  https://wiki.example.com/api/repos/team/pages

# 未登录写入预期 401
curl --silent --show-error -o /dev/null -w '%{http_code}\n' \
  -X POST -H 'Content-Type: application/json' -d '{"title":"验收"}' \
  https://wiki.example.com/api/repos/team/page
```

后台推送失败时先检查服务日志和工作副本，不要删除本地目录重建，本地可能有尚未推送的提交：

```bash
sudo journalctl -u gitwiki -n 100 --no-pager
sudo -u gitwiki git -C /var/lib/gitwiki/repos/team status --short --branch
sudo -u gitwiki git -C /var/lib/gitwiki/repos/team log --oneline origin/main..HEAD
```

最后一条命令有输出表示本地领先于当前记录的远端分支；`origin/main` 是最后一次 fetch 的结果，进一步确认时还需检查 GitHub 实际分支。后台推送按 5 秒起、最长 5 分钟间隔重试，本地无待推送提交时每分钟拉取远端更新。遇到 rebase 冲突，先停服务并备份整个工作副本，再由管理员处理冲突，验证后重新启动。

有仓库写权限的用户可打开顶部“同步状态”，查看本次服务启动以来最近成功拉取时间、待推送提交数，以及最近的拉取或推送失败原因。待推送数量相对于最近一次 fetch 记录的远端分支计算。点击“立即同步”会唤醒已有的后台循环，先推送待同步提交，再拉取远端更改；请求返回只代表已触发，面板会每两秒更新结果。若推送持续失败，先处理失败原因，拉取会等待推送完成。状态只保存在内存中，重启后重新记录成功时间。

## 常见失败

- `pattern all:dist: no matching files found`：直接构建了 Go，尚未构建前端。先执行 `bun run build`，确认 `internal/web/dist/index.html` 存在，再编译 Go。
- `session_secret is required` / `at least one repo is required`：配置缺失。检查实际 `-config` 路径。当前启动检查不会验证 OAuth 密钥是否正确，看到 listening 仍需测试登录。
- `git clone` 失败：核对仓库名、分支、网络和首次读取的账号权限；空仓库先创建首个提交。私有仓库的匿名首次克隆失败时，先登录打开仓库。
- `bad oauth state`：检查访问域名和回调是否对应、浏览器是否允许 cookie；使用同一地址重新发起登录。
- 登录后 403：检查 GitHub 仓库权限、组织的 OAuth App 批准状态。权限结果缓存 5 分钟，授权变更可能需要等缓存失效。
- 页面已保存但 GitHub 没有提交：打开顶部“同步状态”，检查失败原因、待推送数量、分支保护、token 有效性和服务日志。OAuth token 被撤销或过期后需重新登录，再点“立即同步”或再次写入，为后台循环更新凭据。
- 代理返回 502：先检查服务是否 active、本机 `/api/me` 是否可访问及端口是否一致。
- 上传返回 413：检查代理上传体积限制；示例限制为整个请求 64 MiB，并非每个文件 64 MiB。后端的 multipart 内存参数不是上传大小硬限制。
- 能阅读但看不到在线成员：匿名阅读不连接 WebSocket；登录后的连接还需检查 Nginx Upgrade 头和超时。

## 备份和升级

GitHub 保存已成功推送的数据，本地工作副本可能额外保存未推送的提交。备份需包含 `/etc/gitwiki/config.yaml` 和 `/var/lib/gitwiki`，不能只备份 `content/`；备份副本含凭据，按原文件的访问权限保存。

升级前确认同步状态，停服务后备份配置、数据和旧二进制，再安装新二进制，启动并执行本机 HTTP、登录、阅读和写入验收。回滚时恢复旧二进制和对应配置；不要覆盖升级期间已经产生的新文档提交。

```bash
sudo systemctl stop gitwiki
# 此处先完成备份，再安装已构建的新二进制
sudo install -m 755 gitwiki /usr/local/bin/gitwiki
sudo systemctl start gitwiki
sudo systemctl status gitwiki --no-pager
curl --fail --silent --show-error http://127.0.0.1:8080/api/me
```

## 本轮验证记录

2026-10-05，以源码提交 `5f015b5` 的干净副本验证，没有复用现有 `node_modules`、前端产物、二进制或文档工作副本。构建环境是 macOS ARM64，Git 2.56.0、Go 1.27.1、Bun 1.3.14；运行验证另使用了一个全新的 Ubuntu 24.04 ARM64 容器。宿主机已有工具和缓存，容器验证也不能替代完整服务器的启动和公网验收。

已通过：

- 锁文件安装、前端类型检查及 Vite 生产构建、Go 二进制构建。前端构建有大于 500 kB 的 chunk 提示，不影响构建成功。
- `go test -race ./internal/auth ./internal/gitstore ./internal/importer`，包括已有的权限、页面存储、合并、同步和导入测试。未运行 `task test`。
- 独立端口启动嵌入前端的二进制；公开仓库在空工作目录下首次克隆成功，并能返回空页面树。
- 私有测试仓库匿名首次克隆返回 500，未携带凭据的直接 Git 请求也失败；使用本机已有 Git 凭据预克隆到隔离目录后，匿名阅读成功。这验证了前文的首次克隆限制，没有验证真实 OAuth 克隆。
- 24 项 HTTP 断言：HTML 和静态资源、缓存头、无效资源 / API 的 404、公开页面树与正文、搜索、历史、最近更新、评论、附件列表、反链、回收站、Markdown / 打印页、匿名读取受保护仓库及写入的 401、匿名 WebSocket 拒绝、无效 OAuth state 的 400。
- Chrome 实际打开首页，点击搜索、输入关键字、选择结果并打开页面；刷新后页面内容正常。
- 重启隔离进程后页面继续可读，已克隆的工作副本仍被使用。
- `go test ./...`、GoReleaser 配置校验及六个平台产物构建通过；相对上一提交的 `golangci-lint run --new-from-rev=HEAD~1 ./...` 返回 `0 issues`，这不代表历史 lint 问题全部清理。
- 发布 [v0.1.0](https://github.com/jimyag/gitwiki/releases/tag/v0.1.0)，包含六个二进制和 SHA-256 校验文件。产物基于 `5f015b5`，本使用文档在该版本之后编写，不包含在该 tag 中。
- 从公开 Release URL 重新下载 macOS ARM64 二进制和校验文件，SHA-256 验证通过；使用下载的二进制替换隔离进程，浏览器刷新后仍可阅读已有页面。
- 在全新 Ubuntu 24.04 ARM64 容器中安装本文的依赖（另安装 systemd 用于配置检查），校验下载的 Linux ARM64 二进制。按本文创建服务用户和目录，实际以服务用户启动，首次克隆公开仓库成功；提取本文的 Nginx 配置，通过 `nginx -t` 并实际验证 HTTP 代理、匿名读取和写入返回 401。容器中的 Git 为 2.43.0，Certbot 为 2.9.0。
- 本文 systemd unit 通过 `systemd-analyze verify`；容器没有以 systemd 作为 PID 1，因此未执行 `systemctl enable --now`，也未验证开机启动。

自动化问题及修复：[原 Check 运行](https://github.com/jimyag/gitwiki/actions/runs/37279565639) 中，lint / test 都因 `pattern all:dist: no matching files found` 失败，build 作业通过；[原 Release 运行](https://github.com/jimyag/gitwiki/actions/runs/37281114676) 也有同样的问题。现已让 Check 的 lint / test 作业先构建前端，并将 Release 的构建放到检查之前。Release 的增量 lint 改为以 `v0.1.0` 为基线，避免新 tag 的全零比较 SHA 导致检查全部历史问题。Release 新增手动入口：选择 `main` 时验证并构建快照，选择 `v*` tag 时正式发布。`v0.1.0` 本身仍是本地验证后上传的版本，旧 tag 上的失败记录不会因此变绿。

[修复后的 Check 运行](https://github.com/jimyag/gitwiki/actions/runs/37284089617) 全部通过，包括构建、lint、测试和覆盖率上传。Codecov CLI 下载端点存在 TLS 握手错误，`ingest.codecov.io` 的证书已过期；现改用 PyPI 安装 CLI，并通过 TLS 正常的 `https://codecov.io` 上传，保留 OIDC 和上传失败时报错。中间一次运行返回 `Repository not found`，最新运行未再出现该错误，日志确认覆盖率文件已传到存储并进入处理队列；本轮没有修改 Codecov 的仓库接入或权限配置。[Release 快照运行](https://github.com/jimyag/gitwiki/actions/runs/37283829904) 的验证和六个平台构建也全部通过；快照没有发布新版本。

仍未验证：新的 GitHub OAuth App 注册及真实回调、真实编辑后的 GitHub push、双账号协作、Linux systemd 常驻和开机启动、Certbot 证书签发和续期及公网 HTTPS。这些需要在目标部署上按前面的验收清单执行；现有后端测试不能替代真实登录和远端写入验收。会话 cookie 的 `Secure` 标记缺口尚未修复，本轮没有修改业务代码。
