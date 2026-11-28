package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	cloudflare "github.com/cloudflare/cloudflare-go/v7"
	"github.com/cloudflare/cloudflare-go/v7/option"
	"github.com/cloudflare/cloudflare-go/v7/workers"
)

type managedEdgeProvider struct {
	cf           cfCommandRunner
	reader       cloudflareAPI
	routeWriter  func(context.Context) (cloudflareAPI, error)
	workerWriter func(context.Context) (cloudflareAPI, error)
	spec         managedEdgeSpec
}

type cfZone struct {
	ID, Name, Status string
	Account          struct{ ID string }
}

func cfFindZone(ctx context.Context, cf cfCommandRunner, host string) (cfZone, error) {
	var candidates []cfZone
	for suffix := host; strings.Contains(suffix, "."); {
		zones, err := cfList[cfZone](ctx, cf, "zones", "list", "--name", suffix)
		if err != nil {
			return cfZone{}, err
		}
		for _, zone := range zones {
			if zone.Name == suffix {
				candidates = append(candidates, zone)
			}
		}
		_, suffix, _ = strings.Cut(suffix, ".")
	}
	if len(candidates) != 1 || candidates[0].Status != "active" ||
		!cloudflareID.MatchString(candidates[0].ID) || !cloudflareID.MatchString(candidates[0].Account.ID) {
		return cfZone{}, needsAction("Cloudflare did not verify one active zone for the requested hostname")
	}
	return candidates[0], nil
}

// The fixed cf version supplies account-side inventory by generated public
// commands. Its public command catalogue does not expose the complete zone
// route or custom-domain inventory. Those observations use only the separately
// verified, account and zone restricted SDK credential.
func (p managedEdgeProvider) Observe(ctx context.Context, spec managedEdgeSpec) (managedEdgeInventory, error) {
	for _, host := range []string{spec.Host, spec.ManagementHost} {
		zone, err := cfFindZone(ctx, p.cf, host)
		if err != nil {
			return managedEdgeInventory{}, err
		}
		if zone.ID != spec.ZoneID || zone.Account.ID != spec.AccountID {
			return managedEdgeInventory{}, refused("Cloudflare edge hostname belongs to a different account or zone")
		}
	}
	state, err := p.observeAccount(ctx, spec)
	if err != nil {
		return state, err
	}
	if p.reader.workers == nil {
		return state, needsAction("Cloudflare cf " + cfCLIVersion + " cannot list the complete Workers Routes or Custom Domains inventory. A separately issued and verified bounded observation credential is required; run init to approve issuance")
	}
	err = observeManagedWorkerRouting(ctx, p.reader, spec, &state)
	return state, err
}

func (p managedEdgeProvider) observeAccount(ctx context.Context, spec managedEdgeSpec) (managedEdgeInventory, error) {
	var state managedEdgeInventory
	var err error
	if state.Tunnels, err = cfList[managedEdgeTunnel](ctx, p.cf, "tunnels", "list", "--name", cloudflareTunnel, "--is-deleted=false"); err != nil {
		return state, err
	}
	for _, host := range []string{spec.Host, spec.ManagementHost} {
		records, err := cfList[managedEdgeDNS](ctx, p.cf, "dns", "records", "list", "--zone", spec.ZoneID, "--name-exact", host)
		if err != nil {
			return state, err
		}
		state.DNS = append(state.DNS, records...)
	}
	if state.Workers, err = cfList[managedEdgeWorker](ctx, p.cf, "workers", "list"); err != nil {
		return state, err
	}
	if state.Apps, err = cfList[managedEdgeApp](ctx, p.cf, "zero-trust", "access", "applications", "list"); err != nil {
		return state, err
	}
	if state.Policies, err = cfList[managedEdgePolicy](ctx, p.cf, "zero-trust", "access", "policies", "list"); err != nil {
		return state, err
	}
	if state.Providers, err = cfList[managedEdgeIdentityProvider](ctx, p.cf, "zero-trust", "identity-providers", "list"); err != nil {
		return state, err
	}
	for _, provider := range state.Providers {
		if !cloudflareUUID.MatchString(provider.ID) || slices.Contains(state.IdentityProviders, provider.ID) {
			return state, errors.New("Invalid Cloudflare identity provider inventory")
		}
		state.IdentityProviders = append(state.IdentityProviders, provider.ID)
	}
	organization, err := cfResult[struct {
		AuthDomain string `json:"auth_domain"`
	}](ctx, p.cf, "zero-trust", "organization", "get")
	if err != nil {
		return state, err
	}
	authDomain := strings.TrimPrefix(organization.AuthDomain, "https://")
	team, ok := strings.CutSuffix(authDomain, ".cloudflareaccess.com")
	if !ok || !cloudflareTeam.MatchString(team) {
		return state, errors.New("Cloudflare Access organization did not identify its team")
	}
	state.TeamName = team
	if spec.TeamName != "" && team != spec.TeamName {
		return state, refused("Cloudflare Access team changed after the target was confirmed")
	}
	state.AppPolicies = make(map[string][]cloudflareAccessPolicy)
	for i, app := range state.Apps {
		if !managedEdgeAppRelevant(app, spec) {
			continue
		}
		if !cloudflareUUID.MatchString(app.ID) {
			return state, errors.New("Invalid Cloudflare Access application identity")
		}
		detail, err := cfResult[managedEdgeApp](ctx, p.cf, "zero-trust", "access", "applications", "get", app.ID)
		if err != nil {
			return state, err
		}
		if detail.ID != app.ID || detail.Domain != app.Domain || detail.AUD != app.AUD || detail.Policies == nil {
			return state, errors.New("Cloudflare Access application and its attached policies could not be bound to the inventory")
		}
		for _, policy := range detail.Policies {
			if !cloudflareUUID.MatchString(policy.ID) {
				return state, errors.New("Invalid Cloudflare Access application policy identity")
			}
		}
		slices.SortFunc(detail.Policies, compareCloudflarePolicyPrecedence)
		state.AppPolicies[app.ID] = detail.Policies
		state.Apps[i] = detail
	}
	for _, tunnel := range state.Tunnels {
		if tunnel.Name != cloudflareTunnel {
			continue
		}
		if !cloudflareUUID.MatchString(tunnel.ID) || tunnel.AccountTag != spec.AccountID || tunnel.ConfigSrc != "cloudflare" {
			return state, errors.New("Invalid Cloudflare Tunnel identity")
		}
		config, err := cfResult[struct {
			TunnelID  string `json:"tunnel_id"`
			AccountID string `json:"account_id"`
			Source    string
			Config    map[string]json.RawMessage
		}](ctx, p.cf, "tunnels", "config", "get", tunnel.ID)
		if err != nil {
			return state, err
		}
		if config.TunnelID != tunnel.ID || config.AccountID != spec.AccountID || config.Source != "cloudflare" {
			return state, errors.New("Cloudflare Tunnel configuration identity differs")
		}
		state.TunnelConfig = config.Config
	}
	return state, nil
}

func observeManagedWorkerRouting(ctx context.Context, api cloudflareAPI, spec managedEdgeSpec, state *managedEdgeInventory) error {
	items, err := api.workers.Routes.List(ctx, workers.RouteListParams{ZoneID: cloudflare.F(spec.ZoneID)})
	if err != nil {
		return cloudflareError("Worker Routes inventory", err)
	}
	if items == nil || items.JSON.Result.IsInvalid() || items.JSON.Result.IsNull() {
		return errors.New("Cloudflare Worker Routes inventory is not verifiable")
	}
	for _, item := range items.Result {
		state.Routes = append(state.Routes, managedEdgeRoute{ID: item.ID, Pattern: item.Pattern, Script: item.Script})
	}
	account := cloudflare.F(spec.AccountID)
	for _, query := range []workers.DomainListParams{
		{AccountID: account, Service: cloudflare.F(cloudflareWorker)},
		{AccountID: account, Hostname: cloudflare.F(spec.Host)},
		{AccountID: account, Hostname: cloudflare.F(spec.ManagementHost)},
	} {
		domains, err := api.workers.Domains.List(ctx, query)
		if err != nil {
			return cloudflareError("Worker Custom Domains inventory", err)
		}
		if domains == nil || domains.JSON.Result.IsInvalid() || domains.JSON.Result.IsNull() {
			return errors.New("Cloudflare Worker Custom Domains inventory is not verifiable")
		}
		state.CustomDomainConflict = state.CustomDomainConflict || len(domains.Result) != 0
	}
	return nil
}

func (p managedEdgeProvider) Apply(ctx context.Context, change managedEdgeChange) error {
	account, zone := "accounts/"+p.spec.AccountID, "zones/"+p.spec.ZoneID
	switch {
	case change.Method == http.MethodPost && change.Path == account+"/cfd_tunnel":
		return runCFChange(ctx, p.cf, change.Body, "tunnels", "create")
	case change.Method == http.MethodPost && change.Path == account+"/access/apps":
		return runCFChange(ctx, p.cf, change.Body, "zero-trust", "access", "applications", "create")
	case change.Method == http.MethodPost && change.Path == account+"/access/policies":
		return runCFChange(ctx, p.cf, change.Body, "zero-trust", "access", "policies", "create")
	case change.Method == http.MethodPost && change.Path == zone+"/dns_records":
		return runCFChange(ctx, p.cf, change.Body, "dns", "records", "create", "--zone", p.spec.ZoneID)
	case change.Method == http.MethodPost && change.Path == zone+"/workers/routes":
		return p.createRoute(ctx, change.Body)
	case change.Method == http.MethodPost && change.Path == account+"/workers/workers":
		return p.createWorker(ctx)
	case change.Method == http.MethodPut:
		id := strings.TrimSuffix(strings.TrimPrefix(change.Path, account+"/cfd_tunnel/"), "/configurations")
		if cloudflareUUID.MatchString(id) && change.Path == account+"/cfd_tunnel/"+id+"/configurations" {
			return runCFChange(ctx, p.cf, change.Body, "tunnels", "config", "update", id)
		}
	case change.Method == http.MethodDelete:
		id, found := strings.CutPrefix(change.Path, account+"/access/apps/")
		if found && cloudflareUUID.MatchString(id) && change.Body == nil {
			return runCFChange(ctx, p.cf, nil, "zero-trust", "access", "applications", "delete", id, "--force")
		}
	}
	return refused("Cloudflare change does not identify an approved operation on the verified account or zone")
}

func runCFChange(ctx context.Context, cf cfCommandRunner, body any, args ...string) error {
	if body != nil {
		file, err := os.CreateTemp("", "codexiactl-edge-request-")
		if err != nil {
			return errors.New("Could not prepare a private Cloudflare request")
		}
		defer os.Remove(file.Name())
		encodeErr := json.NewEncoder(file).Encode(body)
		if err := errors.Join(encodeErr, file.Close()); err != nil {
			return errors.New("Could not prepare a private Cloudflare request")
		}
		args = append(args, "--body", "@"+file.Name())
	}
	// Cloudflare's delete result may be empty. Reconciliation independently
	// re-observes the resource and reports success only from the new inventory.
	result, err := cf.run(ctx, args...)
	defer clear(result)
	if err != nil || body == nil {
		return err
	}
	var response map[string]json.RawMessage
	if json.Unmarshal(result, &response) != nil || len(response) == 0 {
		return errors.New("Cloudflare cf write did not return a verifiable resource")
	}
	return nil
}

func (p managedEdgeProvider) createRoute(ctx context.Context, value any) error {
	body, ok := value.(map[string]any)
	if !ok || p.routeWriter == nil {
		return errors.New("Cloudflare route mutation authority is unavailable")
	}
	pattern, _ := body["pattern"].(string)
	script, _ := body["script"].(string)
	if pattern == "" || !strings.HasPrefix(pattern, p.spec.Host+"/") || script != "" && script != cloudflareWorker {
		return errors.New("Invalid managed Cloudflare route")
	}
	api, err := p.routeWriter(ctx)
	if err != nil {
		return err
	}
	params := workers.RouteNewParams{ZoneID: cloudflare.F(p.spec.ZoneID), Pattern: cloudflare.F(pattern)}
	if script != "" {
		params.Script = cloudflare.F(script)
	}
	result, err := api.workers.Routes.New(ctx, params, option.WithMaxRetries(0))
	if err != nil {
		return cloudflareError("create unambiguous Worker route", err)
	}
	if result == nil || !cloudflareID.MatchString(result.ID) || result.Pattern != pattern || result.Script != script {
		return errors.New("Cloudflare Worker route creation result does not match the approved route")
	}
	return nil
}

func (p managedEdgeProvider) createWorker(ctx context.Context) error {
	if p.workerWriter == nil {
		return errors.New("Cloudflare empty Worker mutation authority is unavailable")
	}
	api, err := p.workerWriter(ctx)
	if err != nil {
		return err
	}
	params := workers.BetaWorkerNewParams{
		AccountID: cloudflare.F(p.spec.AccountID),
		Worker: workers.WorkerParam{
			Name:          cloudflare.F(cloudflareWorker),
			Logpush:       cloudflare.F(false),
			Observability: cloudflare.F(workers.WorkerObservabilityParam{Enabled: cloudflare.F(false)}),
			Tags:          cloudflare.F([]string{}),
			TailConsumers: cloudflare.F([]workers.WorkerTailConsumerParam{}),
			Subdomain: cloudflare.F(workers.WorkerSubdomainParam{
				Enabled:         cloudflare.F(false),
				PreviewsEnabled: cloudflare.F(false),
			}),
		},
	}
	result, err := api.workers.Beta.Workers.New(ctx, params, option.WithMaxRetries(0))
	if err != nil {
		return cloudflareError("create empty Worker", err)
	}
	if result == nil || result.Name != cloudflareWorker || !cloudflareWorkerID.MatchString(result.ID) ||
		result.Subdomain.Enabled || result.Subdomain.PreviewsEnabled ||
		result.Subdomain.JSON.Enabled.IsMissing() || result.Subdomain.JSON.PreviewsEnabled.IsMissing() {
		return errors.New("Cloudflare empty Worker result did not match the canonical Worker and its publication boundary")
	}
	return nil
}

func (o *cloudflareObservation) converge(ctx context.Context, snapshot githubSnapshot, guard func(context.Context) error) (resultErr error) {
	p := o.managed
	if p == nil || guard == nil {
		return errors.New("Cloudflare convergence requires a guarded provider session")
	}
	settings := productionContract{PublicOrigin: o.target.Origin, ManagementHostname: p.spec.ManagementHost}
	bindings, err := protectedCloudflareBindings(snapshot, p.spec.Repository, settings)
	if err != nil {
		return err
	}
	if bindings.AccountID != "" && bindings.AccountID != p.spec.AccountID || bindings.ZoneID != "" && bindings.ZoneID != p.spec.ZoneID {
		return refused("Cloudflare account or zone differs from the protected target")
	}
	if err := guard(ctx); err != nil {
		return err
	}
	// Observation requires a separately approved, short-lived credential
	// because these inventory reads are absent from the pinned cf CLI.
	req := o.cloudflareRequirements
	req.accountTokenCreate = true
	req.zoneID = p.spec.ZoneID
	if err := o.replaceManagedSession(ctx, req); err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		for _, role := range []string{cloudflareRouteRole, cloudflareEdgeWorkerRole, cloudflareObservationRole} {
			resultErr = errors.Join(resultErr, o.retireAccountCredential(cleanup, role))
		}
		p.reader = cloudflareAPI{}
		p.routeWriter, p.workerWriter = nil, nil
	}()
	if err := guard(ctx); err != nil {
		return err
	}
	reader, err := o.newManagedSDK(ctx, cloudflareObservationRole)
	if err != nil {
		return err
	}
	p.reader = reader
	state, err := p.Observe(ctx, p.spec)
	if err != nil {
		return err
	}
	spec, err := selectManagedEdgeAuthorities(o.operator, p.spec, state)
	if err != nil {
		return err
	}
	p.spec = spec
	var routeSDK, workerSDK cloudflareAPI
	p.routeWriter = func(ctx context.Context) (cloudflareAPI, error) {
		if routeSDK.workers == nil {
			routeSDK, err = o.newManagedSDK(ctx, cloudflareRouteRole)
		}
		return routeSDK, err
	}
	p.workerWriter = func(ctx context.Context) (cloudflareAPI, error) {
		if workerSDK.workers == nil {
			workerSDK, err = o.newManagedSDK(ctx, cloudflareEdgeWorkerRole)
		}
		return workerSDK, err
	}
	o.Plan, err = reconcileManagedEdge(ctx, p, spec, func(plan []string) error {
		o.operator.Notice("Cloudflare edge plan for repository " + spec.Repository.FullName() + ", account " + spec.AccountID +
			", zone " + spec.ZoneID + ":\n- " + strings.Join(plan, "\n- "))
		if err := requireApproval(o.operator, "Apply this Cloudflare edge plan while the publication gate is closed?"); err != nil {
			return err
		}
		requiresWorkerWrite := req.workerScriptsWrite
		managedEdgeRequirements(plan, &req)
		if req.managedAccess || req.managedDNS || req.managedTunnel || req.workerScriptsWrite != requiresWorkerWrite {
			return o.replaceManagedSession(ctx, req)
		}
		return nil
	}, guard)
	if err != nil {
		return err
	}
	return o.finalizeManagedObservation(ctx, spec)
}

func (o *cloudflareObservation) newManagedSDK(ctx context.Context, role string) (cloudflareAPI, error) {
	secret, err := o.provisionAccountCredential(ctx, role)
	if err != nil {
		return cloudflareAPI{}, err
	}
	defer clear(secret)
	return newCloudflareAPI(secret, cloudflareAPIBase), nil
}

func (o *cloudflareObservation) replaceManagedSession(ctx context.Context, requirements cfDeviceRequirements) error {
	p := o.managed
	runtime, err := startCloudflareSession(ctx, o.operator, p.spec.Host, p.spec.ManagementHost, requirements)
	if err != nil {
		return err
	}
	if err := runtime.setAccount(p.spec.AccountID); err != nil {
		_ = runtime.close()
		return err
	}
	if o.closeAuth != nil {
		o.closeAuth()
	}
	o.closeAuth = func() {
		if err := runtime.close(); err != nil {
			o.operator.Notice("Official cf session cleanup could not be fully verified")
		}
	}
	o.cf, p.cf = runtime, runtime
	return nil
}

func managedEdgeRequirements(plan []string, req *cfDeviceRequirements) {
	for _, key := range plan {
		switch {
		case strings.HasPrefix(key, "create Access "), strings.HasPrefix(key, "create policy "),
			strings.HasPrefix(key, "create Bypass "), strings.HasPrefix(key, "remove Bypass "):
			req.managedAccess = true
		case key == "create Tunnel", key == "converge Tunnel ingress":
			req.managedTunnel = true
		case strings.HasPrefix(key, "create DNS "):
			req.managedDNS = true
		case key == "create empty Worker":
			req.workerScriptsWrite = true
		}
	}
}

func selectManagedEdgeAuthorities(o operator, spec managedEdgeSpec, state managedEdgeInventory) (managedEdgeSpec, error) {
	spec.TeamName = state.TeamName
	for _, app := range state.Apps {
		if app.Domain != spec.Host {
			continue
		}
		policies := state.AppPolicies[app.ID]
		if app.Type != "self_hosted" || len(policies) != 1 || policies[0].Decision != "allow" ||
			(spec.AuthorPolicyID != "" && spec.AuthorPolicyID != policies[0].ID) || len(app.AllowedIDPs) == 0 ||
			len(spec.AllowedIDPs) != 0 {
			return spec, refused("Existing production Access application did not verify the shared author policy and selected identity providers")
		}
		spec.AuthorPolicyID = policies[0].ID
		spec.AllowedIDPs = slices.Clone(app.AllowedIDPs)
	}
	if spec.AuthorPolicyID == "" {
		var ids, labels []string
		for _, policy := range state.Policies {
			if policy.Decision == "allow" && len(policy.Include) != 0 && cloudflareUUID.MatchString(policy.ID) {
				ids = append(ids, policy.ID)
				labels = append(labels, safeTerminalText(policy.Name)+" ("+policy.ID+")")
			}
		}
		if len(ids) == 0 {
			return spec, needsAction("Cloudflare account owner must configure a reusable author Allow policy before deployment")
		}
		idx, err := selectOption(o, "Confirm the Cloudflare account-owned author Allow policy for the production application", labels)
		if err != nil {
			return spec, err
		}
		spec.AuthorPolicyID = ids[idx]
	}
	if len(spec.AllowedIDPs) == 0 {
		if len(state.Providers) == 0 {
			return spec, needsAction("Cloudflare account owner must configure an identity provider before deployment")
		}
		labels := make([]string, len(state.Providers))
		for i, provider := range state.Providers {
			labels[i] = safeTerminalText(provider.Name) + " (" + provider.ID + ")"
		}
		idx, err := selectOption(o, "Confirm the Cloudflare account-owned identity provider for the production application", labels)
		if err != nil {
			return spec, err
		}
		spec.AllowedIDPs = []string{state.Providers[idx].ID}
	}
	return spec, nil
}

func (o *cloudflareObservation) finalizeManagedObservation(ctx context.Context, spec managedEdgeSpec) error {
	state, err := o.managed.Observe(ctx, spec)
	if err != nil {
		return err
	}
	if changes, err := planManagedEdge(spec, state); err != nil || len(changes) != 0 {
		return errors.Join(err, errors.New("Cloudflare resources changed before final observation"))
	}
	target := o.target
	target.AuthorPolicyID, target.TunnelTeamName = spec.AuthorPolicyID, spec.TeamName
	target.PublicProtocolEnabled = spec.PublicProtocolEnabled
	for _, tunnel := range state.Tunnels {
		if tunnel.Name == cloudflareTunnel {
			target.TunnelID = tunnel.ID
		}
	}
	for _, app := range state.Apps {
		policies := state.AppPolicies[app.ID]
		switch {
		case app.Domain == spec.ManagementHost && len(policies) == 1:
			target.SSHPolicyID = policies[0].ID
		case len(policies) == 2 && strings.HasPrefix(app.Domain, spec.Host+"/") && exactManagedServicePolicy(policies[0], managedEdgeProbeTags(spec.Repository.RepoID)):
			target.CIPolicyID = policies[0].ID
		}
	}
	if !cloudflareUUID.MatchString(target.TunnelID) || !cloudflareUUID.MatchString(target.SSHPolicyID) || !cloudflareUUID.MatchString(target.CIPolicyID) {
		return errors.New("Cloudflare final observation did not verify the Tunnel and both Service Auth policy identities")
	}
	connections, err := cfResult[[]struct{ ID string }](ctx, o.cf, "tunnels", "connections", "list", "--tunnel-id", target.TunnelID)
	if err != nil {
		return err
	}
	connectorIDs := make([]string, 0, len(connections))
	for _, connection := range connections {
		if !cloudflareUUID.MatchString(connection.ID) || slices.Contains(connectorIDs, connection.ID) {
			return errors.New("Cloudflare returned an unverifiable Tunnel connector identity")
		}
		connectorIDs = append(connectorIDs, connection.ID)
	}
	slices.Sort(connectorIDs)
	encoded, err := json.Marshal(target)
	if err != nil {
		return err
	}
	o.target, o.Target = target, string(encoded)
	o.Connectors, o.ConnectorIDs = len(connectorIDs) > 0, connectorIDs
	reportResult(o.operator, successText, "Cloudflare target verified: account "+target.AccountID+", zone "+target.ZoneID+", Tunnel "+target.TunnelID)
	return nil
}
