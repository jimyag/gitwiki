package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// Dist returns the dist sub-FS. Build will fail at compile time if web/dist is missing
// (e.g. frontend not built yet). Use `bun --cwd web run build` first.
func Dist() (fs.FS, error) {
	return fs.Sub(dist, "dist")
}
