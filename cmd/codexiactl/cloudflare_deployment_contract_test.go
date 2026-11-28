package main

import (
	"encoding/json"
	"fmt"
	"maps"
	"reflect"
	"slices"
	"testing"
)

func TestManagedEdgePlansExactAuthorProbeAndManagementAttachments(t *testing.T) {
	spec, inventory := convergedManagedEdgeFixture(t)
	inventory.Apps, inventory.AppPolicies, inventory.DNS = nil, nil, nil
	plan, err := planManagedEdge(spec, inventory)
	if err != nil {
		t.Fatal(err)
	}
	var probes map[string]managedEdgePath
	if err := json.Unmarshal(spec.Contract.identityProbes, &probes); err != nil {
		t.Fatal(err)
	}
	want := map[string][]string{
		spec.Host:           {spec.AuthorPolicyID},
		spec.ManagementHost: {spec.ManagementPolicyID},
	}
	for _, probe := range probes {
		want[spec.Host+probe.Path] = []string{spec.ProbePolicyID, spec.AuthorPolicyID}
	}
	for _, change := range plan {
		if change.Path != "accounts/"+spec.AccountID+"/access/apps" {
			continue
		}
		body, ok := change.Body.(map[string]any)
		if !ok {
			t.Fatal("Access change is missing its structured body")
		}
		domain, _ := body["domain"].(string)
		policies, expected := want[domain]
		if !expected || change.Method != "POST" || body["type"] != "self_hosted" || body["app_launcher_visible"] != (domain == spec.Host) {
			t.Fatalf("unexpected Access application for %q: %+v", domain, change)
		}
		links := make([]any, len(policies))
		for i, id := range policies {
			links[i] = map[string]any{"id": id, "precedence": i + 1}
		}
		if !reflect.DeepEqual(body["policies"], links) {
			t.Errorf("Access application for %q used the wrong policy IDs or precedence", domain)
		}
		delete(want, domain)
	}
	if len(want) != 0 {
		t.Fatalf("missing approved Access applications: %v", want)
	}
}

func plannedTunnelIngress(t *testing.T, plan []managedEdgeChange) (int, map[string]json.RawMessage, []managedEdgeIngress) {
	t.Helper()
	index := slices.IndexFunc(plan, func(change managedEdgeChange) bool { return change.Key == "converge Tunnel ingress" })
	if index < 0 || plan[index].Path == "" || plan[index].Method != "PUT" {
		t.Fatal("the plan does not update the observed Tunnel configuration")
	}
	config := plan[index].Body.(map[string]any)["config"].(map[string]json.RawMessage)
	var rules []managedEdgeIngress
	if err := json.Unmarshal(config["ingress"], &rules); err != nil {
		t.Fatal(err)
	}
	return index, config, rules
}

func expectedProtectedIngress(t *testing.T, spec managedEdgeSpec, inventory managedEdgeInventory) []managedEdgeIngress {
	t.Helper()
	audiences := make(map[string]string, len(inventory.Apps))
	for _, app := range inventory.Apps {
		audiences[app.Domain] = app.AUD
	}
	var probes map[string]managedEdgePath
	if err := json.Unmarshal(spec.Contract.identityProbes, &probes); err != nil {
		t.Fatal(err)
	}
	var rules []managedEdgeIngress
	for _, key := range slices.Sorted(maps.Keys(probes)) {
		probe := probes[key]
		rules = append(rules, managedEdgeIngress{
			Hostname: spec.Host, Path: probe.TunnelPath,
			Service: "http://127.0.0.1:18080", OriginRequest: &managedEdgeOrigin{HTTPHostHeader: spec.Host, Access: &managedEdgeAccess{
				Required: true, TeamName: spec.TeamName, AUDTag: []string{audiences[spec.Host+probe.Path], audiences[spec.Host]},
			}},
		})
	}
	return append(rules,
		managedEdgeIngress{Hostname: spec.Host, Service: "http://127.0.0.1:18080", OriginRequest: &managedEdgeOrigin{
			HTTPHostHeader: spec.Host,
			Access:         &managedEdgeAccess{Required: true, TeamName: spec.TeamName, AUDTag: []string{audiences[spec.Host]}},
		}},
		managedEdgeIngress{
			Hostname: spec.ManagementHost, Service: "ssh://127.0.0.1:22",
			OriginRequest: &managedEdgeOrigin{Access: &managedEdgeAccess{Required: true, TeamName: spec.TeamName, AUDTag: []string{audiences[spec.ManagementHost]}}},
		},
		managedEdgeIngress{Service: "http_status:404"})
}

func TestManagedEdgeStagesIngressBeforeOpeningOrClosingProtocolBypass(t *testing.T) {
	spec, inventory := convergedManagedEdgeFixture(t)
	var manifest map[string]managedEdgePath
	if err := json.Unmarshal(spec.Contract.protocolPaths, &manifest); err != nil {
		t.Fatal(err)
	}
	protected := expectedProtectedIngress(t, spec, inventory)
	var publicRules []managedEdgeIngress
	for _, key := range slices.Sorted(maps.Keys(manifest)) {
		if rule := manifest[key]; rule.TunnelPath != "" {
			publicRules = append(publicRules, managedEdgeIngress{
				Hostname: spec.Host, Path: rule.TunnelPath,
				Service: "http://127.0.0.1:18080", OriginRequest: &managedEdgeOrigin{HTTPHostHeader: spec.Host},
			})
		}
	}
	spec.PublicProtocolEnabled, spec.PublicProtocolAccepted, spec.PublicProtocolTransitionApproved = true, true, true
	plan, err := planManagedEdge(spec, inventory)
	if err != nil {
		t.Fatal(err)
	}
	index, config, rules := plannedTunnelIngress(t, plan)
	if !reflect.DeepEqual(rules, append(publicRules, protected...)) || len(plan) != len(manifest)+1 || index != 0 {
		t.Fatal("the public Tunnel plan changed protected rules or exposed paths outside the approved origin path list")
	}
	for i, key := range slices.Sorted(maps.Keys(manifest)) {
		domain := spec.Host + manifest[key].Path
		change := plan[i+1]
		body := change.Body.(map[string]any)
		policy := map[string]any{
			"name": manifest[key].Name, "decision": "bypass", "precedence": 1,
			"include": []any{map[string]any{"everyone": map[string]any{}}},
		}
		if change.Key != "create Bypass "+domain || change.Method != "POST" || body["domain"] != domain ||
			body["app_launcher_visible"] != false || !reflect.DeepEqual(body["policies"], []any{policy}) {
			t.Fatalf("public Access policy for %q differs from the exact path Bypass contract", domain)
		}
		id := fmt.Sprintf("10000000-0000-4000-8000-%012d", i+100)
		inventory.Apps = append(inventory.Apps, managedEdgeApp{cloudflareAccessApp: cloudflareAccessApp{
			ID: id, AUD: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", Domain: domain, Type: "self_hosted",
		}})
		inventory.AppPolicies[id] = []cloudflareAccessPolicy{{
			Decision: "bypass", Precedence: 1,
			Include: []map[string]json.RawMessage{{"everyone": json.RawMessage("{}")}},
		}}
	}
	inventory.TunnelConfig = config
	spec.PublicProtocolEnabled, spec.PublicProtocolTransitionApproved = false, false
	if _, err := planManagedEdge(spec, inventory); err == nil {
		t.Fatal("removing Bypass without explicit transition approval was permitted")
	}
	spec.PublicProtocolTransitionApproved = true
	plan, err = planManagedEdge(spec, inventory)
	if err != nil {
		t.Fatal(err)
	}
	index, _, rules = plannedTunnelIngress(t, plan)
	if !reflect.DeepEqual(rules, protected) || len(plan) != len(manifest)+1 || index != 0 {
		t.Fatal("rollback did not restore protected ingress before removing Bypass")
	}
	for i, key := range slices.Sorted(maps.Keys(manifest)) {
		change := plan[i+1]
		if change.Key != "remove Bypass "+spec.Host+manifest[key].Path || change.Method != "DELETE" {
			t.Fatalf("rollback changed something other than the approved Bypass application %q", key)
		}
	}
}
