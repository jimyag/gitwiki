// Package gitstore manages per-repo local working copies and the save path:
// write -> (merge on conflict) -> commit as user; a background loop pushes to origin (push.go).
package gitstore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jimyag/gitwiki/internal/auth"
	"github.com/jimyag/gitwiki/internal/config"
)

var (
	ErrConflict = errors.New("merge conflict")
	ErrBadPath  = errors.New("invalid path")
)

type Repo struct {
	cfg config.Repo
	// mu guards the working copy and HEAD: writers Lock (local git only, pushing is in push.go),
	// readers share RLock.
	mu     sync.RWMutex
	cloned atomic.Bool // lets EnsureCloned skip the lock once the checkout exists

	pushKick chan struct{} // wakes the push loop; buffered(1) so requests coalesce
	tokens   TokenSource   // nil: origin needs no credentials (tests use local origins)
	homepage string        // the repo's website on GitHub: the default SiteURL

	syncMu     sync.Mutex
	syncStatus SyncStatus

	// lastRecentCreate dedups rapid duplicate create requests (e.g. user double-clicks
	// "create" while a network roundtrip is outstanding). Keyed by parentID+title.
	recentCreateMu sync.Mutex
	recentCreate   map[string]recentCreate
}

type recentCreate struct {
	id string
	at time.Time
}

// TokenSource gives the credential for cloning, pulling and pushing GitHub repo "owner/name":
// the GitHub App's installation token. It never depends on who is logged in.
type TokenSource func(ctx context.Context, githubRepo string) (string, error)

// Lookup tells what GitHub knows of repo "owner/name" through the App, failing with
// auth.ErrNotInstalled where the App is not installed.
type Lookup func(ctx context.Context, name string) (auth.RepoInfo, error)

// Manager hands out the wikis: the GitHub repos the App is installed on, each set up the
// first time it is asked for, with its working copy at <data dir>/<owner>/<repo>.
type Manager struct {
	dataDir string
	tokens  TokenSource
	lookup  Lookup

	mu     sync.Mutex
	repos  map[string]*Repo // by lower-case "owner/repo": GitHub ignores case in names
	onSync func(slug string, err error)
	onPull func(slug string, pages []string)
}

func NewManager(dataDir string, tokens TokenSource, lookup Lookup) *Manager {
	return &Manager{dataDir: dataDir, tokens: tokens, lookup: lookup, repos: map[string]*Repo{}}
}

// Get returns wiki "owner/repo", setting it up on first use. The wiki lives on the repo's
// "wiki" branch when it has one, else on the default branch; a working copy already on disk
// keeps the branch it has. Get does not clone: EnsureCloned does.
func (m *Manager) Get(ctx context.Context, name string) (*Repo, error) {
	key := strings.ToLower(name)
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.repos[key]; ok {
		return r, nil
	}
	if m.lookup == nil {
		return nil, ErrNotFound
	}
	info, err := m.lookup(ctx, name)
	if errors.Is(err, auth.ErrNotInstalled) {
		return nil, fmt.Errorf("%w: %w", ErrNotFound, err)
	}
	if err != nil {
		return nil, err
	}
	owner, repo, _ := strings.Cut(info.FullName, "/")
	workdir := filepath.Join(m.dataDir, owner, repo)
	branch := info.DefaultBranch
	if info.WikiBranch {
		branch = "wiki"
	}
	r := &Repo{
		cfg:      config.Repo{Github: info.FullName, Branch: branch, Workdir: workdir, ContentDir: "content"},
		tokens:   m.tokens,
		homepage: info.Homepage,
	}
	// A working copy already on disk stays on the branch it was cloned with. --git-dir=.git:
	// without a copy here, git must not find a repo further up (data_dir inside a checkout).
	if out, err := r.gitOut(ctx, "--git-dir=.git", "symbolic-ref", "--short", "HEAD"); err == nil {
		r.cfg.Branch = strings.TrimSpace(string(out))
	}
	m.repos[key] = r
	if m.onSync != nil {
		slug := info.FullName
		r.startSync(func(err error) { m.onSync(slug, err) }, func(pages []string) { m.onPull(slug, pages) })
	}
	return r, nil
}

// EnsureCloned makes sure workdir is a git checkout of cfg.Github at cfg.Branch.
func (r *Repo) EnsureCloned(ctx context.Context) error {
	if r.cloned.Load() {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, err := os.Stat(filepath.Join(r.cfg.Workdir, ".git")); err == nil {
		r.cloned.Store(true)
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(r.cfg.Workdir), 0o755); err != nil {
		return err
	}
	token, err := r.token(ctx)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "git", "clone", "--depth", "100",
		"--branch", r.cfg.Branch, "--single-branch", authedURL(r.cfg.Github, token), r.cfg.Workdir)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return redact(fmt.Errorf("git clone: %w: %s", err, out), token)
	}
	r.cloned.Store(true)
	return nil
}

func (r *Repo) token(ctx context.Context) (string, error) {
	if r.tokens == nil {
		return "", nil
	}
	return r.tokens(ctx, r.cfg.Github)
}

// useToken points origin at a fresh installation token before talking to GitHub, and returns
// it so errors can be redacted. Without a token source origin stays as it is.
func (r *Repo) useToken(ctx context.Context) (string, error) {
	token, err := r.token(ctx)
	if err != nil || r.tokens == nil {
		return token, err
	}
	return token, r.git(ctx, "remote", "set-url", "origin", authedURL(r.cfg.Github, token))
}

func authedURL(githubRepo, token string) string {
	return "https://" + url.UserPassword("x-access-token", token).String() + "@github.com/" + githubRepo + ".git"
}

// resolvePath validates an editor-supplied path inside content dir.
func (r *Repo) resolvePath(rel string) (string, error) {
	if rel == "" || strings.HasPrefix(rel, "/") || strings.HasPrefix(rel, `\`) {
		return "", ErrBadPath
	}
	clean := filepath.Clean(rel)
	if clean != rel || strings.HasPrefix(clean, "..") || strings.Contains(clean, string(filepath.Separator)+"..") {
		return "", ErrBadPath
	}
	root := filepath.Clean(r.cfg.Workdir)
	abs := filepath.Join(root, r.cfg.ContentDir, clean)
	rootWithSep := filepath.Join(root, r.cfg.ContentDir) + string(filepath.Separator)
	if !strings.HasPrefix(abs+string(filepath.Separator), rootWithSep) {
		return "", ErrBadPath
	}
	return abs, nil
}

type File struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	BaseSHA string `json:"base_sha"`
}

type Entry struct {
	Path  string `json:"path"`
	IsDir bool   `json:"is_dir"`
}

func (r *Repo) List(ctx context.Context, subdir string) ([]Entry, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var abs string
	var err error
	if subdir == "" {
		abs = filepath.Join(r.cfg.Workdir, r.cfg.ContentDir)
	} else {
		abs, err = r.resolvePath(subdir)
		if err != nil {
			return nil, err
		}
	}
	ents, err := os.ReadDir(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return []Entry{}, nil
		}
		return nil, err
	}
	out := make([]Entry, 0, len(ents))
	for _, e := range ents {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		if !e.IsDir() && !strings.HasSuffix(name, ".md") {
			continue
		}
		out = append(out, Entry{
			Path:  filepath.ToSlash(filepath.Join(subdir, name)),
			IsDir: e.IsDir(),
		})
	}
	return out, nil
}

func (r *Repo) Read(ctx context.Context, rel string) (*File, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	abs, err := r.resolvePath(rel)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	head, err := r.headSHA(ctx)
	if err != nil {
		return nil, err
	}
	return &File{Path: rel, Content: string(data), BaseSHA: head}, nil
}

func (r *Repo) headSHA(ctx context.Context) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", r.cfg.Workdir, "rev-parse", "HEAD")
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// merge3 performs a 3-way merge using `git merge-file`. Returns merged text
// and whether conflicts exist (text then still contains conflict markers).
func (r *Repo) merge3(ctx context.Context, rel, baseSHA, currentSHA, theirs string) (string, bool, error) {
	tmp, err := os.MkdirTemp("", "gitwiki-merge-*")
	if err != nil {
		return "", false, err
	}
	defer os.RemoveAll(tmp)

	basePath := filepath.Join(tmp, "base")
	curPath := filepath.Join(tmp, "current")
	theirPath := filepath.Join(tmp, "theirs")

	repoRel := filepath.ToSlash(filepath.Join(r.cfg.ContentDir, rel))
	baseContent, _ := r.gitOut(ctx, "show", baseSHA+":"+repoRel)   // may not exist for new file
	curContent, _ := r.gitOut(ctx, "show", currentSHA+":"+repoRel) // should exist if head has it
	if err := os.WriteFile(basePath, baseContent, 0o600); err != nil {
		return "", false, err
	}
	if err := os.WriteFile(curPath, curContent, 0o600); err != nil {
		return "", false, err
	}
	if err := os.WriteFile(theirPath, []byte(theirs), 0o600); err != nil {
		return "", false, err
	}

	// merge-file [options] current-file base-file other-file
	// Writes merged result (with markers if conflict) into current-file. The labels end up in
	// the text the user resolves, so they say whose side is whose.
	cmd := exec.CommandContext(ctx, "git", "merge-file",
		"-L", "别人的修改", "-L", "修改前", "-L", "你的修改",
		curPath, basePath, theirPath)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	runErr := cmd.Run()
	conflict := false
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) && exitErr.ExitCode() > 0 {
			conflict = true
		} else {
			return "", false, runErr
		}
	}
	merged, err := os.ReadFile(curPath)
	if err != nil {
		return "", false, err
	}
	return string(merged), conflict, nil
}

func (r *Repo) git(ctx context.Context, args ...string) error {
	return r.gitEnv(ctx, nil, args...)
}

func (r *Repo) gitEnv(ctx context.Context, extraEnv []string, args ...string) error {
	full := append([]string{"-C", r.cfg.Workdir}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	env := append([]string{}, os.Environ()...)
	env = append(env, "GIT_TERMINAL_PROMPT=0")
	env = append(env, extraEnv...)
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, bytes.TrimSpace(out))
	}
	return nil
}

func (r *Repo) gitOut(ctx context.Context, args ...string) ([]byte, error) {
	full := append([]string{"-C", r.cfg.Workdir}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	return cmd.Output()
}

// ReadRaw returns the file at rel inside the content dir. Unlike Read it reports the
// absence of the file cleanly instead of as an os error.
func (r *Repo) ReadRaw(rel string) (string, bool, error) {
	abs, err := r.resolvePath(rel)
	if err != nil {
		return "", false, err
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	data, err := os.ReadFile(abs)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return string(data), true, nil
}

// SaveRaw writes rel as a commit authored by u; the caller gets the previous HEAD (which
// is also its merge base) back at HEAD. Used for files that are not pages (e.g. comments).
func (r *Repo) SaveRaw(rel, content, baseSHA, message string, u *auth.User) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	abs, err := r.resolvePath(rel)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		return "", err
	}
	if err := r.git(context.TODO(), "add", "--", filepath.ToSlash(filepath.Join(r.cfg.ContentDir, rel))); err != nil {
		return "", err
	}
	if err := r.git(context.TODO(), "diff", "--cached", "--quiet"); err == nil {
		return r.headSHA(context.TODO())
	}
	if err := r.commitAs(context.TODO(), u, message); err != nil {
		return "", err
	}
	sha, err := r.headSHA(context.TODO())
	if err != nil {
		return "", err
	}
	r.schedulePush()
	return sha, nil
}

// HeadSHA is the current commit of the working copy.
func (r *Repo) HeadSHA() (string, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.headSHA(context.TODO())
}

// Slug is the wiki's "owner/repo", for keying non-git state (e.g. pending comments).
func (r *Repo) Slug() string { return r.cfg.Github }

// ReadAssetFile opens the stored bytes of one of a page's assets.
func (r *Repo) ReadAssetFile(ctx context.Context, pageID, name string) (*os.File, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, err := r.AssetPath(pageID, name)
	if err != nil {
		return nil, err
	}
	return os.Open(p)
}
