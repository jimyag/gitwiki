package gitstore

import (
	"bytes"
	"fmt"
	"maps"
	"slices"

	"github.com/adrg/frontmatter"
	"gopkg.in/yaml.v3"
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

// RenderPage reassembles front matter and body. Every field goes through a real YAML encoder,
// so values the UI never touches (Hugo tags, params maps, dates) survive a save unchanged.
// Layout stays stable for small diffs: title first, other keys sorted, strings double-quoted,
// lists of scalars on one line.
func RenderPage(doc *PageDoc) ([]byte, error) {
	if doc == nil {
		return nil, fmt.Errorf("nil doc")
	}
	if len(doc.FrontMatter) == 0 {
		// No front matter needed.
		return []byte(doc.Body), nil
	}
	keys := slices.Sorted(maps.Keys(doc.FrontMatter))
	if i := slices.Index(keys, "title"); i > 0 {
		keys = append([]string{"title"}, slices.Delete(keys, i, i+1)...)
	}
	root := &yaml.Node{Kind: yaml.MappingNode}
	for _, k := range keys {
		var v yaml.Node
		if err := v.Encode(doc.FrontMatter[k]); err != nil {
			return nil, fmt.Errorf("front matter %q: %w", k, err)
		}
		gitwikiStyle(&v)
		root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: k}, &v)
	}
	var buf bytes.Buffer
	buf.WriteString("---\n")
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(root); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	buf.WriteString("---\n")
	if doc.Body != "" && doc.Body[0] != '\n' {
		buf.WriteString("\n")
	}
	buf.WriteString(doc.Body)
	return buf.Bytes(), nil
}

// gitwikiStyle double-quotes strings (what gitwiki has always written) and keeps lists of
// scalars such as tags on one line.
func gitwikiStyle(n *yaml.Node) {
	switch n.Kind {
	case yaml.ScalarNode:
		if n.Tag == "!!str" {
			n.Style = yaml.DoubleQuotedStyle
		}
	case yaml.SequenceNode:
		flat := true
		for _, c := range n.Content {
			gitwikiStyle(c)
			flat = flat && c.Kind == yaml.ScalarNode
		}
		if flat {
			n.Style = yaml.FlowStyle
		}
	case yaml.MappingNode:
		for i := 1; i < len(n.Content); i += 2 { // values only; keys stay plain
			gitwikiStyle(n.Content[i])
		}
	}
}
