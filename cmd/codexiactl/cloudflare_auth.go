package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/oauth2"
)

// Set only by the official publisher when a Cloudflare public PKCE client
// with the reviewed callback and scopes has been registered and accepted.
var cloudflareOAuthClientID string

var cloudflareOAuthClientPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

const (
	cloudflareOAuthListen   = "127.0.0.1:18765"
	cloudflareOAuthPath     = "/callback"
	cloudflareOAuthRedirect = "http://" + cloudflareOAuthListen + cloudflareOAuthPath
)

var cloudflareInspectionScopes = []string{
	"zone.read", "dns.read", "workers-routes.read", "argotunnel.read",
	"access.read", "access-service-token.read", "workers-scripts.read",
}

// Derive extra authority from the protected input inventory. An existing
// deployment credential is reused; a missing peer copy needs metadata read,
// not new-token issuance. Unknown inventory is treated as missing.
type cloudflareAuthRequirements struct {
	tunnel, tokenPolicy, mint, workerWrite bool
}

func cloudflareRequirementsFor(snapshot githubSnapshot) cloudflareAuthRequirements {
	var requirements cloudflareAuthRequirements
	for _, input := range missingSecrets(snapshot) {
		switch input.name {
		case "CODEXIA_TUNNEL_TOKEN":
			requirements.tunnel = true
		case cloudflareReadRole, cloudflareWorkerRole:
			requirements.tokenPolicy = true
			if !snapshot.Bootstrap.Secrets[input.name] && !snapshot.Production.Secrets[input.name] {
				requirements.mint = true
				if input.name == cloudflareWorkerRole {
					requirements.workerWrite = true
				}
			}
		}
	}
	return requirements
}

func (r cloudflareAuthRequirements) readOnly() bool {
	return !r.tunnel && !r.tokenPolicy && !r.mint
}

// Only scope IDs published by GET /oauth/scopes are used for a self-managed
// client. The colon-delimited first-party CLI scopes cannot be registered.
// Account API Tokens Write is the available OAuth scope for token management;
// read-only doctor/plan never request it.
func (r cloudflareAuthRequirements) oauthScopes() []string {
	scopes := append([]string(nil), cloudflareInspectionScopes...)
	if r.tunnel {
		scopes = append(scopes, "argotunnel.write")
	}
	if r.tokenPolicy {
		scopes = append(scopes, "account-api-tokens.write")
	}
	if r.workerWrite {
		scopes = append(scopes, "workers-scripts.write")
	}
	return scopes
}

type cloudflareTemplatePermission struct {
	Key  string `json:"key"`
	Type string `json:"type"`
}

// The provider documents these short template keys. Tunnel and Access
// service-token keys are not documented; the form explicitly requires their
// addition instead of silently pretending that the template is complete.
func cloudflareManagementTemplate(requirements cloudflareAuthRequirements) string {
	permissions := []cloudflareTemplatePermission{
		{Key: "zone", Type: "read"},
		{Key: "dns", Type: "read"},
		{Key: "workers_routes", Type: "read"},
		{Key: "workers_scripts", Type: "read"},
		{Key: "access", Type: "read"},
	}
	name := "CodexiaCTL temporary inspection"
	if !requirements.readOnly() {
		name = "CodexiaCTL temporary provisioning"
	}
	if requirements.mint {
		permissions = append(permissions, cloudflareTemplatePermission{Key: "account_api_tokens", Type: "edit"})
	} else if requirements.tokenPolicy {
		permissions = append(permissions, cloudflareTemplatePermission{Key: "account_api_tokens", Type: "read"})
	}
	encoded, _ := json.Marshal(permissions)
	query := url.Values{"to": {"/:account/api-tokens"}, "permissionGroupKeys": {string(encoded)}, "name": {name}}
	return "https://dash.cloudflare.com/?" + query.Encode()
}

func cloudflareManagementCredential(ctx context.Context, o operator, host string, requirements cloudflareAuthRequirements) ([]byte, func(), error) {
	if cloudflareOAuthClientPattern.MatchString(cloudflareOAuthClientID) {
		choice, err := selectOption(o, "Cloudflare authentication for "+host, []string{
			"Browser OAuth (requires SSH local forwarding)", "Temporary account API token (fallback)",
		})
		if err != nil {
			return nil, nil, err
		}
		if choice == 0 {
			return cloudflareOAuthAccess(ctx, o, cloudflareOAuthClientID, requirements.oauthScopes())
		}
	} else if err := requireConfirmation(o, "Authenticate to Cloudflare for "+host+"?"); err != nil {
		return nil, nil, err
	}
	reportResult(o, headingText, "Create one temporary account API token")
	o.Notice("Open the template in your browser. Select the account and zone containing " + host + " and a short expiry.")
	if err := privateNotice(o, cloudflareManagementTemplate(requirements)); err != nil {
		return nil, nil, err
	}
	o.Notice("Review prefilled Zone, DNS, Workers Routes, Workers Scripts and account Access: Apps and Policies (Read).")
	if requirements.tunnel {
		o.Notice("Add Account > Cloudflare Tunnel Edit and Access: Service Tokens Read.")
	} else {
		o.Notice("Add Account > Cloudflare Tunnel Read and Access: Service Tokens Read.")
	}
	if requirements.mint {
		o.Notice("Confirm Account API Tokens Edit for scoped deployment-token issuance.")
	} else if requirements.tokenPolicy {
		o.Notice("Confirm Account API Tokens Read for deployment-token metadata verification.")
	}
	if requirements.tokenPolicy {
		o.Notice("If reusing a user-owned deployment token, use " + cloudflareTokensPage + " instead with the same user, the listed edge permissions, and User API Tokens Read. Existing policy verification still applies.")
	}
	o.Notice("Do not select all accounts or all zones. Paste the temporary token here; revoke it after the session.")
	secret, err := readCloudflareSecret(o, "Temporary Cloudflare management token")
	return secret, nil, err
}

type cloudflareCallback struct {
	code string
	err  error
}

func cloudflareCallbackHandler(state string, result chan<- cloudflareCallback) http.Handler {
	var once sync.Once
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		remote, _, err := net.SplitHostPort(r.RemoteAddr)
		ip := net.ParseIP(remote)
		if err != nil || ip == nil || !ip.IsLoopback() || r.Method != http.MethodGet ||
			r.Host != cloudflareOAuthListen || r.URL.Path != cloudflareOAuthPath {
			http.Error(w, "Invalid callback", http.StatusBadRequest)
			return
		}
		values, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil || len(values["state"]) != 1 || subtle.ConstantTimeCompare([]byte(values.Get("state")), []byte(state)) != 1 {
			http.Error(w, "Invalid callback", http.StatusBadRequest)
			return
		}
		var callback cloudflareCallback
		switch {
		case len(values["error"]) == 1 && len(values["code"]) == 0:
			callback.err = needsAction("Cloudflare browser authorization was denied")
		case len(values["code"]) == 1 && len(values["error"]) == 0 && validCloudflareSecret([]byte(values.Get("code"))):
			callback.code = values.Get("code")
		default:
			http.Error(w, "Invalid callback", http.StatusBadRequest)
			return
		}
		accepted := false
		once.Do(func() {
			accepted = true
			result <- callback
		})
		if !accepted {
			http.Error(w, "Callback already received", http.StatusConflict)
			return
		}
		_, _ = w.Write([]byte("Return to the CodexiaCTL SSH terminal."))
	})
}

func cloudflareOAuthHTTPClient() *http.Client {
	return &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}

func cloudflareOAuthAccess(ctx context.Context, o operator, clientID string, scopes []string) ([]byte, func(), error) {
	if !cloudflareOAuthClientPattern.MatchString(clientID) {
		return nil, nil, needsAction("The official Cloudflare OAuth client is not configured")
	}
	listener, err := net.Listen("tcp4", cloudflareOAuthListen)
	if err != nil {
		return nil, nil, needsAction("Cloudflare callback port 18765 is unavailable on the VM. Free that port or choose the temporary account token on the next run")
	}
	defer listener.Close()
	state, verifier := oauth2.GenerateVerifier(), oauth2.GenerateVerifier()
	cfg := oauth2.Config{
		ClientID:    clientID,
		RedirectURL: cloudflareOAuthRedirect,
		Scopes:      scopes,
		Endpoint: oauth2.Endpoint{
			AuthURL:   "https://dash.cloudflare.com/oauth2/auth",
			TokenURL:  "https://dash.cloudflare.com/oauth2/token",
			AuthStyle: oauth2.AuthStyleInParams,
		},
	}
	result := make(chan cloudflareCallback, 1)
	server := &http.Server{
		Handler:           cloudflareCallbackHandler(state, result),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	serveError := make(chan error, 1)
	go func() { serveError <- server.Serve(listener) }()
	defer server.Close()
	o.Notice("Requested Cloudflare authorization: " + strings.Join(scopes, ", "))
	o.Notice("On your local computer, open a second terminal using the same verified SSH host and administrator. Run ssh -N -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes -L 127.0.0.1:18765:127.0.0.1:18765 <same SSH target>. Close that session after sign-in.")
	if err := privateNotice(o, cfg.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier))); err != nil {
		return nil, nil, err
	}
	wait, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	var callback cloudflareCallback
	select {
	case <-wait.Done():
		return nil, nil, needsAction("Cloudflare browser authorization did not complete; check the SSH forwarding or choose the temporary account token")
	case <-serveError:
		return nil, nil, errors.New("Cloudflare callback listener stopped")
	case callback = <-result:
	}
	if callback.err != nil {
		return nil, nil, callback.err
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	client := cloudflareOAuthHTTPClient()
	token, err := cfg.Exchange(context.WithValue(wait, oauth2.HTTPClient, client), callback.code, oauth2.VerifierOption(verifier))
	if err != nil {
		return nil, nil, errors.New("Cloudflare authorization-code exchange failed; no deployment changes were made")
	}
	access := []byte(token.AccessToken)
	if !validCloudflareSecret(access) || !strings.EqualFold(token.Type(), "Bearer") || token.Expiry.IsZero() || !token.Expiry.After(time.Now()) {
		clear(access)
		return nil, nil, errors.New("Cloudflare returned an invalid or non-expiring OAuth access token")
	}
	token.AccessToken, token.RefreshToken = "", ""
	revokeToken := append([]byte(nil), access...)
	cleanup := func() {
		defer clear(revokeToken)
		revokeCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		body := url.Values{"client_id": {clientID}, "token": {string(revokeToken)}, "token_type_hint": {"access_token"}}
		req, err := http.NewRequestWithContext(revokeCtx, http.MethodPost, "https://dash.cloudflare.com/oauth2/revoke", strings.NewReader(body.Encode()))
		if err == nil {
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			resp, requestErr := client.Do(req)
			if requestErr == nil {
				resp.Body.Close()
				if resp.StatusCode >= 200 && resp.StatusCode < 300 {
					return
				}
			}
		}
		o.Notice("Cloudflare OAuth revocation could not be confirmed; review authorized applications in the Cloudflare dashboard.")
	}
	return access, cleanup, nil
}
