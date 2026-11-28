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
	"testing"
)

func TestCloudflareDenialAndRedirectKeepSecretsOutOfDiagnostics(t *testing.T) {
	const apiToken = "private-provisioning-token"
	t.Setenv("CLOUDFLARE_API_TOKEN", "unexpected-ambient-token")
	t.Setenv("CLOUDFLARE_CUSTOM_HEADERS", "X-Ambient-Auth: unexpected-ambient-header")
	spec, _ := managedEdgeFixture(t)
	for _, tc := range []struct {
		name string
		code int
		body string
	}{
		{"unauthorized", http.StatusForbidden, `{"success":false,"errors":[{"message":"` + apiToken + `"}],"result":null}`},
		{"false envelope", http.StatusOK, `{"success":false,"errors":[{"message":"` + apiToken + `"}],"result":[]}`},
		{"missing result", http.StatusOK, `{"success":true,"errors":[],"result":null}`},
		{"redirect", http.StatusFound, ""},
		{"redirect with success envelope", http.StatusTemporaryRedirect, `{"success":true,"errors":[],"result":[{"id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","name":"example.test","status":"active","account":{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}],"result_info":{"total_pages":1}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Error("Cloudflare SDK must not follow a redirected authenticated request")
			}))
			defer other.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer "+apiToken || r.Header.Get("X-Ambient-Auth") != "" {
					t.Error("SDK request did not use the explicitly bound credential")
				}
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Location", other.URL)
				w.WriteHeader(tc.code)
				_, _ = fmt.Fprint(w, tc.body)
			}))
			defer server.Close()
			api := newCloudflareAPI([]byte(apiToken), server.URL+"/")
			err := observeManagedWorkerRouting(context.Background(), api, spec, &managedEdgeInventory{})
			if err == nil || strings.Contains(err.Error(), apiToken) || strings.Contains(err.Error(), other.URL) {
				t.Fatalf("unexpected provider error %v", err)
			}
		})
	}
}

func cloudflareManifest(t *testing.T, name string) []byte {
	t.Helper()
	root, err := os.OpenRoot(filepath.Join("..", "..", "deploy", "cloudflare"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = root.Close() })
	content, err := root.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return content
}

func cloudflareTestEnvelope(t *testing.T, writer http.ResponseWriter, result any) {
	t.Helper()
	writer.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(writer).Encode(map[string]any{
		"success": true, "errors": []any{}, "result": result,
		"result_info": map[string]int{"total_pages": 1},
	}); err != nil {
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

func TestProtectedCloudflareTargetRejectsAnotherRepositoryWithSameOrigin(t *testing.T) {
	fork := githubTarget{Owner: "Fork-Org", OwnerID: 801, RepoID: 192, InstallationID: 312}
	const origin = "https://codexia.fork.example"
	const managementHost = "codexia-ssh.fork.example"
	const sshPolicyID = "00000000-0000-0000-0000-000000000001"
	target := cloudflareTarget{
		Repository: fork.FullName(), RepositoryID: fork.RepoID, OwnerID: fork.OwnerID, Origin: origin,
		SSHHostname: managementHost, SSHPolicyID: sshPolicyID,
	}
	check := func(value cloudflareTarget, repo githubTarget, requestedOrigin, requestedManagementHost string) error {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return validateProtectedCloudflareTarget(githubSnapshot{Production: githubEnvironment{
			Variables: map[string]string{edgeTarget: string(data)},
		}}, repo, productionContract{PublicOrigin: requestedOrigin, ManagementHostname: requestedManagementHost})
	}
	if err := check(target, fork, origin, managementHost); err != nil {
		t.Fatal(err)
	}
	if err := check(target, githubTestTarget, origin, managementHost); err == nil {
		t.Fatal("a different repository accepted a Cloudflare target for the same origin")
	}
	if err := check(target, fork, "https://unrelated.fork.example", managementHost); err == nil {
		t.Fatal("the selected repository accepted a Cloudflare target for another origin")
	}
	if err := check(target, fork, origin, "unrelated-ssh.fork.example"); err == nil {
		t.Fatal("the selected repository accepted a Cloudflare target for another management hostname")
	}
	target.RepositoryID = 0
	if err := check(target, fork, origin, managementHost); err == nil {
		t.Fatal("an unbound Cloudflare target was accepted")
	}
}
