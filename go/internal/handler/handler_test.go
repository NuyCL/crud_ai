package handler

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"ffservice/internal/repository"
	"ffservice/internal/service"
)

const (
	adminKey  = "test-admin-key"
	clientKey = "test-client-key"
)

func newServer(t *testing.T) http.Handler {
	t.Helper()
	repo, err := repository.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { repo.Close() })
	h, err := New(service.New(repo), Config{AdminKey: adminKey, ClientKey: clientKey})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

type response struct {
	Code   int
	Header http.Header
	Text   string
}

func (r response) errorCode(t *testing.T) string {
	t.Helper()
	var b struct {
		Error struct{ Code, Message string }
	}
	if err := json.Unmarshal([]byte(r.Text), &b); err != nil {
		t.Fatalf("not an error body (%d): %q", r.Code, r.Text)
	}
	if b.Error.Message == "" {
		t.Fatalf("no message in %q", r.Text)
	}
	return b.Error.Code
}

// do sends a request; auth is "admin", "client", "bad" or "".
func do(h http.Handler, method, path, body, auth string) response {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	switch auth {
	case "admin":
		req.Header.Set("X-Admin-Key", adminKey)
	case "client":
		req.Header.Set("X-Client-Key", clientKey)
	case "bad":
		req.Header.Set("X-Admin-Key", "wrong")
		req.Header.Set("X-Client-Key", "wrong")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return response{rec.Code, rec.Header(), rec.Body.String()}
}

func TestNewRequiresBothKeys(t *testing.T) {
	for _, cfg := range []Config{{}, {AdminKey: "a"}, {ClientKey: "c"}} {
		if _, err := New(nil, cfg); err == nil {
			t.Errorf("%+v accepted", cfg)
		}
	}
}

func TestBR13_HealthzNeedsNoKey(t *testing.T) {
	r := do(newServer(t), "GET", "/healthz", "", "")
	if r.Code != 200 || r.Text != `{"status":"ok"}` {
		t.Fatalf("%d %q", r.Code, r.Text)
	}
}

func TestBR10_BR12_AdminEndpointsAcceptOnlyTheAdminKey(t *testing.T) {
	h := newServer(t)
	for _, e := range [][2]string{
		{"GET", "/v1/flags"}, {"POST", "/v1/flags"}, {"GET", "/v1/flags/x"}, {"PUT", "/v1/flags/x"},
		{"DELETE", "/v1/flags/x"}, {"GET", "/v1/flags/x/results?goal=g"}, {"GET", "/v1/audit-logs"},
	} {
		name := e[0] + " " + e[1]
		for auth, want := range map[string][2]any{"": {401, "UNAUTHORIZED"}, "bad": {401, "UNAUTHORIZED"}, "client": {403, "FORBIDDEN"}} {
			r := do(h, e[0], e[1], `{"key":"x"}`, auth)
			if r.Code != want[0].(int) || r.errorCode(t) != want[1].(string) {
				t.Errorf("%s with %q key: %d %s", name, auth, r.Code, r.Text)
			}
		}
	}
}

func TestBR11_ClientEndpointsAcceptEitherKey(t *testing.T) {
	h := newServer(t)
	for _, path := range []string{"/v1/evaluate", "/v1/events"} {
		body := `{}`
		if path == "/v1/events" {
			body = `{"events":[{"type":"conversion","userId":"u","goal":"g"}]}`
		}
		for _, auth := range []string{"client", "admin"} {
			if r := do(h, "POST", path, body, auth); r.Code/100 != 2 {
				t.Errorf("%s with %s key: %d %s", path, auth, r.Code, r.Text)
			}
		}
		for _, auth := range []string{"", "bad"} {
			if r := do(h, "POST", path, body, auth); r.Code != 401 || r.errorCode(t) != "UNAUTHORIZED" {
				t.Errorf("%s with %q key: %d %s", path, auth, r.Code, r.Text)
			}
		}
	}
}

func TestBR51_AuthIsCheckedBeforeTheBodyIsRead(t *testing.T) {
	r := do(newServer(t), "POST", "/v1/flags", `{not json`, "")
	if r.Code != 401 {
		t.Fatalf("got %d, want 401 before any body validation", r.Code)
	}
}

func TestStatusCodesAndContentTypeOfTheHappyPath(t *testing.T) {
	h := newServer(t)
	check := func(r response, want int) {
		t.Helper()
		if r.Code != want {
			t.Fatalf("got %d (%s), want %d", r.Code, r.Text, want)
		}
	}
	r := do(h, "POST", "/v1/flags", `{"key":"f","enabled":true}`, "admin")
	check(r, 201)
	if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("content type %q", ct)
	}
	check(do(h, "GET", "/v1/flags/f", "", "admin"), 200)
	check(do(h, "PUT", "/v1/flags/f", `{"key":"f"}`, "admin"), 200)
	check(do(h, "GET", "/v1/flags?limit=5", "", "admin"), 200)
	check(do(h, "GET", "/v1/audit-logs?flagKey=f", "", "admin"), 200)
	check(do(h, "POST", "/v1/evaluate", `{"flags":["f"]}`, "client"), 200)
	check(do(h, "POST", "/v1/events", `{"events":[{"type":"conversion","userId":"u","goal":"g"}]}`, "client"), 202)
	check(do(h, "GET", "/healthz", "", ""), 200)
	d := do(h, "DELETE", "/v1/flags/f", "", "admin")
	check(d, 204)
	if d.Text != "" {
		t.Fatalf("204 must have no body, got %q", d.Text)
	}
}

func TestBR52_BodiesThatAreNotOneJSONValueAreValidationErrors(t *testing.T) {
	h := newServer(t)
	for name, body := range map[string]string{
		"empty": "", "malformed": "{oops", "truncated": `{"key":`,
		"two documents": `{"key":"a"}{"key":"b"}`, "trailing garbage": `{"key":"a"} x`,
	} {
		r := do(h, "POST", "/v1/flags", body, "admin")
		if r.Code != 400 || r.errorCode(t) != "VALIDATION_ERROR" {
			t.Errorf("%s: %d %s", name, r.Code, r.Text)
		}
	}
	// trailing whitespace is fine
	if r := do(h, "POST", "/v1/flags", "{\"key\":\"ws\"}\n  \n", "admin"); r.Code != 201 {
		t.Errorf("trailing whitespace: %d %s", r.Code, r.Text)
	}
}

func TestOversizedBodyIsRejectedNotCrashed(t *testing.T) {
	big := `{"key":"big","description":"` + strings.Repeat("a", maxBodyBytes+10) + `"}`
	r := do(newServer(t), "POST", "/v1/flags", big, "admin")
	if r.Code != 400 || r.errorCode(t) != "VALIDATION_ERROR" {
		t.Fatalf("%d %.80s", r.Code, r.Text)
	}
}

func TestEveryErrorCodeMapsToItsStatus(t *testing.T) {
	h := newServer(t)
	do(h, "POST", "/v1/flags", `{"key":"taken"}`, "admin")
	cases := []struct {
		method, path, body string
		status             int
		code               string
	}{
		{"POST", "/v1/flags", `{"key":"taken"}`, 409, "FLAG_EXISTS"},
		{"POST", "/v1/flags", `{"key":"Bad"}`, 400, "INVALID_KEY"},
		{"POST", "/v1/flags", `{"key":"v","variants":[{"key":"a","weight":100}]}`, 400, "INVALID_VARIANTS"},
		{"PUT", "/v1/flags/taken", `{"key":"other"}`, 400, "KEY_IMMUTABLE"},
		{"GET", "/v1/flags/ghost", ``, 404, "FLAG_NOT_FOUND"},
		{"GET", "/v1/flags?limit=0", ``, 400, "VALIDATION_ERROR"},
		{"GET", "/v1/flags/taken/results", ``, 400, "VALIDATION_ERROR"},
	}
	for _, c := range cases {
		r := do(h, c.method, c.path, c.body, "admin")
		if r.Code != c.status || r.errorCode(t) != c.code {
			t.Errorf("%s %s: %d %s, want %d %s", c.method, c.path, r.Code, r.Text, c.status, c.code)
		}
		if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
			t.Errorf("%s %s: content type %q", c.method, c.path, ct)
		}
	}
}

func TestUnknownRoutesAnswerWithAJSONErrorBody(t *testing.T) {
	h := newServer(t)
	for _, p := range [][2]string{{"GET", "/nope"}, {"GET", "/v1/nope"}, {"PATCH", "/v1/flags"}} {
		r := do(h, p[0], p[1], "", "admin")
		if r.Code != 404 {
			t.Errorf("%v: %d", p, r.Code)
		}
		r.errorCode(t) // fails the test unless the body is the JSON error shape
	}
}

func TestAPanicBecomesAnOpaque500(t *testing.T) {
	log.SetOutput(io.Discard) // the handler logs the panic; keep test output quiet
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	h, err := New(nil, Config{AdminKey: adminKey, ClientKey: clientKey}) // a nil service panics on first use
	if err != nil {
		t.Fatal(err)
	}
	r := do(h, "GET", "/v1/flags", "", "admin")
	if r.Code != 500 || r.errorCode(t) != "INTERNAL_ERROR" {
		t.Fatalf("%d %s", r.Code, r.Text)
	}
	if strings.Contains(r.Text, "nil pointer") || strings.Contains(r.Text, "runtime") {
		t.Fatalf("internal details leaked: %s", r.Text)
	}
}
