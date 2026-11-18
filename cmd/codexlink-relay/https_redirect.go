package main

import (
	"net"
	"net/http"
	"strings"

	"golang.org/x/crypto/acme/autocert"
)

func plaintextRedirectHandler(manager *autocert.Manager, domain, relayListen, adminListen string) http.Handler {
	redirect := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		port := listenerPort(relayListen)
		if adminListen != "" && isAdminPath(r.URL.Path) {
			port = listenerPort(adminListen)
		}
		authority := strings.TrimSpace(domain)
		if port != "" && port != "443" {
			authority = net.JoinHostPort(authority, port)
		}
		location := "https://" + authority + r.URL.RequestURI()
		w.Header().Set("Connection", "close")
		http.Redirect(w, r, location, http.StatusPermanentRedirect)
	})
	if manager == nil {
		return redirect
	}
	return manager.HTTPHandler(redirect)
}

func listenerPort(address string) string {
	_, port, err := net.SplitHostPort(strings.TrimSpace(address))
	if err != nil {
		return ""
	}
	return port
}

func isAdminPath(path string) bool {
	return path == "/admin" || strings.HasPrefix(path, "/admin/")
}
