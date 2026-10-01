package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type Repo struct {
	Slug       string `yaml:"slug"`
	Github     string `yaml:"github"` // owner/name
	Branch     string `yaml:"branch"`
	Workdir    string `yaml:"workdir"`
	ContentDir string `yaml:"content_dir"`
	Title      string `yaml:"title"`
	SiteURL    string `yaml:"site_url"` // optional: the published Hugo site, for "在站点中查看" links
}

type Config struct {
	Listen string `yaml:"listen"` // e.g. ":8080"

	Github struct {
		ClientID     string `yaml:"client_id"`
		ClientSecret string `yaml:"client_secret"`
	} `yaml:"github"`

	SessionSecret string `yaml:"session_secret"`

	Repos []Repo `yaml:"repos"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := yaml.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	if c.Listen == "" {
		c.Listen = ":8080"
	}
	if c.SessionSecret == "" {
		return nil, fmt.Errorf("session_secret is required")
	}
	if len(c.Repos) == 0 {
		return nil, fmt.Errorf("at least one repo is required")
	}
	for i := range c.Repos {
		r := &c.Repos[i]
		if r.Slug == "" || r.Github == "" || r.Workdir == "" {
			return nil, fmt.Errorf("repo %d: slug, github, workdir are required", i)
		}
		if r.Branch == "" {
			r.Branch = "main"
		}
		if r.ContentDir == "" {
			r.ContentDir = "content"
		}
		if r.Title == "" {
			r.Title = r.Slug
		}
	}
	return &c, nil
}

func (c *Config) FindRepo(slug string) *Repo {
	for i := range c.Repos {
		if c.Repos[i].Slug == slug {
			return &c.Repos[i]
		}
	}
	return nil
}
