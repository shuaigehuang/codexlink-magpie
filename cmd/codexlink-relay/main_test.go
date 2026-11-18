package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLoadConfigDefaults(t *testing.T) {
	env := map[string]string{
		"CODEXLINK_RELAY_DESKTOP_TOKEN": "0123456789abcdef0123456789abcdef",
	}
	cfg, listen, err := loadConfig(func(key string) string { return env[key] })
	if err != nil {
		t.Fatal(err)
	}
	if listen != defaultListen || cfg.DataDir != "./data" {
		t.Fatalf("unexpected defaults: listen=%s data=%s", listen, cfg.DataDir)
	}
	if cfg.PairTTL != 10*time.Minute || cfg.SessionTTL != 90*24*time.Hour {
		t.Fatalf("unexpected TTL defaults: %v %v", cfg.PairTTL, cfg.SessionTTL)
	}
}

func TestLoadConfigRejectsShortToken(t *testing.T) {
	env := map[string]string{"CODEXLINK_RELAY_DESKTOP_TOKEN": "short"}
	if _, _, err := loadConfig(func(key string) string { return env[key] }); err == nil {
		t.Fatal("short token was accepted")
	}
}

func TestLoadConfigOverrides(t *testing.T) {
	env := map[string]string{
		"CODEXLINK_RELAY_DESKTOP_TOKEN": "0123456789abcdef0123456789abcdef",
		"CODEXLINK_RELAY_ADMIN_TOKEN":   "abcdef0123456789abcdef0123456789",
		"CODEXLINK_RELAY_DATA_DIR":      "/var/lib/codexlink",
		"CODEXLINK_RELAY_LISTEN":        "127.0.0.1:9999",
		"CODEXLINK_RELAY_PAIR_TTL":      "5m",
		"CODEXLINK_RELAY_SESSION_TTL":   "24h",
		"CODEXLINK_RELAY_TRUST_PROXY":   "1",
		"CODEXLINK_RELAY_ORIGINS":       "https://a.example, https://b.example",
		"CODEXLINK_RELAY_PUBLIC_URLS":   "https://relay.example.com,http://relay.example.com",
	}
	cfg, listen, err := loadConfig(func(key string) string { return env[key] })
	if err != nil {
		t.Fatal(err)
	}
	if listen != "127.0.0.1:9999" || cfg.DataDir != "/var/lib/codexlink" {
		t.Fatalf("overrides not applied: %+v", cfg)
	}
	if cfg.PairTTL != 5*time.Minute || cfg.SessionTTL != 24*time.Hour || !cfg.TrustProxy {
		t.Fatalf("duration or proxy overrides not applied: %+v", cfg)
	}
	if len(cfg.AllowedOrigins) != 2 || cfg.AllowedOrigins[1] != "https://b.example" {
		t.Fatalf("origins not parsed: %v", cfg.AllowedOrigins)
	}
	if cfg.AdminToken != env["CODEXLINK_RELAY_ADMIN_TOKEN"] || len(cfg.PublicURLs) != 2 {
		t.Fatalf("admin or public URLs not parsed: %+v", cfg)
	}
}

func TestLoadTLSOptions(t *testing.T) {
	env := map[string]string{
		"CODEXLINK_RELAY_TLS_DOMAIN": "Relay.Example.com",
		"CODEXLINK_RELAY_TLS_EMAIL":  "admin@example.com",
	}
	options := loadTLSOptions(func(key string) string { return env[key] })
	if options.Domain != "relay.example.com" || options.Email != "admin@example.com" || options.HTTPAddr != ":80" {
		t.Fatalf("unexpected TLS options: %+v", options)
	}
	manager, config := newAutocertManager(options, t.TempDir())
	if manager == nil || config == nil || config.MinVersion == 0 {
		t.Fatal("autocert manager was not configured")
	}
	if !strings.Contains(strings.Join(config.NextProtos, ","), "http/1.1") {
		t.Fatalf("HTTP/1.1 was not advertised for WebSocket compatibility: %v", config.NextProtos)
	}
}

func TestLoadTLSOptionsExtraHTTPAddress(t *testing.T) {
	env := map[string]string{
		"CODEXLINK_RELAY_EXTRA_HTTP_ADDR": ":443",
	}
	options := loadTLSOptions(func(key string) string { return env[key] })
	if options.Domain != "" || options.ExtraHTTPAddr != ":443" {
		t.Fatalf("unexpected plaintext dual-port options: %+v", options)
	}
}

func TestValidateListenersRejectsDuplicatePorts(t *testing.T) {
	err := validateListeners(":8080", "0.0.0.0:8080", tlsOptions{})
	if err == nil {
		t.Fatal("duplicate public listener addresses were accepted")
	}
	if err := validateListeners(":8080", "0.0.0.0:08080", tlsOptions{}); err == nil {
		t.Fatal("duplicate listener addresses with leading zeroes were accepted")
	}
}

func TestValidateListenersAcceptsSeparatePorts(t *testing.T) {
	err := validateListeners(":443", ":8443", tlsOptions{
		Domain:   "relay.example.com",
		HTTPAddr: ":80",
	})
	if err != nil {
		t.Fatalf("valid listener configuration was rejected: %v", err)
	}
}

func TestPlaintextRedirectKeepsAdminOnAdminPort(t *testing.T) {
	manager, _ := newAutocertManager(tlsOptions{Domain: "relay.example.com"}, t.TempDir())
	handler := plaintextRedirectHandler(manager, "relay.example.com", ":443", ":8443")

	relayRequest := httptest.NewRequest(http.MethodGet, "http://relay.example.com/v1/pair/claim?x=1", nil)
	relayResponse := httptest.NewRecorder()
	handler.ServeHTTP(relayResponse, relayRequest)
	if relayResponse.Code != http.StatusPermanentRedirect {
		t.Fatalf("relay redirect status = %d", relayResponse.Code)
	}
	if got := relayResponse.Header().Get("Location"); got != "https://relay.example.com/v1/pair/claim?x=1" {
		t.Fatalf("relay redirect = %q", got)
	}

	adminRequest := httptest.NewRequest(http.MethodGet, "http://relay.example.com/admin", nil)
	adminResponse := httptest.NewRecorder()
	handler.ServeHTTP(adminResponse, adminRequest)
	if adminResponse.Code != http.StatusPermanentRedirect {
		t.Fatalf("admin redirect status = %d", adminResponse.Code)
	}
	if got := adminResponse.Header().Get("Location"); got != "https://relay.example.com:8443/admin" {
		t.Fatalf("admin redirect = %q", got)
	}
}

func TestPlaintextRedirectUsesConfiguredDomain(t *testing.T) {
	manager, _ := newAutocertManager(tlsOptions{Domain: "relay.example.com"}, t.TempDir())
	handler := plaintextRedirectHandler(manager, "relay.example.com", "127.0.0.1:9443", "")
	request := httptest.NewRequest(http.MethodGet, "http://attacker.example/healthz", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if got := response.Header().Get("Location"); got != "https://relay.example.com:9443/healthz" {
		t.Fatalf("redirect accepted an untrusted host: %q", got)
	}
}
