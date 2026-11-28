package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cloudflare/cloudflare-go/v7/workers"
	"github.com/cloudflare/cloudflare-go/v7/zones"
)

func TestCloudflareZoneIsUniqueAndTargetBound(t *testing.T) {
	t.Setenv("CLOUDFLARE_API_TOKEN", "unexpected-ambient-token")
	t.Setenv("CLOUDFLARE_CUSTOM_HEADERS", "X-Ambient-Auth: unexpected-ambient-header")
	const apiToken = "private-provisioning-token"
	const accountID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const zoneID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	for _, tc := range []struct {
		name, suffixResults, expectedError string
	}{
		{"exact active parent zone", `[{"id":"` + zoneID + `","account":{"id":"` + accountID + `"},"name":"example.test","status":"active"}]`, ""},
		{"ambiguous parent zone", `[{"id":"` + zoneID + `","account":{"id":"` + accountID + `"},"name":"example.test","status":"active"},{"id":"` + zoneID + `","account":{"id":"` + zoneID + `"},"name":"example.test","status":"active"}]`, "ambiguous"},
		{"wrong account's domain", `[{"id":"` + zoneID + `","account":{"id":"` + accountID + `"},"name":"unrelated.test","status":"active"}]`, "not verified"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/zones" || r.Header.Get("Authorization") != "Bearer "+apiToken ||
					r.Header.Get("X-Ambient-Auth") != "" {
					t.Errorf("unexpected zone request %s %s", r.Method, r.URL.Path)
					http.Error(w, "forbidden", http.StatusForbidden)
					return
				}
				result := "[]"
				if r.URL.Query().Get("name") == "example.test" && r.URL.Query().Get("page") == "1" {
					result = tc.suffixResults
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprintf(w, `{"success":true,"errors":[],"result":%s,"result_info":{"total_pages":1}}`, result)
			}))
			defer server.Close()
			client := newCloudflareAPI([]byte(apiToken), server.URL+"/")
			zone, err := client.findZone(context.Background(), "codexia.example.test")
			if tc.expectedError != "" {
				if err == nil || !strings.Contains(err.Error(), tc.expectedError) || strings.Contains(err.Error(), apiToken) {
					t.Fatalf("unexpected zone error %v", err)
				}
				return
			}
			if err != nil || zone.ID != zoneID || zone.Account.ID != accountID {
				t.Fatalf("expected exact zone, got %v", err)
			}
		})
	}
}

func TestCloudflareDenialAndRedirectKeepSecretsOutOfDiagnostics(t *testing.T) {
	const apiToken = "private-provisioning-token"
	for _, tc := range []struct {
		name string
		code int
		body string
	}{
		{"unauthorized", http.StatusForbidden, `{"success":false,"errors":[{"message":"` + apiToken + `"}],"result":null}`},
		{"false envelope", http.StatusOK, `{"success":false,"errors":[{"message":"` + apiToken + `"}],"result":[]}`},
		{"missing result", http.StatusOK, `{"success":true,"errors":[],"result":null}`},
		{"redirect", http.StatusFound, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Error("Cloudflare SDK must not follow a redirected authenticated request")
			}))
			defer other.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Location", other.URL)
				w.WriteHeader(tc.code)
				fmt.Fprint(w, tc.body)
			}))
			defer server.Close()
			_, err := newCloudflareAPI([]byte(apiToken), server.URL+"/").findZone(context.Background(), "codexia.example.test")
			if err == nil || strings.Contains(err.Error(), apiToken) || strings.Contains(err.Error(), other.URL) {
				t.Fatalf("unexpected provider error %v", err)
			}
		})
	}
}

func TestCloudflareRoutesRejectUnexpectedIngress(t *testing.T) {
	const host = "codexia.example.test"
	var canonical cloudflareRoutes
	if err := json.Unmarshal(cloudflareManifest(t, "ui-routes.json"), &canonical); err != nil {
		t.Fatal(err)
	}
	var routes []workers.RouteListResponse
	for _, path := range canonical.Routes {
		routes = append(routes, workers.RouteListResponse{Pattern: host + path, Script: cloudflareWorker})
	}
	for _, path := range canonical.OriginRoutes {
		routes = append(routes, workers.RouteListResponse{Pattern: host + path})
	}
	if err := canonical.check(host, routes); err != nil {
		t.Fatal(err)
	}
	for _, route := range []workers.RouteListResponse{
		{Pattern: "*.example.test/*", Script: "another-worker"},
		{Pattern: "another.example.test/*", Script: cloudflareWorker},
		{Pattern: host + "/api/*", Script: cloudflareWorker},
	} {
		if err := canonical.check(host, append(routes, route)); err == nil {
			t.Errorf("accepted an unexpected route %q", route.Pattern)
		}
	}
	if err := canonical.check(host, routes[1:]); err == nil {
		t.Fatal("accepted a missing canonical route")
	}
}

func cloudflareManifest(t *testing.T, name string) []byte {
	t.Helper()
	content, err := os.ReadFile(filepath.Join("..", "..", "deploy", "cloudflare", name))
	if err != nil {
		t.Fatal(err)
	}
	return content
}

func TestCloudflareDiscoversCanonicalEdgeWithoutMutation(t *testing.T) {
	const (
		host       = "codexia.example.test"
		account    = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		zoneID     = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		tunnelID   = "00000000-0000-0000-0000-000000000001"
		authorApp  = "00000000-0000-0000-0000-000000000002"
		backendApp = "00000000-0000-0000-0000-000000000003"
		uiApp      = "00000000-0000-0000-0000-000000000004"
		authorID   = "00000000-0000-0000-0000-000000000005"
		ciID       = "00000000-0000-0000-0000-000000000006"
		tokenID    = "00000000-0000-0000-0000-000000000007"
	)
	contract := cloudflareContract{
		routes:         cloudflareManifest(t, "ui-routes.json"),
		identityProbes: cloudflareManifest(t, "identity-probes.json"),
		protocolPaths:  cloudflareManifest(t, "public-protocol-paths.json"),
	}
	var identities map[string]cloudflarePath
	var routeManifest cloudflareRoutes
	if json.Unmarshal(contract.identityProbes, &identities) != nil || json.Unmarshal(contract.routes, &routeManifest) != nil {
		t.Fatal("canonical Cloudflare fixture is invalid")
	}
	application := func(id, path, aud string) map[string]any {
		return map[string]any{"id": id, "domain": host + path, "aud": aud, "type": "self_hosted", "self_hosted_domains": []string{host + path}}
	}
	policy := func(id, decision string, order int, include any) map[string]any {
		return map[string]any{"id": id, "decision": decision, "precedence": order, "include": include}
	}
	authorAudience, backendAudience, uiAudience := strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)
	ingress := func(path string, audiences []string) map[string]any {
		return map[string]any{"hostname": host, "service": "http://codexia-api:3000", "path": path,
			"originRequest": map[string]any{"httpHostHeader": host, "access": map[string]any{
				"required": true, "teamName": "test-team", "audTag": audiences}}}
	}
	var routes []map[string]any
	for _, path := range routeManifest.Routes {
		routes = append(routes, map[string]any{"pattern": host + path, "script": cloudflareWorker})
	}
	for _, path := range routeManifest.OriginRoutes {
		routes = append(routes, map[string]any{"pattern": host + path, "script": nil})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("Cloudflare read issued %s", r.Method)
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var result any
		switch p := r.URL.Path; p {
		case "/zones/" + zoneID + "/dns_records":
			result = []map[string]any{{"name": host, "type": "CNAME", "content": tunnelID + ".cfargotunnel.com", "proxied": true}}
		case "/accounts/" + account + "/cfd_tunnel/" + tunnelID:
			result = map[string]any{"id": tunnelID, "account_tag": account, "config_src": "cloudflare", "name": cloudflareTunnel}
		case "/accounts/" + account + "/cfd_tunnel/" + tunnelID + "/connections":
			result = []any{}
		case "/accounts/" + account + "/workers/workers":
			result = []map[string]any{{"id": "sample-worker-id", "name": cloudflareWorker,
				"subdomain": map[string]bool{"enabled": false, "previews_enabled": false}}}
		case "/accounts/" + account + "/workers/domains":
			result = []any{}
		case "/zones/" + zoneID + "/workers/routes":
			result = routes
		case "/accounts/" + account + "/access/apps":
			result = []map[string]any{application(authorApp, "", authorAudience),
				application(backendApp, identities["backend"].Path, backendAudience), application(uiApp, identities["frontend"].Path, uiAudience)}
		case "/accounts/" + account + "/access/apps/" + authorApp + "/policies":
			result = []any{policy(authorID, "allow", 1, []any{})}
		case "/accounts/" + account + "/access/apps/" + backendApp + "/policies", "/accounts/" + account + "/access/apps/" + uiApp + "/policies":
			result = []any{policy(authorID, "allow", 2, []any{}),
				policy(ciID, "non_identity", 1, []any{map[string]any{"service_token": map[string]string{"token_id": tokenID}}})}
		case "/accounts/" + account + "/cfd_tunnel/" + tunnelID + "/configurations":
			result = map[string]any{"account_id": account, "source": "cloudflare", "tunnel_id": tunnelID,
				"config": map[string]any{"ingress": []any{
					ingress(identities["backend"].TunnelPath, []string{backendAudience, authorAudience}),
					ingress(identities["frontend"].TunnelPath, []string{uiAudience, authorAudience}),
					ingress("", []string{authorAudience}), map[string]any{"service": "http_status:404"},
				}}}
		case "/accounts/" + account + "/access/service_tokens/" + tokenID:
			result = map[string]any{"id": tokenID, "client_id": "test.access", "enabled": true,
				"expires_at": time.Now().Add(time.Hour).Format(time.RFC3339)}
		default:
			t.Errorf("unknown Cloudflare edge path %s", p)
			http.NotFound(w, r)
			return
		}
		cloudflareTestEnvelope(t, w, result)
	}))
	defer server.Close()
	api := newCloudflareAPI([]byte("test-provisioning-token"), server.URL+"/")
	observed, err := api.observeEdge(context.Background(), host, zones.Zone{ID: zoneID, Account: zones.ZoneAccount{ID: account}}, githubTestTarget, contract)
	if err != nil {
		t.Fatal(err)
	}
	var target cloudflareTarget
	if err := json.Unmarshal([]byte(observed.Target), &target); err != nil {
		t.Fatal(err)
	}
	if observed.Connectors || target.AuthorPolicyID != authorID || target.CIPolicyID != ciID ||
		target.TunnelTeamName != "test-team" || target.PublicProtocolEnabled || target.TunnelID != tunnelID ||
		target.Repository != githubTestTarget.FullName() || target.RepositoryID != githubTestTarget.RepoID ||
		target.OwnerID != githubTestTarget.OwnerID || target.Origin != "https://"+host ||
		target.AccountID != account || target.ZoneID != zoneID || observed.serviceToken.ClientID != "test.access" {
		t.Fatalf("incorrect bound edge snapshot %#v", target)
	}
}

func cloudflareTestEnvelope(t *testing.T, writer http.ResponseWriter, result any) {
	t.Helper()
	writer.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(writer).Encode(map[string]any{"success": true, "errors": []any{}, "result": result,
		"result_info": map[string]int{"total_pages": 1}}); err != nil {
		t.Error(err)
	}
}

func TestCloudflareConnectorTokenIsBoundToTheSelectedTunnel(t *testing.T) {
	target := cloudflareTarget{AccountID: strings.Repeat("a", 32), TunnelID: "00000000-0000-0000-0000-000000000001"}
	encoded := func(account, tunnel string) []byte {
		return []byte(base64.StdEncoding.EncodeToString(fmt.Appendf(nil, `{"a":%q,"t":%q,"s":"dGVzdDEyMw=="}`, account, tunnel)))
	}
	valid := encoded(target.AccountID, target.TunnelID)
	if !tokenMatchesTunnel(valid, target) {
		t.Fatal("valid Tunnel credential rejected")
	}
	if tokenMatchesTunnel(encoded(strings.Repeat("b", 32), target.TunnelID), target) ||
		tokenMatchesTunnel(encoded(target.AccountID, "other-tunnel"), target) || tokenMatchesTunnel([]byte("invalid"), target) ||
		tokenMatchesTunnel(valid[:len(valid)-1], target) {
		t.Fatal("accepted an invalid or foreign Tunnel credential")
	}
}

type cloudflareTestOperator struct{ approves bool }

func (o cloudflareTestOperator) Confirm(string) (bool, error) { return o.approves, nil }
func (o cloudflareTestOperator) Ask(string) (string, error) {
	return "", errors.New("unexpected prompt")
}
func (o cloudflareTestOperator) Secret(string) ([]byte, error) {
	return nil, errors.New("unexpected secret prompt")
}
func (o cloudflareTestOperator) Notice(string) {}

func TestCloudflareMintRequiresScopedAuthorityAndDoesNotReplay(t *testing.T) {
	const (
		account     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		zone        = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		currentID   = "cccccccccccccccccccccccccccccccc"
		writeGroup  = "dddddddddddddddddddddddddddddddd"
		workerGroup = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
		mintedID    = "ffffffffffffffffffffffffffffffff"
		mintedToken = "new-limited-worker-token"
		name        = "codexia-worker-publication-aaaaaaaa"
	)
	for _, tc := range []struct {
		name                         string
		existing, approve, lose      bool
		missingAuthority, wrongScope bool
		oauth                        bool
		wantPost                     int32
	}{
		{name: "exact scope", approve: true, wantPost: 1},
		{name: "OAuth exact scope", approve: true, oauth: true, wantPost: 1},
		{name: "OAuth wrong scope", approve: true, oauth: true, wrongScope: true},
		{name: "OAuth already issued", approve: true, oauth: true, existing: true},
		{name: "OAuth refused", oauth: true},
		{name: "OAuth ambiguous outcome", approve: true, oauth: true, lose: true, wantPost: 1},
		{name: "already issued", existing: true, approve: true},
		{name: "refused", approve: false},
		{name: "write unavailable", approve: true, missingAuthority: true},
		{name: "wrong scope", approve: true, wrongScope: true},
		{name: "ambiguous outcome", approve: true, lose: true, wantPost: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var writes atomic.Int32
			route := "/accounts/" + account + "/tokens"
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					writes.Add(1)
					if r.URL.Path != route {
						t.Errorf("unexpected Cloudflare mutation %s", r.URL.Path)
					}
					var body struct {
						Name     string `json:"name"`
						Expiry   string `json:"expires_on"`
						Policies []struct {
							Effect      string `json:"effect"`
							Permissions []struct {
								ID string `json:"id"`
							} `json:"permission_groups"`
							Resources map[string]string `json:"resources"`
						} `json:"policies"`
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name != name || len(body.Policies) != 1 ||
						body.Policies[0].Effect != "allow" || len(body.Policies[0].Permissions) != 1 ||
						body.Policies[0].Permissions[0].ID != workerGroup || len(body.Policies[0].Resources) != 1 ||
						body.Policies[0].Resources[cloudflareAccountScope+"."+account] != "*" {
						t.Error("mint request did not carry exact Worker permission, resource and name")
					}
					if tc.lose {
						http.Error(w, "ambiguous creation after request containing "+mintedToken, http.StatusServiceUnavailable)
						return
					}
					cloudflareTestEnvelope(t, w, map[string]any{"id": mintedID, "value": mintedToken,
						"name": name, "expires_on": body.Expiry, "status": "active", "policies": []any{map[string]any{
							"id": currentID, "effect": "allow", "resources": body.Policies[0].Resources,
							"permission_groups": body.Policies[0].Permissions,
						}}})
					return
				}
				var result any
				switch r.URL.Path {
				case route + "/verify":
					if tc.oauth {
						t.Error("OAuth bearer must not be treated as an account API token")
						http.Error(w, "wrong credential class", http.StatusUnauthorized)
						return
					}
					result = map[string]any{"id": currentID, "status": "active"}
				case route + "/" + currentID:
					group := "Account API Tokens Write"
					if tc.missingAuthority {
						group = "Account API Tokens Read"
					}
					result = map[string]any{"id": currentID, "status": "active", "policies": []any{map[string]any{
						"id": writeGroup, "effect": "allow", "resources": map[string]string{cloudflareAccountScope + "." + account: "*"},
						"permission_groups": []any{map[string]any{"id": writeGroup, "name": group}},
					}}}
				case route + "/permission_groups":
					scope := cloudflareAccountScope
					if tc.wrongScope {
						scope = cloudflareZoneScope
					}
					result = []any{map[string]any{"id": workerGroup, "name": "Workers Editor", "is_selectable": true, "scopes": []string{scope}}}
				case route:
					result = []any{}
					if tc.existing {
						result = []any{map[string]any{"id": mintedID, "name": name, "status": "active"}}
					}
				default:
					t.Errorf("unexpected Cloudflare request %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
					return
				}
				cloudflareTestEnvelope(t, w, result)
			}))
			defer server.Close()
			edge := cloudflareObservation{target: cloudflareTarget{AccountID: account, ZoneID: zone},
				operator: cloudflareTestOperator{tc.approve}, api: newCloudflareAPI([]byte("scoped-admin-token"), server.URL+"/")}
			if tc.oauth {
				edge.closeAuth = func() {}
			}
			value, err := edge.mintCloudflareToken(context.Background(), edge.permissionPlan(cloudflareWorkerRole))
			if actual := writes.Load(); actual != tc.wantPost {
				t.Fatalf("sent %d mutation requests, expected %d. Error %v", actual, tc.wantPost, err)
			}
			if tc.name == "exact scope" || tc.name == "OAuth exact scope" {
				if err != nil || string(value) != mintedToken {
					t.Fatalf("scoped token was not returned. Error %v", err)
				}
				return
			}
			if err == nil || len(value) != 0 || strings.Contains(err.Error(), mintedToken) {
				t.Fatal("unsafe issuance outcome or credential disclosure")
			}
		})
	}
}

func TestCloudflareSuppliedTokenRequiresExactProviderPolicy(t *testing.T) {
	const (
		account     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		zone        = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		tokenID     = "cccccccccccccccccccccccccccccccc"
		otherID     = "dddddddddddddddddddddddddddddddd"
		workerWrite = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
		workerRead  = "ffffffffffffffffffffffffffffffff"
		legacyWrite = "55555555555555555555555555555555"
		tunnelRead  = "11111111111111111111111111111111"
		accessRead  = "22222222222222222222222222222222"
		dnsRead     = "33333333333333333333333333333333"
		routesRead  = "44444444444444444444444444444444"
	)
	for _, tc := range []struct {
		name, role, problem string
		userOwned, existing bool
	}{
		{name: "Worker publication", role: cloudflareWorkerRole},
		{name: "Existing legacy Worker token", role: cloudflareWorkerRole, existing: true},
		{name: "New legacy Worker token rejected", role: cloudflareWorkerRole, problem: "policy"},
		{name: "User-owned Worker publication", role: cloudflareWorkerRole, userOwned: true},
		{name: "Read-only Worker token", role: cloudflareWorkerRole, problem: "policy"},
		{name: "Overprivileged observer token", role: cloudflareReadRole, problem: "policy"},
		{name: "Wildcard Worker account", role: cloudflareWorkerRole, problem: "policy"},
		{name: "Permission advertised for wrong scope", role: cloudflareWorkerRole, problem: "permission catalog"},
		{name: "Wrong metadata identity", role: cloudflareWorkerRole, problem: "metadata"},
		{name: "Unauthorized metadata", role: cloudflareWorkerRole, problem: "metadata"},
		{name: "Expired token", role: cloudflareWorkerRole, problem: "expiry"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const suppliedValue, managementValue = "hidden-candidate-value", "hidden-management-value"
			accountTokens := "/accounts/" + account + "/tokens"
			origin := accountTokens
			if tc.userOwned {
				origin = "/user/tokens"
			}
			expiry := time.Now().UTC().Add(time.Hour).Format(time.RFC3339)
			if tc.name == "Expired token" {
				expiry = time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
			}
			policy := func(resource string, ids ...string) map[string]any {
				groups := make([]map[string]string, len(ids))
				for i, id := range ids {
					groups[i] = map[string]string{"id": id}
				}
				return map[string]any{"id": otherID, "effect": "allow", "resources": map[string]string{resource: "*"}, "permission_groups": groups}
			}
			group := func(name, id, scope string) map[string]any {
				return map[string]any{"name": name, "id": id, "scopes": []string{scope}, "is_selectable": false}
			}
			var verifiedResources = []any{policy(cloudflareAccountScope+"."+account, workerWrite)}
			switch tc.name {
			case "Existing legacy Worker token", "New legacy Worker token rejected":
				verifiedResources = []any{policy(cloudflareAccountScope+"."+account, legacyWrite)}
			case "Read-only Worker token":
				verifiedResources = []any{policy(cloudflareAccountScope+"."+account, workerRead)}
			case "Overprivileged observer token":
				verifiedResources = []any{policy(cloudflareAccountScope+"."+account, workerRead, tunnelRead, accessRead, workerWrite),
					policy(cloudflareZoneScope+"."+zone, dnsRead, routesRead)}
			case "Wildcard Worker account":
				verifiedResources = []any{policy(cloudflareAccountScope+".*", workerWrite)}
			}
			var workingReads atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					t.Error("credential verification attempted a mutation")
				}
				var result any
				switch r.URL.Path {
				case origin + "/verify":
					if r.Header.Get("Authorization") != "Bearer "+suppliedValue {
						t.Error("Verify did not use the supplied credential")
					}
					result = map[string]any{"id": tokenID, "status": "active", "expires_on": expiry}
				case accountTokens + "/verify":
					http.Error(w, "account-token authentication denied", http.StatusUnauthorized)
					return
				case origin + "/" + tokenID:
					if r.Header.Get("Authorization") != "Bearer "+managementValue {
						t.Error("metadata read did not use the separate management credential")
					}
					if tc.name == "Unauthorized metadata" {
						http.Error(w, "credential metadata denied: "+managementValue, http.StatusForbidden)
						return
					}
					id := tokenID
					if tc.name == "Wrong metadata identity" {
						id = otherID
					}
					result = map[string]any{"id": id, "status": "active", "expires_on": expiry, "policies": verifiedResources}
				case origin + "/permission_groups":
					if r.Header.Get("Authorization") != "Bearer "+managementValue {
						t.Error("permission catalog did not use the separate management credential")
					}
					workerScope := cloudflareAccountScope
					if tc.name == "Permission advertised for wrong scope" {
						workerScope = cloudflareZoneScope
					}
					result = []any{group("Workers Editor", workerWrite, workerScope), group("Workers Content Read-Only", workerRead, cloudflareAccountScope),
						group("Workers Scripts Write", legacyWrite, cloudflareAccountScope),
						group("Cloudflare Tunnel Read", tunnelRead, cloudflareAccountScope), group("Access: Apps and Policies Read", accessRead, cloudflareAccountScope),
						group("DNS Read", dnsRead, cloudflareZoneScope), group("Workers Routes Read", routesRead, cloudflareZoneScope)}
				case "/accounts/" + account + "/workers/workers":
					workingReads.Add(1)
					result = []any{}
				default:
					http.NotFound(w, r)
					return
				}
				cloudflareTestEnvelope(t, w, result)
			}))
			defer server.Close()
			edge := cloudflareObservation{target: cloudflareTarget{AccountID: account, ZoneID: zone},
				api: newCloudflareAPI([]byte(managementValue), server.URL+"/")}
			err := edge.verifyCloudflareCredential(context.Background(), []byte(suppliedValue), tc.role, tc.existing)
			if tc.problem == "" {
				if err != nil || workingReads.Load() != 1 {
					t.Fatalf("expected verified scoped token with a successful read. Error %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.problem) || strings.Contains(err.Error(), suppliedValue) || strings.Contains(err.Error(), managementValue) {
				t.Fatalf("expected sanitized %s rejection, got %v", tc.problem, err)
			}
			if calls := workingReads.Load(); calls != 0 {
				t.Fatalf("sent %d Worker reads before token policy was verified", calls)
			}
		})
	}
}

func TestProtectedCloudflareTargetRejectsAnotherRepositoryWithSameOrigin(t *testing.T) {
	fork := githubTarget{Owner: "Fork-Org", OwnerID: 801, RepoID: 192, InstallationID: 312}
	const origin = "https://codexia.fork.example"
	target := cloudflareTarget{Repository: fork.FullName(), RepositoryID: fork.RepoID, OwnerID: fork.OwnerID, Origin: origin}
	check := func(value cloudflareTarget, repo githubTarget, requestedOrigin string) error {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return validateProtectedCloudflareTarget(githubSnapshot{Production: githubEnvironment{
			Variables: map[string]string{edgeTarget: string(data)},
		}}, repo, requestedOrigin)
	}
	if err := check(target, fork, origin); err != nil {
		t.Fatal(err)
	}
	if err := check(target, githubTestTarget, origin); err == nil {
		t.Fatal("a different repository accepted a Cloudflare target for the same origin")
	}
	if err := check(target, fork, "https://unrelated.fork.example"); err == nil {
		t.Fatal("the selected repository accepted a Cloudflare target for another origin")
	}
	target.RepositoryID = 0
	if err := check(target, fork, origin); err == nil {
		t.Fatal("an unbound Cloudflare target was accepted")
	}
}
