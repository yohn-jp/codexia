package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
)

func managedEdgeFixture(t *testing.T) (managedEdgeSpec, managedEdgeInventory) {
	t.Helper()
	id := func(n int) string { return fmt.Sprintf("10000000-0000-4000-8000-%012d", n) }
	spec := managedEdgeSpec{
		Repository: githubTarget{Owner: "test-org", OwnerID: 1, RepoID: 2, InstallationID: 3},
		Host: "codexia.example.com", ManagementHost: "ssh.example.com",
		AccountID: strings.Repeat("a", 32), ZoneID: strings.Repeat("b", 32),
		TeamName: "test-team", AuthorPolicyID: id(1), ProbeTokenID: id(2),
		AllowedIDPs: []string{id(3)}, SSHServiceTokenIDs: []string{id(4), id(5)},
		ProductService: "http://127.0.0.1:3000", SSHService: "ssh://127.0.0.1:22",
		Contract: cloudflareContract{
			routes:         cloudflareManifest(t, "ui-routes.json"),
			identityProbes: cloudflareManifest(t, "identity-probes.json"),
			protocolPaths:  cloudflareManifest(t, "public-protocol-paths.json"),
		},
	}
	state := managedEdgeInventory{
		IdentityProviders: slices.Clone(spec.AllowedIDPs),
		Policies: []managedEdgePolicy{{
			cloudflareAccessPolicy: cloudflareAccessPolicy{
				ID: spec.AuthorPolicyID, Decision: "allow",
				Include: []map[string]json.RawMessage{{"email": json.RawMessage(`{"email":"author@example.com"}`)}},
			},
			AccountID: spec.AccountID,
		}},
	}
	return spec, state
}

func TestManagedEdgePlansProtectedRoutesBeforeDNS(t *testing.T) {
	spec, state := managedEdgeFixture(t)
	plan, err := planManagedEdge(spec, state)
	if err != nil {
		t.Fatal(err)
	}
	var keys []string
	for _, change := range plan {
		keys = append(keys, change.Key)
		if change.Method == "DELETE" || strings.Contains(change.Key, "Bypass") {
			t.Fatalf("fresh private installation planned an unsafe action: %s", change.Key)
		}
	}
	for _, pair := range [][2]string{
		{"create policy identity-probe", "create Access " + spec.Host + "/api/version"},
		{"create policy management-ssh", "create Access " + spec.ManagementHost},
		{"create Tunnel", "converge Tunnel ingress"},
		{"converge Tunnel ingress", "create DNS " + spec.ManagementHost},
		{"create Worker route " + spec.Host + "/api*", "create Worker route " + spec.Host + "/*"},
		{"create Worker route " + spec.Host + "/*", "create DNS " + spec.Host},
	} {
		first, second := slices.Index(keys, pair[0]), slices.Index(keys, pair[1])
		if first < 0 || second < 0 || first >= second {
			t.Fatalf("expected %q before %q, got %v", pair[0], pair[1], keys)
		}
	}
}

func TestManagedEdgeRejectsUnsafeInventory(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*managedEdgeSpec, *managedEdgeInventory)
	}{
		{"shared service token", func(s *managedEdgeSpec, _ *managedEdgeInventory) { s.SSHServiceTokenIDs[0] = s.ProbeTokenID }},
		{"unaccepted protocol", func(s *managedEdgeSpec, _ *managedEdgeInventory) { s.PublicProtocolEnabled = true }},
		{"unapproved protocol", func(s *managedEdgeSpec, _ *managedEdgeInventory) {
			s.PublicProtocolEnabled, s.PublicProtocolAccepted = true, true
		}},
		{"alternate worker domain", func(_ *managedEdgeSpec, i *managedEdgeInventory) { i.CustomDomainConflict = true }},
		{"foreign DNS", func(s *managedEdgeSpec, i *managedEdgeInventory) {
			i.DNS = []managedEdgeDNS{{Name: s.Host, Type: "A", Content: "192.0.2.1"}}
		}},
		{"foreign worker route", func(s *managedEdgeSpec, i *managedEdgeInventory) {
			i.Routes = []managedEdgeRoute{{Pattern: s.Host + "/*", Script: "foreign-worker"}}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spec, state := managedEdgeFixture(t)
			tc.edit(&spec, &state)
			if _, err := planManagedEdge(spec, state); err == nil {
				t.Fatal("unsafe edge state accepted")
			}
		})
	}
}

type managedEdgeTestAPI struct {
	state   managedEdgeInventory
	writes  int
	observe int
}

func (a *managedEdgeTestAPI) Observe(context.Context, managedEdgeSpec) (managedEdgeInventory, error) {
	a.observe++
	return a.state, nil
}

func (a *managedEdgeTestAPI) Apply(context.Context, managedEdgeChange) error {
	a.writes++
	return nil
}

func TestManagedEdgeRequiresApprovalAndObservedConvergence(t *testing.T) {
	spec, state := managedEdgeFixture(t)
	api := &managedEdgeTestAPI{state: state}
	guard := func(context.Context) error { return nil }
	if keys, err := reconcileManagedEdge(context.Background(), api, spec, nil, nil); err != nil || len(keys) == 0 || api.writes != 0 {
		t.Fatalf("read-only plan failed: keys=%v err=%v writes=%d", keys, err, api.writes)
	}
	if _, err := reconcileManagedEdge(context.Background(), api, spec, func([]string) error { return errors.New("declined") }, guard); err == nil || api.writes != 0 {
		t.Fatal("declined plan was applied")
	}
	if _, err := reconcileManagedEdge(context.Background(), api, spec, func([]string) error { return nil }, nil); err == nil || api.writes != 0 {
		t.Fatal("mutation without gate check was accepted")
	}
	if _, err := reconcileManagedEdge(context.Background(), api, spec, func([]string) error { return nil }, guard); err == nil || api.writes != 1 {
		t.Fatal("unobserved mutation was retried or accepted")
	}
}
