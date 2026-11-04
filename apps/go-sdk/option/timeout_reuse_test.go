package option

import (
	"testing"
	"time"
)

func TestWithTimeoutReuseDoesNotShareMutableDuration(t *testing.T) {
	const wanted = 12 * time.Second
	configure := WithTimeout(wanted)
	first := RequestConfig{}
	configure(&first)
	if first.Timeout == nil || *first.Timeout != wanted {
		t.Fatal("first timeout missing")
	}
	*first.Timeout = time.Millisecond
	second := RequestConfig{}
	configure(&second)
	if second.Timeout == nil || *second.Timeout != wanted {
		t.Fatalf("reused timeout changed: %v", second.Timeout)
	}
	*second.Timeout = 2 * time.Millisecond
	if *first.Timeout != time.Millisecond {
		t.Fatal("configurations share mutable timeout storage")
	}
}
