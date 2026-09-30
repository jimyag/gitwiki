# gitwiki

基于 GitHub 仓库的协作 Wiki 编辑器：用户用 GitHub 账号登录，在网页上编辑 Hugo 站点 `content/` 下的页面，保存即以用户身份产生 commit 推到 origin。

![演示](docs/screenshot.png)

## 功能

- GitHub OAuth 登录，scope `repo user:email`，登录后仅显示有 push 权限的白名单仓库
- 页面 / 子页面模型：Hugo `content/foo.md`（leaf）与 `content/foo/_index.md`（bundle）自动迁移
- Markdown 编辑器：CodeMirror 6，Cmd/Ctrl+S 保存
- 粘贴图片 / 文件即上传到 `content/<page>/assets/`，并自动插入 `![](assets/...)` 引用
- 三方合并：保存时若 HEAD 已前进，自动 `git merge-file`；冲突时把带标记的合并结果返回给前端
- 在线感知：WebSocket 在同页面的编辑者之间同步头像 / "X 已保存"提示
- 不主动构建，交给 Hugo server / GitHub Pages / Cloudflare Pages 等既有静态站点管线

## 快速开始

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

## 配置

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
```

## 开发

```bash
# 前端 dev server (proxy /api → 127.0.0.1:8080)
bun --cwd web run dev
# 后端
go run ./cmd/gitwiki -config config.yaml
```

## 目录

```
cmd/gitwiki        # main
internal/auth      # GitHub OAuth + session cookie
internal/config    # yaml config
internal/gitstore  # 本地 git 工作副本 + 三方合并 + 页面抽象
internal/presence  # WebSocket 在场感知
internal/server    # HTTP API + SPA
web                # React + Vite + Tailwind + CodeMirror
```

## 已知限制

- 还没做"删除页面 / 重命名"，目前要回到仓库层手动操作
- 冲突解决 UI 目前是"载入合并结果"模式，还不是双栏 diff
- Hugo 站点本身不含在二进制内，filesystem 依赖 `web/dist`（用 go:embed 待办）
