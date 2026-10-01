package gitstore

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Writers commit locally and return; pushing to origin happens here, in the background, so a
// save costs local git time instead of GitHub round trips. There is one loop per repo, so pushes
// never overlap, and requests that arrive during a push collapse into one more push. The same
// loop pulls commits made outside gitwiki, so edits on GitHub show up without a restart.

// pullInterval is how often origin is checked for commits made outside gitwiki.
const pullInterval = time.Minute

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
	pull := time.Tick(pullInterval)
	for {
		select {
		case <-r.pushKick:
			r.pushUntilDone(onSync)
		case <-pull:
			pages, err := r.pullOnce()
			if err != nil {
				log.Printf("pull %s: %v", r.cfg.Slug, err)
			} else if len(pages) > 0 {
				onPull(pages)
			}
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
func (r *Repo) pullOnce() ([]string, error) {
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
	var pages []string
	for f := range strings.FieldsSeq(string(out)) {
		if id, ok := r.pageOfFile(f); ok && !slices.Contains(pages, id) {
			pages = append(pages, id)
		}
	}
	return pages, nil
}

// pushOnce pushes the branch to origin. If origin has commits made outside gitwiki, the local
// ones are rebased onto them and pushed again. A rebase conflict is returned rather than
// resolved: both sides were already reported as saved, so a person has to pick.
func (r *Repo) pushOnce() error {
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
	err := r.git(ctx, "push", "origin", r.cfg.Branch)
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
func redact(err error, token string) error {
	if err == nil || token == "" || !strings.Contains(err.Error(), token) {
		return err
	}
	return errors.New(strings.ReplaceAll(err.Error(), token, "***"))
}
