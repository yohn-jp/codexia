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
		Host:       "codexia.example.com", ManagementHost: "ssh.example.com",
		AccountID: strings.Repeat("a", 32), ZoneID: strings.Repeat("b", 32),
		TeamName: "test-team", AuthorPolicyID: id(1),
		AllowedIDPs:    []string{id(3)},
		ProductService: "http://127.0.0.1:18080", SSHService: "ssh://127.0.0.1:22",
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
		{"direct API bypass", func(s *managedEdgeSpec, _ *managedEdgeInventory) { s.ProductService = "http://127.0.0.1:18081" }},
		{"wrong SSH endpoint", func(s *managedEdgeSpec, _ *managedEdgeInventory) { s.SSHService = "ssh://127.0.0.1:2222" }},
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

func TestManagedEdgeRefusesChangedApprovedTarget(t *testing.T) {
	spec, state := managedEdgeFixture(t)
	state.Tunnels = []managedEdgeTunnel{{ID: "10000000-0000-4000-8000-000000000010", Name: cloudflareTunnel, AccountTag: spec.AccountID, ConfigSrc: "cloudflare"}}
	api := &managedEdgeTestAPI{state: state}
	// DNS still needs to be created under the same operation names, but the
	// tunnel ID in its body changes while the operator is approving the plan.
	_, err := reconcileManagedEdge(context.Background(), api, spec, func([]string) error {
		api.state.Tunnels[0].ID = "10000000-0000-4000-8000-000000000011"
		return nil
	}, func(context.Context) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "plan changed") || api.writes != 0 {
		t.Fatalf("changed target was not refused: err=%v writes=%d", err, api.writes)
	}
}

func TestManagedEdgeRequiresExplicitNeverDeployedWorker(t *testing.T) {
	spec, state := managedEdgeFixture(t)
	off := false
	w := managedEdgeWorker{ID: "canonical-worker", Name: cloudflareWorker}
	w.Subdomain.Enabled, w.Subdomain.PreviewsEnabled = &off, &off
	for _, deployedOn := range []json.RawMessage{nil, json.RawMessage(`"2026-11-28T00:00:00Z"`), json.RawMessage(`""`)} {
		w.DeployedOn = deployedOn
		state.Workers = []managedEdgeWorker{w}
		if _, err := planManagedEdge(spec, state); err == nil || !strings.Contains(err.Error(), "without release admission") {
			t.Fatalf("unproven empty Worker accepted: deployed_on=%s err=%v", deployedOn, err)
		}
	}
	w.DeployedOn = json.RawMessage(`null`)
	state.Workers = []managedEdgeWorker{w}
	if _, err := planManagedEdge(spec, state); err != nil {
		t.Fatalf("explicit never-deployed Worker refused: %v", err)
	}
}

func TestManagedEdgeRequiresManagementOriginAccess(t *testing.T) {
	spec, state := managedEdgeFixture(t)
	id := func(n int) string { return fmt.Sprintf("10000000-0000-4000-8000-%012d", n) }
	state.Tunnels = []managedEdgeTunnel{{ID: id(20), Name: cloudflareTunnel, AccountTag: spec.AccountID, ConfigSrc: "cloudflare"}}
	spec.ProbePolicyID, spec.ManagementPolicyID = id(21), id(22)
	servicePolicy := func(policyID string, tags []string) cloudflareAccessPolicy {
		p := cloudflareAccessPolicy{ID: policyID, Decision: "non_identity", Precedence: 1}
		for _, tag := range tags {
			p.Include = append(p.Include, map[string]json.RawMessage{"service_token_tag": json.RawMessage(fmt.Sprintf(`{"key":"codexia-scope","value":%q}`, tag))})
		}
		state.Policies = append(state.Policies, managedEdgePolicy{cloudflareAccessPolicy: p, AccountID: spec.AccountID})
		return p
	}
	author := state.Policies[0].cloudflareAccessPolicy
	probe := servicePolicy(spec.ProbePolicyID, managedEdgeProbeTags(spec.Repository.RepoID))
	ssh := servicePolicy(spec.ManagementPolicyID, managedEdgeSSHTags(spec.Repository.RepoID))
	state.AppPolicies = map[string][]cloudflareAccessPolicy{}
	addApp := func(domain string, n int, policies ...cloudflareAccessPolicy) string {
		aud := strings.Repeat(fmt.Sprintf("%x", n%16), 64)
		app := managedEdgeApp{cloudflareAccessApp: cloudflareAccessApp{ID: id(n), AUD: aud, Domain: domain, Type: "self_hosted"}, AllowedIDPs: spec.AllowedIDPs}
		for i := range policies {
			policies[i].Precedence = int64(i + 1)
		}
		state.Apps = append(state.Apps, app)
		state.AppPolicies[app.ID] = policies
		return aud
	}
	addApp(spec.Host, 30, author)
	var probes map[string]managedEdgePath
	if err := json.Unmarshal(spec.Contract.identityProbes, &probes); err != nil {
		t.Fatal(err)
	}
	for _, p := range probes {
		addApp(spec.Host+p.Path, 31+len(state.Apps), probe, author)
	}
	sshAUD := addApp(spec.ManagementHost, 40, ssh)
	state.TunnelConfig = map[string]json.RawMessage{"ingress": json.RawMessage(fmt.Sprintf(`[{"hostname":%q,"service":%q},{"service":"http_status:404"}]`, spec.ManagementHost, spec.SSHService))}
	plan, err := planManagedEdge(spec, state)
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range plan {
		if change.Key != "converge Tunnel ingress" {
			continue
		}
		var rules []managedEdgeIngress
		if change.Path == "" {
			t.Fatal("observed applications and tunnel did not resolve the ingress target")
		}
		if err := json.Unmarshal(change.Body.(map[string]any)["config"].(map[string]json.RawMessage)["ingress"], &rules); err != nil {
			t.Fatal(err)
		}
		for _, rule := range rules {
			if rule.Hostname == spec.ManagementHost && rule.Service == spec.SSHService {
				if rule.OriginRequest == nil || rule.OriginRequest.Access == nil || !rule.OriginRequest.Access.Required || rule.OriginRequest.Access.TeamName != spec.TeamName || !slices.Equal(rule.OriginRequest.Access.AUDTag, []string{sshAUD}) {
					t.Fatalf("management ingress does not enforce the observed SSH Access audience: %+v", rule)
				}
				return
			}
		}
		t.Fatal("management ingress missing from configuration")
	}
	t.Fatal("management ingress repair was not planned")
}

func TestManagedEdgeServiceAuthMatchesRepositoryPurposeAndEnvironment(t *testing.T) {
	spec, state := managedEdgeFixture(t)
	expected := []string{"repo-2-ssh-codexia-bootstrap", "repo-2-ssh-codexia-production"}
	if !slices.Equal(managedEdgeSSHTags(spec.Repository.RepoID), expected) || !slices.Equal(managedEdgeProbeTags(spec.Repository.RepoID), []string{"repo-2-probe-codexia-production"}) {
		t.Fatal("service tags differ from the release admission contract")
	}
	rule := func(key, value string) map[string]json.RawMessage {
		return map[string]json.RawMessage{"service_token_tag": json.RawMessage(fmt.Sprintf(`{"key":%q,"value":%q}`, key, value))}
	}
	valid := []map[string]json.RawMessage{rule("codexia-scope", expected[1]), rule("codexia-scope", expected[0])}
	for _, tc := range []struct {
		name    string
		include []map[string]json.RawMessage
		want    bool
	}{
		{"exact tags in either order", valid, true},
		{"foreign repository", []map[string]json.RawMessage{valid[0], rule("codexia-scope", "repo-3-ssh-codexia-bootstrap")}, false},
		{"foreign purpose", []map[string]json.RawMessage{valid[0], rule("codexia-scope", "repo-2-probe-codexia-production")}, false},
		{"foreign key", []map[string]json.RawMessage{valid[0], rule("scope", expected[0])}, false},
		{"duplicate tag", []map[string]json.RawMessage{valid[0], valid[0]}, false},
		{"extra OR selector", append(slices.Clone(valid), rule("codexia-scope", "repo-3-ssh-codexia-production")), false},
		{"legacy explicit ID", []map[string]json.RawMessage{valid[0], {"service_token": json.RawMessage(`{"token_id":"10000000-0000-4000-8000-000000000002"}`)}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			policy := cloudflareAccessPolicy{ID: "10000000-0000-4000-8000-000000000022", Decision: "non_identity", Include: tc.include}
			if exactManagedServicePolicy(policy, expected) != tc.want {
				t.Fatal("unexpected service selector decision")
			}
			spec.ManagementPolicyID = policy.ID
			state.Policies = append(state.Policies[:1], managedEdgePolicy{cloudflareAccessPolicy: policy, AccountID: spec.AccountID})
			_, err := planManagedEdge(spec, state)
			if (err == nil) != tc.want {
				t.Fatalf("unexpected plan decision: %v", err)
			}
		})
	}
}
