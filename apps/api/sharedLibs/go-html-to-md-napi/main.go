package main

/*
#include <stdlib.h>
*/
import "C"
import (
	"context"
	"fmt"
	"sync"
	"time"
	"unsafe"

	md "github.com/tomkosm/html-to-markdown"
	"github.com/tomkosm/html-to-markdown/plugin"
)

// Global mutex to ensure thread safety
var mutex sync.Mutex

// ConvertHTMLToMarkdown converts HTML string to Markdown
//export ConvertHTMLToMarkdown
func ConvertHTMLToMarkdown(html *C.char) *C.char {
	mutex.Lock()
	defer mutex.Unlock()

	// Create context with timeout to prevent hanging
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Convert C string to Go string
	htmlStr := C.GoString(html)
	
	// Create converter
	converter := md.NewConverter("", true, nil)
	converter.Use(plugin.GitHubFlavored())

	// Use a channel to handle timeout
	resultChan := make(chan string, 1)
	errorChan := make(chan error, 1)

	go func() {
		markdown, err := converter.ConvertString(htmlStr)
		if err != nil {
			errorChan <- err
			return
		}
		resultChan <- markdown
	}()

	// Wait for result or timeout
	select {
	case result := <-resultChan:
		return C.CString(result)
	case err := <-errorChan:
		// Return error as string
		return C.CString(fmt.Sprintf("Error: %v", err))
	case <-ctx.Done():
		// Timeout occurred
		return C.CString("Error: HTML to Markdown conversion timed out")
	}
}

//export FreeString
func FreeString(s *C.char) {
	C.free(unsafe.Pointer(s))
}

func main() {
	// Required for main package but not used
}