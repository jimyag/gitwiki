package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/jimyag/gitwiki/internal/config"
	"github.com/jimyag/gitwiki/internal/gitstore"
)

func main() {
	cfg := &config.Config{
		Repos: []config.Repo{{
			Slug: "test", Workdir: "data/repos/test", ContentDir: "content", Title: "test",
		}},
	}
	gm := gitstore.NewManager(cfg)
	r := gm.Get("test")
	tree, err := r.PageTree(context.Background())
	if err != nil { panic(err) }
	json.NewEncoder(os.Stdout).Encode(tree)
	fmt.Println()
}
