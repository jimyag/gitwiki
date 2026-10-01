// Package importer turns pasted foreign markup (a configured repo's source) into a gitwiki
// page. Markdown passes through with front matter cleaned; MediaWiki supports what a pasted
// page realistically uses: headings, bold/italic, links, lists, code blocks and tables.
package importer

import (
	"fmt"
	"html"
	"io"
	"regexp"
	"strings"

	"github.com/jimyag/gitwiki/internal/gitstore"
)

// Convert reads src and returns the parsed page.
func Convert(kind, filename string, src io.Reader) (*gitstore.PageDoc, error) {
	data, err := io.ReadAll(io.LimitReader(src, 16<<20))
	if err != nil {
		return nil, err
	}
	switch kind {
	case "markdown":
		// Wrapping whole markdown in a code fence happens a lot when it is copied out of a
		// chat message or a ticket: unwrap one outer fence.
		body := unwrapFence(string(data))
		return gitstore.ParsePage([]byte(body))
	case "mediawiki":
		return gitstore.ParsePage([]byte(mediawiki(string(data))))
	default:
		return nil, fmt.Errorf("unknown source %q", kind)
	}
}

var fenceRe = regexp.MustCompile("(?s)^\\s*```(?:markdown|md|mediawiki)?\\s*\n(.*)\n```\\s*$")

func unwrapFence(s string) string {
	if m := fenceRe.FindStringSubmatch(s); m != nil {
		return m[1] + "\n"
	}
	return s
}

// MediaWiki markup to markdown, line based. Not a full parser: nested templates, magic
// words and HTML tables come through as plain text, which is still readable.
func mediawiki(src string) string {
	src = html.UnescapeString(src)
	lines := strings.Split(src, "\n")
	var out []string
	inPre, inTable := false, false
	listStack := []byte{}
	flush := func() {
		if inTable {
			out = append(out, "")
			inTable = false
		}
		listStack = listStack[:0]
	}
	for _, line := range lines {
		trim := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trim, "{|"):
			inTable = true
		case strings.HasPrefix(trim, "|}"):
			flush()
		case inTable:
			out = append(out, mwTableRow(trim)...)
		default:
			if strings.HasPrefix(line, " ") && !inPre {
				inPre = true
				out = append(out, "```")
			} else if !strings.HasPrefix(line, " ") && inPre {
				inPre = false
				out = append(out, "```")
			}
			if inPre {
				out = append(out, line)
				continue
			}
			out = append(out, mwLine(trim, &listStack)...)
		}
	}
	if inPre {
		out = append(out, "```")
	}
	flushTo(&out, &inTable, &listStack)
	return strings.Join(out, "\n")
}

func flushTo(out *[]string, inTable *bool, listStack *[]byte) {
	if *inTable {
		*out = append(*out, "")
		*inTable = false
	}
	*listStack = (*listStack)[:0]
}

var mwHeadingRe = regexp.MustCompile(`^(={2,6})\s*(.*?)\s*=*\s*$`)

func mwLine(line string, listStack *[]byte) []string {
	if line == "" {
		*listStack = (*listStack)[:0]
		return []string{""}
	}
	// Lists are runes of *# at the start; a changed depth emits no fence, just indentation.
	if m := regexp.MustCompile(`^([*#]+)\s*(.*)$`).FindStringSubmatch(line); m != nil {
		marks, text := []byte(m[1]), m[2]
		depth := len(marks)
		*listStack = marks
		bullet := "-"
		if marks[depth-1] == '#' {
			bullet = "1."
		}
		return []string{strings.Repeat("  ", depth-1) + bullet + " " + inlineMW(text)}
	}
	*listStack = (*listStack)[:0]
	if m := mwHeadingRe.FindStringSubmatch(line); m != nil {
		return []string{strings.Repeat("#", len(m[1])) + " " + inlineMW(m[2])}
	}
	return []string{inlineMW(line)}
}

var (
	mwInternalLink = regexp.MustCompile(`\[\[([^\]|]+)(?:\|([^\]]+))?\]\]`)
	mwExternalLink = regexp.MustCompile(`\[([a-z]+://\S+)(?:\s+([^\]]+))?\]`)
	mwBoldItalic   = regexp.MustCompile(`'''(.*?)'''`)
	mwItalic       = regexp.MustCompile(`''(.*?)''`)
	mwCode         = regexp.MustCompile(`(?s)<code>(.*?)</code>`)
	mwNowiki       = regexp.MustCompile(`(?s)<nowiki>(.*?)</nowiki>`)
	mwRef          = regexp.MustCompile(`(?s)<ref[^>]*>.*?</ref>`)
	mwTemplate     = regexp.MustCompile(`\{\{[^{}]*\}\}`)
)

func inlineMW(s string) string {
	s = mwNowiki.ReplaceAllString(s, "`$1`")
	s = mwRef.ReplaceAllString(s, "")
	s = mwCode.ReplaceAllString(s, "`$1`")
	s = mwBoldItalic.ReplaceAllString(s, "**$1**")
	s = mwItalic.ReplaceAllString(s, "*$1*")
	s = mwInternalLink.ReplaceAllStringFunc(s, func(m string) string {
		parts := mwInternalLink.FindStringSubmatch(m)
		target, label := strings.TrimSpace(parts[1]), strings.TrimSpace(parts[2])
		if label == "" {
			label = target
		}
		return "[" + label + "](" + strings.ReplaceAll(target, " ", "_") + ")"
	})
	s = mwExternalLink.ReplaceAllStringFunc(s, func(m string) string {
		parts := mwExternalLink.FindStringSubmatch(m)
		label := parts[2]
		if label == "" {
			label = parts[1]
		}
		return "[" + label + "](" + parts[1] + ")"
	})
	s = mwTemplate.ReplaceAllString(s, "")
	return s
}

// mwTableRow emits a markdown table fragment. MediaWiki rows/cells become rows; header cells
// first since markdown has no native column headers mid-table.
func mwTableRow(line string) []string {
	line = strings.TrimPrefix(strings.TrimSuffix(line, "|}"), "{|")
	line = strings.TrimSpace(line)
	if line == "" || line == "|-" {
		return nil
	}
	header := strings.HasPrefix(line, "!")
	line = strings.TrimLeft(line, "!|+-")
	cells, sep := []string{}, "|"
	for _, part := range strings.Split(line, func() string {
		if strings.Contains(line, "||") {
			return "||"
		}
		if strings.Contains(line, "!!") {
			return "!!"
		}
		return "|"
	}()) {
		_ = sep
		cells = append(cells, strings.TrimSpace(inlineMW(part)))
	}
	row := "| " + strings.Join(cells, " | ") + " |"
	if header {
		return []string{row, "|" + strings.Repeat(" --- |", len(cells))}
	}
	return []string{row}
}
