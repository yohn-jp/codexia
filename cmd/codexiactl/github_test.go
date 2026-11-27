package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/go-github/v93/github"
	"golang.org/x/crypto/nacl/box"
)

const githubTestSHA = "0123456789012345678901234567890123456789"

func newTestGitHub(t *testing.T, handler http.HandlerFunc) *githubControl {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	base := server.URL + "/"
	client, err := github.NewClient(github.WithHTTPClient(server.Client()), github.WithURLs(&base, nil))
	if err != nil {
		t.Fatal(err)
	}
	return &githubControl{client: client}
}

func githubTestJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Error(err)
	}
}

func githubTestProtection(t *testing.T, w http.ResponseWriter, r *http.Request) bool {
	t.Helper()
	switch {
	case strings.HasSuffix(r.URL.Path, "/deployment-branch-policies"):
		githubTestJSON(t, w, map[string]any{"total_count": 1, "branch_policies": []any{map[string]any{"name": "main", "type": "branch"}}})
	case strings.Contains(r.URL.Path, "/environments/") && strings.HasPrefix(r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:], "codexia-"):
		githubTestJSON(t, w, map[string]any{
			"id": 92, "name": r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:],
			"protection_rules":         []any{map[string]any{"type": "required_reviewers", "prevent_self_review": true, "reviewers": []any{map[string]any{"type": "User", "reviewer": map[string]any{"id": 123}}}}},
			"deployment_branch_policy": map[string]any{"protected_branches": false, "custom_branch_policies": true},
		})
	case strings.HasSuffix(r.URL.Path, "/branches/main"):
		githubTestJSON(t, w, map[string]any{"name": "main", "protected": true, "commit": map[string]any{"sha": githubTestSHA}})
	case r.URL.Path == "/repos/yohn-jp/codexia":
		githubTestJSON(t, w, map[string]any{
			"id": 1450072993, "full_name": "yohn-jp/codexia", "default_branch": "main", "permissions": map[string]any{"push": true},
		})
	default:
		return false
	}
	return true
}

func TestGitHubDispatchBindsMainAndNeverRetriesAmbiguousWrite(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, sha               string
		status                  int
		id                      int64
		wantPost, wantAmbiguous bool
	}{
		{"run-id", githubTestSHA, 200, 12345, true, false},
		{"legacy-response", githubTestSHA, 204, 0, true, true},
		{"upstream-error", githubTestSHA, 503, 0, true, true},
		{"forbidden", githubTestSHA, 403, 0, true, false},
		{"stale-main", strings.Repeat("a", 40), 200, 0, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			posts := 0
			g := newTestGitHub(t, func(w http.ResponseWriter, r *http.Request) {
				if githubTestProtection(t, w, r) {
					return
				}
				if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/production-bootstrap.yml/dispatches") {
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
					return
				}
				posts++
				var body github.CreateWorkflowDispatchEventRequest
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body.Ref != "main" || body.ReturnRunDetails == nil || !*body.ReturnRunDetails || body.Inputs["mode"] != "preflight" {
					t.Errorf("unexpected dispatch body %#v", body)
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				if tc.id != 0 {
					_ = json.NewEncoder(w).Encode(map[string]any{"workflow_run_id": tc.id})
				}
			})
			id, err := g.Dispatch(context.Background(), "production-bootstrap.yml", tc.sha, map[string]string{"mode": "preflight"})
			if id != tc.id || errors.Is(err, errGitHubDispatchUnknown) != tc.wantAmbiguous || (err == nil) != (tc.id != 0) {
				t.Fatalf("unexpected dispatch outcome id=%d error=%v", id, err)
			}
			if (posts == 1) != tc.wantPost || posts > 1 {
				t.Errorf("unexpected dispatch count %d", posts)
			}
		})
	}
}

func TestGitHubRunAndJobsRequireOriginalAttempt(t *testing.T) {
	t.Parallel()
	const id = 12345
	g := newTestGitHub(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/runs/12345"):
			githubTestJSON(t, w, map[string]any{
				"id": id, "head_branch": "main", "head_sha": githubTestSHA, "path": ".github/workflows/production-bootstrap.yml",
				"event": "workflow_dispatch", "run_attempt": 1, "status": "completed", "conclusion": "success",
				"repository": map[string]any{"id": 1450072993}, "head_repository": map[string]any{"id": 1450072993},
			})
		case strings.HasSuffix(r.URL.Path, "/runs/12345/attempts/1/jobs"):
			githubTestJSON(t, w, map[string]any{"total_count": 1, "jobs": []any{map[string]any{
				"head_sha": githubTestSHA, "run_id": id, "run_attempt": 1, "name": "Protected production controller (preflight)", "status": "completed", "conclusion": "skipped",
			}}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	ctx := context.Background()
	run, err := g.Run(ctx, "production-bootstrap.yml", githubTestSHA, id)
	if err != nil || run.Attempt != 1 || run.Conclusion != "success" {
		t.Fatalf("run=%+v err=%v", run, err)
	}
	if _, err := g.Run(ctx, "frontend-release.yml", githubTestSHA, id); err == nil {
		t.Fatal("accepted a run from a different workflow")
	}
	jobs, err := g.Jobs(ctx, id, 1)
	if err != nil || jobs["Protected production controller (preflight)"] != "skipped" {
		t.Fatalf("jobs=%+v err=%v", jobs, err)
	}
}

func TestGitHubRecentPreservesDispatchIdentityWithoutExposingRunTitleInJSON(t *testing.T) {
	t.Parallel()
	const title = "Protected production bootstrap · bootstrap · preflight 3920"
	g := newTestGitHub(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("event") != "workflow_dispatch" || r.URL.Query().Get("branch") != "main" {
			t.Errorf("read runs without the protected dispatch selectors")
		}
		runs := []any{}
		if strings.HasSuffix(r.URL.Path, "/production-bootstrap.yml/runs") {
			runs = append(runs, map[string]any{"id": 3921, "head_branch": "main", "head_sha": githubTestSHA,
				"path": ".github/workflows/production-bootstrap.yml", "event": "workflow_dispatch",
				"run_attempt": 1, "status": "in_progress", "display_title": title,
				"repository": map[string]any{"id": 1450072993}, "head_repository": map[string]any{"id": 1450072993},
			})
		}
		githubTestJSON(t, w, map[string]any{"total_count": len(runs), "workflow_runs": runs})
	})
	runs, err := g.Recent(context.Background())
	if err != nil || len(runs) != 1 || runs[0].DisplayTitle != title || runs[0].File != "production-bootstrap.yml" {
		t.Fatalf("unexpected correlation evidence: %d runs, err=%v", len(runs), err)
	}
	data, err := json.Marshal(runs)
	if err != nil || bytes.Contains(data, []byte(title)) {
		t.Fatal("display titles may contain untrusted operator input")
	}
}

func TestGitHubSecretsUseSealedBoxAndPreserveExisting(t *testing.T) {
	t.Parallel()
	pub, key, err := box.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, existing := range []bool{false, true} {
		t.Run(fmt.Sprintf("existing=%v", existing), func(t *testing.T) {
			present := existing
			writes := 0
			const name = "CODEXIA_TUNNEL_TOKEN"
			const secret = "fixture credential must never be echoed"
			g := newTestGitHub(t, func(w http.ResponseWriter, r *http.Request) {
				if githubTestProtection(t, w, r) {
					return
				}
				switch {
				case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/secrets/public-key"):
					githubTestJSON(t, w, map[string]any{"key_id": "123", "key": base64.StdEncoding.EncodeToString(pub[:])})
				case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/secrets/"+name):
					if !present {
						w.WriteHeader(http.StatusNotFound)
						return
					}
					githubTestJSON(t, w, map[string]any{"name": name, "updated_at": time.Now().UTC().Format(time.RFC3339)})
				case r.Method == http.MethodPut && strings.HasSuffix(r.URL.Path, "/secrets/"+name):
					writes++
					var body github.SecretRequest
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					payload, err := base64.StdEncoding.DecodeString(body.EncryptedValue)
					if err != nil {
						t.Error(err)
					}
					plaintext, ok := box.OpenAnonymous(nil, payload, pub, key)
					if !ok || !bytes.Equal(plaintext, []byte(secret)) || body.KeyID != "123" {
						t.Error("secret could not be opened with the environment key")
					}
					present = true
					w.WriteHeader(http.StatusCreated)
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			})
			err := g.PutSecret(context.Background(), "codexia-bootstrap", name, []byte(secret))
			if (err != nil) != existing || (writes == 1) == existing {
				t.Fatalf("unexpected writes=%d error=%v", writes, err)
			}
		})
	}
}

func TestGitHubPinnedArtifactZIP(t *testing.T) {
	t.Parallel()
	const member = "codexia-lifecycle-preflight.json"
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	writer, err := archive.Create(member)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte("{}")); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	data := output.Bytes()
	digest := fmt.Sprintf("sha256:%x", sha256.Sum256(data))
	result, err := githubArtifactMember(data, digest, member)
	if err != nil || string(result) != "{}" {
		t.Fatalf("artifact result=%q err=%v", result, err)
	}
	for _, tt := range []struct{ digest, member string }{
		{"sha256:" + strings.Repeat("1", 64), member}, {digest, "../" + member}, {digest, "missing"},
	} {
		if _, err := githubArtifactMember(data, tt.digest, tt.member); err == nil {
			t.Errorf("accepted mismatching digest or member")
		}
	}
}

func TestGitHubArtifactDownloadDoesNotSendAuthorization(t *testing.T) {
	t.Parallel()
	const member = "codexia-lifecycle-preflight.json"
	const signedPath = "/run-artifacts/fixture.zip?signature=fixture"
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	entry, err := writer.Create(member)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(entry, "{}"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	g := newTestGitHub(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/runs/41"):
			githubTestJSON(t, w, map[string]any{
				"id": 41, "head_branch": "main", "head_sha": githubTestSHA, "path": ".github/workflows/production-preflight.yml",
				"event": "workflow_dispatch", "run_attempt": 1, "status": "completed", "conclusion": "success",
				"repository": map[string]any{"id": 1450072993}, "head_repository": map[string]any{"id": 1450072993},
			})
		case strings.HasSuffix(r.URL.Path, "/runs/41/artifacts"):
			githubTestJSON(t, w, map[string]any{"total_count": 1, "artifacts": []any{map[string]any{
				"name": "lifecycle-preflight-41-1", "id": 42, "size_in_bytes": archive.Len(), "expired": false,
				"digest":       fmt.Sprintf("sha256:%x", sha256.Sum256(archive.Bytes())),
				"workflow_run": map[string]any{"id": 41, "repository_id": 1450072993, "head_repository_id": 1450072993, "head_branch": "main", "head_sha": githubTestSHA},
			}}})
		case strings.HasSuffix(r.URL.Path, "/artifacts/42/zip"):
			w.Header().Set("Location", "https://productionresultssa17.blob.core.windows.net"+signedPath)
			w.WriteHeader(http.StatusFound)
		default:
			t.Errorf("unexpected API request path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	g.download = &http.Client{Transport: githubTestRoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Scheme != "https" || r.URL.Host != "productionresultssa17.blob.core.windows.net" ||
			r.URL.RequestURI() != signedPath || r.Header.Get("Authorization") != "" {
			t.Error("artifact storage received an unsafe request")
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(archive.Bytes())), Request: r}, nil
	})}
	receipt, err := g.Artifact(context.Background(), 41, "lifecycle-preflight-41-1", member)
	if err != nil || string(receipt) != "{}" {
		t.Fatalf("pinned receipt retrieval failed: %v", err)
	}
}

func TestGitHubEnvironmentNeedsIndependentApprovalBeforeWrites(t *testing.T) {
	t.Parallel()
	g := newTestGitHub(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("attempted mutation at %s", r.URL.Path)
		}
		if strings.HasSuffix(r.URL.Path, "/environments/codexia-bootstrap") {
			githubTestJSON(t, w, map[string]any{
				"id": 92, "name": "codexia-bootstrap",
				"protection_rules":         []any{map[string]any{"type": "required_reviewers", "prevent_self_review": false, "reviewers": []any{map[string]any{"type": "User", "reviewer": map[string]any{"id": 123}}}}},
				"deployment_branch_policy": map[string]any{"protected_branches": false, "custom_branch_policies": true},
			})
			return
		}
		if !githubTestProtection(t, w, r) {
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	err := g.PutVariable(context.Background(), githubBootstrapEnvironment, "CODEXIA_BOOTSTRAP_ENABLED", "true", nil)
	if !errors.Is(err, errGitHubProtection) {
		t.Fatalf("invalid protection must block a write, got %v", err)
	}
}

func TestGitHubAdditiveBranchRestrictionRequiresExistingReviewers(t *testing.T) {
	t.Parallel()
	for _, reviewers := range []bool{true, false} {
		t.Run(fmt.Sprintf("reviewers=%v", reviewers), func(t *testing.T) {
			created := 0
			g := newTestGitHub(t, func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/repos/yohn-jp/codexia":
					githubTestJSON(t, w, map[string]any{"id": 1450072993, "full_name": "yohn-jp/codexia", "default_branch": "main", "permissions": map[string]any{"admin": true}})
				case strings.HasSuffix(r.URL.Path, "/environments/codexia-bootstrap"):
					rules := []any{}
					if reviewers {
						rules = append(rules, map[string]any{"type": "required_reviewers", "prevent_self_review": true, "reviewers": []any{map[string]any{"type": "User", "reviewer": map[string]any{"id": 123}}}})
					}
					githubTestJSON(t, w, map[string]any{"id": 92, "name": "codexia-bootstrap", "protection_rules": rules,
						"deployment_branch_policy": map[string]any{"protected_branches": false, "custom_branch_policies": true}})
				case strings.Contains(r.URL.Path, "/environments/codexia-bootstrap/deployment-branch-policies"):
					branch := map[string]any{"id": 93, "name": "main", "type": "branch"}
					if r.Method == http.MethodPost {
						var body github.CreateDeploymentBranchPolicyRequest
						err := json.NewDecoder(r.Body).Decode(&body)
						if !reviewers || err != nil || body.Name != "main" || body.Type == nil || *body.Type != "branch" {
							t.Error("unexpected branch policy mutation")
							w.WriteHeader(http.StatusUnprocessableEntity)
							return
						}
						created++
						githubTestJSON(t, w, branch)
						return
					}
					rules := []any{}
					if created > 0 {
						rules = append(rules, branch)
					}
					githubTestJSON(t, w, map[string]any{"total_count": len(rules), "branch_policies": rules})
				default:
					if !githubTestProtection(t, w, r) {
						t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
						w.WriteHeader(http.StatusNotFound)
					}
				}
			})
			operator := new(githubTestOperator)
			changed, err := g.OfferMissingMainRestriction(context.Background(), operator)
			if err != nil || changed != reviewers || created > 1 || (created == 1) != reviewers {
				t.Fatalf("unexpected outcome changed=%v created=%d err=%v", changed, created, err)
			}
		})
	}
}

type githubTestRoundTrip func(*http.Request) (*http.Response, error)

func (f githubTestRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

type githubTestOperator struct {
	notices []string
}

func (*githubTestOperator) Confirm(string) (bool, error) { return true, nil }
func (*githubTestOperator) Ask(string) (string, error)   { return "", nil }
func (*githubTestOperator) Secret(string) ([]byte, error) {
	return nil, errors.New("unexpected secret prompt")
}
func (o *githubTestOperator) Notice(message string) {
	o.notices = append(o.notices, message)
}

func TestGitHubDeviceFlowRejectsDenialAndUntrustedVerificationURL(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, verificationURI string
		wantPoll              bool
	}{
		{"denied", "https://github.com/login/device", true},
		{"unexpected-origin", "https://github.com.example/login/device", false},
		{"embedded-code", "https://github.com/login/device?secret=do-not-share", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			operator := new(githubTestOperator)
			polls := 0
			const private = "server response may contain private credentials"
			client := &http.Client{Transport: githubTestRoundTrip(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host != "github.com" || r.Method != http.MethodPost {
					t.Errorf("unexpected OAuth request to %s", r.URL.Path)
				}
				body := ""
				if r.URL.Path == "/login/device/code" {
					body = fmt.Sprintf(`{"device_code":%q,"user_code":"ABCD-1E2F","expires_in":10,"interval":1,"verification_uri":%q}`, private, tc.verificationURI)
				} else {
					polls++
					body = fmt.Sprintf(`{"error":"access_denied","error_description":%q}`, private)
				}
				return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
			})}
			access, err := githubDeviceAccess(context.Background(), operator, "IvTestFixtureID", client)
			if err == nil || len(access) != 0 || strings.Contains(err.Error(), private) ||
				strings.Contains(err.Error(), "do-not-share") || polls > 1 || (polls == 1) != tc.wantPoll {
				t.Fatalf("unexpected OAuth rejection polls=%d error-present=%v", polls, err != nil)
			}
			if tc.wantPoll && (!strings.Contains(err.Error(), "denied") || len(operator.notices) != 1 ||
				!strings.Contains(operator.notices[0], "ABCD-1E2F") || strings.Contains(operator.notices[0], private)) {
				t.Fatal("the terminal should receive only the short public user code and a safe refusal")
			}
			if !tc.wantPoll && len(operator.notices) != 0 {
				t.Fatal("displayed a verification notice for an untrusted URI")
			}
		})
	}
}
