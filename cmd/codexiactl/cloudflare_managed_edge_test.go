package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
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

type fixtureCFCommand func(context.Context, ...string) ([]byte, error)

func (f fixtureCFCommand) run(ctx context.Context, args ...string) ([]byte, error) {
	return f(ctx, args...)
}

func TestManagedEdgeUsesPublicCFCommandsAndPrivateJSONBody(t *testing.T) {
	spec, _ := managedEdgeFixture(t)
	dir := t.TempDir()
	t.Setenv("TMPDIR", dir)
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = root.Close() })
	var paths []string
	cf := fixtureCFCommand(func(_ context.Context, args ...string) ([]byte, error) {
		if len(args) != 6 || !slices.Equal(args[:3], []string{"zero-trust", "access", "policies"}) ||
			args[3] != "create" || args[4] != "--body" || !strings.HasPrefix(args[5], "@") {
			t.Fatalf("unexpected cf command: %q", args)
		}
		path := strings.TrimPrefix(args[5], "@")
		paths = append(paths, path)
		stat, err := os.Stat(path)
		if err != nil || stat.Mode().Perm() != 0o600 {
			t.Fatalf("request payload is not private: %v", err)
		}
		if filepath.Dir(path) != dir {
			t.Fatal("request escaped the test's private directory")
		}
		data, err := root.ReadFile(filepath.Base(path))
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]string
		if json.Unmarshal(data, &body) != nil || body["decision"] != "non_identity" {
			t.Fatal("request payload differs from the approved policy")
		}
		return []byte(`{"id":"10000000-0000-4000-8000-000000000099"}`), nil
	})
	provider := managedEdgeProvider{cf: cf, spec: spec}
	change := managedEdgeChange{
		Key: "create policy identity-probe", Method: http.MethodPost,
		Path: "accounts/" + spec.AccountID + "/access/policies", Body: map[string]string{"decision": "non_identity"},
	}
	if err := provider.Apply(context.Background(), change); err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 {
		t.Fatalf("executed %d Cloudflare commands", len(paths))
	}
	if _, err := os.Stat(paths[0]); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Cloudflare request body was retained: %v", err)
	}
	change.Path = "accounts/" + spec.ZoneID + "/access/policies"
	if err := provider.Apply(context.Background(), change); err == nil || len(paths) != 1 {
		t.Fatal("accepted another account's Cloudflare write")
	}
}

func TestManagedEdgeWorkerRoutingUsesScopedTypedSDK(t *testing.T) {
	spec, _ := managedEdgeFixture(t)
	const apiToken = "provider-verified-test-credential"
	pattern := spec.Host + "/*"
	routeID := strings.Repeat("c", 32)
	var calls []string
	workerBody := map[string]any{
		"name":           cloudflareWorker,
		"logpush":        false,
		"observability":  map[string]any{"enabled": false},
		"subdomain":      map[string]any{"enabled": false, "previews_enabled": false},
		"tags":           []any{},
		"tail_consumers": []any{},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+apiToken {
			t.Error("Worker request did not use the explicitly supplied credential")
		}
		calls = append(calls, r.Method+" "+r.URL.RequestURI())
		var result any
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/zones/"+spec.ZoneID+"/workers/routes":
			result = []any{map[string]string{"id": routeID, "pattern": pattern, "script": cloudflareWorker}}
		case r.Method == http.MethodGet && r.URL.Path == "/accounts/"+spec.AccountID+"/workers/domains":
			result = []any{}
		case r.Method == http.MethodPost && r.URL.Path == "/zones/"+spec.ZoneID+"/workers/routes":
			var data map[string]any
			if err := json.NewDecoder(r.Body).Decode(&data); err != nil || !reflect.DeepEqual(data, map[string]any{"pattern": pattern, "script": cloudflareWorker}) {
				t.Error("Worker route request differs from approval")
			}
			result = map[string]string{"id": routeID, "pattern": pattern, "script": cloudflareWorker}
		case r.Method == http.MethodPost && r.URL.Path == "/accounts/"+spec.AccountID+"/workers/workers":
			var data map[string]any
			if err := json.NewDecoder(r.Body).Decode(&data); err != nil || !reflect.DeepEqual(data, workerBody) {
				t.Errorf("Worker creation payload differs from approved empty worker: %v", data)
			}
			result = map[string]any{
				"id": "new-worker-id", "name": cloudflareWorker,
				"subdomain": workerBody["subdomain"],
			}
		default:
			t.Errorf("unknown SDK request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		cloudflareTestEnvelope(t, w, result)
	}))
	defer server.Close()
	api := newCloudflareAPI([]byte(apiToken), server.URL+"/")
	provider := managedEdgeProvider{
		spec: spec, reader: api,
		routeWriter:  func(context.Context) (cloudflareAPI, error) { return api, nil },
		workerWriter: func(context.Context) (cloudflareAPI, error) { return api, nil },
	}
	var state managedEdgeInventory
	ctx := context.Background()
	if err := observeManagedWorkerRouting(ctx, api, spec, &state); err != nil ||
		!slices.Equal(state.Routes, []managedEdgeRoute{{ID: routeID, Pattern: pattern, Script: cloudflareWorker}}) ||
		state.CustomDomainConflict {
		t.Fatalf("Worker route observation failed: %+v %v", state.Routes, err)
	}
	route := managedEdgeChange{
		Method: http.MethodPost, Path: "zones/" + spec.ZoneID + "/workers/routes",
		Body: map[string]any{"pattern": pattern, "script": cloudflareWorker},
	}
	if err := provider.Apply(ctx, route); err != nil {
		t.Fatal(err)
	}
	worker := managedEdgeChange{Method: http.MethodPost, Path: "accounts/" + spec.AccountID + "/workers/workers"}
	if err := provider.Apply(ctx, worker); err != nil {
		t.Fatal(err)
	}
	expected := []string{
		"GET /zones/" + spec.ZoneID + "/workers/routes",
		"GET /accounts/" + spec.AccountID + "/workers/domains?service=" + cloudflareWorker,
		"GET /accounts/" + spec.AccountID + "/workers/domains?hostname=" + spec.Host,
		"GET /accounts/" + spec.AccountID + "/workers/domains?hostname=" + spec.ManagementHost,
		"POST /zones/" + spec.ZoneID + "/workers/routes",
		"POST /accounts/" + spec.AccountID + "/workers/workers",
	}
	if !slices.Equal(calls, expected) {
		t.Fatalf("unexpected Worker request sequence %q", calls)
	}
}

type statefulManagedEdge struct {
	state             managedEdgeInventory
	writes, reads     int
	loseFirstResponse bool
}

func (f *statefulManagedEdge) Observe(context.Context, managedEdgeSpec) (managedEdgeInventory, error) {
	f.reads++
	return f.state, nil
}

func (f *statefulManagedEdge) Apply(_ context.Context, change managedEdgeChange) error {
	f.writes++
	body, ok := change.Body.(map[string]any)
	if !ok {
		return errors.New("unexpected fixture payload")
	}
	pattern, isRoute := body["pattern"].(string)
	if isRoute {
		script, _ := body["script"].(string)
		f.state.Routes = append(f.state.Routes, managedEdgeRoute{ID: strings.Repeat("b", 32), Pattern: pattern, Script: script})
	} else {
		host, _ := body["name"].(string)
		content, _ := body["content"].(string)
		if host == "" || content == "" {
			return errors.New("unexpected fixture write")
		}
		f.state.DNS = append(f.state.DNS, managedEdgeDNS{
			ID: strings.Repeat("c", 32), Name: host, Type: "CNAME", Content: content, Proxied: true,
		})
	}
	if f.writes == 1 && f.loseFirstResponse {
		return errors.New("Cloudflare response lost after write")
	}
	return nil
}

func convergedManagedEdgeFixture(t *testing.T) (managedEdgeSpec, managedEdgeInventory) {
	t.Helper()
	spec, state := managedEdgeFixture(t)
	id := func(n int) string { return fmt.Sprintf("10000000-0000-4000-8000-%012d", n) }
	tunnelID := id(20)
	spec.ExpectedTunnelID = tunnelID
	state.Tunnels = []managedEdgeTunnel{{ID: tunnelID, Name: cloudflareTunnel, AccountTag: spec.AccountID, ConfigSrc: "cloudflare"}}
	spec.ProbePolicyID, spec.ManagementPolicyID = id(21), id(22)
	servicePolicy := func(policyID string, tags []string) cloudflareAccessPolicy {
		p := cloudflareAccessPolicy{ID: policyID, Decision: "non_identity", Precedence: 1}
		for _, tag := range tags {
			p.Include = append(p.Include, map[string]json.RawMessage{
				"service_token_tag": json.RawMessage(fmt.Sprintf(`{"key":"codexia-scope","value":%q}`, tag)),
			})
		}
		state.Policies = append(state.Policies, managedEdgePolicy{cloudflareAccessPolicy: p, AccountID: spec.AccountID})
		return p
	}
	author := state.Policies[0].cloudflareAccessPolicy
	probe := servicePolicy(spec.ProbePolicyID, managedEdgeProbeTags(spec.Repository.RepoID))
	ssh := servicePolicy(spec.ManagementPolicyID, managedEdgeSSHTags(spec.Repository.RepoID))
	state.AppPolicies = map[string][]cloudflareAccessPolicy{}
	addApp := func(domain string, n int, policies ...cloudflareAccessPolicy) {
		app := managedEdgeApp{cloudflareAccessApp: cloudflareAccessApp{
			ID: id(n), AUD: strings.Repeat(fmt.Sprintf("%x", n%16), 64), Domain: domain, Type: "self_hosted",
		}, AllowedIDPs: spec.AllowedIDPs}
		for i := range policies {
			policies[i].Precedence = int64(i + 1)
		}
		state.Apps = append(state.Apps, app)
		state.AppPolicies[app.ID] = policies
	}
	addApp(spec.Host, 30, author)
	var probes map[string]managedEdgePath
	if err := json.Unmarshal(spec.Contract.identityProbes, &probes); err != nil {
		t.Fatal(err)
	}
	for _, probePath := range probes {
		addApp(spec.Host+probePath.Path, 31+len(state.Apps), probe, author)
	}
	addApp(spec.ManagementHost, 40, ssh)
	var ingress map[string]json.RawMessage
	plan, err := planManagedEdge(spec, state)
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range plan {
		switch {
		case change.Key == "converge Tunnel ingress":
			ingress = change.Body.(map[string]any)["config"].(map[string]json.RawMessage)
		case strings.HasPrefix(change.Key, "create Worker route "):
			body := change.Body.(map[string]any)
			script, _ := body["script"].(string)
			state.Routes = append(state.Routes, managedEdgeRoute{
				ID: strings.Repeat("a", 32), Pattern: body["pattern"].(string), Script: script,
			})
		case strings.HasPrefix(change.Key, "create DNS "):
			body := change.Body.(map[string]any)
			state.DNS = append(state.DNS, managedEdgeDNS{
				ID: strings.Repeat("a", 32), Name: body["name"].(string), Type: "CNAME", Content: body["content"].(string), Proxied: true,
			})
		}
	}
	state.TunnelConfig = ingress
	off := false
	worker := managedEdgeWorker{ID: "canonical-worker", Name: cloudflareWorker, DeployedOn: json.RawMessage("null")}
	worker.Subdomain.Enabled, worker.Subdomain.PreviewsEnabled = &off, &off
	state.Workers = []managedEdgeWorker{worker}
	if plan, err := planManagedEdge(spec, state); err != nil || len(plan) != 0 {
		t.Fatalf("complete fixture has drift: %v (%v)", plan, err)
	}
	return spec, state
}

func TestManagedEdgeReobservesResponseLossAndResumesWithoutReplay(t *testing.T) {
	spec, state := convergedManagedEdgeFixture(t)
	state.Routes = state.Routes[:len(state.Routes)-1]
	state.DNS = state.DNS[:len(state.DNS)-1]
	api := &statefulManagedEdge{state: state, loseFirstResponse: true}
	ctx := context.Background()
	guards, approvals := 0, 0
	guard := func(context.Context) error { guards++; return nil }
	approve := func([]string) error { approvals++; return nil }
	plan, err := reconcileManagedEdge(ctx, api, spec, approve, guard)
	if !slices.Equal(plan, []string{"create Worker route " + spec.Host + "/*", "create DNS " + spec.ManagementHost}) ||
		err == nil || !strings.Contains(err.Error(), "uncertain result") || api.writes != 1 || api.reads != 3 || guards != 1 {
		t.Fatalf("did not stop after response loss and reobserve: %+v, %v, writes=%d, reads=%d", plan, err, api.writes, api.reads)
	}
	plan, err = reconcileManagedEdge(ctx, api, spec, approve, guard)
	if err != nil || !slices.Equal(plan, []string{"create DNS " + spec.ManagementHost}) || api.writes != 2 || guards != 2 {
		t.Fatalf("resume replayed the observed route or failed the DNS write: %+v, %v, writes=%d", plan, err, api.writes)
	}
	plan, err = reconcileManagedEdge(ctx, api, spec, approve, guard)
	if err != nil || len(plan) != 0 || approvals != 2 || api.writes != 2 {
		t.Fatalf("idempotent run changed the converged state: %+v, %v, writes=%d", plan, err, api.writes)
	}
}

func TestManagedEdgeOfficialCFInventoryRequiresIndependentRoutingProof(t *testing.T) {
	spec, _ := managedEdgeFixture(t)
	const tunnelID = "10000000-0000-4000-8000-000000000123"
	const appID = "10000000-0000-4000-8000-000000000124"
	aud := strings.Repeat("d", 64)
	const paged = " --page 1 --per-page 50"
	zone := []cfZone{{ID: spec.ZoneID, Name: "example.com", Status: "active", Account: struct{ ID string }{spec.AccountID}}}
	app := map[string]any{
		"id": appID, "aud": aud, "domain": spec.Host, "type": "self_hosted",
		"allowed_idps": spec.AllowedIDPs, "policies": []map[string]any{{"id": spec.AuthorPolicyID, "decision": "allow", "precedence": 1}},
	}
	results := map[string]any{
		"zones list --name " + spec.Host + paged:           []any{},
		"zones list --name " + spec.ManagementHost + paged: []any{},
		"zones list --name example.com" + paged:            zone,
		"tunnels list --name codexia --is-deleted=false --tun-types cfd_tunnel" + paged: []managedEdgeTunnel{
			{ID: tunnelID, Name: cloudflareTunnel, AccountTag: spec.AccountID, ConfigSrc: "cloudflare"},
		},
		"dns records list --zone " + spec.ZoneID + " --name-exact " + spec.Host + paged:           []any{},
		"dns records list --zone " + spec.ZoneID + " --name-exact " + spec.ManagementHost + paged: []any{},
		"workers list" + paged:                        []any{},
		"zero-trust access applications list" + paged: []any{app},
		"zero-trust access policies list" + paged:     []any{},
		"zero-trust identity-providers list" + paged:  []managedEdgeIdentityProvider{{ID: spec.AllowedIDPs[0], Name: "Fixture"}},
		"zero-trust organization get":                 map[string]string{"auth_domain": spec.TeamName + ".cloudflareaccess.com"},
		"zero-trust access applications get " + appID: app,
		"tunnels config get " + tunnelID: map[string]any{
			"tunnel_id": tunnelID, "account_id": spec.AccountID, "source": "cloudflare",
			"config": map[string][]any{"ingress": {}},
		},
	}
	calls := 0
	provider := managedEdgeProvider{spec: spec, cf: fixtureCFCommand(func(_ context.Context, args ...string) ([]byte, error) {
		calls++
		key := strings.Join(args, " ")
		result, ok := results[key]
		if !ok {
			t.Fatalf("unexpected cf observation command %q", key)
		}
		return json.Marshal(result)
	})}
	state, err := provider.Observe(context.Background(), spec)
	if err == nil || !strings.Contains(err.Error(), "separately issued and verified bounded observation credential") ||
		calls != len(results)+1 || state.TeamName != spec.TeamName ||
		len(state.Tunnels) != 1 || state.Tunnels[0].ID != tunnelID ||
		len(state.AppPolicies[appID]) != 1 || state.AppPolicies[appID][0].ID != spec.AuthorPolicyID {
		t.Fatalf("read-only observation did not record available inventory with incomplete routing proof: calls=%d err=%v", calls, err)
	}
}
