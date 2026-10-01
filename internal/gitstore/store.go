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
	ErrPush     = errors.New("push rejected")
)

type Repo struct {
	cfg config.Repo
	// mu guards the working copy and HEAD: writers Lock (local git only, pushing is in push.go),
	// readers share RLock.
	mu     sync.RWMutex
	cloned atomic.Bool // lets EnsureCloned skip the lock once the checkout exists

	pushKick chan struct{}          // wakes the push loop; buffered(1) so requests coalesce
	token    atomic.Pointer[string] // newest writer's GitHub token, used by the next push

	// lastRecentCreate dedups rapid duplicate create requests (e.g. user double-clicks
	// "create" while a network roundtrip is outstanding). Keyed by parentID+title.
	recentCreateMu sync.Mutex
	recentCreate   map[string]recentCreate
}

type recentCreate struct {
	id string
	at time.Time
}

type Manager struct {
	repos map[string]*Repo // keyed by slug
}

func NewManager(cfg *config.Config) *Manager {
	m := &Manager{repos: map[string]*Repo{}}
	for _, rc := range cfg.Repos {
		m.repos[rc.Slug] = &Repo{cfg: rc}
	}
	return m
}

func (m *Manager) Get(slug string) *Repo { return m.repos[slug] }

// EnsureCloned makes sure workdir is a git checkout of cfg.Github at cfg.Branch.
func (r *Repo) EnsureCloned(ctx context.Context, token string) error {
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
	remote := authedURL(r.cfg.Github, token)
	cmd := exec.CommandContext(ctx, "git", "clone", "--depth", "100",
		"--branch", r.cfg.Branch, "--single-branch", remote, r.cfg.Workdir)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git clone: %w: %s", err, out)
	}
	r.cloned.Store(true)
	return nil
}

func (r *Repo) setPushToken(ctx context.Context, token string) error {
	return r.git(ctx, "remote", "set-url", "origin", authedURL(r.cfg.Github, token))
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

// Save writes content at rel and creates a commit as the user.
// If upstream moved since baseSHA, 3-way merges via git merge-file; conflict
// is returned as ConflictError carrying the marker-annotated content for the UI.
func (r *Repo) Save(ctx context.Context, rel, content, baseSHA, message string, u *auth.User) (commitSHA string, retErr error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	abs, err := r.resolvePath(rel)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", err
	}

	if err := r.git(ctx, "fetch", "origin", r.cfg.Branch); err != nil {
		return "", fmt.Errorf("fetch: %w", err)
	}
	localHead, err := r.headSHA(ctx)
	if err != nil {
		return "", err
	}

	if localHead != baseSHA {
		merged, conflict, err := r.merge3(ctx, rel, baseSHA, localHead, content)
		if err != nil {
			return "", err
		}
		if conflict {
			return "", &ConflictError{Path: rel, Merged: merged, CurrentSHA: localHead}
		}
		content = merged
		if err := r.git(ctx, "merge", "--ff-only", "origin/"+r.cfg.Branch); err != nil {
			return "", fmt.Errorf("ff to origin: %w", err)
		}
	}

	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		return "", err
	}
	// Path relative to repo root for git.
	gitPath := filepath.ToSlash(filepath.Join(r.cfg.ContentDir, rel))
	if err := r.git(ctx, "add", "--", gitPath); err != nil {
		return "", fmt.Errorf("add: %w", err)
	}
	if err := r.git(ctx, "diff", "--cached", "--quiet"); err == nil {
		// nothing changed after merge
		head, _ := r.headSHA(ctx)
		return head, nil
	}
	if message == "" {
		message = "wiki: update " + rel
	}
	name := u.Name
	if name == "" {
		name = u.Login
	}
	email := u.Email
	if email == "" {
		email = u.Login + "@users.noreply.github.com"
	}
	env := []string{
		"GIT_AUTHOR_NAME=" + name,
		"GIT_AUTHOR_EMAIL=" + email,
		"GIT_COMMITTER_NAME=" + name,
		"GIT_COMMITTER_EMAIL=" + email,
	}
	if err := r.gitEnv(ctx, env, "commit", "-m", message); err != nil {
		return "", fmt.Errorf("commit: %w", err)
	}
	sha, err := r.headSHA(ctx)
	if err != nil {
		return "", err
	}
	if err := r.setPushToken(ctx, u.Token); err != nil {
		return sha, err
	}
	if err := r.git(ctx, "push", "origin", r.cfg.Branch); err != nil {
		return sha, fmt.Errorf("%w: %v", ErrPush, err)
	}
	return sha, nil
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
	baseContent, _ := r.gitOut(ctx, "show", baseSHA+":"+repoRel)     // may not exist for new file
	curContent, _ := r.gitOut(ctx, "show", currentSHA+":"+repoRel)   // should exist if head has it
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
