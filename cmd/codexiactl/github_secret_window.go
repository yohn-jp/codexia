package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"

	"github.com/google/go-github/v93/github"
)

const githubSettingsWriterVariable = "CODEXIACTL_SETTINGS_WRITER"

var (
	errGitHubSettingsWriterUnavailable = errors.New("an exclusive GitHub Settings writer window could not be verified")
	errGitHubSecretWriteUnknown        = errors.New("GitHub Secret write or its verification is unresolved; reconcile the recorded operation before retrying")
	githubSettingsOperationID          = regexp.MustCompile(`^(?:[a-f0-9]{32}|[a-f0-9]{64})$`)
)

type githubSecretWriteWindow struct {
	control     *githubControl
	operationID string
	releaseErr  error
}

// AcquireSecretWriteWindow uses the operation ID from an exclusively locked,
// local checkpoint. The operator ensures that settings writers outside this
// protocol are quiesced. GitHub has no conditional Environment Secret PUT.
func (g *githubControl) AcquireSecretWriteWindow(ctx context.Context, o operator, operationID string) (*githubSecretWriteWindow, error) {
	return g.authorizeSecretWriteWindow(ctx, o, operationID, false)
}

// ResumeSecretWriteWindow requires proof of continuous ownership for a
// checkpoint that records potentially applied changes.
func (g *githubControl) ResumeSecretWriteWindow(ctx context.Context, o operator, operationID string) (*githubSecretWriteWindow, error) {
	return g.authorizeSecretWriteWindow(ctx, o, operationID, true)
}

func (g *githubControl) authorizeSecretWriteWindow(ctx context.Context, o operator, operationID string, requireExisting bool) (*githubSecretWriteWindow, error) {
	if !githubSettingsOperationID.MatchString(operationID) {
		return nil, errGitHubSettingsWriterUnavailable
	}
	g.settingsMu.Lock()
	defer g.settingsMu.Unlock()
	if g.settingsWriter != nil {
		return nil, errGitHubSettingsWriterUnavailable
	}

	approved, err := o.Confirm("Confirm exclusive GitHub Settings access for codexia-bootstrap and codexia-production. " +
		"Coordinate with the repository settings owners to finish or pause every other Variable and Secret writer, including administrators, automation, and older installers, until this session releases CODEXIACTL_SETTINGS_WRITER. " +
		"GitHub's Secret endpoint cannot protect against a writer outside this window. If another writer can still act, decline. Proceed with exclusive Settings access?")
	if err != nil {
		return nil, err
	}
	if !approved {
		return nil, errGitHubSettingsWriterUnavailable
	}
	if err := g.requireWriteTarget(ctx, githubBootstrapEnvironment); err != nil {
		return nil, err
	}
	if err := g.requireProtection(ctx, githubProductionEnvironment); err != nil {
		return nil, err
	}
	window := &githubSecretWriteWindow{control: g, operationID: operationID}
	current, exists, err := g.settingsOperation(ctx)
	if err != nil {
		return nil, err
	}
	if exists && current != operationID {
		return nil, fmt.Errorf("%w: another operation holds %s", errGitHubSettingsWriterUnavailable, githubSettingsWriterVariable)
	}
	if !exists {
		if requireExisting {
			return nil, fmt.Errorf("%w: the interrupted operation's %s is missing; reconcile its writes through the protected runbook", errGitHubSettingsWriterUnavailable, githubSettingsWriterVariable)
		}
		// CreateEnvVariable is a create-only POST. A concurrent client that also
		// saw absence receives a conflict and cannot replace the first owner.
		resp, err := g.client.Actions.CreateEnvVariable(ctx, g.target.Owner, deploymentRepositoryName, githubBootstrapEnvironment,
			github.ActionsCreateVariableRequest{Name: githubSettingsWriterVariable, Value: operationID})
		if err != nil || githubStatus(resp) != http.StatusCreated {
			return nil, errors.Join(errGitHubSettingsWriterUnavailable, githubFailure("claim "+githubSettingsWriterVariable+" (retain the checkpoint and reobserve)", resp, err))
		}
	}

	if err := window.verify(ctx); err != nil {
		return nil, err
	}
	g.settingsWriter = window
	return window, nil
}

func (g *githubControl) settingsOperation(ctx context.Context) (string, bool, error) {
	value, resp, err := g.client.Actions.GetEnvVariable(ctx, g.target.Owner, deploymentRepositoryName, githubBootstrapEnvironment, githubSettingsWriterVariable)
	if githubStatus(resp) == http.StatusNotFound {
		return "", false, nil
	}
	if err != nil {
		return "", false, githubFailure("verify "+githubSettingsWriterVariable, resp, err)
	}
	if value == nil || value.Name != githubSettingsWriterVariable || !githubSettingsOperationID.MatchString(value.Value) {
		return "", false, fmt.Errorf("%w: %s has an unrecognized owner", errGitHubSettingsWriterUnavailable, githubSettingsWriterVariable)
	}
	return value.Value, true, nil
}

func (w *githubSecretWriteWindow) verify(ctx context.Context) error {
	value, exists, err := w.control.settingsOperation(ctx)
	if err != nil {
		return err
	}
	if !exists || value != w.operationID {
		return fmt.Errorf("%w: %s is missing or belongs to a different operation", errGitHubSettingsWriterUnavailable, githubSettingsWriterVariable)
	}
	return nil
}

func (w *githubSecretWriteWindow) Close(ctx context.Context) error {
	g := w.control
	g.settingsMu.Lock()
	defer g.settingsMu.Unlock()
	if g.settingsWriter != w {
		return w.releaseErr
	}
	// Disable this process's writes before touching the shared lock. If the
	// release is uncertain, recovery keeps the owning checkpoint.
	g.settingsWriter = nil
	w.releaseErr = w.release(ctx)
	return w.releaseErr
}

func (w *githubSecretWriteWindow) release(ctx context.Context) error {
	if err := w.control.requireWriteTarget(ctx, githubBootstrapEnvironment); err != nil {
		return err
	}
	if err := w.verify(ctx); err != nil {
		return err
	}
	g := w.control
	resp, err := g.client.Actions.DeleteEnvVariable(ctx, g.target.Owner, deploymentRepositoryName, githubBootstrapEnvironment, githubSettingsWriterVariable)
	if err == nil && githubStatus(resp) == http.StatusNoContent {
		return nil
	}
	return githubFailure("release "+githubSettingsWriterVariable+" (retain the checkpoint and reobserve)", resp, err)
}
