package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ffservice/internal/repository"
	"ffservice/internal/service"
)

const appOrigin = "https://app.example.com"

func newCORSServer(t *testing.T, origins ...string) http.Handler {
	t.Helper()
	repo, err := repository.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { repo.Close() })
	h, err := New(service.New(repo), Config{AdminKey: adminKey, ClientKey: clientKey, CORSOrigins: origins})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func send(h http.Handler, method, path, origin, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if method == http.MethodPost {
		req.Header.Set("X-Client-Key", clientKey)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestBR56_PreflightFromAnAllowedOrigin(t *testing.T) {
	h := newCORSServer(t, appOrigin)
	for _, path := range []string{"/v1/evaluate", "/v1/events"} {
		rec := send(h, http.MethodOptions, path, appOrigin, "")
		hd := rec.Header()
		if rec.Code != 204 || rec.Body.Len() != 0 {
			t.Fatalf("%s: %d %q", path, rec.Code, rec.Body.String())
		}
		if hd.Get("Access-Control-Allow-Origin") != appOrigin || hd.Get("Access-Control-Allow-Methods") != "POST" ||
			hd.Get("Access-Control-Allow-Headers") != "Content-Type, X-Client-Key" || hd.Get("Access-Control-Max-Age") != "600" ||
			hd.Get("Vary") != "Origin" || hd.Get("Access-Control-Allow-Credentials") != "" {
			t.Errorf("%s: %v", path, hd)
		}
	}
}

func TestBR56_PreflightIs404ForEverythingElse(t *testing.T) {
	h := newCORSServer(t, appOrigin)
	cases := []struct{ path, origin string }{
		{"/v1/evaluate", ""}, {"/v1/evaluate", "https://evil.example.org"}, {"/v1/evaluate", "null"},
		{"/v1/evaluate", appOrigin + "/"}, {"/v1/evaluate", "http://app.example.com"}, {"/v1/evaluate", strings.ToUpper(appOrigin)},
		{"/v1/events", "https://evil.example.org"},
		{"/v1/flags", appOrigin}, {"/v1/flags/x", appOrigin}, {"/healthz", appOrigin}, {"/nope", appOrigin}, {"/v1/evaluate/", appOrigin},
	}
	for _, c := range cases {
		rec := send(h, http.MethodOptions, c.path, c.origin, "")
		if rec.Code != 404 || rec.Header().Get("Access-Control-Allow-Origin") != "" || rec.Header().Get("Access-Control-Allow-Methods") != "" {
			t.Errorf("%+v: %d %v", c, rec.Code, rec.Header())
		}
	}
}

func TestBR56_PostResponsesCarryTheOriginInEveryStatus(t *testing.T) {
	h := newCORSServer(t, appOrigin)
	for name, c := range map[string]struct {
		path, body string
		want       int
	}{
		"evaluate 200": {"/v1/evaluate", `{"flags":[]}`, 200},
		"evaluate 400": {"/v1/evaluate", `[]`, 400},
		"events 202":   {"/v1/events", `{"events":[{"type":"conversion","userId":"u","goal":"g"}]}`, 202},
		"events 400":   {"/v1/events", `{"events":[]}`, 400},
	} {
		rec := send(h, http.MethodPost, c.path, appOrigin, c.body)
		if rec.Code != c.want || rec.Header().Get("Access-Control-Allow-Origin") != appOrigin || rec.Header().Get("Vary") != "Origin" {
			t.Errorf("%s: %d %v", name, rec.Code, rec.Header())
		}
	}
	// 401: no key at all
	req := httptest.NewRequest(http.MethodPost, "/v1/evaluate", strings.NewReader(`{}`))
	req.Header.Set("Origin", appOrigin)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 401 || rec.Header().Get("Access-Control-Allow-Origin") != appOrigin {
		t.Errorf("401: %d %v", rec.Code, rec.Header())
	}
}

func TestBR56_NoCORSHeadersOutsideTheRules(t *testing.T) {
	h := newCORSServer(t, appOrigin)
	for name, rec := range map[string]*httptest.ResponseRecorder{
		"no origin":       send(h, http.MethodPost, "/v1/evaluate", "", `{"flags":[]}`),
		"other origin":    send(h, http.MethodPost, "/v1/evaluate", "https://evil.example.org", `{"flags":[]}`),
		"healthz":         send(h, http.MethodGet, "/healthz", appOrigin, ""),
		"admin API":       send(h, http.MethodGet, "/v1/flags", appOrigin, ""),
		"GET on evaluate": send(h, http.MethodGet, "/v1/evaluate", appOrigin, ""),
	} {
		if v := rec.Header().Get("Access-Control-Allow-Origin"); v != "" {
			t.Errorf("%s: Access-Control-Allow-Origin %q", name, v)
		}
	}
	if rec := send(h, http.MethodPost, "/v1/evaluate", "https://evil.example.org", `{"flags":[]}`); rec.Code != 200 {
		t.Errorf("a request from another origin is still served: %d", rec.Code)
	}
}

func TestBR56_StarAllowsEveryOriginWithoutVary(t *testing.T) {
	h := newCORSServer(t, "*")
	rec := send(h, http.MethodOptions, "/v1/events", "https://anything.example", "")
	if rec.Code != 204 || rec.Header().Get("Access-Control-Allow-Origin") != "*" || rec.Header().Get("Vary") != "" {
		t.Errorf("%d %v", rec.Code, rec.Header())
	}
	if rec := send(h, http.MethodPost, "/v1/evaluate", "", `{"flags":[]}`); rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Error("a request without Origin gets no CORS header")
	}
}

func TestBR56_OffByDefault(t *testing.T) {
	h := newServer(t)
	rec := send(h, http.MethodOptions, "/v1/evaluate", appOrigin, "")
	if rec.Code != 404 || rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Errorf("%d %v", rec.Code, rec.Header())
	}
	if rec := send(h, http.MethodPost, "/v1/evaluate", appOrigin, `{"flags":[]}`); rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Error("CORS header sent while CORS is off")
	}
}
