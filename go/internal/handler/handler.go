// Package handler is the HTTP layer: routing, authentication, JSON in and out,
// and the mapping from service errors to status codes. It holds no business
// rules.
package handler

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"unicode/utf8"

	"ffservice/internal/service"
)

const maxBodyBytes = 1 << 20

// Config holds the two API keys. Both are required.
type Config struct {
	AdminKey  string
	ClientKey string
}

type api struct {
	svc        *service.Service
	adminKey   []byte
	clientKey  []byte
	errorLogFn func(format string, args ...any)
}

// New returns the HTTP handler of the service.
func New(svc *service.Service, cfg Config) (http.Handler, error) {
	if cfg.AdminKey == "" || cfg.ClientKey == "" {
		return nil, errors.New("both an admin key and a client key are required")
	}
	a := &api{svc: svc, adminKey: []byte(cfg.AdminKey), clientKey: []byte(cfg.ClientKey), errorLogFn: log.Printf}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.healthz)

	mux.HandleFunc("GET /v1/flags", a.admin(a.listFlags))
	mux.HandleFunc("POST /v1/flags", a.admin(a.createFlag))
	mux.HandleFunc("GET /v1/flags/{key}", a.admin(a.getFlag))
	mux.HandleFunc("PUT /v1/flags/{key}", a.admin(a.updateFlag))
	mux.HandleFunc("DELETE /v1/flags/{key}", a.admin(a.deleteFlag))
	mux.HandleFunc("GET /v1/flags/{key}/results", a.admin(a.results))
	mux.HandleFunc("GET /v1/audit-logs", a.admin(a.listAudit))

	mux.HandleFunc("POST /v1/evaluate", a.clientOrAdmin(a.evaluate))
	mux.HandleFunc("POST /v1/events", a.clientOrAdmin(a.events))

	// Everything else gets a JSON error too, never the mux's plain-text one.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, service.CodeFlagNotFound, "no such route")
	})
	return a.recoverPanics(mux), nil
}

// ------------------------------------------------------------------ auth

func equal(header string, key []byte) bool {
	return subtle.ConstantTimeCompare([]byte(header), key) == 1
}

func (a *api) isAdmin(r *http.Request) bool  { return equal(r.Header.Get("X-Admin-Key"), a.adminKey) }
func (a *api) isClient(r *http.Request) bool { return equal(r.Header.Get("X-Client-Key"), a.clientKey) }

// admin allows only the admin key. A valid client key gets 403 (it is known
// but not allowed here), anything else 401 (BR-10, BR-12).
func (a *api) admin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch {
		case a.isAdmin(r):
			next(w, r)
		case a.isClient(r):
			writeError(w, http.StatusForbidden, service.CodeForbidden, "this key cannot use the admin API")
		default:
			writeError(w, http.StatusUnauthorized, service.CodeUnauthorized, "missing or invalid admin key")
		}
	}
}

// clientOrAdmin allows either key (BR-11).
func (a *api) clientOrAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.isAdmin(r) || a.isClient(r) {
			next(w, r)
			return
		}
		writeError(w, http.StatusUnauthorized, service.CodeUnauthorized, "missing or invalid key")
	}
}

func (a *api) recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if p := recover(); p != nil {
				a.errorLogFn("panic serving %s %s: %v", r.Method, r.URL.Path, p)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// -------------------------------------------------------------- plumbing

func writeJSON(w http.ResponseWriter, status int, body any) {
	data, err := json.Marshal(body)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "internal error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(data)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

// statusFor maps an error code to its HTTP status. Every code not listed is a
// validation problem, which is a 400.
func statusFor(code string) int {
	switch code {
	case service.CodeUnauthorized:
		return http.StatusUnauthorized
	case service.CodeForbidden:
		return http.StatusForbidden
	case service.CodeFlagNotFound:
		return http.StatusNotFound
	case service.CodeFlagExists:
		return http.StatusConflict
	}
	return http.StatusBadRequest
}

// fail answers with the service error, or with an opaque 500 for anything
// else so internal details never reach the client.
func (a *api) fail(w http.ResponseWriter, r *http.Request, err error) {
	var se *service.Error
	if errors.As(err, &se) {
		writeError(w, statusFor(se.Code), se.Code, se.Message)
		return
	}
	a.errorLogFn("internal error serving %s %s: %v", r.Method, r.URL.Path, err)
	writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "internal error")
}

// decodeBody reads exactly one JSON value. Numbers are kept as json.Number so
// the service can tell 10 from 10.5 (BR-30). Anything that is not a single,
// complete JSON document is a validation error (BR-52).
func decodeBody(w http.ResponseWriter, r *http.Request) (any, error) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		return nil, &service.Error{Code: service.CodeValidation, Message: "request body could not be read or is larger than 1 MiB"}
	}
	// encoding/json silently turns invalid UTF-8 into U+FFFD; the spec says reject it (BR-52).
	if !utf8.Valid(raw) {
		return nil, &service.Error{Code: service.CodeValidation, Message: "request body must be valid UTF-8"}
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, &service.Error{Code: service.CodeValidation, Message: "request body must be valid JSON"}
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, &service.Error{Code: service.CodeValidation, Message: "request body must contain a single JSON value"}
	}
	return v, nil
}

// ------------------------------------------------------------- endpoints

func (a *api) healthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *api) listFlags(w http.ResponseWriter, r *http.Request) {
	limit, offset, err := service.ParsePage(r.URL.Query())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	items, total, err := a.svc.ListFlags(r.Context(), limit, offset)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total})
}

func (a *api) createFlag(w http.ResponseWriter, r *http.Request) {
	body, err := decodeBody(w, r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	flag, err := a.svc.CreateFlag(r.Context(), body)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, flag)
}

func (a *api) getFlag(w http.ResponseWriter, r *http.Request) {
	flag, err := a.svc.GetFlag(r.Context(), r.PathValue("key"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, flag)
}

func (a *api) updateFlag(w http.ResponseWriter, r *http.Request) {
	body, err := decodeBody(w, r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	flag, err := a.svc.UpdateFlag(r.Context(), r.PathValue("key"), body)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, flag)
}

func (a *api) deleteFlag(w http.ResponseWriter, r *http.Request) {
	if err := a.svc.DeleteFlag(r.Context(), r.PathValue("key")); err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) results(w http.ResponseWriter, r *http.Request) {
	res, err := a.svc.Results(r.Context(), r.PathValue("key"), r.URL.Query().Get("goal"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (a *api) listAudit(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, offset, err := service.ParsePage(q)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	var flagKey *string
	if q.Has("flagKey") {
		k := q.Get("flagKey")
		flagKey = &k
	}
	items, total, err := a.svc.ListAudit(r.Context(), flagKey, limit, offset)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total})
}

func (a *api) evaluate(w http.ResponseWriter, r *http.Request) {
	body, err := decodeBody(w, r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	results, err := a.svc.Evaluate(r.Context(), body)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func (a *api) events(w http.ResponseWriter, r *http.Request) {
	body, err := decodeBody(w, r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	accepted, err := a.svc.RecordEvents(r.Context(), body)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]int{"accepted": accepted})
}
