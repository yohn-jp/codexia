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
	SchemaVersion      int             `json:"schemaVersion"`
	ObservedAt         time.Time       `json:"observedAt"`
	EvidenceObservedAt *time.Time      `json:"evidenceObservedAt,omitempty"`
	RepositoryID       int64           `json:"repositoryId"`
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
	status := statusReport{SchemaVersion: 1, RepositoryID: targetRepositoryID, Repository: "yohn-jp/codexia",
		Phase: "UNKNOWN", Route: "unknown", Active: "unknown", Accepted: "unknown", OrdinaryUpdate: "unknown",
		Blockers: []string{}, Runs: []observedRun{}, Evidence: []string{}}
	err := inspectReadOnly(ctx, i, &status)
	status.ObservedAt = time.Now().UTC()
	if i.json {
		if err := json.NewEncoder(stdout).Encode(status); err != nil {
			return reportError(ctx, stderr, fmt.Errorf("could not write inspection result"))
		}
	} else {
		fmt.Fprintf(stdout, "%s (%d) VM %s\n%s on %s. Route %s. ACTIVE: %s. ACCEPTED: %s. Ordinary update: %s.\n",
			status.Repository, status.RepositoryID, status.HostID, status.Phase, status.MainSHA,
			status.Route, status.Active, status.Accepted, status.OrdinaryUpdate)
		if status.EvidenceObservedAt != nil {
			fmt.Fprintln(stdout, "Lifecycle evidence observed at", status.EvidenceObservedAt.Format(time.RFC3339Nano))
		}
		for _, blocker := range status.Blockers {
			fmt.Fprintln(stdout, "Blocker:", blocker)
			if guidance := blockerGuidance(blocker); guidance != "" {
				fmt.Fprintln(stdout, "  Next:", guidance)
			}
		}
		if len(status.Runs) > 0 {
			fmt.Fprintln(stdout, "Latest recorded workflow per lane (history available with --json):")
		}
		for _, run := range latestWorkflowSummary(status.Runs) {
			fmt.Fprintln(stdout, " ", run.Workflow, run.Status, run.Conclusion, runLink(run.ID))
		}
	}
	return reportError(ctx, stderr, err)
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
	if i.command == "doctor" || i.plan {
		tty.Notice("READ-ONLY INSPECTION: no VM, Tailnet, Cloudflare, or GitHub settings will be changed. Provider credentials are requested only for temporary API reads and are not stored. Decline a provider to stop safely.")
	}
	gh, err := githubLogin(ctx, tty, githubAppClientID)
	if err != nil {
		report.Blockers = append(report.Blockers, "github-authentication-unverified")
		return err
	}
	defer closeGitHub(ctx, gh)
	snapshot, snapshotErr := gh.Observe(ctx)
	report.MainSHA = snapshot.MainSHA
	reportProtectedInputs(snapshot, report)
	if snapshotErr != nil {
		report.Blockers = append(report.Blockers, "github-environment-or-permission-unverified")
		tty.Notice(snapshotErr.Error())
	}
	settings, err := productionSettings(ctx, snapshot.MainSHA, false)
	if err != nil {
		report.Blockers = append(report.Blockers, "canonical-source-unverified")
		return err
	}
	report.PublicOrigin = settings.PublicOrigin
	runs, err := gh.StatusHistory(ctx)
	if err != nil {
		report.Blockers = append(report.Blockers, "workflow-observation-unavailable")
		return err
	}
	for _, run := range runs {
		report.Runs = append(report.Runs, observedRun{run.ID, run.File, stateValue(run.Status), stateValue(run.Conclusion)})
	}
	observeExistingReceipt(ctx, gh, vm.HostID, runs, time.Now().UTC(), report)
	if i.command == "doctor" || i.plan {
		if err := inspectProviders(ctx, tty, vm, snapshot, settings, report); err != nil {
			return err
		}
	}
	if i.plan {
		tty.Notice("Proposed operations: register missing protected inputs, run protected read-only SSH and lifecycle checks, then follow the admitted route through R4 and R5. Each write and workflow dispatch requires separate approval.")
	}
	if snapshotErr != nil {
		return snapshotErr
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
	case "github-environment-or-permission-unverified":
		return "Settings > Environments: for codexia-bootstrap and codexia-production, require a separate reviewer, prevent self-review, and restrict deployment branches to main. Verify the PAT has Environments read/write. https://github.com/yohn-jp/codexia/settings/environments"
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
	case "canonical-source-unverified":
		return "Verify the exact-release source and current protected workflow contract before running init."
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

func inspectProviders(ctx context.Context, o operator, vm vmObservation, snapshot githubSnapshot, settings productionContract, report *statusReport) error {
	var failures []error
	tailnet, tailErr := prepareTailnet(ctx, o, vm, true)
	if tailErr != nil {
		report.Blockers = append(report.Blockers, "tailnet-identity-or-policy-unverified")
		o.Notice("Tailscale check: " + tailErr.Error())
		failures = append(failures, tailErr)
	} else {
		report.TailnetAddress = tailnet.Address
	}
	var pin string
	if tailErr == nil {
		var pinErr error
		pin, pinErr = vm.ConfirmPin(o, tailnet.Address)
		if pinErr != nil {
			report.Blockers = append(report.Blockers, "ssh-host-pin-unverified")
			o.Notice("SSH identity check: " + pinErr.Error())
			failures = append(failures, pinErr)
		}
	}
	// Cloudflare discovery is independent of a failed Tailscale trust check.
	// Continue gathering read-only evidence instead of requiring another doctor
	// invocation merely to discover the next missing prerequisite.
	edge, edgeErr := observeCloudflare(ctx, o, settings.PublicOrigin)
	if edgeErr != nil {
		report.Blockers = append(report.Blockers, "cloudflare-edge-unverified")
		o.Notice("Cloudflare check: " + edgeErr.Error())
		failures = append(failures, edgeErr)
	} else {
		defer edge.Close()
		if verifyErr := verifyInitialEdge(ctx, vm, edge); verifyErr != nil {
			report.Blockers = append(report.Blockers, "edge-initial-install-unverified")
			o.Notice("Cloudflare edge check: " + verifyErr.Error())
			failures = append(failures, verifyErr)
		}
	}
	if len(failures) != 0 {
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
	if len(missing)+len(missingSecrets(snapshot)) > 0 {
		report.Blockers = append(report.Blockers, "protected-inputs-missing")
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
	report.Evidence = append(report.Evidence, runLink(receipt.RunID))
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
	receipt, err := readReceipt(ctx, gh, latest.ID)
	if err != nil || (receipt.Management != "runtime" && receipt.Management != "bootstrap") ||
		receipt.validateObservation(report.MainSHA, latest.ID, receipt.Management, host, report.PublicOrigin, now) != nil {
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
