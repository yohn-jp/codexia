package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
)

type statusReport struct {
	SchemaVersion      int        `json:"schemaVersion"`
	ObservedAt         time.Time  `json:"observedAt"`
	EvidenceObservedAt *time.Time `json:"evidenceObservedAt,omitempty"`
	RepositoryID       int64      `json:"repositoryId"`
	OwnerID            int64      `json:"ownerId,omitempty"`
	InstallationID     int64      `json:"installationId,omitempty"`
	target             githubTarget
	Repository         string          `json:"repository"`
	HostID             string          `json:"hostId,omitempty"`
	MainSHA            string          `json:"mainSha,omitempty"`
	PublicOrigin       string          `json:"publicOrigin,omitempty"`
	Clock              string          `json:"clock,omitempty"`
	TailnetAddress     string          `json:"tailnetAddress,omitempty"`
	Phase              string          `json:"phase"`
	Route              string          `json:"route"`
	Active             string          `json:"active"`
	Accepted           string          `json:"accepted"`
	OrdinaryUpdate     string          `json:"ordinaryUpdate"`
	Blockers           []string        `json:"blockers"`
	ProtectedInputs    map[string]bool `json:"protectedInputs,omitempty"`
	Runs               []observedRun   `json:"runs"`
	Evidence           []string        `json:"evidence"`
}

type observedRun struct {
	ID         int64  `json:"id"`
	Workflow   string `json:"workflow"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion,omitempty"`
}

func readOnly(ctx context.Context, i invocation, stdout, stderr io.Writer) int {
	status := statusReport{SchemaVersion: 1,
		Phase: "UNKNOWN", Route: "unknown", Active: "unknown", Accepted: "unknown", OrdinaryUpdate: "unknown",
		Blockers: []string{}, Runs: []observedRun{}, Evidence: []string{}}
	err := inspectReadOnly(ctx, i, &status)
	status.ObservedAt = time.Now().UTC()
	if i.json {
		if err := json.NewEncoder(stdout).Encode(status); err != nil {
			return reportError(ctx, stderr, fmt.Errorf("could not write inspection result"))
		}
	} else {
		renderStatus(stdout, status)
	}
	return reportError(ctx, stderr, err)
}

func renderStatus(out io.Writer, status statusReport) {
	repo := status.Repository
	if repo == "" {
		repo = "repository unverified"
	} else {
		repo = fmt.Sprintf("%s (%d)", repo, status.RepositoryID)
	}
	printTerminalLine(out, headingText, fmt.Sprintf("%s | VM %s", repo, stateValue(status.HostID)))
	printTerminalLine(out, bodyText, fmt.Sprintf("%s on %s | Route %s | ACTIVE: %s | ACCEPTED: %s | Ordinary update: %s",
		status.Phase, stateValue(status.MainSHA), status.Route, status.Active, status.Accepted, status.OrdinaryUpdate))
	if status.PublicOrigin != "" {
		printTerminalLine(out, detailText, "Public origin "+status.PublicOrigin)
	}
	if status.EvidenceObservedAt != nil {
		printTerminalLine(out, detailText, "Lifecycle evidence observed at "+status.EvidenceObservedAt.Format(time.RFC3339Nano))
	}
	for _, blocker := range status.Blockers {
		printTerminalLine(out, warningText, "Blocker: "+blocker)
		if guidance := blockerGuidance(blocker); guidance != "" {
			printTerminalLine(out, bodyText, "  Next: "+guidance)
		}
	}
	if len(status.Runs) > 0 {
		printTerminalLine(out, headingText, "Latest recorded workflow per lane (history available with --json)")
	}
	for _, run := range latestWorkflowSummary(status.Runs) {
		printTerminalLine(out, bodyText, fmt.Sprintf("  %s | %s | %s | %s", run.Workflow, run.Status,
			stateValue(run.Conclusion), status.target.runLink(run.ID)))
	}
}

func inspectReadOnly(ctx context.Context, i invocation, report *statusReport) error {
	vm, err := observeVM(ctx)
	if err != nil {
		report.Blockers = append(report.Blockers, "target-vm-unverified")
		return err
	}
	report.HostID, report.Clock = vm.HostID, vm.Clock
	tty, err := openTerminal()
	if err != nil {
		report.Blockers = append(report.Blockers, "interactive-authentication-required")
		return needsAction("Read-only provider observations require an SSH terminal for one-time authentication")
	}
	defer tty.Close()
	tty.bindContext(ctx)
	reportResult(tty, headingText, "CodexiaCTL | "+version+" | read-only inspection")
	reportStage(tty, vmStage, "Check local SSH session, OS, clock and administrator access")
	reportResult(tty, successText, "Local VM observed; clock "+vm.Clock)
	if i.command == "doctor" || i.plan {
		tty.Notice("READ-ONLY INSPECTION: no VM, Tailnet, Cloudflare, or GitHub settings will be changed. Provider credentials are requested only for temporary API reads and are not stored. Decline a provider to stop safely.")
	}
	reportStage(tty, githubStage, "Authenticate and inspect the selected repository")
	gh, err := githubLogin(ctx, tty, githubAppClientID)
	if err != nil {
		report.Blockers = append(report.Blockers, "github-authentication-unverified")
		return err
	}
	defer closeGitHub(ctx, gh)
	state, err := readCheckpoint(vm.HostID)
	if err != nil {
		report.Blockers = append(report.Blockers, "checkpoint-identity-unverified")
		return err
	}
	settings, err := gh.selectTarget(ctx, tty, vm, state)
	if err != nil {
		report.Blockers = append(report.Blockers, "github-target-or-contract-unverified")
		return err
	}
	report.target = gh.target
	report.Repository, report.RepositoryID, report.OwnerID, report.InstallationID =
		gh.target.FullName(), gh.target.RepoID, gh.target.OwnerID, gh.target.InstallationID
	report.PublicOrigin = settings.PublicOrigin
	oidcErr := gh.verifyOIDC(ctx)
	if oidcErr != nil {
		report.Blockers = append(report.Blockers, "github-immutable-oidc-unverified")
		reportResult(tty, warningText, oidcErr.Error())
	}
	snapshot, snapshotErr := gh.Observe(ctx)
	report.MainSHA = snapshot.MainSHA
	targetErr := validateProtectedCloudflareTarget(snapshot, gh.target, settings.PublicOrigin)
	if targetErr != nil {
		report.Blockers = append(report.Blockers, "existing-protected-input-mismatch")
		reportResult(tty, warningText, targetErr.Error())
	}
	reportProtectedInputs(snapshot, report)
	if snapshotErr != nil {
		report.Blockers = append(report.Blockers, "github-environment-or-permission-unverified")
		reportResult(tty, warningText, snapshotErr.Error())
	}
	if snapshotErr == nil && oidcErr == nil && targetErr == nil {
		reportResult(tty, successText, "Repository, Environment restrictions and immutable OIDC verified")
	}
	if snapshot.MainSHA != gh.approvedSHA {
		report.Blockers = append(report.Blockers, "github-target-or-contract-unverified")
		return refused("GitHub main changed after deployment target confirmation")
	}
	runs, historyErr := gh.StatusHistory(ctx)
	if historyErr != nil {
		report.Blockers = append(report.Blockers, "workflow-observation-unavailable")
	}
	for _, run := range runs {
		report.Runs = append(report.Runs, observedRun{run.ID, run.File, stateValue(run.Status), stateValue(run.Conclusion)})
	}
	if historyErr == nil {
		observeExistingReceipt(ctx, gh, vm.HostID, runs, time.Now().UTC(), report)
	}
	var providerErr error
	if i.command == "doctor" || i.plan {
		providerErr = inspectProviders(ctx, tty, vm, gh, snapshot, settings, report)
	}
	if i.plan {
		tty.Notice("If the prerequisites are satisfied, init reviews missing protected inputs, requests the management SSH and lifecycle checks, then uses the admitted R4 and R5 route.")
		tty.Notice("Workflows: " + bootstrapFile + " for SSH, R4 and Owner setup; " + preflightFile + " for lifecycle evidence; " + frontendFile + " for initial Frontend publication.")
		tty.Notice("Each write and dispatch requires explicit approval in the terminal. Optional GitHub Environment protection, if configured, still applies.")
	}
	if err := errors.Join(snapshotErr, oidcErr, targetErr, historyErr, providerErr); err != nil {
		return err
	}
	if len(report.Blockers) > 0 {
		if i.plan {
			return needsAction("Review the reported prerequisites before running init")
		}
		return needsAction("Some required observations are unavailable or blocked")
	}
	return nil
}

// Status retains all fetched evidence for fail-closed lifecycle checks. A human
// gets one recent run per workflow instead of dozens of irrelevant older runs.
func latestWorkflowSummary(runs []observedRun) []observedRun {
	seen := make(map[string]bool)
	var result []observedRun
	for _, run := range runs {
		if seen[run.Workflow] {
			continue
		}
		seen[run.Workflow] = true
		result = append(result, run)
	}
	return result
}

func blockerGuidance(blocker string) string {
	switch blocker {
	case "interactive-authentication-required":
		return "Reconnect to the target VM over a real interactive SSH terminal (ssh -t), not a pipe or CI stdin. Read-only provider access is authenticated through /dev/tty."
	case "github-authentication-unverified":
		return "Install the official Codexia GitHub App on only the intended codexia repository at " + githubAppInstallationURL + ", then reconnect with Device Flow."
	case "independent-restore-acceptance-unverified":
		return "The app can be ACTIVE, but ACCEPTED requires independent verified backup restoration and protected recovery evidence. Use the existing Backup and Restore runbooks; a green CI job is insufficient."
	case "live-deployment-state-unverified":
		return "The latest signed Preflight did not prove a known Bootstrap/Activation/ACTIVE state. Review the exact plan and live VM evidence before issuing a new deployment; do not initialize an unknown DB."
	case "github-environment-or-permission-unverified":
		return "Settings > Environments: for codexia-bootstrap and codexia-production, restrict deployment branches to main. Required reviewers and Prevent self-review are optional. Verify the official GitHub App and authenticated user can access these settings in the selected repository."
	case "latest-target-lifecycle-evidence-unavailable":
		return "No current, exact-main Preflight receipt is proven for this VM. A first installation needs init to request a fresh protected Preflight; an existing installation needs operator recovery evidence. Older successful runs do not authorize changes."
	case "tailnet-identity-or-policy-unverified":
		return "Review the exact OIDC subject, auth_keys-only scope, tag:ci and main-workflow claims at " + wifTrustConsole + ". For a missing credential, init can offer a separate, scoped one after approval; doctor and --plan never create it."
	case "ssh-host-pin-unverified":
		return "Compare the VM's SSH host key fingerprint with the independent SSH client/provider console; never disable strict host-key verification."
	case "cloudflare-edge-unverified", "edge-initial-install-unverified":
		return "Inspect the account, zone, Tunnel, Access and Worker for the configured production origin. Changes to Terraform-owned resources must use the existing IaC path."
	case "protected-inputs-missing":
		return "Missing GitHub Environment inputs are reported before any write. Run init only after reviewing the target and supplying the approved, minimum-scope provider credentials."
	case "existing-protected-input-mismatch":
		return "The live target differs from existing protected GitHub inputs. Do not overwrite them automatically; reconcile the owning environment first."
	case "protected-input-inventory-unavailable":
		return "GitHub returned no complete secret/variable inventory. Restore the read permissions before planning changes."
	case "newer-or-unresolved-protected-deployment-activity":
		return "A newer protected operation may have changed the VM. Confirm the latest run, then request a fresh Preflight with init."
	case "workflow-observation-unavailable":
		return "Check GitHub Actions read permission and API availability for the target repository."
	case "github-target-or-contract-unverified":
		return "Verify the exact-release source and current protected workflow contract before running init."
	case "github-immutable-oidc-unverified":
		return "Check the default immutable OIDC subject in the selected repository's settings and the App's Administration read permission."
	case "checkpoint-identity-unverified":
		return "Reconcile any earlier local checkpoint and its repository binding through the protected deployment runbook."
	case "target-vm-unverified":
		return "Run from an independently authenticated non-root SSH terminal on the supported Ubuntu x86-64 target."
	}
	return ""
}

func reportProtectedInputs(snapshot githubSnapshot, report *statusReport) {
	report.ProtectedInputs = make(map[string]bool)
	for _, item := range protectedSecrets() {
		if inventory := selectEnvironment(snapshot, item.environment).Secrets; inventory != nil {
			report.ProtectedInputs[item.environment+"/"+item.name] = inventory[item.name]
		}
	}
	for _, item := range append(protectedVariables("", "", "", ""),
		environmentInput{bootstrapEnvironment, wifClientIDInput, ""},
		environmentInput{productionEnvironment, wifClientIDInput, ""}) {
		if inventory := selectEnvironment(snapshot, item.environment).Variables; inventory != nil {
			_, report.ProtectedInputs[item.environment+"/"+item.name] = inventory[item.name]
		}
	}
	report.OrdinaryUpdate = "unknown"
	if vars := snapshot.Production.Variables; vars != nil {
		switch vars["CODEXIA_PUSH_DEPLOYMENT_ENABLED"] {
		case "true":
			report.OrdinaryUpdate = "enabled-unverified"
		case "", "false":
			report.OrdinaryUpdate = "disabled"
		}
	}
}

func inspectProviders(ctx context.Context, o operator, vm vmObservation, gh *githubControl, snapshot githubSnapshot, settings productionContract, report *statusReport) error {
	var failures []error
	reportStage(o, tailnetStage, "Inspect Tailnet identity and CI SSH/OIDC trust")
	tailnet, tailErr := prepareTailnet(ctx, o, vm, gh, snapshot, true)
	if ctx.Err() != nil || errors.Is(tailErr, errTerminalInterrupt) {
		return errors.Join(ctx.Err(), tailErr)
	}
	if tailErr != nil {
		report.Blockers = append(report.Blockers, "tailnet-identity-or-policy-unverified")
		reportResult(o, warningText, "Tailscale check: " + tailErr.Error())
		failures = append(failures, tailErr)
	} else {
		report.TailnetAddress = tailnet.Address
	}
	var pin string
	if tailErr == nil {
		var pinErr error
		pin, pinErr = vm.ConfirmPin(o, tailnet.Address)
		if ctx.Err() != nil || errors.Is(pinErr, errTerminalInterrupt) {
			return errors.Join(ctx.Err(), pinErr)
		}
		if pinErr != nil {
			report.Blockers = append(report.Blockers, "ssh-host-pin-unverified")
			reportResult(o, warningText, "SSH identity check: " + pinErr.Error())
			failures = append(failures, pinErr)
		}
	}
	// Cloudflare discovery is independent of a failed Tailscale trust check.
	// Continue gathering read-only evidence instead of requiring another doctor
	// invocation merely to discover the next missing prerequisite.
	reportStage(o, cloudflareStage, "Inspect DNS, Tunnel, Access and Workers")
	edge, edgeErr := observeCloudflare(ctx, o, gh.target, settings)
	if edgeErr != nil {
		report.Blockers = append(report.Blockers, "cloudflare-edge-unverified")
		reportResult(o, warningText, "Cloudflare check: " + edgeErr.Error())
		failures = append(failures, edgeErr)
	} else {
		defer edge.Close()
		if verifyErr := verifyInitialEdge(ctx, vm, edge); verifyErr != nil {
			report.Blockers = append(report.Blockers, "edge-initial-install-unverified")
			reportResult(o, warningText, "Cloudflare edge check: " + verifyErr.Error())
			failures = append(failures, verifyErr)
		} else {
			reportResult(o, successText, "Cloudflare edge verified")
		}
	}
	reportStage(o, settingsStage, "Compare protected inputs with observed provider identity")
	if len(failures) != 0 {
		reportResult(o, warningText, "Input comparison incomplete because a provider check failed")
		return errors.Join(failures...)
	}
	if snapshot.Bootstrap.Variables == nil || snapshot.Production.Variables == nil ||
		snapshot.Bootstrap.Secrets == nil || snapshot.Production.Secrets == nil {
		report.Blockers = append(report.Blockers, "protected-input-inventory-unavailable")
		return nil
	}
	desired, err := observedProtectedVariables(snapshot, vm, tailnet, pin, edge.Target)
	if err != nil {
		report.Blockers = append(report.Blockers, "existing-protected-input-mismatch")
		return err
	}
	missing, err := missingVariables(snapshot, desired)
	if err != nil {
		report.Blockers = append(report.Blockers, "existing-protected-input-mismatch")
		return err
	}
	absent := append(missing, missingSecrets(snapshot)...)
	if len(absent) > 0 {
		report.Blockers = append(report.Blockers, "protected-inputs-missing")
		for _, input := range absent {
			reportResult(o, warningText, "Missing protected input "+input.environment+"/"+input.name)
		}
	} else {
		reportResult(o, successText, "Required protected input inventory verified")
	}
	return nil
}

func observeExistingReceipt(ctx context.Context, gh workflowGitHub, host string, runs []githubRunSummary, now time.Time, report *statusReport) {
	receipt, ok := latestStatusReceipt(ctx, gh, host, runs, now, report)
	if !ok {
		report.Blockers = append(report.Blockers, "latest-target-lifecycle-evidence-unavailable")
		return
	}
	observed := receipt.Plan.Observation.ObservedAt.UTC()
	if protectedDeploymentMaySupersede(runs, now, observed) {
		report.Blockers = append(report.Blockers, "newer-or-unresolved-protected-deployment-activity")
		return
	}
	report.EvidenceObservedAt = &observed
	report.Evidence = append(report.Evidence, report.target.runLink(receipt.RunID))
	switch receipt.Plan.CandidateRoute {
	case "R0", "R1", "R2", "R3", "R4", "R5", "R6", "R8":
		report.Route = receipt.Plan.CandidateRoute
	}
	state := receipt.Plan.Observation.State
	switch {
	case receipt.setupForDelivery():
		report.Phase, report.Active, report.Accepted = "SETUP_PENDING", "false", "false"
	case state.A == "ready" && state.B == "compatible" && state.F == "compatible" && receipt.Evidence.Edge.Backend != nil &&
		receipt.Evidence.Edge.Backend.StandaloneOAuth && state.T == "none":
		report.Phase, report.Active = "ACTIVE", "true"
		if report.OrdinaryUpdate == "enabled-unverified" && receipt.Plan.Route == "R8" && len(receipt.Plan.Blockers) == 0 {
			report.OrdinaryUpdate = "r8-admitted-recovery-unverified"
		}
		// Actual independent recovery evidence is owned by the recovery operator.
		report.Blockers = append(report.Blockers, "independent-restore-acceptance-unverified")
	case state.A == "ready" && state.B == "absent":
		report.Phase, report.Active, report.Accepted = "ACTIVATION_READY", "false", "false"
	case state.H == "ready" && state.D == "compatible" && state.A == "pending" && state.B == "absent":
		report.Phase, report.Active, report.Accepted = "BOOTSTRAPPED", "false", "false"
	default:
		report.Blockers = append(report.Blockers, "live-deployment-state-unverified")
	}
}

func latestStatusReceipt(ctx context.Context, gh workflowGitHub, host string, runs []githubRunSummary, now time.Time, report *statusReport) (lifecycleReceipt, bool) {
	var latest githubRunSummary
	tied := false
	var latestActivity time.Time
	for _, run := range runs {
		if run.File != preflightFile {
			continue
		}
		if !knownStatusRunTime(run, now) {
			return lifecycleReceipt{}, false
		}
		if run.UpdatedAt.After(latestActivity) {
			latestActivity = run.UpdatedAt
		}
		if run.CreatedAt.After(latest.CreatedAt) {
			latest, tied = run, false
		} else if run.CreatedAt.Equal(latest.CreatedAt) && run.ID != latest.ID {
			tied = true
		}
	}
	// A failed, queued, skipped, or unbound latest observation ends this
	// projection. An earlier success cannot substitute for it.
	if tied || latest.ID == 0 || latest.SHA != report.MainSHA || latest.Status != "completed" || latest.Conclusion != "success" ||
		latest.UpdatedAt.Before(latestActivity) {
		return lifecycleReceipt{}, false
	}
	metadata, err := gh.Run(ctx, preflightFile, report.MainSHA, latest.ID)
	if err != nil || metadata.Attempt != 1 || metadata.Status != "completed" || metadata.Conclusion != "success" {
		return lifecycleReceipt{}, false
	}
	jobs, err := gh.Jobs(ctx, latest.ID, 1)
	if err != nil || verifyJobs(metadata, operations["lifecycle"], jobs) != nil {
		return lifecycleReceipt{}, false
	}
	receipt, err := readReceipt(ctx, gh, report.target, latest.ID)
	if err != nil || (receipt.Management != "runtime" && receipt.Management != "bootstrap") ||
		receipt.validateObservation(report.target, report.MainSHA, latest.ID, receipt.Management, host, report.PublicOrigin, now) != nil {
		return lifecycleReceipt{}, false
	}
	return receipt, true
}

func knownStatusRunTime(run githubRunSummary, now time.Time) bool {
	return !run.CreatedAt.IsZero() && !run.UpdatedAt.Before(run.CreatedAt) && !run.UpdatedAt.After(now)
}

func protectedDeploymentMaySupersede(runs []githubRunSummary, now, observed time.Time) bool {
	for _, run := range runs {
		switch run.File {
		case bootstrapFile:
			if run.DisplayTitle == "Production bootstrap [preflight] Preflight none" {
				continue
			}
		case frontendFile, githubBackendHandoffFile:
		default:
			continue
		}
		// A failing deployment can have reached a mutation before it failed.
		if !knownStatusRunTime(run, now) || run.Status != "completed" || !run.UpdatedAt.Before(observed.Truncate(time.Second)) {
			return true
		}
	}
	return false
}
