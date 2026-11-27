package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	ts "tailscale.com/client/tailscale/v2"
)

func TestTailnetAuthenticatesTheObservedNodeAndScopedTrust(t *testing.T) {
	const address = "100.64.32.5"
	const keyID = "federated-test-key"
	const nodeID = "nLocalVM"
	fixtureNodeIdentity := "nodekey:" + strings.Repeat("a", 64)
	const network = "tnExpectedStableID"

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v2/tailnet/" + network + "/devices":
			fmt.Fprintf(w, `{"devices":[{"addresses":[%q],"nodeId":%q,"authorized":true,"connectedToControl":true,"nodeKey":%q,"name":"codexia.example.ts.net","os":"linux"}]}`, address, nodeID, fixtureNodeIdentity)
		case "/api/v2/tailnet/" + network + "/keys":
			fmt.Fprintf(w, `{"keys":[{"id":%q}]}`, keyID)
		case "/api/v2/tailnet/" + network + "/keys/" + keyID:
			_ = json.NewEncoder(w).Encode(validWIFKey(keyID))
		case "/api/v2/tailnet/" + network + "/acl":
			fmt.Fprint(w, `{"grants":[{"src":["tag:ci"],"dst":["100.64.32.5"],"ip":["tcp:22"]}]}`)
		case "/api/v2/tailnet/" + network + "/acl/validate":
			var tests []ts.ACLTest
			if err := json.NewDecoder(r.Body).Decode(&tests); err != nil || len(tests) != 1 ||
				tests[0].Source != "tag:ci" || len(tests[0].Accept) != 1 || tests[0].Accept[0] != address+":22" {
				t.Errorf("unexpected ACL test: %+v, %v", tests, err)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	base, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client := &ts.Client{BaseURL: base, Tailnet: network}
	local := localTailnet{
		BackendState:   "Running",
		CurrentTailnet: &localTailnetIdentity{Name: "example", StableID: network},
		Self:           &localTailnetNode{ID: nodeID, PublicKey: fixtureNodeIdentity, DNSName: "codexia.example.ts.net.", TailscaleIPs: []string{address}},
	}
	got, err := inspectTailnet(context.Background(), client, local)
	if err != nil {
		t.Fatal(err)
	}
	if got.Address != address || got.ClientID != keyID {
		t.Fatalf("wrong target or identity: %+v", got)
	}
	if got := calls.Load(); got != 5 {
		t.Fatalf("did not read device, WIF and ACL evidence: %d calls", got)
	}
	local.Self.PublicKey = "nodekey:wrong"
	if _, err := inspectTailnet(context.Background(), client, local); err == nil {
		t.Fatal("accepted a different node key")
	}
}

func TestTailscaleWIFRejectsBroadOrIncompleteClaims(t *testing.T) {
	for _, change := range []func(*ts.Key){
		func(k *ts.Key) { k.Subject = "repo:yohn-jp/*" },
		func(k *ts.Key) { k.Audience = "https://another-audience.example" },
		func(k *ts.Key) { k.CustomClaimRules["workflow_ref"] = "*" },
		func(k *ts.Key) { k.CustomClaimRules["ref"] = "refs/heads/*" },
		func(k *ts.Key) { k.Tags = append(k.Tags, "tag:prod") },
		func(k *ts.Key) { k.Scopes = append(k.Scopes, "policy_file") },
		func(k *ts.Key) { k.Invalid = true },
	} {
		key := validWIFKey("test")
		change(&key)
		if matchesWIF(key) {
			t.Fatal("accepted broader or unusable WIF trust")
		}
	}
	if !matchesWIF(validWIFKey("test")) {
		t.Fatal("rejected narrowly bound repository, workflow main and environment claims")
	}
}

func validWIFKey(id string) ts.Key {
	return ts.Key{
		ID: id, KeyType: "federated", Audience: "api.tailscale.com/" + id,
		Issuer:  wifIssuer,
		Subject: wifSubject,
		Scopes:  []string{"auth_keys"}, Tags: []string{"tag:ci"},
		CustomClaimRules: map[string]string{
			"ref":          "refs/heads/main",
			"repository":   "yohn-jp/codexia",
			"workflow_ref": "yohn-jp/codexia/.github/workflows/*@refs/heads/main",
		},
	}
}

func TestTailscaleWIFReportsExactReconciliationActions(t *testing.T) {
	key := validWIFKey("legacy-id")
	key.Subject = "repo:yohn-jp@299811358/codexia@1450072993:environment:codexia-production"
	key.Scopes = []string{"all"}
	key.CustomClaimRules = nil
	problems := strings.Join(wifProblems(key), "\n")
	for _, expected := range []string{"subject must be", "immutable owner/repository", "scopes must contain only auth_keys", "custom claim ref", "custom claim workflow_ref"} {
		if !strings.Contains(problems, expected) {
			t.Errorf("missing actionable WIF mismatch %q in %q", expected, problems)
		}
	}
	if matchesWIF(key) {
		t.Fatal("legacy broad OIDC credential bypassed scoped trust")
	}
}

type wifApprovalOperator struct {
	approve bool
	notices []string
}

func (o *wifApprovalOperator) Confirm(string) (bool, error)  { return o.approve, nil }
func (o *wifApprovalOperator) Ask(string) (string, error)    { return "", nil }
func (o *wifApprovalOperator) Secret(string) ([]byte, error) { return nil, nil }
func (o *wifApprovalOperator) Notice(message string)         { o.notices = append(o.notices, message) }

func TestTailnetCreatesOnlySeparatelyApprovedScopedOIDCTrust(t *testing.T) {
	const network = "tnOwner"
	const address = "100.64.20.10"
	var created atomic.Int32
	legacy := validWIFKey("old-wide-key")
	legacy.Subject = "repo:yohn-jp@299811358/codexia@1450072993:environment:codexia-production"
	legacy.Scopes = []string{"all"}
	legacy.CustomClaimRules = nil
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/v2/tailnet/"+network+"/devices":
			fmt.Fprintf(w, `{"devices":[{"addresses":[%q],"nodeId":"nVM","authorized":true,"connectedToControl":true,"nodeKey":"nodekey:%s","name":"codexia.example.ts.net","os":"linux"}]}`, address, strings.Repeat("a", 64))
		case r.URL.Path == "/api/v2/tailnet/"+network+"/keys" && r.Method == http.MethodGet:
			fmt.Fprint(w, `{"keys":[{"id":"old-wide-key"}]}`)
		case r.URL.Path == "/api/v2/tailnet/"+network+"/keys/old-wide-key":
			_ = json.NewEncoder(w).Encode(legacy)
		case r.URL.Path == "/api/v2/tailnet/"+network+"/keys" && r.Method == http.MethodPost:
			var request struct {
				Subject          string            `json:"subject"`
				Issuer           string            `json:"issuer"`
				Scopes           []string          `json:"scopes"`
				Tags             []string          `json:"tags"`
				CustomClaimRules map[string]string `json:"customClaimRules"`
			}
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil ||
				request.Subject != wifSubject || request.Issuer != wifIssuer ||
				!matchesWIF(validWIFKey("new-scoped-key")) || !slices.Equal(request.Scopes, []string{"auth_keys"}) ||
				!slices.Equal(request.Tags, []string{"tag:ci"}) ||
				request.CustomClaimRules["ref"] != "refs/heads/main" ||
				request.CustomClaimRules["workflow_ref"] != "yohn-jp/codexia/.github/workflows/*@refs/heads/main" {
				t.Errorf("unexpected scoped WIF creation request: %+v (%v)", request, err)
			}
			created.Add(1)
			_ = json.NewEncoder(w).Encode(validWIFKey("new-scoped-key"))
		case r.URL.Path == "/api/v2/tailnet/"+network+"/keys/new-scoped-key":
			_ = json.NewEncoder(w).Encode(validWIFKey("new-scoped-key"))
		case r.URL.Path == "/api/v2/tailnet/"+network+"/acl":
			fmt.Fprint(w, `{"grants":[{"src":["tag:ci"],"dst":["100.64.20.10"],"ip":["tcp:22"]]}`)
		case r.URL.Path == "/api/v2/tailnet/"+network+"/acl/validate":
			fmt.Fprint(w, `{}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	base, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client := &ts.Client{BaseURL: base, Tailnet: network}
	local := localTailnet{BackendState: "Running",
		CurrentTailnet: &localTailnetIdentity{Name: "example", StableID: network},
		Self: &localTailnetNode{ID: "nVM", PublicKey: "nodekey:" + strings.Repeat("a", 64),
			DNSName: "codexia.example.ts.net.", TailscaleIPs: []string{address}}}
	if _, err := inspectTailnet(context.Background(), client, local); err == nil {
		t.Fatal("read-only inspection accepted broad legacy WIF")
	}
	declined := &wifApprovalOperator{}
	if _, err := inspectTailnetWithApproval(context.Background(), client, local, declined, true); err == nil {
		t.Fatal("declined WIF creation was not stopped")
	}
	if created.Load() != 0 {
		t.Fatal("WIF was created without separate approval")
	}
	approved := &wifApprovalOperator{approve: true}
	got, err := inspectTailnetWithApproval(context.Background(), client, local, approved, true)
	if err != nil {
		t.Fatal(err)
	}
	if got.ClientID != "new-scoped-key" || created.Load() != 1 {
		t.Fatalf("unexpected WIF creation outcome: %+v, count %d", got, created.Load())
	}
	if !strings.Contains(strings.Join(approved.notices, "\n"), "scopes must contain only auth_keys") {
		t.Fatal("existing broad WIF mismatch was not explained before approval")
	}
}

func TestTailscaleBrowserURLIsBoundToOfficialLogin(t *testing.T) {
	for _, invalid := range []string{
		"http://login.tailscale.com/a/secret",
		"https://login.tailscale.com.evil.example/a/secret",
		"https://login.tailscale.com@evil.example/a/secret",
		"https://login.tailscale.com/a/secret?credential=secret",
		"https://login.tailscale.com:444/a/secret",
		"https://login.tailscale.com/unrelated",
		"https://login.tailscale.com/a/../secret",
	} {
		if validTailscaleBrowserURL(invalid) {
			t.Errorf("accepted an unverified login URL: %s", invalid)
		}
	}
	if !validTailscaleBrowserURL("https://login.tailscale.com/a/" + strings.Repeat("A", 14)) {
		t.Fatal("rejected an official auth URL")
	}
}

func TestFreshTailnetProfileNeverReauthenticatesExistingProfile(t *testing.T) {
	if !freshTailnetProfile(localTailnet{BackendState: "NeedsLogin"}) {
		t.Fatal("a fresh login was blocked")
	}
	for _, state := range []localTailnet{
		{BackendState: "Running"},
		{BackendState: "Stopped"},
		{BackendState: "Starting"},
		{BackendState: "NeedsMachineAuth"},
		{BackendState: "NeedsLogin", HaveNodeKey: true},
		{BackendState: "NeedsLogin", CurrentTailnet: &localTailnetIdentity{Name: "existing"}},
	} {
		if freshTailnetProfile(state) {
			t.Errorf("would overwrite an existing Tailscale profile: %+v", state)
		}
	}
}

func TestTailscaleErrorsDoNotExposeProviderResponses(t *testing.T) {
	const token = "mock-private-credential"
	err := tailnetAPIError("read the Tailnet policy", ts.APIError{
		Message: token,
		Status:  http.StatusForbidden,
	})
	if strings.Contains(err.Error(), token) || !strings.Contains(err.Error(), "403") {
		t.Fatalf("provider response was not sanitized: %v", err)
	}
}

func TestEveryProtectedTailnetWorkflowUsesTheApprovedCredentialAudience(t *testing.T) {
	t.Parallel()
	for _, name := range []string{
		"production-bootstrap.yml", "production-preflight.yml",
		"frontend-release.yml", "backend-deployment-handoff.yml",
		"tailscale-connectivity.yml",
	} {
		t.Run(name, func(t *testing.T) {
			contents, err := os.ReadFile(filepath.Join("..", "..", ".github", "workflows", name))
			if err != nil {
		t.Fatal(err)
	}
			text := string(contents)
			count := strings.Count(text, "uses: tailscale/github-action@")
			if count == 0 || strings.Count(text,
				"audience: ${{ format('api.tailscale.com/{0}', vars.TS_OAUTH_CLIENT_ID || secrets.TS_OAUTH_CLIENT_ID) }}") != count {
				t.Fatalf("%s must bind each OIDC audience to its protected TS_OAUTH_CLIENT_ID, actions=%d", name, count)
			}
		})
	}
}
