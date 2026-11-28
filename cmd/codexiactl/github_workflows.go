package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/go-github/v93/github"
)

var githubWorkflows = []string{"production-bootstrap.yml", "production-preflight.yml", "frontend-release.yml"}

var (
	errGitHubDispatchUnknown = errors.New("GitHub dispatch outcome is unknown; reconcile the operation before retrying")
	errGitHubRunUnavailable  = errors.New("GitHub workflow run is not yet available")
	githubArtifactHost       = regexp.MustCompile(`^productionresultssa[0-9]+\.blob\.core\.windows\.net$`)
	githubArtifactDigest     = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	githubArtifactMemberName = regexp.MustCompile(`^[A-Za-z0-9_-]+\.json$`)
)

const githubArtifactMax = 4 << 20
const githubBackendHandoffFile = "backend-deployment-handoff.yml"

type githubRun struct {
	Status, Conclusion string
	Attempt            int
}

type githubRunSummary struct {
	ID                            int64
	File, Status, Conclusion, SHA string
	Attempt                       int
	DisplayTitle                  string `json:"-"`
	CreatedAt, UpdatedAt          time.Time
}

func githubWorkflowPath(file string) string {
	return ".github/workflows/" + file
}

func githubWorkflowAllowed(file string) bool {
	for _, allowed := range githubWorkflows {
		if file == allowed {
			return true
		}
	}
	return false
}

func githubDispatchAllowed(file string, inputs map[string]string) bool {
	switch file {
	case "production-bootstrap.yml":
		switch inputs["mode"] {
		case "preflight":
			return len(inputs) == 1
		case "bootstrap":
			initialize, hasInit := inputs["initialize_database"]
			return inputs["approval_phrase"] == "BOOTSTRAP_CODEXIA" && githubValidRunID(inputs["preflight_run_id"]) &&
				(!hasInit && len(inputs) == 3 || hasInit && len(inputs) == 4 && (initialize == "true" || initialize == "false"))
		case "owner-setup":
			return len(inputs) == 3 && inputs["approval_phrase"] == "OWNER_SETUP_CODEXIA" &&
				githubValidRunID(inputs["preflight_run_id"])
		}
	case "production-preflight.yml":
		return len(inputs) == 3 && inputs["mode"] == "lifecycle" && inputs["intent"] == "install" &&
			(inputs["management"] == "bootstrap" || inputs["management"] == "runtime")
	case "frontend-release.yml":
		return len(inputs) == 2 && inputs["approval_phrase"] == "PUBLISH_INITIAL_FRONTEND" && githubValidRunID(inputs["preflight_run_id"])
	}
	return false
}

func githubValidRunID(value string) bool {
	id, err := strconv.ParseInt(value, 10, 64)
	return err == nil && id > 0 && len(value) <= 16 && strconv.FormatInt(id, 10) == value
}

func (g *githubControl) Dispatch(ctx context.Context, file, sha string, inputs map[string]string) (int64, error) {
	if !githubDispatchAllowed(file, inputs) {
		return 0, errors.New("GitHub workflow inputs are outside the initial-install contract")
	}
	for _, env := range []string{githubBootstrapEnvironment, githubProductionEnvironment} {
		if err := g.requireProtection(ctx, env); err != nil {
			return 0, err
		}
	}
	if err := g.requireApprovedTarget(ctx, false); err != nil {
		return 0, err
	}
	if g.approvedSHA != sha {
		return 0, errGitHubTarget
	}
	requestInputs := make(map[string]any, len(inputs))
	for key, value := range inputs {
		requestInputs[key] = value
	}
	wantRun := true
	run, resp, err := g.client.Actions.CreateWorkflowDispatchEventByFileName(ctx, g.target.Owner, deploymentRepositoryName, file, github.CreateWorkflowDispatchEventRequest{
		Ref: "main", Inputs: requestInputs, ReturnRunDetails: &wantRun,
	})
	if err != nil {
		failure := githubFailure("dispatch "+file, resp, err)
		status := githubStatus(resp)
		if status >= 400 && status < 500 && status != http.StatusRequestTimeout {
			return 0, failure
		}
		return 0, errors.Join(errGitHubDispatchUnknown, failure)
	}
	if run.GetWorkflowRunID() <= 0 {
		return 0, errGitHubDispatchUnknown
	}
	return run.GetWorkflowRunID(), nil
}

func (g *githubControl) Run(ctx context.Context, file, sha string, id int64) (githubRun, error) {
	if !githubWorkflowAllowed(file) || !githubSHA.MatchString(sha) || id <= 0 {
		return githubRun{}, errGitHubTarget
	}
	run, resp, err := g.client.Actions.GetWorkflowRunByID(ctx, g.target.Owner, deploymentRepositoryName, id)
	if err != nil {
		failure := githubFailure(fmt.Sprintf("read workflow run %d", id), resp, err)
		if githubStatus(resp) == http.StatusNotFound {
			return githubRun{}, errors.Join(errGitHubRunUnavailable, failure)
		}
		return githubRun{}, failure
	}
	if !g.githubRunBelongs(run, file) || run.GetID() != id || run.GetHeadSHA() != sha {
		return githubRun{}, errGitHubTarget
	}
	return githubRun{Status: run.GetStatus(), Conclusion: run.GetConclusion(), Attempt: run.GetRunAttempt()}, nil
}

func (g *githubControl) githubRunBelongs(run *github.WorkflowRun, file string) bool {
	return g.githubRunMatches(run, file, "workflow_dispatch")
}

func (g *githubControl) githubRunMatches(run *github.WorkflowRun, file, event string) bool {
	return run.GetID() > 0 && run.GetRunAttempt() > 0 && run.GetEvent() == event &&
		g.target.matchesRepository(run.GetRepository()) && g.target.matchesRepository(run.GetHeadRepository()) &&
		run.GetHeadBranch() == "main" && run.GetPath() == githubWorkflowPath(file) && githubSHA.MatchString(run.GetHeadSHA())
}

func (g *githubControl) Jobs(ctx context.Context, id int64, attempt int) (map[string]string, error) {
	if id <= 0 || attempt != 1 {
		return nil, errors.New("GitHub workflow job evidence must come from the original attempt")
	}
	run, resp, err := g.client.Actions.GetWorkflowRunByID(ctx, g.target.Owner, deploymentRepositoryName, id)
	if err != nil {
		return nil, githubFailure(fmt.Sprintf("recheck producer for jobs of run %d", id), resp, err)
	}
	file := path.Base(run.GetPath())
	if !githubWorkflowAllowed(file) || !g.githubRunBelongs(run, file) || run.GetID() != id ||
		run.GetRunAttempt() != attempt || run.GetStatus() != "completed" {
		return nil, errors.New("GitHub workflow job producer is not its completed original attempt")
	}
	jobs := make(map[string]string)
	for page := 1; page != 0; {
		list, resp, err := g.client.Actions.ListWorkflowJobsAttempt(ctx, g.target.Owner, deploymentRepositoryName, id, int64(attempt), &github.ListOptions{Page: page, PerPage: 100})
		if err != nil {
			return nil, githubFailure(fmt.Sprintf("read jobs for workflow run %d attempt %d", id, attempt), resp, err)
		}
		for _, job := range list.Jobs {
			name := job.GetName()
			if name == "" || job.GetStatus() != "completed" || job.GetConclusion() == "" || job.GetRunID() != id ||
				job.GetRunAttempt() != int64(attempt) || job.GetHeadSHA() != run.GetHeadSHA() {
				return nil, errors.New("GitHub returned incomplete or mismatched job evidence")
			}
			if _, exists := jobs[name]; exists {
				return nil, errors.New("GitHub returned ambiguous job evidence")
			}
			jobs[name] = job.GetConclusion()
		}
		page = resp.NextPage
	}
	return jobs, nil
}

func (g *githubControl) Recent(ctx context.Context) ([]githubRunSummary, error) {
	var result []githubRunSummary
	for _, file := range githubWorkflows {
		runs, err := g.recentWorkflowRuns(ctx, file, "workflow_dispatch")
		if err != nil {
			return result, err
		}
		result = append(result, runs...)
	}
	return result, nil
}

// StatusHistory also reads the canonical ordinary deploy lanes. Recent stays
// scoped to CLI-dispatchable workflows for dispatch recovery and init.
func (g *githubControl) StatusHistory(ctx context.Context) ([]githubRunSummary, error) {
	result, err := g.Recent(ctx)
	if err != nil {
		return result, err
	}
	for _, workflow := range []struct{ file, event string }{
		{frontendFile, "workflow_run"},
		{githubBackendHandoffFile, "workflow_dispatch"},
		{githubBackendHandoffFile, "workflow_run"},
	} {
		runs, err := g.recentWorkflowRuns(ctx, workflow.file, workflow.event)
		if err != nil {
			return result, err
		}
		result = append(result, runs...)
	}
	return result, nil
}

func (g *githubControl) recentWorkflowRuns(ctx context.Context, file, event string) ([]githubRunSummary, error) {
	list, resp, err := g.client.Actions.ListWorkflowRunsByFileName(ctx, g.target.Owner, deploymentRepositoryName, file, &github.ListWorkflowRunsOptions{
		Branch: "main", Event: event, ListOptions: github.ListOptions{PerPage: 30},
	})
	if err != nil {
		return nil, githubFailure("list recent "+file+" runs", resp, err)
	}
	if list == nil {
		return nil, errors.New("GitHub did not return workflow history")
	}
	result := make([]githubRunSummary, 0, len(list.WorkflowRuns))
	for _, run := range list.WorkflowRuns {
		if !g.githubRunMatches(run, file, event) {
			return nil, errors.New("GitHub returned a workflow run for a different target")
		}
		result = append(result, githubRunSummary{ID: run.GetID(), File: file, Status: run.GetStatus(),
			Conclusion: run.GetConclusion(), SHA: run.GetHeadSHA(), Attempt: run.GetRunAttempt(),
			DisplayTitle: run.GetDisplayTitle(), CreatedAt: run.GetCreatedAt().Time, UpdatedAt: run.GetUpdatedAt().Time})
	}
	return result, nil
}

func (g *githubControl) Artifact(ctx context.Context, id int64, name, member string) ([]byte, error) {
	if id <= 0 || name != fmt.Sprintf("lifecycle-preflight-%d-1", id) || member != "codexia-lifecycle-preflight.json" {
		return nil, errors.New("GitHub artifact is outside the lifecycle Preflight receipt contract")
	}
	run, resp, err := g.client.Actions.GetWorkflowRunByID(ctx, g.target.Owner, deploymentRepositoryName, id)
	if err != nil {
		return nil, githubFailure(fmt.Sprintf("read the producer of lifecycle receipt %d", id), resp, err)
	}
	if !g.githubRunBelongs(run, "production-preflight.yml") || run.GetID() != id || run.GetRunAttempt() != 1 || run.GetStatus() != "completed" {
		return nil, errors.New("GitHub lifecycle receipt producer does not match the completed original Preflight attempt")
	}
	var selected *github.Artifact
	for page := 1; page != 0; {
		list, resp, err := g.client.Actions.ListWorkflowRunArtifacts(ctx, g.target.Owner, deploymentRepositoryName, id, &github.ListOptions{Page: page, PerPage: 100})
		if err != nil {
			return nil, githubFailure(fmt.Sprintf("list artifacts for workflow run %d", id), resp, err)
		}
		for _, artifact := range list.Artifacts {
			if artifact.GetName() == name {
				if selected != nil {
					return nil, errors.New("GitHub workflow artifact could not be identified uniquely")
				}
				selected = artifact
			}
		}
		page = resp.NextPage
	}
	producer := selected.GetWorkflowRun()
	if selected == nil || selected.GetID() <= 0 || selected.Expired == nil || selected.GetExpired() ||
		selected.GetSizeInBytes() <= 0 || selected.GetSizeInBytes() > githubArtifactMax ||
		!githubArtifactDigest.MatchString(selected.GetDigest()) ||
		producer.GetID() != id || producer.GetRepositoryID() != g.target.RepoID || producer.GetHeadRepositoryID() != g.target.RepoID ||
		producer.GetHeadSHA() != run.GetHeadSHA() || producer.GetHeadBranch() != "main" {
		return nil, errors.New("GitHub workflow artifact has missing or mismatched attested metadata")
	}
	location, resp, err := g.client.Actions.DownloadArtifact(ctx, g.target.Owner, deploymentRepositoryName, selected.GetID(), 0)
	if err != nil {
		return nil, githubFailure("obtain a download for the lifecycle Preflight receipt", resp, err)
	}
	if !githubArtifactLocation(location) {
		return nil, errors.New("GitHub lifecycle artifact redirects outside approved artifact storage")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, location.String(), nil)
	if err != nil {
		return nil, errors.New("GitHub artifact download request could not be created")
	}
	download, err := g.download.Do(req)
	if err != nil {
		// Transport errors can contain the signed URL. Never propagate it.
		return nil, errors.New("GitHub artifact download failed")
	}
	defer download.Body.Close()
	if download.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub artifact download failed (HTTP %d)", download.StatusCode)
	}
	size := selected.GetSizeInBytes()
	raw, err := io.ReadAll(io.LimitReader(download.Body, size+1))
	if err != nil || int64(len(raw)) != size {
		return nil, errors.New("GitHub artifact size did not match the producer metadata")
	}
	return githubArtifactMember(raw, selected.GetDigest(), member)
}

func githubArtifactLocation(location *url.URL) bool {
	return location != nil && location.Scheme == "https" && location.User == nil && location.Fragment == "" &&
		location.Port() == "" && (githubArtifactHost.MatchString(location.Hostname()) ||
		strings.HasSuffix(location.Hostname(), ".actions.githubusercontent.com"))
}

func githubArtifactMember(raw []byte, digest, member string) ([]byte, error) {
	if len(raw) > githubArtifactMax || !githubArtifactMemberName.MatchString(member) ||
		fmt.Sprintf("sha256:%x", sha256.Sum256(raw)) != digest {
		return nil, errors.New("GitHub workflow artifact digest or member is invalid")
	}
	archive, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil || len(archive.File) != 1 {
		return nil, errors.New("GitHub workflow artifact must contain exactly one regular receipt")
	}
	file := archive.File[0]
	if file.Name != member || path.Base(file.Name) != file.Name || !file.Mode().IsRegular() ||
		file.UncompressedSize64 > githubArtifactMax || file.UncompressedSize64 == 0 {
		return nil, errors.New("GitHub workflow receipt path, type or size did not match")
	}
	entry, err := file.Open()
	if err != nil {
		return nil, errors.New("GitHub workflow receipt could not be opened")
	}
	defer entry.Close()
	content, err := io.ReadAll(io.LimitReader(entry, int64(file.UncompressedSize64)+1))
	if err != nil || uint64(len(content)) != file.UncompressedSize64 {
		return nil, errors.New("GitHub workflow receipt could not be read safely")
	}
	return content, nil
}
