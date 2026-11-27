package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestStatusDoesNotUseSuccessBeforeNewerFailureOrDeployment(t *testing.T) {
	t.Parallel()
	const host = "fixture-host"
	const origin = "https://codexia.yohn.jp"
	now := time.Date(2026, 11, 27, 10, 0, 0, 0, time.UTC)
	observed := now.Add(-time.Minute)
	receipt := statusFixtureReceipt(host, origin, observed)
	older := githubRunSummary{ID: 41, File: preflightFile, SHA: githubTestSHA, Status: "completed", Conclusion: "success",
		CreatedAt: observed.Add(-time.Minute), UpdatedAt: observed.Add(5 * time.Second)}
	newerFailed := githubRunSummary{ID: 42, File: preflightFile, SHA: githubTestSHA, Status: "completed", Conclusion: "failure",
		CreatedAt: observed.Add(30 * time.Second), UpdatedAt: observed.Add(40 * time.Second)}
	newerDispatchFailedFirst := newerFailed
	newerDispatchFailedFirst.CreatedAt, newerDispatchFailedFirst.UpdatedAt = observed.Add(time.Second), observed.Add(2*time.Second)
	newerMutation := githubRunSummary{ID: 43, File: "backend-deployment-handoff.yml", Status: "completed", Conclusion: "failure",
		CreatedAt: observed.Add(30 * time.Second), UpdatedAt: observed.Add(40 * time.Second)}
	for _, tc := range []struct {
		name         string
		runs         []githubRunSummary
		wantEvidence bool
	}{
		{"current", []githubRunSummary{older}, true},
		{"newer-failure", []githubRunSummary{older, newerFailed}, false},
		{"newer-dispatch-failed-first", []githubRunSummary{older, newerDispatchFailedFirst}, false},
		{"newer-mutation", []githubRunSummary{newerMutation, older}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			report := statusReport{MainSHA: githubTestSHA, PublicOrigin: origin, Phase: "UNKNOWN", Active: "unknown", Accepted: "unknown"}
			reader := &statusFixtureWorkflow{receipt: receipt}
			observeExistingReceipt(context.Background(), reader, host, tc.runs, now, &report)
			if tc.wantEvidence {
				if report.Phase != "BOOTSTRAPPED" || report.EvidenceObservedAt == nil ||
					!report.EvidenceObservedAt.Equal(observed) || len(report.Evidence) != 1 {
					t.Fatalf("fresh matching receipt was not published with its observation time: %+v", report)
				}
			} else if report.Phase != "UNKNOWN" || report.Active != "unknown" || report.EvidenceObservedAt != nil ||
				len(report.Evidence) != 0 || len(report.Blockers) == 0 {
				t.Fatalf("superseded receipt was reported as current: %+v", report)
			}
			if strings.HasPrefix(tc.name, "newer-") && tc.name != "newer-mutation" && reader.requestedRun != 0 {
				t.Fatalf("looked for a fallback receipt after newer failure: %d", reader.requestedRun)
			}
		})
	}
}

func statusFixtureReceipt(host, origin string, observed time.Time) lifecycleReceipt {
	r := lifecycleReceipt{SourceSHA: githubTestSHA, RunID: 41, Attempt: 1, Management: "bootstrap", PlanSHA: strings.Repeat("c", 64)}
	r.Request.Intent, r.Plan.Intent = "install", "install"
	r.Request.BackendPublisherRunID, r.Request.Frontend.RunID, r.Request.Frontend.ArtifactID, r.Request.Frontend.VerifyRunID = 5, 6, 7, 8
	r.Request.Frontend.ArtifactDigest = strings.Repeat("d", 64)
	r.Plan.Target.FrontendArtifactSHA = r.Request.Frontend.ArtifactDigest
	r.Plan.Target.BackendCertificateSHA, r.Plan.Target.IdentitySHA = strings.Repeat("1", 64), strings.Repeat("2", 64)
	r.Plan.Format, r.Plan.Route, r.Plan.CandidateRoute = "codexia-deployment-plan/v1", "R5", "R5"
	r.Plan.Observation.ObservedAt = observed
	r.Plan.Observation.State = lifecycleState{M: "ready", H: "ready", D: "compatible", A: "pending", B: "absent", F: "absent", T: "none"}
	r.Plan.Observation.Binding.HostID = host
	r.Evidence.Edge.Origin = origin
	return r
}

type statusFixtureWorkflow struct {
	fakeWorkflow
	receipt      lifecycleReceipt
	requestedRun int64
}

func (s *statusFixtureWorkflow) Run(_ context.Context, _ string, _ string, id int64) (githubRun, error) {
	s.requestedRun = id
	if id != s.receipt.RunID {
		return githubRun{}, errors.New("unexpected evidence producer")
	}
	return githubRun{Status: "completed", Conclusion: "success", Attempt: 1}, nil
}

func (s *statusFixtureWorkflow) Jobs(context.Context, int64, int) (map[string]string, error) {
	jobs := make(map[string]string)
	for _, job := range operations["lifecycle"].jobs {
		jobs[job] = "success"
	}
	return jobs, nil
}

func (s *statusFixtureWorkflow) Artifact(context.Context, int64, string, string) ([]byte, error) {
	return json.Marshal(s.receipt)
}

func TestStatusForbiddenVariableListingLeavesGateAndInventoryUnknown(t *testing.T) {
	t.Parallel()
	g := newTestGitHub(t, func(w http.ResponseWriter, r *http.Request) {
		if githubTestProtection(t, w, r) {
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/variables") && r.URL.Query().Get("page") == "1":
			w.Header().Set("Link", "<http://"+r.Host+r.URL.Path+"?page=2>; rel=\"next\"")
			githubTestJSON(t, w, map[string]any{"total_count": 2, "variables": []any{
				map[string]string{"name": "CODEXIA_PUSH_DEPLOYMENT_ENABLED", "value": "false"},
			}})
		case strings.HasSuffix(r.URL.Path, "/variables"):
			w.WriteHeader(http.StatusForbidden)
		case strings.HasSuffix(r.URL.Path, "/secrets"):
			githubTestJSON(t, w, map[string]any{"total_count": 0, "secrets": []any{}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	env, err := g.observeEnvironment(context.Background(), productionEnvironment)
	if err == nil {
		t.Fatal("permission failure was not reported")
	}
	report := statusReport{OrdinaryUpdate: "unknown"}
	reportProtectedInputs(githubSnapshot{Production: env}, &report)
	_, hasVisibleVariable := report.ProtectedInputs[productionEnvironment+"/CODEXIA_DEPLOY_HOST"]
	_, hasVisibleSecret := report.ProtectedInputs[productionEnvironment+"/"+runtimeSSHSecret]
	if env.Variables != nil || report.OrdinaryUpdate != "unknown" || hasVisibleVariable || !hasVisibleSecret {
		t.Fatalf("unobservable values appeared in status: variables=%v gate=%s hasVar=%v hasSecret=%v",
			env.Variables, report.OrdinaryUpdate, hasVisibleVariable, hasVisibleSecret)
	}
}

func TestDoctorReportsActionableBlockersWithoutDumpingWorkflowHistory(t *testing.T) {
	t.Parallel()
	runs := []observedRun{
		{ID: 15, Workflow: "production-preflight.yml", Conclusion: "failure"},
		{ID: 14, Workflow: "production-preflight.yml", Conclusion: "success"},
		{ID: 12, Workflow: "frontend-release.yml", Conclusion: "failure"},
		{ID: 11, Workflow: "frontend-release.yml", Conclusion: "success"},
		{ID: 10, Workflow: "backend-deployment-handoff.yml", Conclusion: "failure"},
	}
	recent := latestWorkflowSummary(runs)
	if len(recent) != 3 || recent[0].ID != 15 || recent[1].ID != 12 || recent[2].ID != 10 {
		t.Fatalf("expected one most recent run per workflow, got %#v", recent)
	}
	for _, code := range []string{
		"github-environment-or-permission-unverified",
		"tailnet-identity-or-policy-unverified",
		"latest-target-lifecycle-evidence-unavailable",
		"cloudflare-edge-unverified",
	} {
		if blockerGuidance(code) == "" {
			t.Fatalf("no user-facing remediation for %s", code)
		}
	}
}
