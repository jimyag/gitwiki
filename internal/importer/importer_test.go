package importer

import (
	"strings"
	"testing"
)

func TestMediawiki(t *testing.T) {
	src := "== 标题 ==\n\n第一行，'''加粗'''和''斜体''。[[页面 A|链接文字]] [https://x.com 外部]。\n\n* 一\n** 二\n# 序\n\n<pre>code line</pre>\n\n{| class=\"x\"\n! 列1 !! 列2\n|-\n| a || b\n|}\n[[Category:Foo]]"
	doc, err := Convert("mediawiki", "p.txt", strings.NewReader(src))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"## 标题", "**加粗**", "*斜体*", "[链接文字](页面_A)", "[外部](https://x.com)", "- 一", "  - 二", "1. 序", "| 列1 | 列2 |", "| a | b |"}
	for _, w := range want {
		if !strings.Contains(doc.Body, w) {
			t.Errorf("missing %q in:\n%s", w, doc.Body)
		}
	}
}

func TestMarkdownFencedPassthrough(t *testing.T) {
	doc, err := Convert("markdown", "p.md", strings.NewReader("```markdown\n# hi\n```\n"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(doc.Body, "# hi\n") {
		t.Errorf("fence not unwrapped: %q", doc.Body)
	}
}
