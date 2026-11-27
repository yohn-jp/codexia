package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

type statusReport struct {
	SchemaVersion   int             `json:"schemaVersion"`
	ObservedAt      time.Time       `json:"observedAt"`
	RepositoryID    int64           `json:"repositoryId"`
	Repository      string          `json:"repository"`
	HostID          string          `json:"hostId,omitempty"`
	MainSHA         string          `json:"mainSha,omitempty"`
	PublicOrigin    string          `json:"publicOrigin,omitempty"`
	Clock           string          `json:"clock,omitempty"`
	TailnetAddress  string          `json:"tailnetAddress,omitempty"`
	Phase           string          `json:"phase"`
	Route           string          `json:"route"`
	Active          string          `json:"active"`
	Accepted        string          `json:"accepted"`
	OrdinaryUpdate  string          `json:"ordinaryUpdate"`
	Blockers        []string        `json:"blockers"`
	ProtectedInputs map[string]bool `json:"protectedInputs,omitempty"`
	Runs            []observedRun   `json:"runs"`
	Evidence        []string        `json:"evidence"`
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
		for _, blocker := range status.Blockers {
			fmt.Fprintln(stdout, "Blocker:", blocker)
		}
		for _, run := range status.Runs {
			fmt.Fprintln(stdout, run.Workflow, run.Status, run.Conclusion, runLink(run.ID))
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
	gh, err := githubLogin(ctx, tty, githubAppClientID)
	if err != nil {
		report.Blockers = append(report.Blockers, "github-authentication-unverified")
		return err
	}
	defer closeGitHub(ctx, gh)
	snapshot, snapshotErr := gh.Observe(ctx)
	report.MainSHA = snapshot.MainSHA
	report.ProtectedInputs = make(map[string]bool)
	for _, item := range protectedSecrets() {
		if inventory := selectEnvironment(snapshot, item.environment).Secrets; inventory != nil {
			report.ProtectedInputs[item.environment+"/"+item.name] = inventory[item.name]
		}
	}
	for _, item := range protectedVariables("", "", "", "") {
		if inventory := selectEnvironment(snapshot, item.environment).Variables; inventory != nil {
			_, report.ProtectedInputs[item.environment+"/"+item.name] = inventory[item.name]
		}
	}
	switch snapshot.Production.Variables["CODEXIA_PUSH_DEPLOYMENT_ENABLED"] {
	case "true":
		report.OrdinaryUpdate = "enabled-unverified"
	case "", "false":
		if snapshot.Production.Variables != nil {
			report.OrdinaryUpdate = "disabled"
		}
	}
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
	runs, err := gh.Recent(ctx)
	if err != nil {
		report.Blockers = append(report.Blockers, "workflow-observation-unavailable")
		return err
	}
	for _, run := range runs {
		report.Runs = append(report.Runs, observedRun{run.ID, run.File, stateValue(run.Status), stateValue(run.Conclusion)})
	}
	observeExistingReceipt(ctx, gh, vm.HostID, report)
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

func inspectProviders(ctx context.Context, o operator, vm vmObservation, snapshot githubSnapshot, settings productionContract, report *statusReport) error {
	tailnet, err := prepareTailnet(ctx, o, vm, true)
	if err != nil {
		report.Blockers = append(report.Blockers, "tailnet-identity-or-policy-unverified")
		return err
	}
	report.TailnetAddress = tailnet.Address
	pin, err := vm.ConfirmPin(o, tailnet.Address)
	if err != nil {
		report.Blockers = append(report.Blockers, "ssh-host-pin-unverified")
		return err
	}
	edge, err := observeCloudflare(ctx, o, settings.PublicOrigin)
	if err != nil {
		report.Blockers = append(report.Blockers, "cloudflare-edge-unverified")
		return err
	}
	defer edge.Close()
	if err := verifyInitialEdge(ctx, vm, edge); err != nil {
		report.Blockers = append(report.Blockers, "edge-initial-install-unverified")
		return err
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

func observeExistingReceipt(ctx context.Context, gh *githubControl, host string, report *statusReport) {
	for _, run := range report.Runs {
		if run.Workflow != preflightFile || run.Status != "completed" || run.Conclusion != "success" {
			continue
		}
		metadata, err := gh.Run(ctx, preflightFile, report.MainSHA, run.ID)
		if err != nil || metadata.Attempt != 1 {
			continue
		}
		jobs, err := gh.Jobs(ctx, run.ID, 1)
		if err != nil || verifyJobs(metadata, operations["lifecycle"], jobs) != nil {
			continue
		}
		r, err := readReceipt(ctx, gh, run.ID)
		if err != nil || (r.Management != "runtime" && r.Management != "bootstrap") ||
			r.validateObservation(report.MainSHA, run.ID, r.Management, host, report.PublicOrigin, time.Now()) != nil {
			continue
		}
		report.Evidence = append(report.Evidence, runLink(run.ID))
		switch r.Plan.CandidateRoute {
		case "R0", "R1", "R2", "R3", "R4", "R5", "R6", "R8":
			report.Route = r.Plan.CandidateRoute
		}
		s := r.Plan.Observation.State
		switch {
		case r.setupForDelivery():
			report.Phase, report.Active, report.Accepted = "SETUP_PENDING", "false", "false"
		case s.A == "ready" && s.B == "compatible" && s.F == "compatible" && r.Evidence.Edge.Backend != nil &&
			r.Evidence.Edge.Backend.StandaloneOAuth && s.T == "none":
			report.Phase, report.Active = "ACTIVE", "true"
			if report.OrdinaryUpdate == "enabled-unverified" && r.Plan.Route == "R8" && len(r.Plan.Blockers) == 0 {
				report.OrdinaryUpdate = "r8-admitted-recovery-unverified"
			}
			// Actual independent recovery evidence is owned by the recovery operator.
			report.Blockers = append(report.Blockers, "independent-restore-acceptance-unverified")
		case s.A == "ready" && s.B == "absent":
			report.Phase, report.Active, report.Accepted = "ACTIVATION_READY", "false", "false"
		case s.H == "ready" && s.D == "compatible" && s.A == "pending" && s.B == "absent":
			report.Phase, report.Active, report.Accepted = "BOOTSTRAPPED", "false", "false"
		default:
			report.Blockers = append(report.Blockers, "live-deployment-state-unverified")
		}
		return
	}
	report.Blockers = append(report.Blockers, "fresh-target-lifecycle-evidence-unavailable")
}
