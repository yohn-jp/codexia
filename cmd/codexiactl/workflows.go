package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"strconv"
	"strings"
	"time"
)

const (
	bootstrapEnvironment  = "codexia-bootstrap"
	productionEnvironment = "codexia-production"
	bootstrapFile         = "production-bootstrap.yml"
	preflightFile         = "production-preflight.yml"
	frontendFile          = "frontend-release.yml"
)

type workflowOperation struct {
	label  string
	file   string
	inputs map[string]string
	jobs   []string
}

var operations = map[string]workflowOperation{
	"management": {label: "Management connection check", file: bootstrapFile, inputs: map[string]string{"mode": "preflight"},
		jobs: []string{"Protected production controller (preflight)"}},
	"lifecycle": {label: "Lifecycle Preflight", file: preflightFile, inputs: map[string]string{"mode": "lifecycle", "intent": "install"},
		jobs: []string{"Verify certified candidate pair before observing the production host",
			"Observe the pinned production host without mutation",
			"Compute the read-only lifecycle plan from fresh host and certified candidate evidence"}},
	"bootstrap": {label: "R4 Bootstrap", file: bootstrapFile, inputs: map[string]string{"mode": "bootstrap", "approval_phrase": "BOOTSTRAP_CODEXIA"},
		jobs: []string{"Derive the existing runtime SSH public key before R4", "Protected production controller (bootstrap)",
			"Protected runtime operation (bootstrap)"}},
	"frontend": {label: "R5 Frontend publication", file: frontendFile, inputs: map[string]string{"approval_phrase": "PUBLISH_INITIAL_FRONTEND"},
		jobs: []string{"Publish canonical frontend for initial owner enrollment"}},
	"owner-setup": {label: "R5 Owner setup", file: bootstrapFile, inputs: map[string]string{"mode": "owner-setup", "approval_phrase": "OWNER_SETUP_CODEXIA"},
		jobs: []string{"Protected production controller (owner-setup)"}},
}

type workflowGitHub interface {
	Main(context.Context) (string, error)
	Dispatch(context.Context, string, string, map[string]string) (int64, error)
	Run(context.Context, string, string, int64) (githubRun, error)
	Jobs(context.Context, int64, int) (map[string]string, error)
	Artifact(context.Context, int64, string, string) ([]byte, error)
}

type checkpointWriter interface {
	Save(checkpoint) error
}

type workflowController struct {
	target              githubTarget
	github              workflowGitHub
	operator            operator
	store               checkpointWriter
	state               checkpoint
	settingsWindow      *githubSecretWriteWindow
	sha, hostID, origin string
}

func (t githubTarget) runLink(id int64) string {
	return t.URL() + "/actions/runs/" + strconv.FormatInt(id, 10)
}

func (c *workflowController) currentMain(ctx context.Context) error {
	current, err := c.github.Main(ctx)
	if err != nil {
		return err
	}
	if current != c.sha || !sourceHash.MatchString(current) {
		return refused("GitHub main advanced. Re-observe the target before approving any operation")
	}
	return nil
}

func (c *workflowController) dispatch(ctx context.Context, operation string, inputs map[string]string) (int64, error) {
	if c.state.Pending {
		return 0, needsAction("A previous dispatch is unresolved. Reconcile it before continuing")
	}
	if err := c.currentMain(ctx); err != nil {
		return 0, err
	}
	spec, ok := operations[operation]
	if !ok {
		return 0, refused("Unsupported workflow operation")
	}
	dispatchInputs := maps.Clone(spec.inputs)
	maps.Copy(dispatchInputs, inputs)
	c.state.MainSHA, c.state.Operation, c.state.RunID = c.sha, operation, 0
	c.state.Pending, c.state.StartedAt = true, time.Now().UTC()
	c.state.PreflightRunID, _ = strconv.ParseInt(dispatchInputs["preflight_run_id"], 10, 64)
	if err := c.store.Save(c.state); err != nil {
		return 0, err
	}
	id, err := c.github.Dispatch(ctx, spec.file, c.sha, dispatchInputs)
	if err != nil && !errors.Is(err, errGitHubDispatchUnknown) && ctx.Err() == nil {
		return 0, errors.Join(err, c.clearDispatch())
	}
	if err != nil || id < 1 {
		return 0, needsAction(spec.label + " dispatch result is unresolved. Review " + c.target.URL() + "/actions/workflows/" +
			spec.file + " before running codexiactl init again to reconcile the request")
	}
	c.state.RunID = id
	if err := c.store.Save(c.state); err != nil {
		return 0, fmt.Errorf("could not checkpoint workflow %s", c.target.runLink(id))
	}
	c.operator.Notice(spec.label + " submitted: " + c.target.runLink(id) + ". If optional Environment protection is configured, use Review deployments on this run as required by GitHub.")
	return id, nil
}

func (c *workflowController) clearDispatch() error {
	c.state.Operation, c.state.RunID, c.state.Pending = "", 0, false
	c.state.StartedAt = time.Time{}
	c.state.PreflightRunID = 0
	return c.store.Save(c.state)
}

func verifyJobs(run githubRun, spec workflowOperation, jobs map[string]string) error {
	if run.Attempt != 1 || run.Status != "completed" {
		return refused("Expected a completed first-attempt workflow")
	}
	if run.Conclusion != "success" {
		return needsAction("The workflow concluded " + stateValue(run.Conclusion) + ". Inspect the run and its first failed or unexecuted job before resuming")
	}
	for _, job := range spec.jobs {
		if jobs[job] != "success" {
			return needsAction(fmt.Sprintf("Required job %q concluded %s. Inspect the job and resolve the gating condition before resuming", job, stateValue(jobs[job])))
		}
	}
	return nil
}

func (c *workflowController) wait(ctx context.Context, operation, sha string, id int64) (bool, error) {
	spec, ok := operations[operation]
	if !ok || id < 1 {
		return false, refused("The previous dispatch cannot be identified")
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Minute)
	defer cancel()
	waitFor := 5 * time.Second
	initialDeadline := time.Now().Add(time.Minute)
	lastStatus := ""
	for {
		run, err := c.github.Run(ctx, spec.file, sha, id)
		if err != nil {
			retry := githubRetryAfter(err)
			if errors.Is(err, errGitHubRunUnavailable) && time.Now().Before(initialDeadline) {
				retry = max(retry, waitFor)
			}
			if retry > 0 {
				if err := sleepContext(ctx, max(waitFor, retry)); err == nil {
					continue
				}
			}
			return false, fmt.Errorf("cannot confirm workflow %s: %w", c.target.runLink(id), err)
		}
		if run.Attempt != 1 {
			return run.Status == "completed", refused("Workflow was rerun. Review " + c.target.runLink(id) + " and generate new lifecycle evidence")
		}
		if run.Status == "completed" {
			if run.Conclusion != "success" {
				return true, fmt.Errorf("%s: %w", c.target.runLink(id), verifyJobs(run, spec, nil))
			}
			jobs, err := c.github.Jobs(ctx, id, run.Attempt)
			if err != nil {
				return false, fmt.Errorf("could not verify jobs in %s: %w", c.target.runLink(id), err)
			}
			if err := verifyJobs(run, spec, jobs); err != nil {
				return true, fmt.Errorf("%s: %w", c.target.runLink(id), err)
			}
			reportResult(c.operator, successText, spec.label+" jobs verified: "+c.target.runLink(id))
			return true, nil
		}
		if run.Status != lastStatus {
			c.operator.Notice(fmt.Sprintf("%s is %s: %s.", spec.label, stateValue(run.Status), c.target.runLink(id)))
			lastStatus = run.Status
		}
		if err := sleepContext(ctx, waitFor); err != nil {
			return false, needsAction("Workflow " + c.target.runLink(id) + " is unresolved. Run init again to resume observation")
		}
		waitFor = min(waitFor+2*time.Second, 15*time.Second)
	}
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (c *workflowController) execute(ctx context.Context, operation string, inputs map[string]string) (int64, error) {
	id, err := c.dispatch(ctx, operation, inputs)
	if err != nil {
		return 0, err
	}
	terminal, err := c.wait(ctx, operation, c.sha, id)
	if terminal {
		if err == nil {
			c.recordSuccessfulOperation(operation, id)
		}
		err = errors.Join(err, c.clearDispatch())
	}
	return id, err
}

func (c *workflowController) preflight(ctx context.Context, management string) (lifecycleReceipt, int64, error) {
	if err := requireApproval(c.operator, "Run read-only lifecycle Preflight on "+c.target.FullName()+" main using the "+management+" SSH identity? GitHub may enforce optional Environment protection configured by the maintainer."); err != nil {
		return lifecycleReceipt{}, 0, err
	}
	id, err := c.execute(ctx, "lifecycle", map[string]string{"management": management})
	if id == 0 {
		return lifecycleReceipt{}, 0, err
	}
	receipt, evidenceErr := readReceipt(ctx, c.github, c.target, id)
	if err != nil {
		if evidenceErr == nil && len(receipt.Plan.Blockers) > 0 {
			c.operator.Notice("Lifecycle blockers in " + c.target.runLink(id) + ": " + safeBlockers(receipt.Plan.Blockers))
		}
		if evidenceErr == nil && (receipt.Plan.Observation.State.A == "ready" || receipt.Plan.Observation.State.A == "unprepared") &&
			receipt.validate(c.target, c.sha, id, management, c.hostID, c.origin, time.Now()) == nil {
			return receipt, id, c.lifecycleBlocker(id, errExistingOwner)
		}
		c.operator.Notice("If the certified Backend or compatible Frontend is missing, review the selected repository's existing Verify and Release workflows at " +
			c.target.URL() + "/actions, then rerun codexiactl init.")
		return lifecycleReceipt{}, id, err
	}
	if evidenceErr != nil {
		return lifecycleReceipt{}, id, evidenceErr
	}
	if err := c.currentMain(ctx); err != nil {
		return lifecycleReceipt{}, id, err
	}
	if err := receipt.validate(c.target, c.sha, id, management, c.hostID, c.origin, time.Now()); err != nil {
		return receipt, id, c.lifecycleBlocker(id, err)
	}
	return receipt, id, nil
}

func (c *workflowController) lifecycleBlocker(id int64, err error) error {
	if errors.Is(err, errExistingOwner) {
		return fmt.Errorf("%w: %s/blob/main/docs/deployment/PRODUCTION-BOOTSTRAP.md#interrupted-installations-and-recovery (Preflight %s)",
			err, c.target.URL(), c.target.runLink(id))
	}
	return fmt.Errorf("%w. Review %s and the protected procedure at %s/blob/main/docs/deployment/PROTECTED-RECOVERY.md",
		err, c.target.runLink(id), c.target.URL())
}

func readReceipt(ctx context.Context, github workflowGitHub, target githubTarget, id int64) (lifecycleReceipt, error) {
	var receipt lifecycleReceipt
	name := fmt.Sprintf("lifecycle-preflight-%d-1", id)
	raw, err := github.Artifact(ctx, id, name, "codexia-lifecycle-preflight.json")
	if err != nil {
		return receipt, fmt.Errorf("read immutable Preflight receipt from %s: %w", target.runLink(id), err)
	}
	if json.Unmarshal(raw, &receipt) != nil {
		return receipt, refused("Invalid protected Preflight receipt in " + target.runLink(id))
	}
	return receipt, nil
}

func safeBlockers(blockers []string) string {
	safe := make([]string, 0, len(blockers))
	for _, b := range blockers {
		safe = append(safe, stateValue(b))
	}
	return strings.Join(safe, ", ")
}
