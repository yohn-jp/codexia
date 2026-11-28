package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"syscall"
	"time"
)

func verifyInitialEdge(ctx context.Context, _ vmObservation, edge *cloudflareObservation) error {
	var target struct{ PublicProtocolEnabled bool }
	if json.Unmarshal([]byte(edge.Target), &target) != nil || target.PublicProtocolEnabled {
		return refused("Initial setup needs the approved edge with public OAuth and MCP paths closed")
	}
	if len(edge.ConnectorIDs) == 0 {
		return nil
	}
	if len(edge.ConnectorIDs) != 1 {
		return refused("The canonical Tunnel has connectors whose identity cannot be bound to this installation")
	}
	// The management connector can already be running after an interrupted
	// registration, before Codexia's application or runtime account exists.
	return verifyLocalConnector(ctx, edge.ConnectorIDs[0])
}

func verifyLocalConnector(ctx context.Context, expected string) error {
	client := &http.Client{
		Transport:     &http.Transport{DisableKeepAlives: true},
		Timeout:       3 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:2000/ready", nil)
	if err != nil {
		return err
	}
	response, err := client.Do(req)
	if err != nil {
		return refused("The Cloudflare connector could not be bound to the VM's canonical local Tunnel")
	}
	defer func() { _ = response.Body.Close() }()
	var ready struct {
		Status           int
		ReadyConnections int
		ConnectorID      string
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&ready) != nil ||
		ready.Status != http.StatusOK || ready.ReadyConnections < 1 || ready.ConnectorID != expected {
		return refused("Cloudflare reports a connector other than the VM's canonical active Tunnel")
	}
	return nil
}

func requireCloudflarePublicationClosed(ctx context.Context, vm vmObservation) error {
	const helper = "/usr/local/sbin/codexia-api-gate"
	info, err := os.Lstat(helper)
	if err == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != 0 || !info.Mode().IsRegular() || info.Mode().Perm() != 0o755 {
			return needsAction("Cloudflare convergence requires the root-owned canonical publication gate helper")
		}
		state, err := commandOutput(ctx, "/usr/bin/sudo", "-n", helper, "status")
		if err != nil || strings.TrimSpace(string(state)) != "closed" {
			return needsAction("Cloudflare convergence requires independent proof of the closed VM publication gate")
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) || vm.CodexiaPresent {
		return needsAction("An existing Codexia VM requires the canonical closed publication gate before Cloudflare convergence")
	}
	for _, unit := range []string{"codexia-api.socket", "codexia-api-gate.service"} {
		state, err := commandOutput(ctx, "/usr/bin/systemctl", "show", "--property=LoadState", "--value", unit)
		if err != nil || strings.TrimSpace(string(state)) != "not-found" {
			return needsAction("Could not verify the absence of publication units on the new VM")
		}
	}
	for _, port := range []string{"18080", "18081"} {
		listeners, err := commandOutput(ctx, "/usr/bin/ss", "-H", "-ltn", "sport", "=", ":"+port)
		if err != nil || len(bytes.TrimSpace(listeners)) != 0 {
			return needsAction("Could not verify that the new VM has no listener on the publication and origin ports")
		}
	}
	return nil
}
