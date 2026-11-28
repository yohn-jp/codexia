package main

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
)

func TestDifferentCommitWithSameDeploymentContractAllowsFork(t *testing.T) {
	const specification = "docs/deployment/CODEXIACTL.sdoc"
	const legacySpecification = "docs/deployment/CODEXIACTL.md"
	canonicalDocs := []string{
		specification,
		"docs/deployment/ANSIBLE-AUTH-RUNTIME.sdoc",
		"docs/deployment/ANSIBLE-BASE-RUNTIME.sdoc",
		"docs/deployment/ANSIBLE-BASE-SECRETS.sdoc",
		"docs/deployment/ANSIBLE-PUSH-DEPLOYMENT.sdoc",
		"docs/deployment/BACKUP-CONSOLE-OPERATIONS.sdoc",
		"docs/deployment/ACCESS-POLICY-MIGRATION.sdoc",
	}
	officialSHA := strings.Repeat("a", 40)
	forkSHA := strings.Repeat("b", 40)
	contractBlob := strings.Repeat("c", 40)
	legacySpecificationSHA := strings.Repeat("e", 40)
	controlDriftSHA := strings.Repeat("f", 40)
	forkChangedPath := "scripts/deployment/preflight/run.mjs"
	officialPath := "/repos/yohn-jp/codexia/git/trees/" + officialSHA
	forkTreePrefix := "/repos/Fork-Org/codexia/git/trees/"
	driftedDocs := make(map[string]string)
	for i, path := range canonicalDocs {
		driftedDocs[fmt.Sprintf("%040x", i+1)] = path
	}
	g := newTestGitHubFixture(t, func(w http.ResponseWriter, r *http.Request) {
		controlBlob := contractBlob
		ref := strings.TrimPrefix(r.URL.Path, forkTreePrefix)
		driftedDoc := driftedDocs[ref]
		switch r.URL.Path {
		case officialPath, forkTreePrefix + forkSHA, forkTreePrefix + legacySpecificationSHA:
		case forkTreePrefix + controlDriftSHA:
			controlBlob = forkSHA
		default:
			if driftedDoc == "" {
				t.Errorf("contract fetched from unexpected exact source: %s", r.URL.Path)
				http.NotFound(w, r)
				return
			}
		}
		entries := make([]map[string]any, 0, len(releaseContractPaths)+len(canonicalDocs)+2)
		for _, path := range releaseContractPaths {
			if path == "deploy/production.json" || path == legacySpecification || slices.Contains(canonicalDocs, path) {
				continue
			}
			if strings.HasSuffix(path, "/") {
				path += "fixture"
			}
			entries = append(entries, map[string]any{"path": path, "mode": "100644", "type": "blob", "sha": contractBlob})
		}
		for _, path := range canonicalDocs {
			blob := contractBlob
			if path == specification && ref == legacySpecificationSHA {
				path = legacySpecification
			}
			if path == driftedDoc {
				blob = forkSHA
			}
			entries = append(entries, map[string]any{"path": path, "mode": "100644", "type": "blob", "sha": blob})
		}
		entries = append(entries,
			map[string]any{"path": forkChangedPath, "mode": "100644", "type": "blob", "sha": controlBlob},
			map[string]any{"path": "deploy/production.json", "mode": "100644", "type": "blob", "sha": r.URL.Path[len(r.URL.Path)-40:]})
		githubTestJSON(t, w, map[string]any{"truncated": false, "tree": entries})
	})
	ctx := context.Background()
	official, err := contractTree(ctx, g.client, "yohn-jp", "codexia", officialSHA)
	if err != nil {
		t.Fatal(err)
	}
	fork, err := contractTree(ctx, g.client, "Fork-Org", "codexia", forkSHA)
	if err != nil {
		t.Fatal(err)
	}
	if err := requireCompatibleContract(official, fork); err != nil {
		t.Fatal(err)
	}
	for ref, changedPath := range driftedDocs {
		t.Run(changedPath, func(t *testing.T) {
			fork, err := contractTree(ctx, g.client, "Fork-Org", "codexia", ref)
			if err != nil {
				t.Fatal(err)
			}
			if err := requireCompatibleContract(official, fork); err == nil || !strings.Contains(err.Error(), changedPath) {
				t.Fatalf("incompatible deployment document accepted: %v", err)
			}
		})
	}
	if _, err := contractTree(ctx, g.client, "Fork-Org", "codexia", legacySpecificationSHA); err == nil || !strings.Contains(err.Error(), specification) {
		t.Fatalf("tree without the SDoc specification accepted: %v", err)
	}
	fork, err = contractTree(ctx, g.client, "Fork-Org", "codexia", controlDriftSHA)
	if err != nil {
		t.Fatal(err)
	}
	if err := requireCompatibleContract(official, fork); err == nil || !strings.Contains(err.Error(), forkChangedPath) {
		t.Fatalf("incompatible deployment contract accepted: %v", err)
	}
}

func TestProductionSettingsAcceptForkOriginAndRejectNoncanonicalValues(t *testing.T) {
	const profile = `{"publicOrigin":"https://codexia.fork.example","desktopCallbackPath":"/desktop","webClientId":"codexia-web","iosClientId":"codexia-ios","introspectionClientId":"codexia-resource-server","scopes":"openid codexia:api","serviceUid":1001,"serviceGid":1001}`
	var settings productionContract
	if err := validateProductionSettings([]byte(profile), &settings); err != nil || settings.PublicOrigin != "https://codexia.fork.example" {
		t.Fatalf("fork settings were rejected: %v", err)
	}
	for _, invalid := range []string{"https://10.0.0.1", "https://codexia.fork.example:443", "https://codexia.fork.example?", "https://codexia.fork.example/"} {
		if err := validateProductionSettings([]byte(strings.ReplaceAll(profile, settings.PublicOrigin, invalid)), &settings); err == nil {
			t.Fatalf("invalid origin %s was accepted", invalid)
		}
	}
	for _, ambiguous := range []string{
		strings.Replace(profile, `"publicOrigin":`, `"publicOrigin":"https://other.example","publicOrigin":`, 1),
		strings.Replace(profile, `"publicOrigin":`, `"PublicOrigin":`, 1),
	} {
		if err := validateProductionSettings([]byte(ambiguous), &settings); err == nil {
			t.Fatal("the CLI could interpret an ambiguous origin differently from the workflow")
		}
	}
}
