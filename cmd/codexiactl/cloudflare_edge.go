package main

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"regexp"
	"slices"
	"strings"
	"time"

	cloudflare "github.com/cloudflare/cloudflare-go/v7"
	"github.com/cloudflare/cloudflare-go/v7/packages/pagination"
	"github.com/cloudflare/cloudflare-go/v7/workers"
	"github.com/cloudflare/cloudflare-go/v7/zero_trust"
)

var (
	cloudflareWorkerID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)
	cloudflareAUD      = regexp.MustCompile(`^[a-f0-9]{64}$`)
	cloudflareTeam     = regexp.MustCompile(`^[a-z0-9-]+$`)
)

type cloudflareRoutes struct {
	Routes       []string `json:"routes"`
	OriginRoutes []string `json:"originRoutes"`
}

func (manifest cloudflareRoutes) check(host string, routes []workers.RouteListResponse) error {
	expected := make(map[string]string, len(manifest.Routes)+len(manifest.OriginRoutes))
	for _, path := range manifest.Routes {
		expected[host+path] = cloudflareWorker
	}
	for _, path := range manifest.OriginRoutes {
		expected[host+path] = ""
	}
	for _, route := range routes {
		if route.Script != cloudflareWorker && !cloudflareMatchesHost(route.Pattern, host) {
			continue
		}
		script, known := expected[route.Pattern]
		if !known || script != route.Script {
			return cloudflareDrift("Worker routes contain an unexpected route to the origin or canonical Worker")
		}
		delete(expected, route.Pattern)
	}
	if len(expected) != 0 {
		return cloudflareDrift("the canonical Worker and scriptless origin routes are incomplete")
	}
	return nil
}

func cloudflareMatchesHost(pattern, host string) bool {
	pattern = strings.TrimPrefix(strings.TrimPrefix(strings.ToLower(pattern), "https://"), "http://")
	pattern, _, _ = strings.Cut(pattern, "/")
	if !strings.Contains(pattern, "*") {
		return pattern == host
	}
	matcher := "^" + strings.ReplaceAll(regexp.QuoteMeta(pattern), `\*`, ".*") + "$"
	matched, err := regexp.MatchString(matcher, host)
	return matched || err != nil
}

func checkCloudflareWorker(resources []workers.Worker) error {
	ids, names := make(map[string]bool), make(map[string]bool)
	for _, worker := range resources {
		if !cloudflareWorkerID.MatchString(worker.ID) || worker.Name == "" || ids[worker.ID] || names[worker.Name] {
			return errors.New("Cloudflare Worker inventory is ambiguous")
		}
		ids[worker.ID], names[worker.Name] = true, true
		if worker.Name == cloudflareWorker && (worker.Subdomain.Enabled || worker.Subdomain.PreviewsEnabled ||
			worker.Subdomain.JSON.Enabled.IsNull() || worker.Subdomain.JSON.Enabled.IsInvalid() ||
			worker.Subdomain.JSON.PreviewsEnabled.IsNull() || worker.Subdomain.JSON.PreviewsEnabled.IsInvalid()) {
			return cloudflareDrift("the canonical Worker must have its subdomain and previews disabled")
		}
	}
	if !names[cloudflareWorker] {
		return cloudflareDrift("the canonical Worker is missing")
	}
	return nil
}

type cloudflarePath struct {
	Path       string `json:"path"`
	TunnelPath string `json:"tunnelPath"`
}

type cloudflareAccessApp struct {
	ID                string   `json:"id"`
	AUD               string   `json:"aud"`
	Domain            string   `json:"domain"`
	Type              string   `json:"type"`
	SelfHostedDomains []string `json:"self_hosted_domains"`
	Destinations      []struct {
		Type      string            `json:"type"`
		URI       string            `json:"uri"`
		Overrides []json.RawMessage `json:"overrides"`
	} `json:"destinations"`
}

type cloudflareAccessPolicy struct {
	ID         string                       `json:"id"`
	Decision   string                       `json:"decision"`
	Precedence int64                        `json:"precedence"`
	Require    []json.RawMessage            `json:"require"`
	Exclude    []json.RawMessage            `json:"exclude"`
	Include    []map[string]json.RawMessage `json:"include"`
}

func relevantCloudflareApps(host string, inventory []zero_trust.AccessApplicationListResponse) (map[string]cloudflareAccessApp, error) {
	apps := make(map[string]cloudflareAccessApp)
	for _, item := range inventory {
		var app cloudflareAccessApp
		if json.Unmarshal([]byte(item.JSON.RawJSON()), &app) != nil {
			return nil, errors.New("Cloudflare Access application response could not be verified")
		}
		domains := slices.Clone(app.SelfHostedDomains)
		var overrides bool
		for _, destination := range app.Destinations {
			overrides = overrides || len(destination.Overrides) > 0
			if destination.Type == "public" {
				domains = append(domains, destination.URI)
			}
		}
		if !cloudflareMatchesHost(app.Domain, host) && !slices.ContainsFunc(domains, func(value string) bool {
			return cloudflareMatchesHost(value, host)
		}) {
			continue
		}
		path, exact := strings.CutPrefix(app.Domain, host)
		_, duplicate := apps[path]
		if !exact || (path != "" && !strings.HasPrefix(path, "/")) || duplicate || overrides || app.Type != "self_hosted" ||
			!cloudflareUUID.MatchString(app.ID) || !cloudflareAUD.MatchString(app.AUD) ||
			slices.ContainsFunc(domains, func(domain string) bool { return domain != app.Domain }) {
			return nil, cloudflareDrift("the Access application identity or destination differs from the canonical hostname")
		}
		apps[path] = app
	}
	return apps, nil
}

func (api cloudflareAPI) cloudflarePolicies(ctx context.Context, account, app string) ([]cloudflareAccessPolicy, error) {
	items, err := cloudflareList("Access policies (Access: Apps and Policies Read)", func(page int) (*pagination.V4PagePaginationArray[zero_trust.AccessApplicationPolicyListResponse], error) {
		return api.access.Applications.Policies.List(ctx, app, zero_trust.AccessApplicationPolicyListParams{
			AccountID: cloudflare.F(account), Page: cloudflare.F(int64(page)), PerPage: cloudflare.F(int64(cloudflarePageSize))})
	})
	if err != nil {
		return nil, err
	}
	policies := make([]cloudflareAccessPolicy, len(items))
	for i, item := range items {
		if json.Unmarshal([]byte(item.JSON.RawJSON()), &policies[i]) != nil || !cloudflareUUID.MatchString(policies[i].ID) {
			return nil, errors.New("Cloudflare Access policy response could not be verified")
		}
	}
	slices.SortFunc(policies, func(a, b cloudflareAccessPolicy) int { return int(a.Precedence - b.Precedence) })
	return policies, nil
}

func (api cloudflareAPI) checkAccessAndTunnel(ctx context.Context, host string, target *cloudflareTarget, contract cloudflareContract) (zero_trust.ServiceToken, error) {
	accountID := target.AccountID
	account := cloudflare.F(accountID)
	var identityPaths, protocolPaths map[string]cloudflarePath
	if json.Unmarshal(contract.identityProbes, &identityPaths) != nil || len(identityPaths) != 2 ||
		json.Unmarshal(contract.protocolPaths, &protocolPaths) != nil || len(protocolPaths) == 0 {
		return zero_trust.ServiceToken{}, errors.New("Cloudflare Access path contracts are unavailable in the certified CLI")
	}
	items, err := cloudflareList("Access applications (Access: Apps and Policies Read)", func(page int) (*pagination.V4PagePaginationArray[zero_trust.AccessApplicationListResponse], error) {
		return api.access.Applications.List(ctx, zero_trust.AccessApplicationListParams{AccountID: account,
			Page: cloudflare.F(int64(page)), PerPage: cloudflare.F(int64(cloudflarePageSize))})
	})
	if err != nil {
		return zero_trust.ServiceToken{}, err
	}
	apps, err := relevantCloudflareApps(host, items)
	if err != nil {
		return zero_trust.ServiceToken{}, err
	}
	parent, present := apps[""]
	if !present {
		return zero_trust.ServiceToken{}, cloudflareDrift("the parent author Access application is missing")
	}
	author, err := api.cloudflarePolicies(ctx, accountID, parent.ID)
	if err != nil {
		return zero_trust.ServiceToken{}, err
	}
	if len(author) != 1 || author[0].Decision != "allow" || author[0].Precedence != 1 {
		return zero_trust.ServiceToken{}, cloudflareDrift("the parent Access application needs exactly the account-owned author Allow policy")
	}
	target.AuthorPolicyID = author[0].ID
	var accessTokenID string
	for _, key := range slices.Sorted(maps.Keys(identityPaths)) {
		probe := identityPaths[key]
		app, ok := apps[probe.Path]
		if !ok {
			return zero_trust.ServiceToken{}, cloudflareDrift("an exact-path identity probe Access application is missing")
		}
		policies, err := api.cloudflarePolicies(ctx, accountID, app.ID)
		if err != nil {
			return zero_trust.ServiceToken{}, err
		}
		id, err := cloudflareCIServiceTokenID(policies, target.AuthorPolicyID)
		if err != nil {
			return zero_trust.ServiceToken{}, err
		}
		if target.CIPolicyID != "" && (target.CIPolicyID != policies[0].ID || accessTokenID != id) {
			return zero_trust.ServiceToken{}, cloudflareDrift("the identity probes do not share the same CI policy and service token")
		}
		target.CIPolicyID, accessTokenID = policies[0].ID, id
	}
	if err := api.checkPublicProtocol(ctx, accountID, apps, identityPaths, protocolPaths, target); err != nil {
		return zero_trust.ServiceToken{}, err
	}
	config, err := api.tunnels.Configurations.Get(ctx, target.TunnelID,
		zero_trust.TunnelCloudflaredConfigurationGetParams{AccountID: account})
	if err != nil {
		return zero_trust.ServiceToken{}, cloudflareError("Tunnel ingress (Cloudflare Tunnel Read)", err)
	}
	if config.Source != "cloudflare" || config.TunnelID != target.TunnelID || config.AccountID != accountID {
		return zero_trust.ServiceToken{}, cloudflareDrift("Tunnel ingress identity could not be bound to the observed account and Tunnel")
	}
	if err := checkCloudflareIngress(host, apps, identityPaths, protocolPaths, target, config.Config.Ingress); err != nil {
		return zero_trust.ServiceToken{}, err
	}
	token, err := api.access.ServiceTokens.Get(ctx, accessTokenID, zero_trust.AccessServiceTokenGetParams{AccountID: account})
	if err != nil {
		return zero_trust.ServiceToken{}, cloudflareError("CI Access token metadata (Access: Service Tokens Read)", err)
	}
	if token.ID != accessTokenID || !validCloudflareSecret([]byte(token.ClientID)) ||
		token.JSON.Enabled.IsInvalid() || (!token.JSON.Enabled.IsMissing() && !token.Enabled) ||
		(!token.ExpiresAt.IsZero() && !token.ExpiresAt.After(time.Now())) || token.LeakReporter != "" {
		return zero_trust.ServiceToken{}, errors.New("Cloudflare CI Access service token identity, expiry or enabled status could not be verified; reconcile it through the existing account-owned CI policy")
	}
	return *token, nil
}

func cloudflareCIServiceTokenID(policies []cloudflareAccessPolicy, authorPolicyID string) (string, error) {
	if len(policies) != 2 || policies[0].Decision != "non_identity" || policies[0].Precedence != 1 ||
		policies[0].ID == authorPolicyID || policies[1].ID != authorPolicyID || policies[1].Decision != "allow" ||
		policies[1].Precedence != 2 || len(policies[0].Include) != 1 || len(policies[0].Include[0]) != 1 {
		return "", cloudflareDrift("an identity probe needs the separate CI Service Auth policy followed by the author Allow policy")
	}
	var rule struct {
		TokenID string `json:"token_id"`
	}
	if json.Unmarshal(policies[0].Include[0]["service_token"], &rule) != nil || !cloudflareUUID.MatchString(rule.TokenID) {
		return "", cloudflareDrift("the account-owned CI Service Auth policy must select exactly one service token")
	}
	return rule.TokenID, nil
}

func (api cloudflareAPI) checkPublicProtocol(ctx context.Context, account string, apps map[string]cloudflareAccessApp,
	identityPaths, protocolPaths map[string]cloudflarePath, target *cloudflareTarget) error {
	baseCount := 1 + len(identityPaths)
	switch len(apps) {
	case baseCount:
		return nil
	case baseCount + len(protocolPaths):
		for _, key := range slices.Sorted(maps.Keys(protocolPaths)) {
			app, ok := apps[protocolPaths[key].Path]
			if !ok {
				return cloudflareDrift("public OAuth/MCP Access paths differ from the current Terraform contract")
			}
			policies, err := api.cloudflarePolicies(ctx, account, app.ID)
			if err != nil {
				return err
			}
			if len(policies) != 1 || policies[0].Decision != "bypass" || policies[0].Precedence != 1 ||
				len(policies[0].Require) != 0 || len(policies[0].Exclude) != 0 || len(policies[0].Include) != 1 ||
				len(policies[0].Include[0]) != 1 || string(policies[0].Include[0]["everyone"]) != "{}" {
				return cloudflareDrift("a public OAuth/MCP Access policy differs from the current Terraform contract")
			}
		}
		target.PublicProtocolEnabled = true
		return nil
	default:
		return cloudflareDrift("unexpected or partially enabled Access paths overlap the production hostname")
	}
}

func checkCloudflareIngress(host string, apps map[string]cloudflareAccessApp,
	identityPaths, protocolPaths map[string]cloudflarePath, target *cloudflareTarget,
	ingress []zero_trust.TunnelCloudflaredConfigurationGetResponseConfigIngress) error {
	type rule struct {
		path      string
		audiences []string
	}
	var expected []rule
	if target.PublicProtocolEnabled {
		for _, key := range slices.Sorted(maps.Keys(protocolPaths)) {
			if path := protocolPaths[key].TunnelPath; path != "" {
				expected = append(expected, rule{path: path})
			}
		}
	}
	authorAudience := apps[""].AUD
	for _, key := range slices.Sorted(maps.Keys(identityPaths)) {
		path := identityPaths[key]
		expected = append(expected, rule{path.TunnelPath, []string{apps[path.Path].AUD, authorAudience}})
	}
	expected = append(expected, rule{audiences: []string{authorAudience}})
	if len(ingress) != len(expected)+1 {
		return cloudflareDrift("Tunnel ingress has unexpected or missing routes")
	}
	for i, want := range expected {
		actual := ingress[i]
		if actual.Hostname != host || actual.Path != want.path || actual.Service != "http://codexia-api:3000" ||
			actual.OriginRequest.HTTPHostHeader != host {
			return cloudflareDrift("a Tunnel ingress rule differs from the current Terraform contract")
		}
		access := actual.OriginRequest.Access
		if len(want.audiences) == 0 {
			if access.Required {
				return cloudflareDrift("a public protocol Tunnel rule unexpectedly requires Access")
			}
			continue
		}
		if target.TunnelTeamName == "" {
			target.TunnelTeamName = access.TeamName
		}
		if !access.Required || !cloudflareTeam.MatchString(target.TunnelTeamName) || access.TeamName != target.TunnelTeamName ||
			!slices.Equal(slices.Sorted(slices.Values(access.AUDTag)), slices.Sorted(slices.Values(want.audiences))) {
			return cloudflareDrift("a protected Tunnel ingress rule has an unexpected Access team or audience")
		}
	}
	catchAll := ingress[len(ingress)-1]
	if catchAll.Hostname != "" || catchAll.Path != "" || catchAll.Service != "http_status:404" {
		return cloudflareDrift("Tunnel ingress needs an unconditional final 404")
	}
	return nil
}
