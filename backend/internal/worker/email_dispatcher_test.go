package worker

import (
	"strings"
	"testing"
)

func TestBuildMessageBlocksHeaderInjection(t *testing.T) {
	msg := string(buildMessage("bb@lab.org", "a@lab.org\r\nBcc: evil@x.org", "Hi\nBcc: evil@x.org", "line1\nline2"))
	head, body, _ := strings.Cut(msg, "\r\n\r\n")
	if strings.Contains(head, "\r\nBcc:") || strings.Count(head, "\r\n") != 4 {
		t.Fatalf("header injection: %q", head)
	}
	if body != "line1\r\nline2\r\n" {
		t.Fatalf("body %q", body)
	}
}
