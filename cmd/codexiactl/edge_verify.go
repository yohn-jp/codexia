package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
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
