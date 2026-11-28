package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestInitialOperationFollowsObservedLifecycle(t *testing.T) {
	state := lifecycleState{M: "ready", H: "ready", D: "absent", A: "absent", B: "absent", F: "absent", T: "none"}
	receipt := lifecycleReceipt{}
	receipt.Plan.Observation.State = state
	receipt.Plan.CandidateRoute = "R4"
	receipt.Plan.Blockers = []string{"approval-required"}
	receipt.Plan.RequiredApprovals = []string{"bootstrap", "database-initialization"}
	receipt.Evidence.Host.Database.State = "absent"
	if mutation, err := receipt.initialOperation(); err != nil || mutation != initializeDatabase {
		t.Fatalf("fresh DB absence: got %v, %v", mutation, err)
	}
	receipt.Plan.Observation.State.D = "pristine"
	if _, err := receipt.initialOperation(); err == nil {
		t.Fatal("an existing empty database was authorized for fresh initialization")
	}
	receipt.Plan.Observation.State.D = "compatible"
	receipt.Plan.Observation.BootstrapResume = []byte(`{"checkpoint":"empty-auth-schema"}`)
	if mutation, err := receipt.initialOperation(); err != nil || mutation != resumeAuthOnly {
		t.Fatalf("canonical checkpoint: got %v, %v", mutation, err)
	}
	receipt.Plan.Observation.State = lifecycleState{M: "ready", H: "ready", D: "compatible", A: "pending", B: "absent", F: "compatible", T: "none"}
	receipt.Plan.CandidateRoute = "R5"
	receipt.Plan.RequiredApprovals = []string{"owner-enrollment"}
	if mutation, err := receipt.initialOperation(); err != nil || mutation != publishFrontend {
		t.Fatalf("owner pending: got %v, %v", mutation, err)
	}
	receipt.Plan.Observation.State.F = "incompatible"
	receipt.Evidence.Edge.FrontendState = "running"
	receipt.Evidence.Edge.Frontend = &frontendIdentity{SourceSHA: strings.Repeat("b", 40), Version: "1.2.3", Profile: "full", APIEpoch: 4}
	if mutation, err := receipt.initialOperation(); err != nil || mutation != publishFrontend {
		t.Fatalf("reviewed R5 must permit replacing old epoch frontend: %v, %v", mutation, err)
	}
	receipt.Evidence.Edge.Frontend = nil
	if _, err := receipt.initialOperation(); err == nil {
		t.Fatal("incompatible frontend cannot be replaced without positive live identity evidence")
	}
	receipt.Plan.Observation.State.A = "unprepared"
	if _, err := receipt.initialOperation(); !errors.Is(err, errExistingOwner) {
		t.Fatalf("existing Owner must stop: %v", err)
	}
	receipt.Plan.Observation.State.A = "pending"
	receipt.Plan.Blockers = []string{"approval-required", "unverified-fresh-installation"}
	if _, err := receipt.initialOperation(); err == nil {
		t.Fatal("approval does not authorize operation with another blocker")
	}
}

func TestRequiredWorkflowJobsMustActuallyRun(t *testing.T) {
	ok := githubRun{Status: "completed", Conclusion: "success", Attempt: 1}
	spec := operations["bootstrap"]
	jobs := make(map[string]string)
	for _, job := range spec.jobs {
		jobs[job] = "success"
	}
	if err := verifyJobs(ok, spec, jobs); err != nil {
		t.Fatal(err)
	}
	jobs[spec.jobs[0]] = "skipped"
	if err := verifyJobs(ok, spec, jobs); err == nil || !strings.Contains(err.Error(), "skipped") {
		t.Fatalf("a skipped real job must stop: %v", err)
	}
	jobs[spec.jobs[0]] = "success"
	ok.Attempt = 2
	if err := verifyJobs(ok, spec, jobs); err == nil {
		t.Fatal("rerun cannot substitute for first-attempt approval")
	}
}

func TestDispatchRemembersAmbiguousResponsesWithoutResending(t *testing.T) {
	store := &memoryCheckpoint{}
	gh := &fakeWorkflow{dispatchError: errGitHubDispatchUnknown}
	c := workflowController{
		github: gh, store: store, operator: acceptingOperator{}, sha: strings.Repeat("a", 40),
		state: checkpoint{HostID: strings.Repeat("b", 64), RepositoryID: githubTestTarget.RepoID},
	}
	if _, err := c.dispatch(context.Background(), "management", nil); err == nil {
		t.Fatal("missing dispatch response must fail")
	}
	if !store.last.Pending || store.last.RunID != 0 || store.last.Operation != "management" || store.last.StartedAt.IsZero() {
		t.Fatalf("missing unresolved intent in checkpoint: %+v", store.last)
	}
	if _, err := c.dispatch(context.Background(), "management", nil); err == nil || gh.dispatches != 1 {
		t.Fatalf("ambiguous dispatch was sent twice: %v, count %d", err, gh.dispatches)
	}
}

func TestSetupDeliveryRequiresPositiveProof(t *testing.T) {
	var receipt lifecycleReceipt
	receipt.Plan.Observation.State = lifecycleState{M: "ready", H: "ready", D: "compatible", A: "pending", B: "setup", F: "compatible", T: "none"}
	receipt.Evidence.Edge.RoutesReady = true
	receipt.Evidence.Edge.FrontendState = "running"
	receipt.Evidence.Edge.Frontend = &frontendIdentity{SourceSHA: strings.Repeat("b", 40), Version: "1.2.3", Profile: "full", APIEpoch: 2}
	receipt.Evidence.Candidate.Frontend = *receipt.Evidence.Edge.Frontend
	receipt.Evidence.Host.Database.OwnerSetupCheckpoint.EncryptedHandoffPresent = true
	receipt.Evidence.Host.Database.OwnerSetupCheckpoint.GrantBindingSHA = strings.Repeat("f", 64)
	if !receipt.setupForDelivery() {
		t.Fatal("valid live and grant receipt was rejected")
	}
	if resumeVerifiedOwnerDelivery(receipt, checkpoint{}) || !resumeVerifiedOwnerDelivery(receipt, checkpoint{OwnerSetupRunID: 82}) {
		t.Fatal("only a completed recorded R5 operation may resume the live grant without provider convergence")
	}
	receipt.Evidence.Host.Database.OwnerSetupCheckpoint.PendingHandoff = true
	if receipt.setupForDelivery() || resumeVerifiedOwnerDelivery(receipt, checkpoint{OwnerSetupRunID: 82}) {
		t.Fatal("interrupted grant was accepted")
	}
	receipt.Evidence.Host.Database.OwnerSetupCheckpoint.PendingHandoff = false
	receipt.Evidence.Edge.PublicProtocolEnabled = true
	if receipt.setupForDelivery() || resumeVerifiedOwnerDelivery(receipt, checkpoint{OwnerSetupRunID: 82}) {
		t.Fatal("public protocol bypass was accepted")
	}
}

type memoryCheckpoint struct{ last checkpoint }

func (s *memoryCheckpoint) Save(next checkpoint) error { s.last = next; return nil }

type fakeWorkflow struct {
	dispatches    int
	dispatchError error
}

func (f *fakeWorkflow) Main(context.Context) (string, error) { return strings.Repeat("a", 40), nil }
func (f *fakeWorkflow) Dispatch(context.Context, string, string, map[string]string) (int64, error) {
	f.dispatches++
	return 0, f.dispatchError
}

func (f *fakeWorkflow) Run(context.Context, string, string, int64) (githubRun, error) {
	panic("unexpected Run")
}

func (f *fakeWorkflow) Jobs(context.Context, int64, int) (map[string]string, error) {
	panic("unexpected Jobs")
}

func (f *fakeWorkflow) Artifact(context.Context, int64, string, string) ([]byte, error) {
	panic("unexpected Artifact")
}

type acceptingOperator struct{}

func (acceptingOperator) Confirm(string) (bool, error)  { return true, nil }
func (acceptingOperator) Ask(string) (string, error)    { panic("unexpected Ask") }
func (acceptingOperator) Secret(string) ([]byte, error) { panic("unexpected Secret") }
func (acceptingOperator) Notice(string)                 {}

func TestValidateReceiptBoundToTargetAndTime(t *testing.T) {
	now := time.Now().UTC()
	sha, id, host := strings.Repeat("a", 40), int64(238), strings.Repeat("b", 64)
	r := lifecycleReceipt{Repository: githubTestTarget.FullName(), RepositoryID: githubTestTarget.RepoID, OwnerID: githubTestTarget.OwnerID, SourceSHA: sha, RunID: id, Attempt: 1, Management: "bootstrap", PlanSHA: strings.Repeat("c", 64)}
	r.Request.Intent, r.Plan.Intent = "install", "install"
	r.Request.BackendPublisherRunID, r.Request.Frontend.RunID, r.Request.Frontend.ArtifactID, r.Request.Frontend.VerifyRunID = 5, 6, 7, 8
	r.Request.Frontend.ArtifactDigest = strings.Repeat("d", 64)
	r.Plan.Target.FrontendArtifactSHA = r.Request.Frontend.ArtifactDigest
	r.Plan.Target.BackendCertificateSHA, r.Plan.Target.IdentitySHA = strings.Repeat("1", 64), strings.Repeat("2", 64)
	r.Plan.Format = "codexia-deployment-plan/v1"
	r.Plan.Observation.ObservedAt = now.Add(-time.Minute)
	r.Plan.Observation.Binding.HostID = host
	r.Evidence.Edge.Origin = "https://codexia.yohn.jp"
	r.Evidence.Candidate.BackendImage = githubTestTarget.imageRepository() + "@sha256:" + strings.Repeat("b", 64)
	if err := r.validate(githubTestTarget, sha, id, "bootstrap", host, r.Evidence.Edge.Origin, now); err != nil {
		t.Fatal(err)
	}
	fork := githubTarget{Owner: "Fork-Org", OwnerID: 12, RepoID: 34, InstallationID: 56}
	if err := r.validate(fork, sha, id, "bootstrap", host, r.Evidence.Edge.Origin, now); err == nil {
		t.Fatal("receipt accepted evidence for a different repository")
	}
	foreignImage := r
	foreignImage.Evidence.Candidate.BackendImage = fork.imageRepository() + "@sha256:" + strings.Repeat("b", 64)
	if err := foreignImage.validate(githubTestTarget, sha, id, "bootstrap", host, r.Evidence.Edge.Origin, now); err == nil {
		t.Fatal("receipt accepted the product image of a different repository")
	}
	if err := r.validate(githubTestTarget, sha, id, "bootstrap", strings.Repeat("f", 64), r.Evidence.Edge.Origin, now); err == nil {
		t.Fatal("receipt accepted a different VM")
	}
	if err := r.validate(githubTestTarget, sha, id, "bootstrap", host, r.Evidence.Edge.Origin, now.Add(6*time.Minute)); err == nil {
		t.Fatal("stale approval evidence was reused")
	}
	r.Request.Intent, r.Plan.Intent = "update", "update"
	if err := r.validateObservation(githubTestTarget, sha, id, "bootstrap", host, r.Evidence.Edge.Origin, now); err != nil {
		t.Fatalf("read-only status must accept update evidence: %v", err)
	}
	if err := r.validate(githubTestTarget, sha, id, "bootstrap", host, r.Evidence.Edge.Origin, now); err == nil {
		t.Fatal("update evidence was accepted as a first-install approval")
	}
}

func TestCorrelateLostResponseByExactReviewedPreflight(t *testing.T) {
	sha := strings.Repeat("b", 40)
	cp := checkpoint{Operation: "owner-setup", MainSHA: sha, PreflightRunID: 42}
	runs := []githubRunSummary{
		{ID: 52, Attempt: 1, File: bootstrapFile, SHA: sha, DisplayTitle: dispatchTitle("bootstrap", 42)},
		{ID: 53, Attempt: 1, File: bootstrapFile, SHA: sha, DisplayTitle: dispatchTitle("owner-setup", 41)},
		{ID: 54, Attempt: 1, File: bootstrapFile, SHA: strings.Repeat("c", 40), DisplayTitle: dispatchTitle("owner-setup", 42)},
	}
	if got, err := correlateRun(cp, runs); got != 0 || err != nil {
		t.Fatalf("unrelated runs were selected: %d, %v", got, err)
	}
	exact := githubRunSummary{ID: 55, Attempt: 1, File: bootstrapFile, SHA: sha, DisplayTitle: dispatchTitle("owner-setup", 42)}
	runs = append(runs, exact)
	if got, err := correlateRun(cp, runs); got != exact.ID || err != nil {
		t.Fatalf("exact run was not selected: %d, %v", got, err)
	}
	exact.ID++
	runs = append(runs, exact)
	if _, err := correlateRun(cp, runs); err == nil {
		t.Fatal("two matching dispatches are not an authorized retry")
	}
}

func TestRejectsHiddenAutomationAndCredentialsOnCommandLine(t *testing.T) {
	for _, args := range [][]string{
		{"init", "--yes"},
		{"init", "--force"},
		{"init", "--token", "token"},
		{"init", "--json"},
		{"status", "--owner-grant", "grant"},
		{"doctor", "--plan"},
	} {
		if _, accepted := parseInvocation(args); accepted {
			t.Fatalf("unexpected arguments accepted: %v", args[:2])
		}
	}
}

func TestExistingProtectedInputsArePreserved(t *testing.T) {
	snapshot := githubSnapshot{
		Bootstrap: githubEnvironment{
			Variables: map[string]string{edgeTarget: `{"accountId":"a", "publicProtocolEnabled":false}`},
			Secrets:   map[string]bool{bootstrapSSHSecret: true},
		},
		Production: githubEnvironment{Variables: map[string]string{edgeTarget: `{"accountId":"a", "publicProtocolEnabled":false}`}},
	}
	values := []environmentInput{
		{bootstrapEnvironment, edgeTarget, `{"publicProtocolEnabled":false,"accountId":"a"}`},
		{productionEnvironment, "CODEXIA_DEPLOY_HOST", "100.64.1.8"},
	}
	missing, err := missingVariables(snapshot, values)
	if err != nil || len(missing) != 1 || missing[0] != values[1] {
		t.Fatalf("semantically equal existing value would be written: %v, %v", missing, err)
	}
	values[0].value = `{"publicProtocolEnabled":false,"accountId":"b"}`
	if _, err := missingVariables(snapshot, values); err == nil {
		t.Fatal("different Cloudflare account was accepted")
	}
	for _, input := range missingSecrets(snapshot) {
		if input.name == bootstrapSSHSecret {
			t.Fatal("an existing bootstrap credential would be replaced")
		}
	}
}

func TestReadOnlyJSONWithUnverifiedVM(t *testing.T) {
	t.Setenv("SSH_CONNECTION", "")
	t.Setenv("CODEXIA_ACCESS_CLIENT_SECRET", "fixture-never-report-this")
	var stdout, stderr bytes.Buffer
	if code := runCLI(context.Background(), []string{"status", "--json"}, &stdout, &stderr); code == 0 {
		t.Fatal("unknown VM was reported as success")
	}
	var report statusReport
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.Active != "unknown" || report.Accepted != "unknown" || len(report.Blockers) == 0 {
		t.Fatalf("unknown deployment was reported as accepted: %+v", report)
	}
	if strings.Contains(stdout.String()+stderr.String(), "fixture-never-report-this") {
		t.Fatal("credential leaked to logs or JSON")
	}
}

func TestInterruptedFirstHostUsesAdministratorPreflight(t *testing.T) {
	private, public, err := newSSHIdentity()
	if err != nil {
		t.Fatal(err)
	}
	defer clear(private)
	key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(public))
	if err != nil {
		t.Fatal(err)
	}
	const hostname = "codexia-ssh.example.test"
	vm := vmObservation{hostKeys: []ssh.PublicKey{key}}
	target := `{"sshHostname":"codexia-ssh.example.test","sshPolicyId":"policy-123"}`
	valid := func(names []string, sshSecret, hostName, pinName string) githubEnvironment {
		env := githubEnvironment{Variables: map[string]string{edgeTarget: target}, Secrets: map[string]bool{sshSecret: true}}
		for _, name := range names {
			switch name {
			case hostName:
				env.Variables[name] = hostname
			case pinName:
				env.Variables[name] = hostname + " " + public
			default:
				env.Variables[name] = "fixture"
			}
		}
		for _, name := range managementSecrets() {
			env.Secrets[name] = true
		}
		return env
	}
	snapshot := githubSnapshot{
		Bootstrap:  valid([]string{"CODEXIA_BOOTSTRAP_HOST", "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS", "CODEXIA_BOOTSTRAP_SSH_USER"}, bootstrapSSHSecret, "CODEXIA_BOOTSTRAP_HOST", "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS"),
		Production: valid([]string{"CODEXIA_DEPLOY_HOST", "CODEXIA_DEPLOY_SSH_KNOWN_HOSTS"}, runtimeSSHSecret, "CODEXIA_DEPLOY_HOST", "CODEXIA_DEPLOY_SSH_KNOWN_HOSTS"),
	}
	if found := existingManagement(snapshot, vm, hostname); found != "bootstrap" {
		t.Fatalf("partially configured runtime would block recovery: %s", found)
	}
	snapshot.Bootstrap.Variables["CODEXIA_BOOTSTRAP_HOST"] = "codexia.example.ts.net"
	if found := existingManagement(githubSnapshot{Bootstrap: snapshot.Bootstrap}, vm, hostname); found != "" {
		t.Fatalf("legacy Tailscale destination was reused for management preflight: %s", found)
	}
	snapshot.Bootstrap.Variables["CODEXIA_BOOTSTRAP_HOST"] = hostname
	snapshot.Bootstrap.Variables["CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS"] = "codexia.example.ts.net " + public
	if found := existingManagement(githubSnapshot{Bootstrap: snapshot.Bootstrap}, vm, hostname); found != "" {
		t.Fatalf("legacy Tailscale host pin was reused for management preflight: %s", found)
	}
	snapshot.Bootstrap = githubEnvironment{}
	if found := existingManagement(snapshot, vm, hostname); found != "runtime" {
		t.Fatalf("existing runtime should retain its independent observation path: %s", found)
	}
}

func TestOwnerSetupRechecksRecipientBeforeProtectedDispatch(t *testing.T) {
	sha := strings.Repeat("a", 40)
	reviewed := githubSnapshot{MainSHA: sha, Bootstrap: githubEnvironment{Variables: map[string]string{ownerRecipient: "owner-A"}}}
	if err := requireApprovedOwnerRecipient(reviewed, sha, "owner-A"); err != nil {
		t.Fatal(err)
	}
	reviewed.Bootstrap.Variables[ownerRecipient] = "owner-B"
	if err := requireApprovedOwnerRecipient(reviewed, sha, "owner-A"); err == nil {
		t.Fatal("an unapproved new recipient would receive the newly issued grant")
	}
}
