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
	targetRepositoryID    = 1450072993
	bootstrapEnvironment  = "codexia-bootstrap"
	productionEnvironment = "codexia-production"
	bootstrapFile         = "production-bootstrap.yml"
	preflightFile         = "production-preflight.yml"
	frontendFile          = "frontend-release.yml"
)

type workflowOperation struct {
	file   string
	inputs map[string]string
	jobs   []string
}

var operations = map[string]workflowOperation{
	"management": {file: bootstrapFile, inputs: map[string]string{"mode": "preflight"},
		jobs: []string{"Protected production controller (preflight)"}},
	"lifecycle": {file: preflightFile, inputs: map[string]string{"mode": "lifecycle", "intent": "install"},
		jobs: []string{"Verify certified candidate pair before observing the production host",
			"Observe the pinned production host without mutation",
			"Compute the read-only lifecycle plan from fresh host and certified candidate evidence"}},
	"bootstrap": {file: bootstrapFile, inputs: map[string]string{"mode": "bootstrap", "approval_phrase": "BOOTSTRAP_CODEXIA"},
		jobs: []string{"Derive the existing runtime SSH public key before R4", "Protected production controller (bootstrap)",
			"Verify R4 runtime SSH on the same pinned VM"}},
	"frontend": {file: frontendFile, inputs: map[string]string{"approval_phrase": "PUBLISH_INITIAL_FRONTEND"},
		jobs: []string{"Publish canonical frontend for initial owner enrollment"}},
	"owner-setup": {file: bootstrapFile, inputs: map[string]string{"mode": "owner-setup", "approval_phrase": "OWNER_SETUP_CODEXIA"},
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
	github              workflowGitHub
	operator            operator
	store               checkpointWriter
	state               checkpoint
	sha, hostID, origin string
}

func runLink(id int64) string {
	return "https://github.com/yohn-jp/codexia/actions/runs/" + strconv.FormatInt(id, 10)
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
		return 0, needsAction("The dispatch result is unresolved. Review GitHub Actions before another attempt. The request will never be replayed automatically")
	}
	c.state.RunID = id
	if err := c.store.Save(c.state); err != nil {
		return 0, fmt.Errorf("could not checkpoint workflow %s", runLink(id))
	}
	c.operator.Notice("Follow " + runLink(id) + " and use GitHub for independent Environment approval.")
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
		return needsAction("The workflow concluded " + stateValue(run.Conclusion))
	}
	for _, job := range spec.jobs {
		if jobs[job] != "success" {
			return needsAction(fmt.Sprintf("Required job %q concluded %s", job, stateValue(jobs[job])))
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
			return false, fmt.Errorf("cannot confirm workflow %s: %w", runLink(id), err)
		}
		if run.Attempt != 1 {
			return run.Status == "completed", refused("Workflow was rerun. Review " + runLink(id) + " and generate new lifecycle evidence")
		}
		if run.Status == "completed" {
			if run.Conclusion != "success" {
				return true, fmt.Errorf("%s: %w", runLink(id), verifyJobs(run, spec, nil))
			}
			jobs, err := c.github.Jobs(ctx, id, run.Attempt)
			if err != nil {
				return false, fmt.Errorf("could not verify jobs in %s: %w", runLink(id), err)
			}
			if err := verifyJobs(run, spec, jobs); err != nil {
				return true, fmt.Errorf("%s: %w", runLink(id), err)
			}
			return true, nil
		}
		if run.Status != lastStatus {
			c.operator.Notice(fmt.Sprintf("Workflow %s is %s.", runLink(id), stateValue(run.Status)))
			lastStatus = run.Status
		}
		if err := sleepContext(ctx, waitFor); err != nil {
			return false, needsAction("Workflow " + runLink(id) + " is unresolved. Run init again to resume observation")
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
	if err := requireApproval(c.operator, "Run read-only lifecycle Preflight using the "+management+" SSH identity?"); err != nil {
		return lifecycleReceipt{}, 0, err
	}
	id, err := c.execute(ctx, "lifecycle", map[string]string{"management": management})
	if id == 0 {
		return lifecycleReceipt{}, 0, err
	}
	receipt, evidenceErr := readReceipt(ctx, c.github, id)
	if err != nil {
		if evidenceErr == nil && len(receipt.Plan.Blockers) > 0 {
			c.operator.Notice("Lifecycle blockers in " + runLink(id) + ": " + safeBlockers(receipt.Plan.Blockers))
		}
		if evidenceErr == nil && (receipt.Plan.Observation.State.A == "ready" || receipt.Plan.Observation.State.A == "unprepared") &&
			receipt.validate(c.sha, id, management, c.hostID, c.origin, time.Now()) == nil {
			return receipt, id, errExistingOwner
		}
		return lifecycleReceipt{}, id, err
	}
	if evidenceErr != nil {
		return lifecycleReceipt{}, id, evidenceErr
	}
	if err := c.currentMain(ctx); err != nil {
		return lifecycleReceipt{}, id, err
	}
	return receipt, id, receipt.validate(c.sha, id, management, c.hostID, c.origin, time.Now())
}

func readReceipt(ctx context.Context, github workflowGitHub, id int64) (lifecycleReceipt, error) {
	var receipt lifecycleReceipt
	name := fmt.Sprintf("lifecycle-preflight-%d-1", id)
	raw, err := github.Artifact(ctx, id, name, "codexia-lifecycle-preflight.json")
	if err != nil {
		return receipt, fmt.Errorf("read immutable Preflight receipt from %s: %w", runLink(id), err)
	}
	if json.Unmarshal(raw, &receipt) != nil {
		return receipt, refused("Invalid protected Preflight receipt in " + runLink(id))
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
