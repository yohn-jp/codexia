package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	cloudflare "github.com/cloudflare/cloudflare-go/v7"
	"github.com/cloudflare/cloudflare-go/v7/accounts"
	"github.com/cloudflare/cloudflare-go/v7/dns"
	"github.com/cloudflare/cloudflare-go/v7/option"
	"github.com/cloudflare/cloudflare-go/v7/packages/pagination"
	"github.com/cloudflare/cloudflare-go/v7/user"
	"github.com/cloudflare/cloudflare-go/v7/workers"
	"github.com/cloudflare/cloudflare-go/v7/zero_trust"
	"github.com/cloudflare/cloudflare-go/v7/zones"
)

const (
	cloudflareAPIBase     = "https://api.cloudflare.com/client/v4/"
	cloudflareTokensPage  = "https://dash.cloudflare.com/profile/api-tokens"
	cloudflareWorker      = "codexia-frontend"
	cloudflareTunnel      = "codexia"
	cloudflarePageSize    = 50
	cloudflareMaxPages    = 100
	cloudflareMaxResponse = 8 << 20
)

var (
	cloudflareID   = regexp.MustCompile(`^[a-f0-9]{32}$`)
	cloudflareUUID = regexp.MustCompile(`^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$`)
	cloudflareHost = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`)
)

type cloudflareTarget struct {
	Repository            string `json:"repository"`
	RepositoryID          int64  `json:"repositoryId"`
	OwnerID               int64  `json:"ownerId"`
	Origin                string `json:"origin"`
	AccountID             string `json:"accountId"`
	ZoneID                string `json:"zoneId"`
	TunnelID              string `json:"tunnelId"`
	AuthorPolicyID        string `json:"authorPolicyId"`
	CIPolicyID            string `json:"ciPolicyId"`
	TunnelTeamName        string `json:"tunnelTeamName"`
	PublicProtocolEnabled bool   `json:"publicProtocolEnabled"`
}

type cloudflareAPI struct {
	resourceClient *cloudflare.Client
	zones          *zones.ZoneService
	dns            *dns.RecordService
	workers        *workers.WorkerService
	tunnels        *zero_trust.TunnelCloudflaredService
	access         *zero_trust.AccessService
	accountTokens  *accounts.TokenService
	userTokens     *user.TokenService
	baseURL        string
}

type cloudflareObservation struct {
	Target       string
	Connectors   bool
	ConnectorIDs []string
	AccountID    string

	target         cloudflareTarget
	routesContract []byte
	host           string
	operator       operator
	api            cloudflareAPI
	serviceToken   zero_trust.ServiceToken
	provisioning   [32]byte
	closeAuth      func()
	readToken      [32]byte
	workerToken    [32]byte
}

func newCloudflareAPI(secret []byte, baseURL string) cloudflareAPI {
	client := &http.Client{Timeout: 25 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	// Construct the SDK services directly so ambient Cloudflare keys and custom
	// headers from a different user's session never become deployment credentials.
	opts := []option.RequestOption{option.WithBaseURL(baseURL), option.WithHTTPClient(client),
		option.WithAPIToken(string(secret)), option.WithMiddleware(checkCloudflareResponse)}
	return cloudflareAPI{
		resourceClient: &cloudflare.Client{Options: opts},
		zones:          zones.NewZoneService(opts...), dns: dns.NewRecordService(opts...), workers: workers.NewWorkerService(opts...),
		tunnels: zero_trust.NewTunnelCloudflaredService(opts...), access: zero_trust.NewAccessService(opts...),
		accountTokens: accounts.NewTokenService(opts...), userTokens: user.NewTokenService(opts...), baseURL: baseURL,
	}
}

func checkCloudflareResponse(request *http.Request, next option.MiddlewareNext) (*http.Response, error) {
	response, err := next(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, cloudflareMaxResponse+1))
	if err != nil || len(body) > cloudflareMaxResponse {
		return nil, errors.New("Cloudflare response body could not be verified")
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		var envelope struct {
			Success bool              `json:"success"`
			Errors  []json.RawMessage `json:"errors"`
			Result  json.RawMessage   `json:"result"`
		}
		if json.Unmarshal(body, &envelope) != nil || !envelope.Success || len(envelope.Errors) != 0 ||
			len(envelope.Result) == 0 || bytes.Equal(envelope.Result, []byte("null")) {
			return nil, errors.New("Cloudflare returned an invalid result envelope")
		}
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	return response, nil
}

func cloudflareError(label string, err error) error {
	if errors.Is(err, context.Canceled) {
		return fmt.Errorf("Cloudflare %s: %w", label, context.Canceled)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("Cloudflare %s: %w", label, context.DeadlineExceeded)
	}
	status := cloudflareStatus(err)
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return needsAction(fmt.Sprintf("Cloudflare %s failed (HTTP %d). Verify the credential's scope and selected account or zone", label, status))
	}
	if status != 0 {
		return fmt.Errorf("Cloudflare %s failed (HTTP %d); verify token scope and target", label, status)
	}
	return fmt.Errorf("Cloudflare %s response could not be verified", label)
}

func cloudflareStatus(err error) int {
	var apiError *cloudflare.Error
	if errors.As(err, &apiError) {
		return apiError.StatusCode
	}
	return 0
}

// Pass the original context on every page. The SDK's GetNextPage currently uses
// a background context and does not expose total_pages as a typed field.
func cloudflareList[T any](label string, page func(int) (*pagination.V4PagePaginationArray[T], error)) ([]T, error) {
	var items []T
	for number := 1; number <= cloudflareMaxPages; number++ {
		result, err := page(number)
		if err != nil {
			return nil, cloudflareError(label, err)
		}
		if result == nil || result.JSON.Result.IsNull() || result.JSON.Result.IsInvalid() {
			return nil, fmt.Errorf("Cloudflare %s returned an invalid list", label)
		}
		items = append(items, result.Result...)
		var info struct {
			Page       int `json:"page"`
			TotalPages int `json:"total_pages"`
		}
		if raw := result.ResultInfo.JSON.RawJSON(); raw != "" && json.Unmarshal([]byte(raw), &info) != nil {
			return nil, fmt.Errorf("Cloudflare %s pagination could not be verified", label)
		}
		if info.Page != 0 && info.Page != number {
			return nil, fmt.Errorf("Cloudflare %s returned the wrong page", label)
		}
		if len(result.Result) == 0 || (info.TotalPages > 0 && number >= info.TotalPages) {
			return items, nil
		}
	}
	return nil, fmt.Errorf("Cloudflare %s exceeds the pagination limit", label)
}

func (api cloudflareAPI) findZone(ctx context.Context, host string) (zones.Zone, error) {
	// Check the full hostname and each possible zone suffix. An overlapping
	// Cloudflare zone must be resolved in the owning account before proceeding.
	var candidates []zones.Zone
	for suffix := host; strings.Contains(suffix, "."); {
		items, err := cloudflareList("zone inventory (Zone Read)", func(page int) (*pagination.V4PagePaginationArray[zones.Zone], error) {
			return api.zones.List(ctx, zones.ZoneListParams{Name: cloudflare.F(suffix), Page: cloudflare.F(float64(page)),
				PerPage: cloudflare.F(float64(cloudflarePageSize))})
		})
		if err != nil {
			return zones.Zone{}, err
		}
		for _, zone := range items {
			if zone.Name == suffix {
				candidates = append(candidates, zone)
			}
		}
		_, suffix, _ = strings.Cut(suffix, ".")
	}
	if len(candidates) > 1 {
		return zones.Zone{}, refused("Cloudflare zone for the production hostname is ambiguous. Verify the correct account and zone scope")
	}
	if len(candidates) != 1 || candidates[0].Status != "active" || !cloudflareID.MatchString(candidates[0].ID) ||
		!cloudflareID.MatchString(candidates[0].Account.ID) {
		return zones.Zone{}, needsAction("Cloudflare active production zone and account were not verified")
	}
	return candidates[0], nil
}

func observeCloudflare(ctx context.Context, o operator, repo githubTarget, settings productionContract, requirements cloudflareAuthRequirements) (*cloudflareObservation, error) {
	origin, err := url.Parse(settings.PublicOrigin)
	if err != nil || origin.Scheme != "https" || origin.Hostname() != origin.Host || origin.User != nil ||
		origin.Path != "" || origin.RawQuery != "" || origin.ForceQuery || origin.Fragment != "" ||
		!strings.Contains(origin.Host, ".") || !cloudflareHost.MatchString(origin.Host) {
		return nil, refused("Cloudflare requires the reviewed HTTPS production origin")
	}
	secret, closeAuth, err := cloudflareManagementCredential(ctx, o, origin.Host, requirements)
	if err != nil {
		return nil, err
	}
	defer clear(secret)
	defer func() {
		if closeAuth != nil {
			closeAuth()
		}
	}()
	api := newCloudflareAPI(secret, cloudflareAPIBase)
	zone, err := api.findZone(ctx, origin.Host)
	if err != nil {
		return nil, err
	}
	observed, err := api.observeEdge(ctx, origin.Host, zone, repo, settings.edge)
	if err != nil {
		return nil, err
	}
	observed.operator = o
	observed.provisioning = cloudflareSecretDigest(secret)
	observed.closeAuth, closeAuth = closeAuth, nil
	if observed.closeAuth != nil && requirements.tokenPolicy {
		// OAuth is not an account API token. Establish the selected account's
		// token-management API access before any protected inputs are written.
		if err := observed.checkOAuthTokenAuthority(ctx, requirements); err != nil {
			observed.Close()
			return nil, err
		}
	}
	reportResult(o, successText, fmt.Sprintf("Cloudflare target verified\nAccount: %s\nZone: %s\nTunnel: %s", observed.AccountID, zone.ID, observed.target.TunnelID))
	return observed, nil
}

func (api cloudflareAPI) observeEdge(ctx context.Context, host string, zone zones.Zone, repo githubTarget, contract cloudflareContract) (*cloudflareObservation, error) {
	if !repo.valid() {
		return nil, refused("Cloudflare resources must belong to a verified deployment repository and origin")
	}
	target := cloudflareTarget{
		Repository: repo.FullName(), RepositoryID: repo.RepoID, OwnerID: repo.OwnerID, Origin: "https://" + host,
		AccountID: zone.Account.ID, ZoneID: zone.ID,
	}
	account := cloudflare.F(target.AccountID)
	zoneID := cloudflare.F(target.ZoneID)
	records, err := cloudflareList("DNS records (DNS Read)", func(page int) (*pagination.V4PagePaginationArray[dns.RecordResponse], error) {
		return api.dns.List(ctx, dns.RecordListParams{ZoneID: zoneID,
			Name: cloudflare.F(dns.RecordListParamsName{Exact: cloudflare.F(host)}),
			Page: cloudflare.F(float64(page)), PerPage: cloudflare.F(float64(cloudflarePageSize))})
	})
	if err != nil {
		return nil, err
	}
	if len(records) != 1 || records[0].Name != host || records[0].Type != "CNAME" || !records[0].Proxied {
		return nil, cloudflareDrift("production hostname needs one proxied Tunnel CNAME")
	}
	target.TunnelID = strings.TrimSuffix(records[0].Content, ".cfargotunnel.com")
	if target.TunnelID == records[0].Content || !cloudflareUUID.MatchString(target.TunnelID) {
		return nil, cloudflareDrift("production CNAME does not identify a Cloudflare Tunnel")
	}
	tunnel, err := api.tunnels.Get(ctx, target.TunnelID, zero_trust.TunnelCloudflaredGetParams{AccountID: account})
	if err != nil {
		return nil, cloudflareError("Tunnel identity (Cloudflare Tunnel Read)", err)
	}
	if tunnel.ID != target.TunnelID || tunnel.AccountTag != target.AccountID || tunnel.Name != cloudflareTunnel ||
		tunnel.ConfigSrc != "cloudflare" || !tunnel.DeletedAt.IsZero() {
		return nil, cloudflareDrift("the production Tunnel identity is different or no longer remote-managed")
	}
	connectors, err := api.tunnels.Connections.Get(ctx, target.TunnelID,
		zero_trust.TunnelCloudflaredConnectionGetParams{AccountID: account})
	if err != nil {
		return nil, cloudflareError("Tunnel connectors (Cloudflare Tunnel Read)", err)
	}
	if connectors.JSON.Result.IsNull() || connectors.JSON.Result.IsInvalid() {
		return nil, errors.New("Cloudflare Tunnel connector inventory was not verified")
	}
	var connectorIDs []string
	for _, connector := range connectors.Result {
		if !cloudflareUUID.MatchString(connector.ID) || slices.Contains(connectorIDs, connector.ID) {
			return nil, errors.New("Cloudflare returned an unverifiable Tunnel connector identity")
		}
		connectorIDs = append(connectorIDs, connector.ID)
	}
	slices.Sort(connectorIDs)
	if err := api.checkWorker(ctx, host, target, contract.routes); err != nil {
		return nil, err
	}
	serviceToken, err := api.checkAccessAndTunnel(ctx, host, &target, contract)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(target)
	if err != nil {
		return nil, err
	}
	return &cloudflareObservation{Target: string(encoded), Connectors: len(connectorIDs) > 0, ConnectorIDs: connectorIDs,
		AccountID: target.AccountID, target: target, routesContract: contract.routes, host: host, api: api, serviceToken: serviceToken}, nil
}

func (api cloudflareAPI) checkWorker(ctx context.Context, host string, target cloudflareTarget, routesContract []byte) error {
	account := cloudflare.F(target.AccountID)
	resources, err := cloudflareList("Worker inventory (Workers Scripts Read)", func(page int) (*pagination.V4PagePaginationArray[workers.Worker], error) {
		return api.workers.Beta.Workers.List(ctx, workers.BetaWorkerListParams{AccountID: account,
			Page: cloudflare.F(int64(page)), PerPage: cloudflare.F(int64(cloudflarePageSize))})
	})
	if err != nil {
		return err
	}
	if err := checkCloudflareWorker(resources); err != nil {
		return err
	}
	for _, query := range []workers.DomainListParams{
		{AccountID: account, Service: cloudflare.F(cloudflareWorker)},
		{AccountID: account, Hostname: cloudflare.F(host)},
	} {
		domains, err := api.workers.Domains.List(ctx, query)
		if err != nil {
			return cloudflareError("Worker custom domains (Workers Scripts Read)", err)
		}
		if domains.JSON.Result.IsNull() || domains.JSON.Result.IsInvalid() || len(domains.Result) != 0 {
			return cloudflareDrift("a Worker custom domain bypasses the canonical ingress or its absence could not be proved")
		}
	}
	routes, err := api.workers.Routes.List(ctx, workers.RouteListParams{ZoneID: cloudflare.F(target.ZoneID)})
	if err != nil {
		return cloudflareError("Worker routes (Workers Routes Read)", err)
	}
	if routes.JSON.Result.IsNull() || routes.JSON.Result.IsInvalid() {
		return errors.New("Cloudflare Worker route inventory was not verified")
	}
	var manifest cloudflareRoutes
	if json.Unmarshal(routesContract, &manifest) != nil || len(manifest.Routes) == 0 || len(manifest.OriginRoutes) == 0 {
		return errors.New("Cloudflare route contract is unavailable in the certified CLI")
	}
	return manifest.check(host, routes.Result)
}

func cloudflareDrift(reason string) error {
	return refused("Cloudflare " + reason + ". Reconcile the Codexia-owned edge through the approved CTL operation or the account-owned Access policy, then observe again")
}

func validateProtectedCloudflareTarget(snapshot githubSnapshot, repo githubTarget, origin string) error {
	for _, environment := range []string{bootstrapEnvironment, productionEnvironment} {
		value, exists := selectEnvironment(snapshot, environment).Variables[edgeTarget]
		if !exists {
			continue
		}
		var stored cloudflareTarget
		if json.Unmarshal([]byte(value), &stored) != nil || stored.Repository == "" ||
			stored.RepositoryID == 0 || stored.OwnerID == 0 || stored.Origin == "" {
			return refused(environment + "/" + edgeTarget + " lacks the required repository and origin binding. Reobserve the edge in doctor and have the repository settings owner review the existing target, then register the verified repository and origin in the same protected Variable at " + repo.URL() + "/settings/environments")
		}
		if stored.Repository != repo.FullName() || stored.RepositoryID != repo.RepoID || stored.OwnerID != repo.OwnerID || stored.Origin != origin {
			return refused(environment + "/" + edgeTarget + " belongs to a different repository or origin. Reconcile the environment with the independently verified Cloudflare account, zone and origin before continuing")
		}
	}
	return nil
}
