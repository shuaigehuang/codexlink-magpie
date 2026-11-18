package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/shuaigehuang/codexlink/internal/relay"

	"golang.org/x/crypto/acme/autocert"
)

const (
	defaultListen = "127.0.0.1:8787"
	minTokenBytes = 32
)

func main() {
	cfg, listen, err := loadConfig(os.Getenv)
	if err != nil {
		log.Fatalf("配置错误: %v", err)
	}
	adminListen := strings.TrimSpace(os.Getenv("CODEXLINK_RELAY_ADMIN_LISTEN"))

	service, err := relay.NewServer(cfg)
	if err != nil {
		log.Fatalf("启动中继失败: %v", err)
	}
	defer service.Close()

	tlsOptions := loadTLSOptions(os.Getenv)
	if tlsOptions.Domain != "" && strings.TrimSpace(os.Getenv("CODEXLINK_RELAY_LISTEN")) == "" {
		listen = ":443"
	}
	httpServer, adminServer, plainServers, certManager, err := buildServers(
		service, listen, adminListen, tlsOptions, cfg,
	)
	if err != nil {
		log.Fatalf("监听配置错误: %v", err)
	}
	runServers(service, httpServer, adminServer, plainServers, certManager, cfg)
}

func buildServers(service *relay.Server, listen, adminListen string, tlsOptions tlsOptions, cfg relay.Config) (*http.Server, *http.Server, []*http.Server, *autocert.Manager, error) {
	if err := validateListeners(listen, adminListen, tlsOptions); err != nil {
		return nil, nil, nil, nil, err
	}

	var certManager *autocert.Manager
	var tlsConfig *tls.Config
	if tlsOptions.Domain != "" {
		certManager, tlsConfig = newAutocertManager(tlsOptions, cfg.DataDir)
	}

	relayHandler := service.Handler()
	if adminListen == "" {
		relayHandler = service.CombinedHandler()
	}
	httpServer := &http.Server{
		Addr:              listen,
		Handler:           relayHandler,
		TLSConfig:         tlsConfig,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	var adminServer *http.Server
	if adminListen != "" {
		adminServer = &http.Server{
			Addr:              adminListen,
			Handler:           service.AdminHandler(),
			TLSConfig:         tlsConfig,
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       60 * time.Second,
		}
	}

	plainServers := make([]*http.Server, 0, 2)
	if certManager != nil && tlsOptions.HTTPAddr != "" {
		plainServers = append(plainServers, &http.Server{
			Addr:              tlsOptions.HTTPAddr,
			Handler:           plaintextRedirectHandler(certManager, tlsOptions.Domain, listen, adminListen),
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       30 * time.Second,
		})
	}
	if tlsOptions.ExtraHTTPAddr != "" {
		handler := relayHandler
		if certManager != nil {
			handler = plaintextRedirectHandler(certManager, tlsOptions.Domain, listen, adminListen)
		}
		plainServers = append(plainServers, &http.Server{
			Addr:              tlsOptions.ExtraHTTPAddr,
			Handler:           handler,
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       60 * time.Second,
		})
	}
	return httpServer, adminServer, plainServers, certManager, nil
}

func validateListeners(listen, adminListen string, tlsOptions tlsOptions) error {
	addresses := []string{listen}
	if adminListen != "" {
		addresses = append(addresses, adminListen)
	}
	if tlsOptions.Domain != "" && tlsOptions.HTTPAddr != "" {
		addresses = append(addresses, tlsOptions.HTTPAddr)
	}
	if tlsOptions.ExtraHTTPAddr != "" {
		addresses = append(addresses, tlsOptions.ExtraHTTPAddr)
	}
	seen := make(map[string]string, len(addresses))
	for _, address := range addresses {
		key, err := listenerKey(address)
		if err != nil {
			return fmt.Errorf("监听地址 %q 无效: %w", address, err)
		}
		if previous, ok := seen[key]; ok {
			return fmt.Errorf("监听地址重复: %s 与 %s", previous, address)
		}
		seen[key] = address
	}
	return nil
}

func listenerKey(address string) (string, error) {
	host, port, err := net.SplitHostPort(strings.TrimSpace(address))
	if err != nil {
		return "", err
	}
	switch strings.TrimSpace(host) {
	case "", "0.0.0.0", "::", "[::]":
		host = "*"
	}
	if number, err := strconv.Atoi(port); err == nil {
		port = strconv.Itoa(number)
	}
	return net.JoinHostPort(strings.ToLower(host), port), nil
}

func runServers(service *relay.Server, httpServer, adminServer *http.Server, plainServers []*http.Server, certManager *autocert.Manager, cfg relay.Config) {
	type serveSpec struct {
		server *http.Server
		tls    bool
		label  string
	}
	specs := []serveSpec{{
		server: httpServer,
		tls:    certManager != nil,
		label:  "relay",
	}}
	if adminServer != nil {
		specs = append(specs, serveSpec{
			server: adminServer,
			tls:    certManager != nil,
			label:  "admin",
		})
	}
	for _, server := range plainServers {
		specs = append(specs, serveSpec{server: server, label: "plaintext"})
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errCh := make(chan error, len(specs))
	for _, spec := range specs {
		spec := spec
		go func() {
			var err error
			if spec.tls {
				err = spec.server.ListenAndServeTLS("", "")
			} else {
				err = spec.server.ListenAndServe()
			}
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				errCh <- fmt.Errorf("%s listener on %s: %w", spec.label, spec.server.Addr, err)
			}
		}()
	}

	shutdownDone := make(chan struct{})
	var serveErr error
	go func() {
		select {
		case <-ctx.Done():
		case serveErr = <-errCh:
		}
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
		if adminServer != nil {
			_ = adminServer.Shutdown(shutdownCtx)
		}
		for _, server := range plainServers {
			_ = server.Shutdown(shutdownCtx)
		}
		service.Close()
		close(shutdownDone)
	}()

	if certManager != nil {
		cfg.Logger.Printf("relay listening with automatic HTTPS on %s", httpServer.Addr)
		if adminServer != nil {
			cfg.Logger.Printf("admin console listening with automatic HTTPS on %s", adminServer.Addr)
		}
	} else {
		cfg.Logger.Printf("relay listening on %s", httpServer.Addr)
		if adminServer != nil {
			cfg.Logger.Printf("admin console listening on %s", adminServer.Addr)
		}
	}
	for _, server := range plainServers {
		if certManager != nil {
			cfg.Logger.Printf("HTTP redirect listener on %s", server.Addr)
		} else {
			cfg.Logger.Printf("relay also serving HTTP on %s", server.Addr)
		}
	}

	<-shutdownDone
	if serveErr != nil {
		log.Fatalf("中继服务异常退出: %v", serveErr)
	}
	cfg.Logger.Print("relay stopped")
}

func loadConfig(getenv func(string) string) (relay.Config, string, error) {
	token := strings.TrimSpace(getenv("CODEXLINK_RELAY_DESKTOP_TOKEN"))
	if len(token) < minTokenBytes {
		return relay.Config{}, "", fmt.Errorf("CODEXLINK_RELAY_DESKTOP_TOKEN 至少需要 %d 个字符", minTokenBytes)
	}
	adminToken := strings.TrimSpace(getenv("CODEXLINK_RELAY_ADMIN_TOKEN"))
	if adminToken != "" && len(adminToken) < minTokenBytes {
		return relay.Config{}, "", fmt.Errorf("CODEXLINK_RELAY_ADMIN_TOKEN 至少需要 %d 个字符", minTokenBytes)
	}
	dataDir := strings.TrimSpace(getenv("CODEXLINK_RELAY_DATA_DIR"))
	if dataDir == "" {
		dataDir = "./data"
	}
	listen := strings.TrimSpace(getenv("CODEXLINK_RELAY_LISTEN"))
	if listen == "" {
		listen = defaultListen
	}

	pairTTL, err := durationEnv(getenv, "CODEXLINK_RELAY_PAIR_TTL", 10*time.Minute)
	if err != nil {
		return relay.Config{}, "", err
	}
	sessionTTL, err := durationEnv(getenv, "CODEXLINK_RELAY_SESSION_TTL", 90*24*time.Hour)
	if err != nil {
		return relay.Config{}, "", err
	}
	trustProxy, err := boolEnv(getenv, "CODEXLINK_RELAY_TRUST_PROXY", false)
	if err != nil {
		return relay.Config{}, "", err
	}
	origins := splitList(getenv("CODEXLINK_RELAY_ORIGINS"))
	publicURLs := splitList(getenv("CODEXLINK_RELAY_PUBLIC_URLS"))

	return relay.Config{
		DesktopToken:   token,
		AdminToken:     adminToken,
		PublicURLs:     publicURLs,
		DataDir:        dataDir,
		PairTTL:        pairTTL,
		SessionTTL:     sessionTTL,
		AllowedOrigins: origins,
		TrustProxy:     trustProxy,
		Logger:         log.New(os.Stderr, "relay ", log.LstdFlags|log.LUTC),
	}, listen, nil
}

func durationEnv(getenv func(string) string, key string, fallback time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(getenv(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s 需为有效时长，例如 10m 或 720h", key)
	}
	return parsed, nil
}

func boolEnv(getenv func(string) string, key string, fallback bool) (bool, error) {
	value := strings.TrimSpace(getenv(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s 需为 true/false 或 1/0", key)
	}
	return parsed, nil
}

func splitList(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if item := strings.TrimSpace(part); item != "" {
			result = append(result, item)
		}
	}
	return result
}
