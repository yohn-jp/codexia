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
	"time"

	cloudflare "github.com/cloudflare/cloudflare-go/v7"
	"github.com/cloudflare/cloudflare-go/v7/option"
	"github.com/cloudflare/cloudflare-go/v7/workers"
)

const (
	cloudflareAPIBase     = "https://api.cloudflare.com/client/v4/"
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
	SSHHostname           string `json:"sshHostname"`
	SSHPolicyID           string `json:"sshPolicyId"`
	TunnelTeamName        string `json:"tunnelTeamName"`
	PublicProtocolEnabled bool   `json:"publicProtocolEnabled"`
}

type cloudflareAPI struct {
	workers *workers.WorkerService
}

type cloudflareObservation struct {
	Plan                   []string
	cf                     cfCommandRunner
	managed                *managedEdgeProvider
	cloudflareRequirements cfDeviceRequirements
	temporaryCredentials   map[string]cfCredentialReceipt
	Target                 string
	Connectors             bool
	ConnectorIDs           []string
	AccountID              string

	target         cloudflareTarget
	routesContract []byte
	host           string
	operator       operator
	api            cloudflareAPI
	closeAuth      func()
}

func newCloudflareAPI(secret []byte, baseURL string) cloudflareAPI {
	client := &http.Client{Timeout: 25 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	// Construct the SDK services directly so ambient Cloudflare keys and custom
	// headers from a different user's session never become deployment credentials.
	opts := []option.RequestOption{option.WithBaseURL(baseURL), option.WithHTTPClient(client),
		option.WithAPIToken(string(secret)), option.WithMiddleware(checkCloudflareResponse)}
	return cloudflareAPI{workers: workers.NewWorkerService(opts...)}
}

func checkCloudflareResponse(request *http.Request, next option.MiddlewareNext) (*http.Response, error) {
	response, err := next(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return nil, errors.New("Cloudflare redirected the authenticated SDK request")
	}
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

func observeCloudflare(ctx context.Context, o operator, repo githubTarget, settings productionContract,
	snapshot githubSnapshot, requirements cfDeviceRequirements) (*cloudflareObservation, error) {
	origin, err := url.Parse(settings.PublicOrigin)
	if err != nil || origin.Scheme != "https" || origin.Hostname() != origin.Host || origin.User != nil ||
		origin.Path != "" || origin.RawQuery != "" || origin.ForceQuery || origin.Fragment != "" ||
		!validDNSHostname(origin.Host) || !validDNSHostname(settings.ManagementHostname) ||
		origin.Host == settings.ManagementHostname || !repo.valid() {
		return nil, refused("Cloudflare requires a verified repository, HTTPS production origin and distinct management hostname")
	}
	bindings, err := protectedCloudflareBindings(snapshot, repo, settings)
	if err != nil {
		return nil, err
	}
	runtime, err := startCloudflareSession(ctx, o, origin.Host, settings.ManagementHostname, cfDeviceRequirements{zoneID: bindings.ZoneID})
	if err != nil {
		return nil, err
	}
	keepSession := false
	defer func() {
		if !keepSession {
			_ = runtime.close()
		}
	}()
	zone, err := cfFindZone(ctx, runtime, origin.Host)
	if err != nil {
		return nil, err
	}
	if (bindings.ZoneID != "" && bindings.ZoneID != zone.ID) ||
		(bindings.AccountID != "" && bindings.AccountID != zone.Account.ID) {
		return nil, refused("Cloudflare account or zone differs from the existing protected target")
	}
	if err := runtime.setAccount(zone.Account.ID); err != nil {
		return nil, err
	}
	spec := managedEdgeSpec{
		Repository: repo, Host: origin.Host, ManagementHost: settings.ManagementHostname,
		AccountID: zone.Account.ID, ZoneID: zone.ID, ExpectedTunnelID: bindings.TunnelID,
		TeamName: bindings.TunnelTeamName, AuthorPolicyID: bindings.AuthorPolicyID,
		ProbePolicyID: bindings.CIPolicyID, ManagementPolicyID: bindings.SSHPolicyID,
		ProductService: managedEdgePublicationService, SSHService: managedEdgeManagementService,
		PublicProtocolEnabled: bindings.PublicProtocolEnabled, Contract: settings.edge,
	}
	provider := &managedEdgeProvider{cf: runtime, spec: spec}
	if !requirements.allowTemporaryObservation {
		_, err := provider.Observe(ctx, spec)
		return nil, err
	}

	keepSession = true
	return &cloudflareObservation{
		AccountID: zone.Account.ID, host: origin.Host, operator: o, cf: runtime, managed: provider,
		routesContract: settings.edge.routes, cloudflareRequirements: requirements,
		target: cloudflareTarget{Repository: repo.FullName(), RepositoryID: repo.RepoID, OwnerID: repo.OwnerID,
			Origin: settings.PublicOrigin, SSHHostname: settings.ManagementHostname, AccountID: zone.Account.ID, ZoneID: zone.ID},
		closeAuth: func() {
			if err := runtime.close(); err != nil {
				o.Notice("Official cf session cleanup could not be fully verified")
			}
		},
	}, nil
}

func validateProtectedCloudflareTarget(snapshot githubSnapshot, repo githubTarget, settings productionContract) error {
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
		if stored.Repository != repo.FullName() || stored.RepositoryID != repo.RepoID || stored.OwnerID != repo.OwnerID || stored.Origin != settings.PublicOrigin {
			return refused(environment + "/" + edgeTarget + " belongs to a different repository or origin. Reconcile the environment with the independently verified Cloudflare account, zone and origin before continuing")
		}
		if stored.SSHHostname != "" || stored.SSHPolicyID != "" {
			if stored.SSHHostname != settings.ManagementHostname || !cloudflareUUID.MatchString(stored.SSHPolicyID) {
				return refused(environment + "/" + edgeTarget + " belongs to a different or unverified Cloudflare management target")
			}
		}
	}
	return nil
}

func protectedCloudflareBindings(snapshot githubSnapshot, repo githubTarget, settings productionContract) (cloudflareTarget, error) {
	var result cloudflareTarget
	var observedProtocol bool
	if err := validateProtectedCloudflareTarget(snapshot, repo, settings); err != nil {
		return result, err
	}
	for _, environment := range []string{bootstrapEnvironment, productionEnvironment} {
		value, exists := selectEnvironment(snapshot, environment).Variables[edgeTarget]
		if !exists {
			continue
		}
		var stored cloudflareTarget
		if err := json.Unmarshal([]byte(value), &stored); err != nil {
			return result, refused("Protected Cloudflare target was not verified")
		}
		// The SSH binding can be absent during migration. All previously
		// recorded resource identities must still agree with one another.
		for _, pair := range []struct {
			dest *string
			id   string
		}{
			{&result.AccountID, stored.AccountID}, {&result.ZoneID, stored.ZoneID}, {&result.TunnelID, stored.TunnelID},
			{&result.AuthorPolicyID, stored.AuthorPolicyID}, {&result.CIPolicyID, stored.CIPolicyID},
			{&result.SSHPolicyID, stored.SSHPolicyID}, {&result.TunnelTeamName, stored.TunnelTeamName},
		} {
			if pair.id == "" {
				continue
			}
			if *pair.dest != "" && *pair.dest != pair.id {
				return result, refused("Protected Cloudflare resource identities differ between GitHub Environments")
			}
			*pair.dest = pair.id
		}
		if observedProtocol && result.PublicProtocolEnabled != stored.PublicProtocolEnabled {
			return result, refused("Protected Cloudflare protocol states differ between GitHub Environments")
		}
		result.PublicProtocolEnabled, observedProtocol = stored.PublicProtocolEnabled, true
	}
	return result, nil
}
