package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"

	"gopkg.in/yaml.v3"
)

// Repo is one wiki as the server keeps it: a GitHub repo the App is installed on, with its
// working copy. It is worked out at run time (see gitstore.Manager); the wiki's own settings
// live in the repo, in .gitwiki/config.yaml.
type Repo struct {
	Github     string // "owner/repo" as GitHub spells it, which is also the wiki's address in gitwiki
	Branch     string
	Workdir    string
	ContentDir string
}

// Config is the server's: where it listens, the GitHub App it runs as, and where it keeps
// working copies. Which repos are wikis, and how each behaves, comes from GitHub and the repos.
type Config struct {
	Listen string `yaml:"listen"` // e.g. ":8080"

	// The GitHub App: people log in through it, and the server clones, pulls and pushes as it.
	Github struct {
		ClientID       string `yaml:"client_id"`
		ClientSecret   string `yaml:"client_secret"`
		PrivateKeyFile string `yaml:"private_key_file"` // the App's .pem private key
	} `yaml:"github"`

	SessionSecret string `yaml:"session_secret"`

	// DataDir holds the working copies, one per wiki at <data_dir>/<owner>/<repo>.
	DataDir string `yaml:"data_dir"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	// Unknown keys are errors: a repos: list left from before wikis came from the App's
	// installations would otherwise be dropped silently, with any unpushed commits in its
	// working copies.
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if c.Listen == "" {
		c.Listen = ":8080"
	}
	if c.DataDir == "" {
		c.DataDir = "./data/repos"
	}
	if c.SessionSecret == "" {
		return nil, fmt.Errorf("session_secret is required")
	}
	if c.Github.ClientID == "" || c.Github.PrivateKeyFile == "" {
		return nil, fmt.Errorf("github.client_id and github.private_key_file (the GitHub App's) are required")
	}
	return &c, nil
}
