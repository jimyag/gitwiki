package gitstore

import (
	"cmp"
	"log"
	"os"
	"path"
	"path/filepath"
	"slices"

	"gopkg.in/yaml.v3"
)

// Settings are a wiki's own options. They live in the repo, next to the page templates, in
// .gitwiki/config.yaml on the wiki's branch, so whoever may change the wiki may change them; a
// repo without the file gets the defaults.
type Settings struct {
	Title      string   `yaml:"title" json:"title"`                 // default: the repo's name
	ReadPublic bool     `yaml:"read_public" json:"read_public"`     // anyone may read it without logging in
	SiteURL    string   `yaml:"site_url" json:"site_url,omitempty"` // the published site; default: the repo's website on GitHub
	StaleDays  *int     `yaml:"stale_days" json:"stale_days"`       // pages not updated this many days are document problems; default 180, 0: off
	Source     []string `yaml:"source" json:"source,omitempty"`     // what the 导入 button takes: markdown, mediawiki
}

// Settings reads .gitwiki/config.yaml as it is now (a pull or a save may have changed it) and
// fills in the defaults. A file that does not parse is logged and ignored.
func (r *Repo) Settings() Settings {
	var s Settings
	if data, err := os.ReadFile(filepath.Join(r.cfg.Workdir, ".gitwiki", "config.yaml")); err == nil {
		if err := yaml.Unmarshal(data, &s); err != nil {
			log.Printf("%s: .gitwiki/config.yaml: %v", r.cfg.Github, err)
			s = Settings{}
		}
	}
	s.Title = cmp.Or(s.Title, path.Base(r.cfg.Github))
	s.SiteURL = cmp.Or(s.SiteURL, r.homepage)
	if s.StaleDays == nil || *s.StaleDays < 0 {
		days := 180
		s.StaleDays = &days
	}
	s.Source = slices.DeleteFunc(s.Source, func(t string) bool { return t != "markdown" && t != "mediawiki" })
	return s
}
