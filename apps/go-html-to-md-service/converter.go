package main

import (
	"strings"
	"unicode/utf8"

	"github.com/PuerkitoBio/goquery"
	md "github.com/firecrawl/html-to-markdown"
	"github.com/firecrawl/html-to-markdown/plugin"
	"golang.org/x/net/html"
)

// Converter handles HTML to Markdown conversion
type Converter struct {
	converter *md.Converter
}

// NewConverter creates a new Converter instance with pre-configured rules
func NewConverter() *Converter {
	converter := md.NewConverter("", true, nil)
	converter.Use(plugin.GitHubFlavored())
	addGenericPreRule(converter)

	return &Converter{
		converter: converter,
	}
}

// ConvertHTMLToMarkdown converts HTML string to Markdown
func (c *Converter) ConvertHTMLToMarkdown(html string) (string, error) {
	return c.converter.ConvertString(html)
}

// addGenericPreRule adds a robust PRE handler that extracts nested code text
// (e.g., tables/rows/gutters) and outputs fenced blocks with detected language.
func addGenericPreRule(conv *md.Converter) {
	isGutter := func(class string) bool {
		c := strings.ToLower(class)
		return strings.Contains(c, "gutter") || strings.Contains(c, "line-numbers")
	}

	detectLang := func(sel *goquery.Selection) string {
		classes := sel.AttrOr("class", "")
		lower := strings.ToLower(classes)
		for _, part := range strings.Fields(lower) {
			if strings.HasPrefix(part, "language-") {
				return strings.TrimPrefix(part, "language-")
			}
			if strings.HasPrefix(part, "lang-") {
				return strings.TrimPrefix(part, "lang-")
			}
		}
		return ""
	}

	// Collect text recursively; insert newlines after block elements and br
	var collect func(n *html.Node, b *strings.Builder)
	collect = func(n *html.Node, b *strings.Builder) {
		if n == nil {
			return
		}
		switch n.Type {
		case html.TextNode:
			b.WriteString(n.Data)
		case html.ElementNode:
			name := strings.ToLower(n.Data)
			// Skip gutters
			if name != "" {
				// check class attr for gutters
				for _, a := range n.Attr {
					if a.Key == "class" && isGutter(a.Val) {
						return
					}
				}
			}

			if name == "br" {
				b.WriteString("\n")
			}

			for c := n.FirstChild; c != nil; c = c.NextSibling {
				collect(c, b)
			}

			// Newline after block-ish wrappers to preserve lines
			switch name {
			case "p", "div", "li", "tr", "table", "thead", "tbody", "tfoot", "section", "article", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6":
				b.WriteString("\n")
			}
		}
	}

	conv.AddRules(md.Rule{
		Filter: []string{"pre"},
		Replacement: func(_ string, selec *goquery.Selection, opt *md.Options) *string {
			// find inner <code> if present for language
			codeSel := selec.Find("code").First()
			lang := detectLang(codeSel)
			if lang == "" {
				lang = detectLang(selec)
			}

			var b strings.Builder
			for _, n := range selec.Nodes {
				collect(n, &b)
			}
			content := strings.TrimRight(b.String(), "\n")

			fenceChar, _ := utf8.DecodeRuneInString(opt.Fence)
			fence := md.CalculateCodeFence(fenceChar, content)
			text := "\n\n" + fence + lang + "\n" + content + "\n" + fence + "\n\n"
			return md.String(text)
		},
	})

	// Inline code: robustly extract text and fence with backticks
	conv.AddRules(md.Rule{
		Filter: []string{"code"},
		Replacement: func(_ string, selec *goquery.Selection, opt *md.Options) *string {
			// If inside pre, let the PRE rule handle it
			if selec.ParentsFiltered("pre").Length() > 0 {
				return nil
			}
			var b strings.Builder
			for _, n := range selec.Nodes {
				collect(n, &b)
			}
			code := b.String()
			// collapse multiple newlines for inline code
			code = md.TrimTrailingSpaces(strings.ReplaceAll(code, "\r\n", "\n"))

			// Choose fence length safely
			fence := "`"
			if strings.Contains(code, "`") {
				fence = "``"
				if strings.Contains(code, "``") {
					fence = "```"
				}
			}
			out := fence + code + fence
			return md.String(out)
		},
	})
}

