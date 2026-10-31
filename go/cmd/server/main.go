// Command server runs the feature flag service.
//
// Configuration comes from the environment:
//
//	PORT         listen port (default 8080)
//	DB_PATH      SQLite file (default ./flags.db)
//	ADMIN_KEY    key for the admin API (required)
//	CLIENT_KEY   key for evaluate and events (required)
//	CORS_ORIGINS comma-separated origins allowed to call evaluate and events from a browser, or "*" (default: none)
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"ffservice/internal/handler"
	"ffservice/internal/repository"
	"ffservice/internal/service"
)

type config struct {
	Port        string
	DBPath      string
	AdminKey    string
	ClientKey   string
	CORSOrigins []string
}

func loadConfig(getenv func(string) string) (config, error) {
	cfg := config{
		Port:        orDefault(getenv("PORT"), "8080"),
		DBPath:      orDefault(getenv("DB_PATH"), "./flags.db"),
		AdminKey:    getenv("ADMIN_KEY"),
		ClientKey:   getenv("CLIENT_KEY"),
		CORSOrigins: splitOrigins(getenv("CORS_ORIGINS")),
	}
	if cfg.AdminKey == "" || cfg.ClientKey == "" {
		return cfg, errors.New("ADMIN_KEY and CLIENT_KEY must both be set")
	}
	return cfg, nil
}

func splitOrigins(v string) []string {
	var out []string
	for _, o := range strings.Split(v, ",") {
		if o = strings.TrimSpace(o); o != "" {
			out = append(out, o)
		}
	}
	return out
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		return err
	}
	repo, err := repository.Open(cfg.DBPath)
	if err != nil {
		return fmt.Errorf("open database %s: %w", cfg.DBPath, err)
	}
	defer repo.Close()

	h, err := handler.New(service.New(repo), handler.Config{AdminKey: cfg.AdminKey, ClientKey: cfg.ClientKey, CORSOrigins: cfg.CORSOrigins})
	if err != nil {
		return err
	}
	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           h,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	failed := make(chan error, 1)
	go func() {
		log.Printf("listening on %s (database %s)", srv.Addr, cfg.DBPath)
		if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			failed <- err
		}
	}()

	select {
	case err := <-failed:
		return err
	case <-ctx.Done():
		log.Print("shutting down")
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}
