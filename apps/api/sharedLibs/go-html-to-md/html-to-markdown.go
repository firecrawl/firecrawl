package main

/*
#include <stdlib.h>
*/
import "C"
import (
	"unsafe"

	md "github.com/firecrawl/html-to-markdown"
	"github.com/firecrawl/html-to-markdown/plugin"
)

//export ConvertHTMLToMarkdown
func ConvertHTMLToMarkdown(html *C.char) *C.char {
	converter := md.NewConverter("", true, nil)
	converter.Use(plugin.GitHubFlavored())
	converter.Use(plugin.RobustCodeBlock())

	markdown, err := converter.ConvertString(C.GoString(html))
	if err != nil {
		// log.Fatal(err)
	}
	return C.CString(markdown)
}

//export FreeCString
func FreeCString(s *C.char) {
	C.free(unsafe.Pointer(s))
}

func main() {
	// This function is required for the main package
}
