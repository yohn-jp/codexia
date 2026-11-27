package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"slices"
	"syscall"
)

var (
	version           = "development"
	source            = "unreleased"
	githubAppClientID string
)

type operator interface {
	Confirm(string) (bool, error)
	Ask(string) (string, error)
	Secret(string) ([]byte, error)
	Notice(string)
}

type exitError struct {
	code    int
	message string
}

func (e *exitError) Error() string     { return e.message }
func needsAction(message string) error { return &exitError{2, message} }
func refused(message string) error     { return &exitError{3, message} }

func requireApproval(o operator, question string) error {
	accepted, err := o.Confirm(question)
	if err != nil {
		return err
	}
	if !accepted {
		return needsAction("The operation is waiting for explicit approval")
	}
	return nil
}

type invocation struct {
	command    string
	plan, json bool
}

func parseInvocation(args []string) (invocation, bool) {
	if len(args) == 0 || slices.Equal(args, []string{"--help"}) || slices.Equal(args, []string{"-h"}) {
		return invocation{command: "help"}, true
	}
	i := invocation{command: args[0]}
	switch i.command {
	case "help", "version":
		return i, len(args) == 1
	case "init":
		i.plan = slices.Equal(args[1:], []string{"--plan"})
		return i, len(args) == 1 || i.plan
	case "status", "doctor":
		i.json = slices.Equal(args[1:], []string{"--json"})
		return i, len(args) == 1 || i.json
	default:
		return i, false
	}
}

const usage = `codexiactl
  init           Prepare first deployment from the target VM's SSH terminal.
  init --plan    Inspect the target and show the planned operations.
  status [--json]
                 Report substantiated deployment state and existing workflows.
  doctor [--json]
                 Inspect management access, provider prerequisites and blockers.
  version        Show the build version and source.
  help           Show this usage.

Initial deployment ends at Owner Setup Grant handoff on the normal HTTPS origin.
Use the protected deployment runbook after the Owner enrolls.
`

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer cancel()
	os.Exit(runCLI(ctx, os.Args[1:], os.Stdout, os.Stderr))
}

func runCLI(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	i, valid := parseInvocation(args)
	if !valid {
		fmt.Fprint(stderr, usage)
		return 3
	}
	switch i.command {
	case "help":
		fmt.Fprint(stdout, usage)
		return 0
	case "version":
		fmt.Fprintf(stdout, "codexiactl %s (%s)\n", version, source)
		return 0
	}
	code := 0
	if i.command == "init" && !i.plan {
		code = reportError(ctx, stderr, runInit(ctx))
	} else {
		code = readOnly(ctx, i, stdout, stderr)
	}
	if ctx.Err() != nil {
		return 130
	}
	return code
}

func reportError(ctx context.Context, stderr io.Writer, err error) int {
	if ctx.Err() != nil {
		return 130
	}
	if err == nil {
		return 0
	}
	fmt.Fprintln(stderr, "codexiactl:", err)
	switch {
	case errors.Is(err, errCheckpointUnsafe), errors.Is(err, errGitHubTarget), errors.Is(err, errExistingOwner):
		return 3
	case errors.Is(err, errCheckpointBusy), errors.Is(err, errGitHubProtection), errors.Is(err, errGitHubSettingsWriterUnavailable),
		errors.Is(err, errHandoffNeedsConsent), errors.Is(err, errHandoffUnavailable):
		return 2
	}
	var coded *exitError
	if errors.As(err, &coded) {
		return coded.code
	}
	return 1
}
