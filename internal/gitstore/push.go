package gitstore

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Writers commit locally and return; pushing to origin happens here, in the background, so a
// save costs local git time instead of GitHub round trips. There is one loop per repo, so pushes
// never overlap, and requests that arrive during a push collapse into one more push. The same
// loop pulls commits made outside gitwiki, so edits on GitHub show up without a restart.

// pullInterval is how often origin is checked for commits made outside gitwiki.
const pullInterval = time.Minute

type SyncStatus struct {
	LastPull  time.Time `json:"last_pull,omitzero"`
	Pending   int       `json:"pending"`
	Running   bool      `json:"running"`
	Queued    bool      `json:"queued"`
	PullError string    `json:"pull_error,omitempty"`
	PushError string    `json:"push_error,omitempty"`
}

// Status reads local state only; checking it never contacts origin.
func (r *Repo) Status(ctx context.Context) (SyncStatus, error) {
	r.syncMu.Lock()
	status := r.syncStatus
	r.syncMu.Unlock()
	status.Queued = len(r.pushKick) > 0
	r.mu.RLock()
	defer r.mu.RUnlock()
	out, err := r.gitOut(ctx, "rev-list", "--count", "origin/"+r.cfg.Branch+"..HEAD")
	if err != nil {
		return status, err
	}
	status.Pending, err = strconv.Atoi(strings.TrimSpace(string(out)))
	return status, err
}

// RequestSync wakes the existing loop, including a push waiting to retry. Requests coalesce.
func (r *Repo) RequestSync(token string) { r.schedulePush(token) }

// StartSync starts every repo's sync loop. onSync gets the outcome of each push attempt
// (nil: origin has all local commits) so clients can be told when pushing is failing;
// onPull gets the pages that commits pulled from origin changed.
func (m *Manager) StartSync(onSync func(slug string, err error), onPull func(slug string, pages []string)) {
	for slug, r := range m.repos {
		r.startSync(func(err error) { onSync(slug, err) }, func(pages []string) { onPull(slug, pages) })
	}
}

func (r *Repo) startSync(onSync func(error), onPull func([]string)) {
	r.pushKick = make(chan struct{}, 1)
	go r.syncLoop(onSync, onPull)
	// Commits left unpushed by an earlier run (crash, GitHub outage) go out now.
	if _, err := os.Stat(filepath.Join(r.cfg.Workdir, ".git")); err == nil {
		r.schedulePush("")
	}
}

// schedulePush asks the loop to push. A non-empty token (the writer's) is used from now on;
// commits keep their own authors whoever's token pushes them.
func (r *Repo) schedulePush(token string) {
	if token != "" {
		r.token.Store(&token)
	}
	select {
	case r.pushKick <- struct{}{}:
	default: // a push is already pending and will include this commit
	}
}

func (r *Repo) syncLoop(onSync func(error), onPull func([]string)) {
	tick := time.Tick(pullInterval)
	pull := func() {
		pages, err := r.pullOnce()
		if err != nil {
			log.Printf("pull %s: %v", r.cfg.Slug, err)
		} else if len(pages) > 0 {
			onPull(pages)
		}
	}
	for {
		select {
		case <-r.pushKick:
			r.pushUntilDone(onSync)
			pull()
		case <-tick:
			pull()
		}
	}
}

func (r *Repo) pushUntilDone(onSync func(error)) {
	for attempt := 0; ; attempt++ {
		err := r.pushOnce()
		onSync(err)
		if err == nil {
			return
		}
		log.Printf("push %s (attempt %d): %v", r.cfg.Slug, attempt+1, err)
		// Back off 5s, 10s … up to 5 minutes; a new commit retries right away.
		select {
		case <-time.After(min(5*time.Second<<min(attempt, 6), 5*time.Minute)):
		case <-r.pushKick:
		}
	}
}

// pullOnce fast-forwards the working copy to origin and returns the pages that changed. It
// leaves local commits that wait for a push alone: pushOnce rebases them onto origin anyway.
func (r *Repo) pullOnce() (pages []string, err error) {
	r.syncMu.Lock()
	r.syncStatus.Running = true
	r.syncMu.Unlock()
	defer func() {
		err = redact(err, "")
		r.syncMu.Lock()
		defer r.syncMu.Unlock()
		r.syncStatus.Running = false
		r.syncStatus.PullError = ""
		if err != nil {
			r.syncStatus.PullError = err.Error()
		}
	}()
	if _, err := os.Stat(filepath.Join(r.cfg.Workdir, ".git")); err != nil {
		return nil, nil // not cloned yet: the first request clones the current state
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	token := ""
	if t := r.token.Load(); t != nil {
		token = *t
		if err := r.setPushToken(ctx, token); err != nil {
			return nil, redact(err, token)
		}
	}
	if err := r.git(ctx, "fetch", "-q", "origin", r.cfg.Branch); err != nil {
		return nil, redact(err, token)
	}
	r.mu.Lock() // the fast-forward rewrites the working tree
	defer r.mu.Unlock()
	upstream := "origin/" + r.cfg.Branch
	ahead, err := r.gitOut(ctx, "rev-list", "--count", upstream+"..HEAD")
	if err != nil || strings.TrimSpace(string(ahead)) != "0" {
		return nil, err
	}
	old, err := r.headSHA(ctx)
	if err != nil {
		return nil, err
	}
	if err := r.git(ctx, "merge", "-q", "--ff-only", upstream); err != nil {
		return nil, err
	}
	out, err := r.gitOut(ctx, "-c", "core.quotePath=false", "diff", "--name-only", old, "HEAD", "--", r.cfg.ContentDir)
	if err != nil {
		return nil, err
	}
	for f := range strings.FieldsSeq(string(out)) {
		if id, ok := r.pageOfFile(f); ok && !slices.Contains(pages, id) {
			pages = append(pages, id)
		}
	}
	r.syncMu.Lock()
	r.syncStatus.LastPull = time.Now()
	r.syncMu.Unlock()
	return pages, nil
}

// pushOnce pushes the branch to origin. If origin has commits made outside gitwiki, the local
// ones are rebased onto them and pushed again. A rebase conflict is returned rather than
// resolved: both sides were already reported as saved, so a person has to pick.
func (r *Repo) pushOnce() (err error) {
	r.syncMu.Lock()
	r.syncStatus.Running = true
	r.syncMu.Unlock()
	defer func() {
		err = redact(err, "")
		r.syncMu.Lock()
		defer r.syncMu.Unlock()
		r.syncStatus.Running = false
		r.syncStatus.PushError = ""
		if err != nil {
			r.syncStatus.PushError = err.Error()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	// Nothing to deliver: skip the round trip, and the error a push gives on a repo that this
	// machine's credentials cannot write to.
	if ahead, err := r.gitOut(ctx, "rev-list", "--count", "origin/"+r.cfg.Branch+"..HEAD"); err == nil && strings.TrimSpace(string(ahead)) == "0" {
		return nil
	}
	token := ""
	if t := r.token.Load(); t != nil {
		token = *t
		if err := r.setPushToken(ctx, token); err != nil {
			return redact(err, token)
		}
	}
	err = r.git(ctx, "push", "origin", r.cfg.Branch)
	if err != nil && strings.Contains(err.Error(), "[rejected]") {
		if err = r.git(ctx, "fetch", "origin", r.cfg.Branch); err == nil {
			if err = r.rebaseOntoOrigin(ctx); err == nil {
				err = r.git(ctx, "push", "origin", r.cfg.Branch)
			}
		}
	}
	return redact(err, token)
}

func (r *Repo) rebaseOntoOrigin(ctx context.Context) error {
	r.mu.Lock() // moves HEAD and rewrites the working tree
	defer r.mu.Unlock()
	// Replayed commits keep their authors; gitwiki becomes the committer. --autostash keeps
	// stray uncommitted files in the working copy from blocking the rebase.
	err := r.git(ctx, "-c", "user.name=gitwiki", "-c", "user.email=gitwiki@users.noreply.github.com",
		"rebase", "--autostash", "origin/"+r.cfg.Branch)
	if err != nil {
		_ = r.git(ctx, "rebase", "--abort")
		return fmt.Errorf("origin 上有与本地冲突的提交，需要手动处理: %w", err)
	}
	return nil
}

// redact keeps the token out of errors that are logged and sent to clients.
var credentialURL = regexp.MustCompile(`https://[^/\s]+@github\.com`)

func redact(err error, token string) error {
	if err == nil {
		return nil
	}
	message := credentialURL.ReplaceAllString(err.Error(), "https://***@github.com")
	if token != "" {
		message = strings.ReplaceAll(message, token, "***")
	}
	if message == err.Error() {
		return err
	}
	return errors.New(message)
}
