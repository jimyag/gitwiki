package main

import (
	"flag"
	"log"
	"net/http"

	"github.com/jimyag/gitwiki/internal/auth"
	"github.com/jimyag/gitwiki/internal/config"
	"github.com/jimyag/gitwiki/internal/gitstore"
	"github.com/jimyag/gitwiki/internal/presence"
	"github.com/jimyag/gitwiki/internal/server"
	gitweb "github.com/jimyag/gitwiki/internal/web"
)

func main() {
	cfgPath := flag.String("config", "config.yaml", "path to config")
	flag.Parse()

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	as := auth.NewStore(cfg)
	gm := gitstore.NewManager(cfg)
	ph := presence.NewHub(as)
	gm.StartSync(ph.BroadcastSync, func(slug string, pages []string) { ph.BroadcastChanged(slug, "", pages...) })
	static, err := gitweb.Dist()
	if err != nil {
		log.Fatalf("load embedded dist: %v (run `bun --cwd web run build` first)", err)
	}
	s := server.New(cfg, as, gm, ph, static)

	log.Printf("listening on %s", cfg.Listen)
	if err := http.ListenAndServe(cfg.Listen, s.Handler()); err != nil {
		log.Fatal(err)
	}
}
