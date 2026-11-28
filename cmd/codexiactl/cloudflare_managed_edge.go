package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net"
	"net/url"
	"reflect"
	"slices"
	"strconv"
	"strings"
)

// The integration caller obtains these values from the verified repository,
// VM, account and cf session. The service token IDs are independently
// verified by the credential issuance and protected registration flow.
type managedEdgeSpec struct {
	Repository                                                  githubTarget
	Host, ManagementHost, AccountID, ZoneID, ExpectedTunnelID   string
	TeamName, AuthorPolicyID, ProbePolicyID, ManagementPolicyID string
	AllowedIDPs, SSHServiceTokenIDs                             []string
	ProbeTokenID, ProductService, SSHService                    string
	PublicProtocolEnabled, PublicProtocolAccepted               bool
	PublicProtocolTransitionApproved                            bool
	Contract                                                    cloudflareContract
}

type managedEdgeTunnel struct {
	ID, Name   string
	AccountTag string  `json:"account_tag"`
	ConfigSrc  string  `json:"config_src"`
	DeletedAt  *string `json:"deleted_at"`
}

type managedEdgeDNS struct {
	ID, Name, Type, Content string
	Proxied                 bool
}

type managedEdgeWorker struct {
	ID, Name   string
	DeployedOn json.RawMessage `json:"deployed_on"`
	Subdomain  struct {
		Enabled         *bool
		PreviewsEnabled *bool `json:"previews_enabled"`
	}
}

type managedEdgeRoute struct{ ID, Pattern, Script string }

type managedEdgePolicy struct {
	cloudflareAccessPolicy
	Name      string
	AccountID string `json:"account_id"`
}

type managedEdgeApp struct {
	cloudflareAccessApp
	AllowedIDPs []string `json:"allowed_idps"`
}

type managedEdgeIngress struct {
	Hostname      string             `json:"hostname,omitempty"`
	Path          string             `json:"path,omitempty"`
	Service       string             `json:"service"`
	OriginRequest *managedEdgeOrigin `json:"originRequest,omitempty"`
}

type managedEdgeOrigin struct {
	HTTPHostHeader string             `json:"httpHostHeader,omitempty"`
	Access         *managedEdgeAccess `json:"access,omitempty"`
}

type managedEdgeAccess struct {
	Required bool     `json:"required"`
	TeamName string   `json:"teamName"`
	AUDTag   []string `json:"audTag"`
}

type managedEdgePath struct{ Name, Path, TunnelPath string }

type managedEdgeInventory struct {
	Tunnels              []managedEdgeTunnel
	DNS                  []managedEdgeDNS
	Workers              []managedEdgeWorker
	Routes               []managedEdgeRoute
	Apps                 []managedEdgeApp
	Policies             []managedEdgePolicy
	AppPolicies          map[string][]cloudflareAccessPolicy
	IdentityProviders    []string
	CustomDomainConflict bool
	TunnelConfig         map[string]json.RawMessage
}

type managedEdgeChange struct {
	Key, Method, Path string
	Body              any
}

type managedEdgeAPI interface {
	Observe(context.Context, managedEdgeSpec) (managedEdgeInventory, error)
	Apply(context.Context, managedEdgeChange) error
}

func validLoopbackService(value, scheme string) bool {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != scheme || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		return false
	}
	host, port, err := net.SplitHostPort(u.Host)
	n, numberErr := strconv.Atoi(port)
	return err == nil && numberErr == nil && host == "127.0.0.1" && n > 0 && n < 65536 && strconv.Itoa(n) == port
}

func (s managedEdgeSpec) validate() error {
	if !s.Repository.valid() || !cloudflareID.MatchString(s.AccountID) || !cloudflareID.MatchString(s.ZoneID) ||
		!cloudflareHost.MatchString(s.Host) || !cloudflareHost.MatchString(s.ManagementHost) ||
		!strings.Contains(s.Host, ".") || !strings.Contains(s.ManagementHost, ".") || s.Host == s.ManagementHost ||
		!cloudflareTeam.MatchString(s.TeamName) || !cloudflareUUID.MatchString(s.AuthorPolicyID) ||
		!cloudflareUUID.MatchString(s.ProbeTokenID) || len(s.SSHServiceTokenIDs) != 2 ||
		!validLoopbackService(s.ProductService, "http") || !validLoopbackService(s.SSHService, "ssh") {
		return errors.New("Cloudflare edge target is not bound to a verified repository, account, zone and local endpoints")
	}
	seen := map[string]bool{}
	for _, id := range append([]string{s.ProbeTokenID}, s.SSHServiceTokenIDs...) {
		if !cloudflareUUID.MatchString(id) || seen[id] {
			return errors.New("Cloudflare probe and SSH service token identities must be distinct")
		}
		seen[id] = true
	}
	seen = map[string]bool{}
	for _, id := range s.AllowedIDPs {
		if !cloudflareUUID.MatchString(id) || seen[id] {
			return errors.New("Invalid Cloudflare identity provider selection")
		}
		seen[id] = true
	}
	if len(seen) == 0 {
		return errors.New("Select a verified account-owned identity provider")
	}
	for _, id := range []string{s.ExpectedTunnelID, s.ProbePolicyID, s.ManagementPolicyID} {
		if id != "" && !cloudflareUUID.MatchString(id) {
			return errors.New("Invalid protected Cloudflare resource identity")
		}
	}
	if s.PublicProtocolEnabled && !s.PublicProtocolAccepted {
		return errors.New("Public OAuth/MCP routes require runtime acceptance")
	}
	return nil
}

func exactManagedServicePolicy(p cloudflareAccessPolicy, ids []string) bool {
	if p.Decision != "non_identity" || len(p.Exclude) != 0 || len(p.Require) != 0 || len(p.Include) != len(ids) {
		return false
	}
	var actual []string
	for _, include := range p.Include {
		var rule struct {
			TokenID string `json:"token_id"`
		}
		if len(include) != 1 || json.Unmarshal(include["service_token"], &rule) != nil || !cloudflareUUID.MatchString(rule.TokenID) {
			return false
		}
		actual = append(actual, rule.TokenID)
	}
	return slices.Equal(slices.Sorted(slices.Values(actual)), slices.Sorted(slices.Values(ids)))
}

func exactManagedBypass(p cloudflareAccessPolicy) bool {
	return p.Decision == "bypass" && p.Precedence == 1 && len(p.Require) == 0 && len(p.Exclude) == 0 &&
		len(p.Include) == 1 && len(p.Include[0]) == 1 && string(p.Include[0]["everyone"]) == "{}"
}

// A read-only plan describes every mutation. Dependencies created in an
// earlier step are resolved by independent observation, never by local state.
// Unexpected overlapping resources fail closed rather than being overwritten.
func planManagedEdge(s managedEdgeSpec, state managedEdgeInventory) ([]managedEdgeChange, error) {
	if err := s.validate(); err != nil {
		return nil, err
	}
	if state.CustomDomainConflict {
		return nil, errors.New("Cloudflare Worker has an alternate custom domain")
	}
	var routes cloudflareRoutes
	var probes, protocols map[string]managedEdgePath
	if json.Unmarshal(s.Contract.routes, &routes) != nil || json.Unmarshal(s.Contract.identityProbes, &probes) != nil ||
		json.Unmarshal(s.Contract.protocolPaths, &protocols) != nil || len(routes.Routes) == 0 || len(routes.OriginRoutes) == 0 ||
		len(probes) == 0 || len(protocols) == 0 {
		return nil, errors.New("Cloudflare certified edge contracts are missing")
	}
	account, zone := "accounts/"+s.AccountID, "zones/"+s.ZoneID
	var changes []managedEdgeChange
	add := func(key, method, path string, body any) {
		changes = append(changes, managedEdgeChange{key, method, path, body})
	}
	for _, id := range s.AllowedIDPs {
		if !slices.Contains(state.IdentityProviders, id) {
			return nil, errors.New("Selected Cloudflare identity provider was not observed")
		}
	}
	policies := map[string]managedEdgePolicy{}
	for _, p := range state.Policies {
		if !cloudflareUUID.MatchString(p.ID) || p.AccountID != "" && p.AccountID != s.AccountID || policies[p.ID].ID != "" {
			return nil, errors.New("Cloudflare account policy inventory is ambiguous")
		}
		policies[p.ID] = p
	}
	if p := policies[s.AuthorPolicyID]; p.ID == "" || p.Decision != "allow" || len(p.Include) == 0 {
		return nil, errors.New("Cloudflare shared author Allow policy was not verified")
	}
	apps := map[string]managedEdgeApp{}
	for _, a := range state.Apps {
		domains := slices.Clone(a.SelfHostedDomains)
		for _, d := range a.Destinations {
			if d.Type == "public" {
				domains = append(domains, d.URI)
			}
		}
		relevant := func(domain string) bool {
			return cloudflareMatchesHost(domain, s.Host) || cloudflareMatchesHost(domain, s.ManagementHost)
		}
		if !relevant(a.Domain) && !slices.ContainsFunc(domains, relevant) {
			continue
		}
		if !cloudflareUUID.MatchString(a.ID) || !cloudflareAUD.MatchString(a.AUD) || a.Type != "self_hosted" ||
			apps[a.Domain].ID != "" || slices.ContainsFunc(domains, func(d string) bool { return d != a.Domain }) {
			return nil, errors.New("Cloudflare overlapping Access application is ambiguous")
		}
		for _, d := range a.Destinations {
			if len(d.Overrides) != 0 {
				return nil, errors.New("Cloudflare Access destination overrides are not permitted")
			}
		}
		apps[a.Domain] = a
	}
	selectPolicy := func(role, wanted string, domains, tokens []string) (string, error) {
		id := wanted
		for _, domain := range domains {
			if a := apps[domain]; a.ID != "" {
				p := state.AppPolicies[a.ID]
				if len(p) == 0 || !exactManagedServicePolicy(p[0], tokens) || id != "" && id != p[0].ID {
					return "", errors.New("Existing Cloudflare service policy does not match the verified service token identities")
				}
				id = p[0].ID
			}
		}
		name := fmt.Sprintf("Codexia %d %s", s.Repository.RepoID, role)
		if id == "" {
			for _, p := range state.Policies {
				if p.Name == name {
					if id != "" {
						return "", errors.New("Ambiguous dedicated Cloudflare policy name")
					}
					id = p.ID
				}
			}
		}
		if id != "" {
			p := policies[id]
			if p.ID == "" || id == s.AuthorPolicyID || !exactManagedServicePolicy(p.cloudflareAccessPolicy, tokens) {
				return "", errors.New("Cloudflare service policy differs from the approved policy")
			}
			return id, nil
		}
		var include []any
		for _, token := range tokens {
			include = append(include, map[string]any{"service_token": map[string]string{"token_id": token}})
		}
		add("create policy "+role, "POST", account+"/access/policies", map[string]any{"name": name, "decision": "non_identity", "include": include})
		return "", nil
	}
	var probeDomains []string
	for _, key := range slices.Sorted(maps.Keys(probes)) {
		probeDomains = append(probeDomains, s.Host+probes[key].Path)
	}
	probePolicy, err := selectPolicy("identity-probe", s.ProbePolicyID, probeDomains, []string{s.ProbeTokenID})
	if err != nil {
		return nil, err
	}
	sshPolicy, err := selectPolicy("management-ssh", s.ManagementPolicyID, []string{s.ManagementHost}, s.SSHServiceTokenIDs)
	if err != nil {
		return nil, err
	}
	if probePolicy != "" && probePolicy == sshPolicy {
		return nil, errors.New("Cloudflare probe and SSH policies must be separate")
	}
	allowedDomains := map[string]bool{}
	ensureApp := func(domain, name string, ids []string, serviceOnly bool) error {
		allowedDomains[domain] = true
		if a := apps[domain]; a.ID != "" {
			attached := state.AppPolicies[a.ID]
			if len(attached) != len(ids) {
				return errors.New("Cloudflare Access application has unexpected policies")
			}
			for i, id := range ids {
				if id == "" || attached[i].ID != id || attached[i].Precedence != int64(i+1) {
					return errors.New("Cloudflare Access policy identity or precedence differs")
				}
			}
			if !serviceOnly && !slices.Equal(slices.Sorted(slices.Values(a.AllowedIDPs)), slices.Sorted(slices.Values(s.AllowedIDPs))) {
				return errors.New("Cloudflare Access identity providers differ from approved selection")
			}
			return nil
		}
		var links []any
		for i, id := range ids {
			if id == "" {
				add("create Access "+domain, "POST", "", nil)
				return nil
			}
			links = append(links, map[string]any{"id": id, "precedence": i + 1})
		}
		body := map[string]any{"name": name, "domain": domain, "type": "self_hosted", "policies": links, "session_duration": "8h", "app_launcher_visible": domain == s.Host}
		if !serviceOnly {
			body["allowed_idps"] = s.AllowedIDPs
			body["auto_redirect_to_identity"] = len(s.AllowedIDPs) == 1
		}
		add("create Access "+domain, "POST", account+"/access/apps", body)
		return nil
	}
	if err := ensureApp(s.Host, "Codexia", []string{s.AuthorPolicyID}, false); err != nil {
		return nil, err
	}
	for _, key := range slices.Sorted(maps.Keys(probes)) {
		p := probes[key]
		if p.Name == "" || !strings.HasPrefix(p.Path, "/") || p.TunnelPath == "" {
			return nil, errors.New("Invalid identity probe contract")
		}
		if err := ensureApp(s.Host+p.Path, p.Name, []string{probePolicy, s.AuthorPolicyID}, false); err != nil {
			return nil, err
		}
	}
	if err := ensureApp(s.ManagementHost, "Codexia management SSH", []string{sshPolicy}, true); err != nil {
		return nil, err
	}

	var publicChanges []managedEdgeChange
	for _, key := range slices.Sorted(maps.Keys(protocols)) {
		p := protocols[key]
		if p.Name == "" || !strings.HasPrefix(p.Path, "/") {
			return nil, errors.New("Invalid public protocol contract")
		}
		domain := s.Host + p.Path
		allowedDomains[domain] = true
		if a := apps[domain]; a.ID != "" {
			attached := state.AppPolicies[a.ID]
			if len(attached) != 1 || !exactManagedBypass(attached[0]) {
				return nil, errors.New("Unexpected Cloudflare protocol Access policy")
			}
			if !s.PublicProtocolEnabled {
				if !s.PublicProtocolTransitionApproved {
					return nil, errors.New("Disabling public protocol requires explicit transition approval")
				}
				publicChanges = append(publicChanges, managedEdgeChange{"remove Bypass " + domain, "DELETE", account + "/access/apps/" + a.ID, nil})
			}
		} else if s.PublicProtocolEnabled {
			if !s.PublicProtocolTransitionApproved {
				return nil, errors.New("Enabling public protocol requires explicit transition approval")
			}
			body := map[string]any{"name": p.Name, "domain": domain, "type": "self_hosted", "app_launcher_visible": false,
				"policies": []any{map[string]any{"name": p.Name, "decision": "bypass", "precedence": 1, "include": []any{map[string]any{"everyone": map[string]any{}}}}}}
			publicChanges = append(publicChanges, managedEdgeChange{"create Bypass " + domain, "POST", account + "/access/apps", body})
		}
	}
	for domain := range apps {
		if !allowedDomains[domain] {
			return nil, errors.New("Unexpected overlapping Cloudflare Access application")
		}
	}

	var tunnelID string
	for _, t := range state.Tunnels {
		if t.Name != cloudflareTunnel {
			continue
		}
		if tunnelID != "" || !cloudflareUUID.MatchString(t.ID) || t.AccountTag != s.AccountID || t.ConfigSrc != "cloudflare" || t.DeletedAt != nil && *t.DeletedAt != "" {
			return nil, errors.New("Cloudflare Tunnel is ambiguous or not remotely managed")
		}
		tunnelID = t.ID
	}
	if s.ExpectedTunnelID != "" && tunnelID != s.ExpectedTunnelID {
		return nil, errors.New("Cloudflare protected Tunnel identity changed")
	}
	if tunnelID == "" {
		add("create Tunnel", "POST", account+"/cfd_tunnel", map[string]any{"name": cloudflareTunnel, "config_src": "cloudflare"})
	}
	var missingDNS []string
	for _, host := range []string{s.Host, s.ManagementHost} {
		count := 0
		for _, d := range state.DNS {
			if d.Name != host {
				continue
			}
			count++
			if count > 1 || !cloudflareID.MatchString(d.ID) || d.Type != "CNAME" || !d.Proxied || tunnelID == "" || d.Content != tunnelID+".cfargotunnel.com" {
				return nil, errors.New("Cloudflare DNS already points to an unexpected resource")
			}
		}
		if count == 0 {
			missingDNS = append(missingDNS, host)
		}
	}
	var want []managedEdgeIngress
	if s.PublicProtocolEnabled {
		for _, key := range slices.Sorted(maps.Keys(protocols)) {
			if p := protocols[key]; p.TunnelPath != "" {
				want = append(want, managedEdgeIngress{Hostname: s.Host, Path: p.TunnelPath, Service: s.ProductService, OriginRequest: &managedEdgeOrigin{HTTPHostHeader: s.Host}})
			}
		}
	}
	parent := apps[s.Host]
	ready := parent.ID != "" && apps[s.ManagementHost].ID != ""
	for _, key := range slices.Sorted(maps.Keys(probes)) {
		p := probes[key]
		a := apps[s.Host+p.Path]
		ready = ready && a.ID != ""
		want = append(want, managedEdgeIngress{Hostname: s.Host, Path: p.TunnelPath, Service: s.ProductService, OriginRequest: &managedEdgeOrigin{HTTPHostHeader: s.Host, Access: &managedEdgeAccess{true, s.TeamName, []string{a.AUD, parent.AUD}}}})
	}
	want = append(want, managedEdgeIngress{Hostname: s.Host, Service: s.ProductService, OriginRequest: &managedEdgeOrigin{HTTPHostHeader: s.Host, Access: &managedEdgeAccess{true, s.TeamName, []string{parent.AUD}}}},
		managedEdgeIngress{Hostname: s.ManagementHost, Service: s.SSHService, OriginRequest: &managedEdgeOrigin{Access: &managedEdgeAccess{true, s.TeamName, []string{apps[s.ManagementHost].AUD}}}},
		managedEdgeIngress{Service: "http_status:404"})
	var actual []managedEdgeIngress
	if raw := state.TunnelConfig["ingress"]; len(raw) != 0 && json.Unmarshal(raw, &actual) != nil {
		return nil, errors.New("Invalid Cloudflare Tunnel ingress")
	}
	knownPaths := map[string]bool{"": true}
	for _, p := range probes {
		knownPaths[p.TunnelPath] = true
	}
	for _, p := range protocols {
		if p.TunnelPath != "" {
			knownPaths[p.TunnelPath] = true
		}
	}
	for i, r := range actual {
		switch {
		case r.Hostname == s.Host && knownPaths[r.Path] && (r.Service == s.ProductService || r.Service == "http://codexia-api:3000"):
		case r.Hostname == s.ManagementHost && r.Path == "" && r.Service == s.SSHService:
		case i == len(actual)-1 && r.Hostname == "" && r.Path == "" && r.Service == "http_status:404":
		default:
			return nil, errors.New("Cloudflare Tunnel contains unknown ingress")
		}
	}
	actualJSON, _ := json.Marshal(actual)
	wantJSON, _ := json.Marshal(want)
	if !ready || tunnelID == "" {
		add("converge Tunnel ingress", "PUT", "", nil)
	} else if string(actualJSON) != string(wantJSON) {
		config := maps.Clone(state.TunnelConfig)
		if config == nil {
			config = map[string]json.RawMessage{}
		}
		var rawRules []map[string]json.RawMessage
		if len(config["ingress"]) != 0 && json.Unmarshal(config["ingress"], &rawRules) != nil {
			return nil, errors.New("Invalid existing ingress")
		}
		for _, r := range rawRules {
			for key := range r {
				if !slices.Contains([]string{"hostname", "path", "service", "originRequest"}, key) {
					return nil, errors.New("Unmanaged Cloudflare ingress field")
				}
			}
			var origin map[string]json.RawMessage
			if raw := r["originRequest"]; len(raw) != 0 && json.Unmarshal(raw, &origin) != nil {
				return nil, errors.New("Invalid origin settings")
			}
			for key := range origin {
				if !slices.Contains([]string{"httpHostHeader", "access"}, key) {
					return nil, errors.New("Unmanaged Cloudflare origin option")
				}
			}
		}
		config["ingress"] = wantJSON
		add("converge Tunnel ingress", "PUT", account+"/cfd_tunnel/"+tunnelID+"/configurations", map[string]any{"config": config})
	}
	// Install origin validation before removing Bypass, and install approved
	// public ingress before creating Bypass. DNS is added last.
	changes = append(changes, publicChanges...)
	var workerFound, workerDeployed bool
	for _, w := range state.Workers {
		if w.Name != cloudflareWorker {
			continue
		}
		if workerFound || !cloudflareWorkerID.MatchString(w.ID) || w.Subdomain.Enabled == nil || *w.Subdomain.Enabled ||
			w.Subdomain.PreviewsEnabled == nil || *w.Subdomain.PreviewsEnabled {
			return nil, errors.New("Invalid canonical Worker or preview boundary")
		}
		workerFound = true
		// Only an explicitly null deployed_on proves that the Worker has never been deployed.
		workerDeployed = string(w.DeployedOn) != "null"
	}
	if !workerFound {
		add("create empty Worker", "POST", account+"/workers/workers", map[string]any{"name": cloudflareWorker, "subdomain": map[string]bool{"enabled": false, "previews_enabled": false}})
	}
	expected := map[string]string{}
	for _, path := range routes.OriginRoutes {
		expected[s.Host+path] = ""
	}
	for _, path := range routes.Routes {
		expected[s.Host+path] = cloudflareWorker
	}
	for _, r := range state.Routes {
		if r.Script != cloudflareWorker && !cloudflareMatchesHost(r.Pattern, s.Host) && !cloudflareMatchesHost(r.Pattern, s.ManagementHost) {
			continue
		}
		script, ok := expected[r.Pattern]
		if !ok || script != r.Script || !cloudflareID.MatchString(r.ID) {
			return nil, errors.New("Unexpected overlapping Cloudflare Worker route")
		}
		delete(expected, r.Pattern)
	}
	for _, paths := range [][]string{routes.OriginRoutes, routes.Routes} {
		for _, path := range paths {
			pattern := s.Host + path
			script, missing := expected[pattern]
			if !missing {
				continue
			}
			if script != "" && workerDeployed {
				return nil, errors.New("Refusing to attach a missing route to an already deployed Worker without release admission")
			}
			body := map[string]any{"pattern": pattern}
			if script != "" {
				body["script"] = script
			}
			add("create Worker route "+pattern, "POST", zone+"/workers/routes", body)
		}
	}
	for _, host := range missingDNS {
		if tunnelID == "" {
			add("create DNS "+host, "POST", "", nil)
			continue
		}
		add("create DNS "+host, "POST", zone+"/dns_records", map[string]any{"type": "CNAME", "name": host, "content": tunnelID + ".cfargotunnel.com", "proxied": true, "ttl": 1})
	}
	return changes, nil
}

// Plan mode performs no mutations. Init approves the observed plan once and
// reobserves after every write; ambiguous results are never blindly retried.
func reconcileManagedEdge(ctx context.Context, api managedEdgeAPI, spec managedEdgeSpec, approve func([]string) error, guard func(context.Context) error) ([]string, error) {
	if err := spec.validate(); err != nil {
		return nil, err
	}
	state, err := api.Observe(ctx, spec)
	if err != nil {
		return nil, err
	}
	plan, err := planManagedEdge(spec, state)
	if err != nil {
		return nil, err
	}
	keys := make([]string, len(plan))
	for i, c := range plan {
		keys[i] = c.Key
	}
	if approve == nil || len(plan) == 0 {
		return keys, nil
	}
	if guard == nil {
		return keys, errors.New("Cloudflare mutation requires a current source and closed publication gate check")
	}
	if err := approve(slices.Clone(keys)); err != nil {
		return keys, err
	}
	remaining := map[string]managedEdgeChange{}
	for _, change := range plan {
		if _, duplicate := remaining[change.Key]; duplicate {
			return keys, errors.New("Cloudflare plan contains duplicate operations")
		}
		remaining[change.Key] = change
	}
	// A known mutation must remain bound to the exact target and body that were
	// observed before approval. Only an unresolved dependency may become concrete.
	for {
		state, err = api.Observe(ctx, spec)
		if err != nil {
			return keys, err
		}
		plan, err = planManagedEdge(spec, state)
		if err != nil {
			return keys, err
		}
		if len(plan) == 0 {
			return keys, nil
		}
		for _, change := range plan {
			approved, ok := remaining[change.Key]
			if !ok || approved.Method != change.Method || approved.Path != "" && !reflect.DeepEqual(approved, change) {
				return keys, errors.New("Cloudflare plan changed or a mutation was not confirmed")
			}
			if change.Path != "" {
				remaining[change.Key] = change
			}
		}
		change := plan[0]
		if change.Path == "" {
			return keys, errors.New("Cloudflare dependency identity was not observed")
		}
		if err := guard(ctx); err != nil {
			return keys, err
		}
		if err := api.Apply(ctx, change); err != nil {
			return keys, err
		}
		delete(remaining, change.Key)
	}
}
