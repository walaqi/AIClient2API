package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
	"golang.org/x/net/proxy"
)

const (
	defaultPort    = 9090
	headerTarget   = "X-Target-Url"
	headerProxy    = "X-Proxy-Url"
	headerProfile  = "X-Tls-Profile"
	readTimeout    = 30 * time.Second
	writeTimeout   = 0
	idleTimeout    = 120 * time.Second
	h2IdleTTL      = 2 * time.Minute
	rtCacheIdleTTL = 5 * time.Minute
	cleanupTick    = 60 * time.Second
)

var profileMap = map[string]utls.ClientHelloID{
	"HelloChrome_Auto":  utls.HelloChrome_Auto,
	"HelloChrome_120":   utls.HelloChrome_120,
	"HelloChrome_131":   utls.HelloChrome_131,
	"HelloChrome_133":   utls.HelloChrome_133,
	"HelloFirefox_Auto": utls.HelloFirefox_Auto,
	"HelloFirefox_120":  utls.HelloFirefox_120,
	"HelloSafari_Auto":  utls.HelloSafari_Auto,
	"HelloEdge_106":     utls.HelloEdge_106,
}

func supportedProfileNames() []string {
	names := make([]string, 0, len(profileMap))
	for k := range profileMap {
		names = append(names, k)
	}
	return names
}

// ──────────────── RoundTripper Cache ────────────────

var (
	rtCacheMu sync.Mutex
	rtCache   = make(map[string]*utlsRoundTripper)
)

func cacheKey(proxyURL, profile string) string {
	return proxyURL + "|" + profile
}

func getOrCreateRT(proxyURL string, helloID utls.ClientHelloID) *utlsRoundTripper {
	key := cacheKey(proxyURL, helloID.Str())
	rtCacheMu.Lock()
	defer rtCacheMu.Unlock()
	if rt, ok := rtCache[key]; ok {
		rt.lastUsed = time.Now()
		return rt
	}
	rt := newUTLSRoundTripper(proxyURL, helloID)
	rtCache[key] = rt
	return rt
}

// ──────────────── uTLS RoundTripper ────────────────

type h2Entry struct {
	cc       *http2.ClientConn
	lastUsed time.Time
}

type utlsRoundTripper struct {
	proxyURL  string
	helloID   utls.ClientHelloID
	lastUsed  time.Time

	mu      sync.Mutex
	h2Conns map[string]*h2Entry
}

func newUTLSRoundTripper(proxyURL string, helloID utls.ClientHelloID) *utlsRoundTripper {
	return &utlsRoundTripper{
		proxyURL: proxyURL,
		helloID:  helloID,
		lastUsed: time.Now(),
		h2Conns:  make(map[string]*h2Entry),
	}
}

func (rt *utlsRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	rt.lastUsed = time.Now()
	addr := req.URL.Host
	if !strings.Contains(addr, ":") {
		if req.URL.Scheme == "https" {
			addr += ":443"
		} else {
			addr += ":80"
		}
	}

	rt.mu.Lock()
	if entry, ok := rt.h2Conns[addr]; ok {
		rt.mu.Unlock()
		if entry.cc.CanTakeNewRequest() {
			entry.lastUsed = time.Now()
			resp, err := entry.cc.RoundTrip(req)
			if err == nil {
				return resp, nil
			}
			log.Printf("[TLS-Sidecar] Cached H2 conn failed for %s: %v, reconnecting", addr, err)
		}
		rt.mu.Lock()
		delete(rt.h2Conns, addr)
		rt.mu.Unlock()
	} else {
		rt.mu.Unlock()
	}

	conn, err := dialUTLS(req.Context(), "tcp", addr, rt.proxyURL, rt.helloID)
	if err != nil {
		return nil, err
	}

	alpn := conn.ConnectionState().NegotiatedProtocol
	log.Printf("[TLS-Sidecar] Connected to %s, ALPN: %q, profile: %s", addr, alpn, rt.helloID.Str())

	if alpn == "h2" {
		t2 := &http2.Transport{
			StrictMaxConcurrentStreams: true,
			AllowHTTP:                 false,
		}
		cc, err := t2.NewClientConn(conn)
		if err != nil {
			conn.Close()
			return nil, fmt.Errorf("h2 client conn: %w", err)
		}
		rt.mu.Lock()
		rt.h2Conns[addr] = &h2Entry{cc: cc, lastUsed: time.Now()}
		rt.mu.Unlock()
		return cc.RoundTrip(req)
	}

	used := false
	t1 := &http.Transport{
		DialTLSContext: func(ctx context.Context, network, a string) (net.Conn, error) {
			if !used {
				used = true
				return conn, nil
			}
			return dialUTLS(ctx, network, a, rt.proxyURL, rt.helloID)
		},
		MaxIdleConnsPerHost: 1,
		IdleConnTimeout:     90 * time.Second,
	}
	resp, err := t1.RoundTrip(req)
	if err != nil {
		conn.Close()
		t1.CloseIdleConnections()
	}
	return resp, err
}

func (rt *utlsRoundTripper) CloseIdleConnections() {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	for k, entry := range rt.h2Conns {
		entry.cc.Close()
		delete(rt.h2Conns, k)
	}
}

func (rt *utlsRoundTripper) cleanupIdleH2(ttl time.Duration) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	now := time.Now()
	for k, entry := range rt.h2Conns {
		if now.Sub(entry.lastUsed) > ttl {
			entry.cc.Close()
			delete(rt.h2Conns, k)
		}
	}
}

// ──────────────── Idle Cleanup ────────────────

func startCleanupLoop(ctx context.Context) {
	ticker := time.NewTicker(cleanupTick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := time.Now()
			rtCacheMu.Lock()
			for key, rt := range rtCache {
				rt.cleanupIdleH2(h2IdleTTL)
				if now.Sub(rt.lastUsed) > rtCacheIdleTTL {
					rt.CloseIdleConnections()
					delete(rtCache, key)
				}
			}
			rtCacheMu.Unlock()
		}
	}
}

// ──────────────── Main ────────────────

func main() {
	log.SetOutput(os.Stdout)

	port := defaultPort
	if p := os.Getenv("TLS_SIDECAR_PORT"); p != "" {
		if v, err := strconv.Atoi(p); err == nil {
			port = v
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go startCleanupLoop(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/", handleProxy)

	srv := &http.Server{
		Addr:         fmt.Sprintf("127.0.0.1:%d", port),
		Handler:      mux,
		ReadTimeout:  readTimeout,
		WriteTimeout: writeTimeout,
		IdleTimeout:  idleTimeout,
	}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("[TLS-Sidecar] Shutting down...")
		cancel()
		shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutCancel()
		srv.Shutdown(shutCtx)
	}()

	log.Printf("[TLS-Sidecar] Listening on 127.0.0.1:%d (multi-profile uTLS, H2+H1 auto)\n", port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[TLS-Sidecar] Fatal: %v", err)
	}
}

// ──────────────── Health ────────────────

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	fmt.Fprintf(w, `{"status":"ok","tls":"utls-multi-profile","protocols":"h2,http/1.1","profiles":%q}`,
		strings.Join(supportedProfileNames(), ","))
}

// ──────────────── Proxy Handler ────────────────

func handleProxy(w http.ResponseWriter, r *http.Request) {
	targetURL := r.Header.Get(headerTarget)
	if targetURL == "" {
		http.Error(w, `{"error":"missing X-Target-Url header"}`, http.StatusBadRequest)
		return
	}

	proxyURL := r.Header.Get(headerProxy)
	profileName := r.Header.Get(headerProfile)

	helloID := utls.HelloChrome_Auto
	if profileName != "" {
		id, ok := profileMap[profileName]
		if !ok {
			http.Error(w, fmt.Sprintf(`{"error":"invalid X-Tls-Profile: %s, supported: %s"}`,
				profileName, strings.Join(supportedProfileNames(), ", ")), http.StatusBadRequest)
			return
		}
		helloID = id
	}

	parsed, err := url.Parse(targetURL)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"invalid target url: %s"}`, err), http.StatusBadRequest)
		return
	}

	outReq, err := http.NewRequestWithContext(r.Context(), r.Method, targetURL, r.Body)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"failed to create request: %s"}`, err), http.StatusInternalServerError)
		return
	}

	for key, vals := range r.Header {
		lk := strings.ToLower(key)
		if lk == strings.ToLower(headerTarget) || lk == strings.ToLower(headerProxy) || lk == strings.ToLower(headerProfile) {
			continue
		}
		if lk == "connection" || lk == "keep-alive" || lk == "transfer-encoding" ||
			lk == "te" || lk == "trailer" || lk == "upgrade" || lk == "host" ||
			lk == "x-forwarded-for" || lk == "x-real-ip" || lk == "x-forwarded-proto" ||
			lk == "x-forwarded-host" || lk == "via" || lk == "proxy-connection" ||
			lk == "cf-connecting-ip" || lk == "true-client-ip" {
			continue
		}
		outReq.Header[key] = vals
	}
	outReq.Host = parsed.Host

	if ae := outReq.Header["Accept-Encoding"]; len(ae) > 0 {
		outReq.Header["Accept-Encoding"] = []string{"gzip, deflate, br, zstd"}
	}

	rt := getOrCreateRT(proxyURL, helloID)
	resp, err := rt.RoundTrip(outReq)
	if err != nil {
		log.Printf("[TLS-Sidecar] RoundTrip error → %s: %v", parsed.Host, err)
		http.Error(w, fmt.Sprintf(`{"error":"upstream request failed: %s"}`, err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for key, vals := range resp.Header {
		for _, v := range vals {
			w.Header().Add(key, v)
		}
	}
	w.WriteHeader(resp.StatusCode)

	flusher, canFlush := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				log.Printf("[TLS-Sidecar] Write error: %v", writeErr)
				return
			}
			if canFlush {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				log.Printf("[TLS-Sidecar] Read error: %v", readErr)
			}
			return
		}
	}
}

// ──────────────── uTLS Dial ────────────────

func dialUTLS(ctx context.Context, network, addr string, proxyURL string, helloID utls.ClientHelloID) (*utls.UConn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}

	var rawConn net.Conn
	if proxyURL != "" {
		rawConn, err = dialViaProxy(ctx, network, addr, proxyURL)
	} else {
		var d net.Dialer
		rawConn, err = d.DialContext(ctx, network, addr)
	}
	if err != nil {
		return nil, fmt.Errorf("tcp dial failed: %w", err)
	}

	tlsConn := utls.UClient(rawConn, &utls.Config{
		ServerName: host,
		NextProtos: []string{"h2", "http/1.1"},
	}, helloID)

	if deadline, ok := ctx.Deadline(); ok {
		tlsConn.SetDeadline(deadline)
	} else {
		tlsConn.SetDeadline(time.Now().Add(15 * time.Second))
	}

	if err := tlsConn.Handshake(); err != nil {
		rawConn.Close()
		return nil, fmt.Errorf("utls handshake failed: %w", err)
	}

	tlsConn.SetDeadline(time.Time{})
	return tlsConn, nil
}

// ──────────────── Proxy Dialer ────────────────

func dialViaProxy(ctx context.Context, network, addr string, proxyURL string) (net.Conn, error) {
	parsed, err := url.Parse(proxyURL)
	if err != nil {
		return nil, fmt.Errorf("invalid proxy url: %w", err)
	}

	switch strings.ToLower(parsed.Scheme) {
	case "socks5", "socks5h", "socks4", "socks":
		var auth *proxy.Auth
		if parsed.User != nil {
			auth = &proxy.Auth{User: parsed.User.Username()}
			auth.Password, _ = parsed.User.Password()
		}
		dialer, err := proxy.SOCKS5("tcp", parsed.Host, auth, &net.Dialer{Timeout: 15 * time.Second})
		if err != nil {
			return nil, fmt.Errorf("socks5 dialer: %w", err)
		}
		if ctxDialer, ok := dialer.(proxy.ContextDialer); ok {
			return ctxDialer.DialContext(ctx, network, addr)
		}
		return dialer.Dial(network, addr)

	case "http", "https":
		proxyConn, err := net.DialTimeout("tcp", parsed.Host, 15*time.Second)
		if err != nil {
			return nil, fmt.Errorf("connect to http proxy: %w", err)
		}
		connectReq := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n", addr, addr)
		if parsed.User != nil {
			username := parsed.User.Username()
			password, _ := parsed.User.Password()
			cred := base64.StdEncoding.EncodeToString([]byte(username + ":" + password))
			connectReq += fmt.Sprintf("Proxy-Authorization: Basic %s\r\n", cred)
		}
		connectReq += "\r\n"
		if _, err = proxyConn.Write([]byte(connectReq)); err != nil {
			proxyConn.Close()
			return nil, fmt.Errorf("proxy CONNECT write: %w", err)
		}
		buf := make([]byte, 4096)
		n, err := proxyConn.Read(buf)
		if err != nil {
			proxyConn.Close()
			return nil, fmt.Errorf("proxy CONNECT read: %w", err)
		}
		if !strings.Contains(string(buf[:n]), "200") {
			proxyConn.Close()
			return nil, fmt.Errorf("proxy CONNECT rejected: %s", strings.TrimSpace(string(buf[:n])))
		}
		return proxyConn, nil

	default:
		return nil, fmt.Errorf("unsupported proxy scheme: %s", parsed.Scheme)
	}
}
