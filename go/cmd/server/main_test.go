package main

import "testing"

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestLoadConfigDefaults(t *testing.T) {
	cfg, err := loadConfig(env(map[string]string{"ADMIN_KEY": "a", "CLIENT_KEY": "c"}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Port != "8080" || cfg.DBPath != "./flags.db" || cfg.AdminKey != "a" || cfg.ClientKey != "c" {
		t.Fatalf("%+v", cfg)
	}
}

func TestLoadConfigReadsOverridesAndRequiresBothKeys(t *testing.T) {
	cfg, err := loadConfig(env(map[string]string{"PORT": "9000", "DB_PATH": "/tmp/x.db", "ADMIN_KEY": "a", "CLIENT_KEY": "c"}))
	if err != nil || cfg.Port != "9000" || cfg.DBPath != "/tmp/x.db" {
		t.Fatalf("%+v %v", cfg, err)
	}
	for name, m := range map[string]map[string]string{
		"none": {}, "no admin": {"CLIENT_KEY": "c"}, "no client": {"ADMIN_KEY": "a"},
	} {
		if _, err := loadConfig(env(m)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
