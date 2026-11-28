package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"slices"
	"strconv"

	"github.com/cloudflare/cloudflare-go/v7/option"
)

// Use the existing explicitly authenticated SDK, not ambient credentials.
type managedEdgeSDK struct{ api cloudflareAPI }

type managedEdgeEnvelope struct {
	Result     json.RawMessage `json:"result"`
	ResultInfo struct {
		Page       int
		TotalPages int `json:"total_pages"`
	} `json:"result_info"`
}

func (s managedEdgeSDK) request(ctx context.Context, method, path string, body any) (managedEdgeEnvelope, error) {
	var envelope managedEdgeEnvelope
	var opts []option.RequestOption
	if method != "GET" {
		opts = append(opts, option.WithMaxRetries(0))
		if body != nil {
			encoded, err := json.Marshal(body)
			if err != nil {
				return envelope, errors.New("Cloudflare request could not be encoded")
			}
			opts = append(opts, option.WithRequestBody("application/json", encoded))
		}
	}
	err := s.api.resourceClient.Execute(ctx, method, path, nil, &envelope, opts...)
	if err != nil {
		return envelope, cloudflareError("Codexia edge resource", err)
	}
	if len(envelope.Result) == 0 || string(envelope.Result) == "null" {
		return envelope, errors.New("Cloudflare edge result is absent")
	}
	return envelope, nil
}

func managedEdgeList[T any](ctx context.Context, s managedEdgeSDK, path string, query url.Values, paged bool) ([]T, error) {
	var items []T
	for page := 1; page <= cloudflareMaxPages; page++ {
		q := url.Values{}
		for k, v := range query {
			q[k] = slices.Clone(v)
		}
		if paged {
			q.Set("page", strconv.Itoa(page))
			q.Set("per_page", strconv.Itoa(cloudflarePageSize))
		}
		requestPath := path
		if len(q) != 0 {
			requestPath += "?" + q.Encode()
		}
		envelope, err := s.request(ctx, "GET", requestPath, nil)
		if err != nil {
			return nil, err
		}
		var result []T
		if json.Unmarshal(envelope.Result, &result) != nil || result == nil {
			return nil, errors.New("Invalid Cloudflare edge inventory")
		}
		if paged && envelope.ResultInfo.Page != 0 && envelope.ResultInfo.Page != page {
			return nil, errors.New("Unexpected Cloudflare inventory page")
		}
		items = append(items, result...)
		if !paged || len(result) == 0 || envelope.ResultInfo.TotalPages > 0 && page >= envelope.ResultInfo.TotalPages {
			return items, nil
		}
	}
	return nil, errors.New("Cloudflare edge inventory exceeds its page limit")
}

func (s managedEdgeSDK) Observe(ctx context.Context, spec managedEdgeSpec) (managedEdgeInventory, error) {
	var state managedEdgeInventory
	if err := spec.validate(); err != nil {
		return state, err
	}
	for _, host := range []string{spec.Host, spec.ManagementHost} {
		z, err := s.api.findZone(ctx, host)
		if err != nil {
			return state, err
		}
		if z.ID != spec.ZoneID || z.Account.ID != spec.AccountID {
			return state, errors.New("Cloudflare edge hostname belongs to a different account or zone")
		}
	}
	account, zone := "accounts/"+spec.AccountID, "zones/"+spec.ZoneID
	var err error
	if state.Tunnels, err = managedEdgeList[managedEdgeTunnel](ctx, s, account+"/cfd_tunnel", url.Values{"name": {cloudflareTunnel}, "is_deleted": {"false"}}, true); err != nil {
		return state, err
	}
	for _, host := range []string{spec.Host, spec.ManagementHost} {
		records, e := managedEdgeList[managedEdgeDNS](ctx, s, zone+"/dns_records", url.Values{"name": {host}}, true)
		if e != nil {
			return state, e
		}
		state.DNS = append(state.DNS, records...)
	}
	if state.Workers, err = managedEdgeList[managedEdgeWorker](ctx, s, account+"/workers/workers", nil, true); err != nil {
		return state, err
	}
	if state.Routes, err = managedEdgeList[managedEdgeRoute](ctx, s, zone+"/workers/routes", nil, false); err != nil {
		return state, err
	}
	for _, q := range []url.Values{{"service": {cloudflareWorker}}, {"hostname": {spec.Host}}, {"hostname": {spec.ManagementHost}}} {
		domains, e := managedEdgeList[json.RawMessage](ctx, s, account+"/workers/domains", q, false)
		if e != nil {
			return state, e
		}
		state.CustomDomainConflict = state.CustomDomainConflict || len(domains) != 0
	}
	if state.Apps, err = managedEdgeList[managedEdgeApp](ctx, s, account+"/access/apps", nil, true); err != nil {
		return state, err
	}
	if state.Policies, err = managedEdgeList[managedEdgePolicy](ctx, s, account+"/access/policies", nil, true); err != nil {
		return state, err
	}
	providers, e := managedEdgeList[struct{ ID string }](ctx, s, account+"/access/identity_providers", nil, true)
	if e != nil {
		return state, e
	}
	for _, p := range providers {
		state.IdentityProviders = append(state.IdentityProviders, p.ID)
	}
	state.AppPolicies = map[string][]cloudflareAccessPolicy{}
	for _, a := range state.Apps {
		if !cloudflareUUID.MatchString(a.ID) {
			return state, errors.New("Invalid Cloudflare Access app identity")
		}
		relevant := func(domain string) bool {
			return cloudflareMatchesHost(domain, spec.Host) || cloudflareMatchesHost(domain, spec.ManagementHost)
		}
		domains := slices.Clone(a.SelfHostedDomains)
		for _, d := range a.Destinations {
			if d.Type == "public" {
				domains = append(domains, d.URI)
			}
		}
		if !relevant(a.Domain) && !slices.ContainsFunc(domains, relevant) {
			continue
		}
		policies, e := s.api.cloudflarePolicies(ctx, spec.AccountID, a.ID)
		if e != nil {
			return state, e
		}
		state.AppPolicies[a.ID] = policies
	}
	for _, t := range state.Tunnels {
		if t.Name != cloudflareTunnel {
			continue
		}
		if !cloudflareUUID.MatchString(t.ID) || t.AccountTag != spec.AccountID || t.ConfigSrc != "cloudflare" {
			return state, errors.New("Invalid Cloudflare Tunnel identity")
		}
		envelope, e := s.request(ctx, "GET", account+"/cfd_tunnel/"+t.ID+"/configurations", nil)
		if e != nil {
			return state, e
		}
		var config struct {
			TunnelID  string `json:"tunnel_id"`
			AccountID string `json:"account_id"`
			Source    string
			Config    map[string]json.RawMessage
		}
		if json.Unmarshal(envelope.Result, &config) != nil || config.TunnelID != t.ID || config.AccountID != spec.AccountID || config.Source != "cloudflare" {
			return state, errors.New("Cloudflare Tunnel configuration identity differs")
		}
		state.TunnelConfig = config.Config
	}
	return state, nil
}

func (s managedEdgeSDK) Apply(ctx context.Context, change managedEdgeChange) error {
	_, err := s.request(ctx, change.Method, change.Path, change.Body)
	return err
}

// The official cf authentication flow supplies and revokes the temporary,
// scoped SDK token. No OAuth token extraction or manual token input is used.
// The integration caller supplies the verified target and VM/source guard.
func convergeCloudflareResources(ctx context.Context, temporaryAPI cloudflareAPI, spec managedEdgeSpec, approve func([]string) error, guard func(context.Context) error) ([]string, error) {
	if temporaryAPI.resourceClient == nil {
		return nil, errors.New("Cloudflare temporary API session is unavailable")
	}
	return reconcileManagedEdge(ctx, managedEdgeSDK{temporaryAPI}, spec, approve, guard)
}
