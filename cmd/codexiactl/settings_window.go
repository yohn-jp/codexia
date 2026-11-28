package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"
)

func (c *workflowController) requireSettingsWindow(ctx context.Context, gh *githubControl) error {
	if c.settingsWindow != nil {
		return c.settingsWindow.verify(ctx)
	}
	resume := c.state.BootstrapKeyWrite == "unresolved" || c.state.BootstrapKeyWrite == "registered" ||
		len(c.state.GateOriginal) > 0 || len(c.state.CloudflareServiceAuth) > 0
	if c.state.SettingsWriterID == "" {
		if resume {
			return needsAction("Pending Settings writes cannot be tied to their original writer window. Use the protected maintenance runbook")
		}
		var ID [16]byte
		if _, err := rand.Read(ID[:]); err != nil {
			return err
		}
		c.state.SettingsWriterID = hex.EncodeToString(ID[:])
		if err := c.store.Save(c.state); err != nil {
			return err
		}
	}
	acquire := gh.AcquireSecretWriteWindow
	if resume {
		acquire = gh.ResumeSecretWriteWindow
	}
	window, err := acquire(ctx, c.operator, c.state.SettingsWriterID)
	if err != nil {
		return err
	}
	c.settingsWindow = window
	return nil
}

func (c *workflowController) finishSettingsWindow(ctx context.Context, operationError error) error {
	if c.settingsWindow == nil {
		return nil
	}
	if (c.state.BootstrapKeyWrite == "unresolved" || c.state.BootstrapKeyWrite == "registered") || errors.Is(operationError, errGitHubSecretWriteUnknown) ||
		len(c.state.GateOriginal) > 0 || len(c.state.CloudflareServiceAuth) > 0 {
		return needsAction("The exclusive Settings writer record is retained for the unresolved operation. Resume using this VM and administrator")
	}
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
	defer cancel()
	if err := c.settingsWindow.Close(cleanup); err != nil {
		return err
	}
	c.state.SettingsWriterID = ""
	return c.store.Save(c.state)
}
