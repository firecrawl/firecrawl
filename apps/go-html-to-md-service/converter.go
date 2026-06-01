package main

import (
	"strings"

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
	converter.Before(promoteImplicitTableHeaders)
	converter.Use(plugin.GitHubFlavored())
	converter.Use(plugin.RobustCodeBlock())

	return &Converter{
		converter: converter,
	}
}

// ConvertHTMLToMarkdown converts HTML string to Markdown
func (c *Converter) ConvertHTMLToMarkdown(html string) (string, error) {
	return c.converter.ConvertString(html)
}

func promoteImplicitTableHeaders(doc *goquery.Selection) {
	doc.Find("table").Each(func(_ int, table *goquery.Selection) {
		if tableHasOwnHeader(table) {
			return
		}

		rows := ownTableRows(table)
		if rows.Length() < 2 {
			return
		}

		firstRow := rows.First()
		firstCells := firstRow.ChildrenFiltered("td")
		if firstCells.Length() < 2 || firstCells.Length() != maxOwnRowCellCount(rows) {
			return
		}

		if !plainNonEmptyCells(firstCells) || firstRow.Find("a, code, pre, img, input, button, select, textarea, table").Length() > 0 {
			return
		}

		firstCells.Each(func(_ int, cell *goquery.Selection) {
			for _, node := range cell.Nodes {
				node.Data = "th"
			}
		})
	})
}

func tableHasOwnHeader(table *goquery.Selection) bool {
	return table.Find("thead, th").FilterFunction(func(_ int, item *goquery.Selection) bool {
		return belongsToTable(item, table)
	}).Length() > 0
}

func ownTableRows(table *goquery.Selection) *goquery.Selection {
	return table.Find("tr").FilterFunction(func(_ int, row *goquery.Selection) bool {
		return belongsToTable(row, table)
	})
}

func belongsToTable(item *goquery.Selection, table *goquery.Selection) bool {
	if len(item.Nodes) == 0 || len(table.Nodes) == 0 {
		return false
	}

	for parent := item.Nodes[0].Parent; parent != nil; parent = parent.Parent {
		if parent.Type == html.ElementNode && parent.Data == "table" {
			return parent == table.Nodes[0]
		}
	}

	return false
}

func maxOwnRowCellCount(rows *goquery.Selection) int {
	maxCount := 0
	rows.Each(func(_ int, row *goquery.Selection) {
		count := row.ChildrenFiltered("td, th").Length()
		if count > maxCount {
			maxCount = count
		}
	})

	return maxCount
}

func plainNonEmptyCells(cells *goquery.Selection) bool {
	allNonEmpty := true
	cells.EachWithBreak(func(_ int, cell *goquery.Selection) bool {
		if strings.TrimSpace(cell.Text()) == "" {
			allNonEmpty = false
			return false
		}

		return true
	})

	return allNonEmpty
}
