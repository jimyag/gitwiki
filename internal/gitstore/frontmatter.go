package gitstore

import (
	"bytes"
	"fmt"

	"github.com/adrg/frontmatter"
)

// PageDoc represents a page split into front matter + body.
// FrontMatter is a raw map so unrecognized fields round-trip unchanged.
type PageDoc struct {
	FrontMatter map[string]any
	Body        string
}

// ParsePage splits a markdown file into front matter and body.
// Files without front matter get an empty map and the whole file as body.
func ParsePage(content []byte) (*PageDoc, error) {
	var fm map[string]any
	rest, err := frontmatter.Parse(bytes.NewReader(content), &fm)
	if err != nil {
		// No front matter, or unknown format: treat all as body.
		return &PageDoc{FrontMatter: map[string]any{}, Body: string(content)}, nil
	}
	if fm == nil {
		fm = map[string]any{}
	}
	return &PageDoc{FrontMatter: fm, Body: string(rest)}, nil
}

// RenderPage reassembles front matter and body. Field order in front matter is
// determined by the YAML marshaler (alphabetical), so we emit title first by
// hand. Other keys follow.
func RenderPage(doc *PageDoc) ([]byte, error) {
	if doc == nil {
		return nil, fmt.Errorf("nil doc")
	}
	if len(doc.FrontMatter) == 0 {
		// No front matter needed.
		return []byte(doc.Body), nil
	}
	var buf bytes.Buffer
	buf.WriteString("---\n")
	// Title first for readability.
	if t, ok := doc.FrontMatter["title"]; ok {
		writeYAMLField(&buf, "title", t)
	}
	keys := make([]string, 0, len(doc.FrontMatter))
	for k := range doc.FrontMatter {
		if k == "title" {
			continue
		}
		keys = append(keys, k)
	}
	// Stable order for diff stability.
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if keys[j] < keys[i] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	for _, k := range keys {
		writeYAMLField(&buf, k, doc.FrontMatter[k])
	}
	buf.WriteString("---\n")
	if doc.Body != "" && doc.Body[0] != '\n' {
		buf.WriteString("\n")
	}
	buf.WriteString(doc.Body)
	return buf.Bytes(), nil
}

func writeYAMLField(buf *bytes.Buffer, key string, v any) {
	switch x := v.(type) {
	case string:
		// Quote strings to be safe against YAML special chars (colons, leading markers).
		buf.WriteString(key)
		buf.WriteString(": ")
		buf.WriteString(quoteYAMLString(x))
		buf.WriteString("\n")
	case bool:
		fmt.Fprintf(buf, "%s: %v\n", key, x)
	case int, int64, float64:
		fmt.Fprintf(buf, "%s: %v\n", key, x)
	case nil:
		fmt.Fprintf(buf, "%s: null\n", key)
	default:
		// Lists and maps: naive one-line representation. good enough for wiki use.
		fmt.Fprintf(buf, "%s: %v\n", key, x)
	}
}

func quoteYAMLString(s string) string {
	var buf bytes.Buffer
	buf.WriteString("\"")
	for _, r := range s {
		switch r {
		case '"':
			buf.WriteString("\\\"")
		case '\\':
			buf.WriteString("\\\\")
		case '\n':
			buf.WriteString("\\n")
		case '\t':
			buf.WriteString("\\t")
		default:
			buf.WriteRune(r)
		}
	}
	buf.WriteString("\"")
	return buf.String()
}
