package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestCloudflareManagementTemplateUsesDocumentedPermissionKeys(t *testing.T) {
	for _, requirements := range []cloudflareAuthRequirements{{}, {tunnel: true}, {tokenPolicy: true}, {tokenPolicy: true, mint: true}} {
		u, err := url.Parse(cloudflareManagementTemplate(requirements))
		if err != nil || u.Scheme != "https" || u.Host != "dash.cloudflare.com" || u.Query().Get("to") != "/:account/api-tokens" {
			t.Fatalf("invalid official account template: %v", err)
		}
		var permissions []cloudflareTemplatePermission
		if err := json.Unmarshal([]byte(u.Query().Get("permissionGroupKeys")), &permissions); err != nil {
			t.Fatal(err)
		}
		want := 5
		if requirements.tokenPolicy {
			want++
		}
		if len(permissions) != want || u.Query().Has("accountId") || u.Query().Has("zoneId") {
			t.Fatal("unexpected template resource or permission selection")
		}
		for _, permission := range permissions {
			if permission.Type != "read" && (!requirements.mint || permission.Key != "account_api_tokens" || permission.Type != "edit") {
				t.Fatalf("unexpected permission: %+v", permission)
			}
		}
	}
}

func TestCloudflareOAuthCallbackAcceptsOnlyMatchingSingleLoopbackCode(t *testing.T) {
	result := make(chan cloudflareCallback, 1)
	handler := cloudflareCallbackHandler("fixture-state", result)
	for _, tc := range []struct {
		name, path, host, remote string
		want                     int
	}{
		{"wrong state", "/callback?state=wrong&code=fixture-code", cloudflareOAuthListen, "127.0.0.1:12345", 400},
		{"duplicate state", "/callback?state=fixture-state&state=fixture-state&code=fixture-code", cloudflareOAuthListen, "127.0.0.1:12345", 400},
		{"wrong host", "/callback?state=fixture-state&code=fixture-code", "example.com", "127.0.0.1:12345", 400},
		{"wrong path", "/other?state=fixture-state&code=fixture-code", cloudflareOAuthListen, "127.0.0.1:12345", 400},
		{"remote", "/callback?state=fixture-state&code=fixture-code", cloudflareOAuthListen, "192.0.2.1:12345", 400},
		{"valid", "/callback?state=fixture-state&code=fixture-code", cloudflareOAuthListen, "127.0.0.1:12345", 200},
		{"replay", "/callback?state=fixture-state&code=another-code", cloudflareOAuthListen, "127.0.0.1:12345", 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			req.Host, req.RemoteAddr = tc.host, tc.remote
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			if w.Code != tc.want {
				t.Fatalf("callback response %d, want %d", w.Code, tc.want)
			}
		})
	}
	select {
	case callback := <-result:
		if callback.code != "fixture-code" || callback.err != nil {
			t.Fatal("wrong callback accepted")
		}
	default:
		t.Fatal("valid callback was not delivered")
	}
}

// No token-management grant is requested when the required credentials exist.
func TestCloudflareAuthRequirementsFollowMissingCredentials(t *testing.T) {
	snapshot := githubSnapshot{
		Bootstrap:  githubEnvironment{Secrets: map[string]bool{}},
		Production: githubEnvironment{Secrets: map[string]bool{}},
	}
	for _, input := range protectedSecrets() {
		selectEnvironment(snapshot, input.environment).Secrets[input.name] = true
	}
	if got := cloudflareRequirementsFor(snapshot); !got.readOnly() {
		t.Fatalf("unexpected provisioning authority: %+v", got)
	}
	delete(snapshot.Bootstrap.Secrets, cloudflareReadRole)
	if got := cloudflareRequirementsFor(snapshot); !got.tokenPolicy || got.mint || got.tunnel {
		t.Fatalf("peer-copy requires metadata read only: %+v", got)
	}
	delete(snapshot.Production.Secrets, cloudflareReadRole)
	if got := cloudflareRequirementsFor(snapshot); !got.tokenPolicy || !got.mint || got.tunnel {
		t.Fatalf("missing deployment token requires issuance: %+v", got)
	}
	delete(snapshot.Bootstrap.Secrets, "CODEXIA_TUNNEL_TOKEN")
	if got := cloudflareRequirementsFor(snapshot); !got.tunnel {
		t.Fatalf("missing connector token requires retrieval: %+v", got)
	}
}
