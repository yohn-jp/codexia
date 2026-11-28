package main

import (
	"context"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestGitHubFindsInstalledCodexiaAcrossPages(t *testing.T) {
	const appID = "fixture"
	installation := func(id int, owner string, selection string, suspended bool) map[string]any {
		x := map[string]any{
			"id": id, "app_id": 25, "client_id": appID, "account": map[string]any{"login": owner, "id": id + 100},
			"repository_selection": selection,
			"permissions":          map[string]any{"actions": "write", "environments": "write", "contents": "read", "metadata": "read", "administration": "read"},
		}
		if suspended {
			x["suspended_at"] = "2026-11-26T00:00:00Z"
		}
		return x
	}
	repo := func(id, ownerID int, owner, name string, push bool) map[string]any {
		return map[string]any{"id": id, "name": name, "full_name": owner + "/" + name, "default_branch": "main",
			"owner": map[string]any{"login": owner, "id": ownerID}, "permissions": map[string]any{"push": push}}
	}
	g := newTestGitHubFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/user/installations":
			var list []any
			if r.URL.Query().Get("page") == "1" {
				list = []any{installation(1, "yohn-jp", "selected", false), installation(3, "disabled", "selected", true)}
				w.Header().Set("Link", fmt.Sprintf("<http://%s%s?page=2>; rel=\"next\"", r.Host, r.URL.Path))
			} else {
				list = []any{installation(2, "Fork-Org", "selected", false), installation(4, "all", "all", false)}
			}
			githubTestJSON(t, w, map[string]any{"total_count": 4, "installations": list})
		case "/user/installations/1/repositories":
			if r.URL.Query().Get("page") == "1" {
				w.Header().Set("Link", fmt.Sprintf("<http://%s%s?page=2>; rel=\"next\"", r.Host, r.URL.Path))
				githubTestJSON(t, w, map[string]any{"total_count": 2, "repositories": []any{repo(50, 101, "yohn-jp", "other", true)}})
			} else {
				githubTestJSON(t, w, map[string]any{"total_count": 2, "repositories": []any{repo(51, 101, "yohn-jp", "codexia", true)}})
			}
		case "/user/installations/2/repositories":
			githubTestJSON(t, w, map[string]any{"total_count": 2, "repositories": []any{
				repo(52, 102, "Fork-Org", "codexia", true), repo(53, 102, "Fork-Org", "codexia", false),
				repo(52, 102, "Fork-Org", "codexia", true),
			}})
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	g.appClientID = appID
	got, err := g.discoverTargets(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, target := range got {
		names = append(names, target.FullName())
	}
	if !reflect.DeepEqual(names, []string{"Fork-Org/codexia", "yohn-jp/codexia"}) {
		t.Fatalf("targets %v", names)
	}
	fork := got[0]
	if fork.oidcPrefix() != "repo:Fork-Org@102/codexia@52" ||
		!fork.matchesFullImage("ghcr.io/fork-org/codexia-backend@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef") ||
		fork.matchesFullImage("ghcr.io/yohn-jp/codexia-backend@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef") {
		t.Fatalf("target %v accepted unexpected image or OIDC identity", fork)
	}
}

type selectionOperator struct {
	githubTestOperator
	answer string
}

func (o *selectionOperator) Ask(string) (string, error) { return o.answer, nil }

func TestGitHubTargetSelectionAndCheckpointBinding(t *testing.T) {
	official := githubTestTarget
	fork := githubTarget{Owner: "Fork-Org", OwnerID: 819, RepoID: 5562, InstallationID: 281}
	var saved checkpoint
	saved.bindTarget(fork)
	for _, tt := range []struct {
		name       string
		candidates []githubTarget
		answer     string
		checkpoint checkpoint
		want       githubTarget
	}{
		{name: "zero", candidates: nil},
		{name: "one", candidates: []githubTarget{fork}, want: fork},
		{name: "confirm-observed-fork", candidates: []githubTarget{official, fork}, answer: "5562", want: fork},
		{name: "confirm-observed-official", candidates: []githubTarget{official, fork}, answer: "1450072993", want: official},
		{name: "cancel", candidates: []githubTarget{official, fork}},
		{name: "arbitrary-repo", candidates: []githubTarget{official, fork}, answer: "https://github.com/Fork-Org/codexia"},
		{name: "resume-original", candidates: []githubTarget{official, fork}, checkpoint: saved, want: fork},
		{name: "unavailable-checkpoint-target", candidates: []githubTarget{official}, checkpoint: saved},
		{name: "same-name-different-repository", candidates: []githubTarget{{Owner: fork.Owner, OwnerID: fork.OwnerID, RepoID: 12, InstallationID: fork.InstallationID}}, checkpoint: saved},
		{name: "same-id-renamed", candidates: []githubTarget{{Owner: "Different-Owner", OwnerID: fork.OwnerID, RepoID: fork.RepoID, InstallationID: fork.InstallationID}}, checkpoint: saved},
		{name: "transferred", candidates: []githubTarget{{Owner: fork.Owner, OwnerID: 91, RepoID: fork.RepoID, InstallationID: fork.InstallationID}}, checkpoint: saved},
		{name: "reinstalled-app", candidates: []githubTarget{{Owner: fork.Owner, OwnerID: fork.OwnerID, RepoID: fork.RepoID, InstallationID: 72}}, checkpoint: saved},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := chooseGitHubTarget(&selectionOperator{answer: tt.answer}, tt.candidates, tt.checkpoint)
			if got != tt.want || (err == nil) != tt.want.valid() {
				t.Fatalf("got %v (%v), want %v", got, err, tt.want)
			}
		})
	}
}

func TestGitHubLoginDoesNotPromptForCredentialsWithoutOfficialApp(t *testing.T) {
	for _, id := range []string{"", "OAuth-client-id", "https://github.com/"} {
		if gh, err := githubLogin(context.Background(), &githubTestOperator{}, id); gh != nil || err == nil {
			t.Fatalf("unconfigured official App login = %v, %v", gh, err)
		}
	}
}

func TestGitHubTargetDiscoveryRejectsIncompleteInventory(t *testing.T) {
	g := newTestGitHubFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/user/installations" {
			t.Errorf("unexpected request %s", r.URL.Path)
			return
		}
		githubTestJSON(t, w, map[string]any{"total_count": 1, "installations": []any{}})
	})
	if _, err := g.discoverTargets(context.Background()); err == nil {
		t.Fatal("accepted incomplete installation inventory")
	}
}

func TestGitHubDispatchAndEvidenceUseTheSelectedFork(t *testing.T) {
	fork := githubTarget{Owner: "Fork-Org", OwnerID: 819, RepoID: 5562, InstallationID: 281}
	repository := githubTestRepository(fork, map[string]any{"push": true})
	upstream := githubTestRepository(githubTestTarget, nil)
	head := repository
	active := true
	transfer := false
	var writes int
	g := newTestGitHubFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/user/installations":
			i := map[string]any{
				"id": fork.InstallationID, "client_id": githubTestAppID,
				"account":              map[string]any{"id": fork.OwnerID, "login": fork.Owner},
				"repository_selection": "selected", "permissions": map[string]string{
					"contents": "read", "metadata": "read", "environments": "write", "actions": "write", "administration": "read",
				},
			}
			if !active {
				i["suspended_at"] = "2026-11-26T00:00:00Z"
			}
			githubTestJSON(t, w, map[string]any{"total_count": 1, "installations": []any{i}})
		case "/user/installations/281/repositories":
			githubTestJSON(t, w, map[string]any{"total_count": 1, "repositories": []any{repository}})
		case "/repos/Fork-Org/codexia":
			if transfer {
				transferred := fork
				transferred.OwnerID++
				githubTestJSON(t, w, githubTestRepository(transferred, map[string]any{"push": true}))
				return
			}
			githubTestJSON(t, w, repository)
		case "/repos/Fork-Org/codexia/actions/oidc/customization/sub":
			githubTestJSON(t, w, map[string]any{"use_default": true, "use_immutable_subject": true, "sub_claim_prefix": fork.oidcPrefix()})
		case "/repos/Fork-Org/codexia/actions/workflows/production-bootstrap.yml/dispatches":
			writes++
			githubTestJSON(t, w, map[string]any{"workflow_run_id": 123})
		case "/repos/Fork-Org/codexia/actions/runs/123":
			githubTestJSON(t, w, map[string]any{
				"id": 123, "head_branch": "main", "head_sha": githubTestSHA, "path": ".github/workflows/production-bootstrap.yml",
				"event": "workflow_dispatch", "run_attempt": 1, "status": "completed", "conclusion": "success",
				"repository": repository, "head_repository": head,
			})
		default:
			if strings.HasPrefix(r.URL.Path, "/repos/Fork-Org/codexia/") && githubTestProtection(t, w, r) {
				return
			}
			t.Errorf("API request went outside selected deployment: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	g.target = fork
	ctx := context.Background()
	dispatch := func() (int64, error) {
		return g.Dispatch(ctx, bootstrapFile, githubTestSHA, map[string]string{"mode": "preflight"})
	}
	if got, err := dispatch(); got != 123 || err != nil {
		t.Fatalf("fork dispatch returned %d, %v", got, err)
	}
	if _, err := g.Run(ctx, bootstrapFile, githubTestSHA, 123); err != nil {
		t.Fatal(err)
	}
	head = upstream
	if _, err := g.Run(ctx, bootstrapFile, githubTestSHA, 123); err == nil {
		t.Fatal("accepted official run evidence for the fork")
	}
	transfer = true
	if _, err := dispatch(); err == nil || writes != 1 {
		t.Fatalf("a transfer did not block dispatch: writes=%d, error=%v", writes, err)
	}
	active = false
	transfer = false
	if _, err := dispatch(); err == nil || writes != 1 {
		t.Fatalf("a suspended installation did not block dispatch: writes=%d, error=%v", writes, err)
	}
}

func TestGitHubOIDCRejectsLegacyCustomAndForeignSubjects(t *testing.T) {
	for _, tt := range []struct {
		name  string
		value map[string]any
		want  bool
	}{
		{"immutable", map[string]any{"use_default": true, "use_immutable_subject": true, "sub_claim_prefix": githubTestTarget.oidcPrefix()}, true},
		{"legacy", map[string]any{"use_default": true, "use_immutable_subject": false, "sub_claim_prefix": "repo:yohn-jp/codexia"}, false},
		{"custom", map[string]any{"use_default": false, "use_immutable_subject": true, "sub_claim_prefix": githubTestTarget.oidcPrefix(), "include_claim_keys": []string{"job_workflow_ref"}}, false},
		{"foreign", map[string]any{"use_default": true, "use_immutable_subject": true, "sub_claim_prefix": "repo:other@5/codexia@7"}, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			g := newTestGitHubFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/repos/yohn-jp/codexia/actions/oidc/customization/sub" {
					t.Errorf("unexpected request %s", r.URL.Path)
					return
				}
				githubTestJSON(t, w, tt.value)
			})
			if err := g.verifyOIDC(context.Background()); (err == nil) != tt.want {
				t.Fatalf("verifyOIDC() = %v, want success %t", err, tt.want)
			}
		})
	}
}
