package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"time"

	cloudflare "github.com/cloudflare/cloudflare-go/v7"
	"github.com/cloudflare/cloudflare-go/v7/accounts"
	"github.com/cloudflare/cloudflare-go/v7/dns"
	"github.com/cloudflare/cloudflare-go/v7/option"
	"github.com/cloudflare/cloudflare-go/v7/packages/pagination"
	"github.com/cloudflare/cloudflare-go/v7/shared"
	"github.com/cloudflare/cloudflare-go/v7/workers"
	"github.com/cloudflare/cloudflare-go/v7/zero_trust"
)

const (
	cloudflareAccountScope = "com.cloudflare.api.account"
	cloudflareZoneScope    = "com.cloudflare.api.account.zone"
	cloudflareReadRole     = "CODEXIA_DEPLOYMENT_CLOUDFLARE_READ_TOKEN"
	cloudflareWorkerRole   = "CLOUDFLARE_API_TOKEN"
)

var errCloudflareMintUnavailable = errors.New("Cloudflare Account API Tokens Write and exact deployment scopes were not verified")

func (o *cloudflareObservation) Close() {
	o.api = cloudflareAPI{}
	o.operator = nil
	o.provisioning, o.readToken, o.workerToken = [32]byte{}, [32]byte{}, [32]byte{}
}

func validCloudflareSecret(value []byte) bool {
	if len(value) == 0 || len(value) > 4096 {
		return false
	}
	for _, char := range value {
		if char <= ' ' || char > '~' {
			return false
		}
	}
	return true
}

func readCloudflareSecret(o operator, label string) ([]byte, error) {
	value, err := o.Secret(label)
	if err != nil {
		return nil, err
	}
	if !validCloudflareSecret(value) {
		clear(value)
		return nil, errors.New("Cloudflare credential is empty or has invalid characters")
	}
	return value, nil
}

func cloudflareSecretDigest(value []byte) [32]byte { return sha256.Sum256(value) }

func (o *cloudflareObservation) Credential(ctx context.Context, name string) ([]byte, error) {
	return o.credential(ctx, name, false)
}

func (o *cloudflareObservation) ExistingCredential(ctx context.Context, name string) ([]byte, error) {
	return o.credential(ctx, name, true)
}

func (o *cloudflareObservation) credential(ctx context.Context, name string, existing bool) ([]byte, error) {
	switch name {
	case "CLOUDFLARE_ACCOUNT_ID":
		return []byte(o.target.AccountID), nil
	case "CODEXIA_ACCESS_CLIENT_ID":
		return []byte(o.serviceToken.ClientID), nil
	case "CODEXIA_ACCESS_CLIENT_SECRET":
		o.operator.Notice("Cloudflare only exposes the CI Access client secret when the service token is created. Use the current designated service token's authorized credential store. If unavailable, have the account owner provision and attach a scoped replacement to the existing CI-only policy, then rerun discovery. Keep the existing service token until the replacement is verified.")
		return readCloudflareSecret(o.operator, "Existing Cloudflare CI Access service-token client secret")
	case "CODEXIA_TUNNEL_TOKEN":
		return o.tunnelCredential(ctx)
	case cloudflareReadRole, cloudflareWorkerRole:
		return o.apiCredential(ctx, name, existing)
	default:
		return nil, errors.New("Cloudflare credential role is not recognized")
	}
}

func (o *cloudflareObservation) tunnelCredential(ctx context.Context) ([]byte, error) {
	value, err := o.api.tunnels.Token.Get(ctx, o.target.TunnelID,
		zero_trust.TunnelCloudflaredTokenGetParams{AccountID: cloudflare.F(o.target.AccountID)})
	var token []byte
	if err == nil {
		token = []byte(*value)
	} else if cloudflareStatus(err) == http.StatusUnauthorized || cloudflareStatus(err) == http.StatusForbidden {
		o.operator.Notice("Cloudflare denied retrieval. Use the existing token from the verified Tunnel in https://one.dash.cloudflare.com/ or authorized custody. Keep the current token and connector in place.")
		token, err = readCloudflareSecret(o.operator, "Existing Cloudflare Tunnel connector token")
	}
	if err != nil {
		return nil, cloudflareError("existing connector token (Cloudflare Tunnel Edit)", err)
	}
	if !tokenMatchesTunnel(token, o.target) {
		clear(token)
		return nil, errors.New("Cloudflare connector token does not match the observed account and Tunnel")
	}
	return token, nil
}

func tokenMatchesTunnel(token []byte, target cloudflareTarget) bool {
	if !validCloudflareSecret(token) || len(token)%4 != 0 {
		return false
	}
	// Match cloudflared ParseToken: the connector credential is a standard
	// base64-encoded TunnelToken JSON object.
	decoded, err := base64.StdEncoding.AppendDecode(nil, token)
	defer clear(decoded)
	var envelope struct {
		Account string `json:"a"`
		Tunnel  string `json:"t"`
		Secret  []byte `json:"s"`
	}
	defer func() { clear(envelope.Secret) }()
	return err == nil && json.Unmarshal(decoded, &envelope) == nil && envelope.Account == target.AccountID &&
		envelope.Tunnel == target.TunnelID && len(envelope.Secret) > 0
}

type cloudflarePermissionPlan struct {
	name, description string
	permissions       map[string][]string
}

func (o *cloudflareObservation) permissionPlan(role string) cloudflarePermissionPlan {
	if role == cloudflareReadRole {
		return cloudflarePermissionPlan{
			name:        "codexia-deployment-read-" + o.target.ZoneID[:8],
			description: "Workers Scripts Read, Cloudflare Tunnel Read and Access: Apps and Policies Read for the selected account; DNS Read and Workers Routes Read for the selected zone",
			permissions: map[string][]string{
				cloudflareAccountScope: {"Workers Scripts Read", "Cloudflare Tunnel Read", "Access: Apps and Policies Read"},
				cloudflareZoneScope:    {"DNS Read", "Workers Routes Read"},
			},
		}
	}
	return cloudflarePermissionPlan{
		name:        "codexia-worker-publication-" + o.target.AccountID[:8],
		description: "Workers Scripts Edit for the selected account",
		permissions: map[string][]string{cloudflareAccountScope: {"Workers Scripts Write"}},
	}
}

func (o *cloudflareObservation) apiCredential(ctx context.Context, role string, existing bool) ([]byte, error) {
	plan := o.permissionPlan(role)
	var value []byte
	var err error
	if !existing {
		value, err = o.mintCloudflareToken(ctx, plan)
		if err != nil && !errors.Is(err, errCloudflareMintUnavailable) {
			return nil, err
		}
	}
	if len(value) == 0 {
		if existing {
			o.operator.Notice("This credential is already registered in another protected Environment. Retrieve it from its authorized custody.")
		} else {
			o.operator.Notice("Cloudflare could not authorize automatic scoped token issuance. Use an existing valid token or create one at " + cloudflareTokensPage + ". Choose a finite expiry.")
		}
		o.operator.Notice(fmt.Sprintf("Cloudflare credential scope for %s: %s. Account %s, zone %s.", role, plan.description, o.target.AccountID, o.target.ZoneID))
		if err := requireApproval(o.operator, "Provide the separately scoped Cloudflare credential for this role?"); err != nil {
			return nil, err
		}
		value, err = readCloudflareSecret(o.operator, "Cloudflare credential for "+role)
		if err != nil {
			return nil, err
		}
	}
	digest := cloudflareSecretDigest(value)
	if digest == o.provisioning || (role == cloudflareReadRole && digest == o.workerToken) ||
		(role == cloudflareWorkerRole && digest == o.readToken) {
		clear(value)
		return nil, errors.New("Cloudflare management, read and Worker publication credentials must be distinct")
	}
	if err := o.verifyCloudflareCredential(ctx, value, role); err != nil {
		clear(value)
		return nil, err
	}
	if role == cloudflareReadRole {
		o.readToken = digest
	} else {
		o.workerToken = digest
	}
	return value, nil
}

func (o *cloudflareObservation) mintCloudflareToken(ctx context.Context, plan cloudflarePermissionPlan) ([]byte, error) {
	account := cloudflare.F(o.target.AccountID)
	api := o.api.accountTokens
	current, err := api.Verify(ctx, accounts.TokenVerifyParams{AccountID: account})
	if err != nil {
		if cloudflareAuthorizationDenied(err) {
			return nil, errCloudflareMintUnavailable
		}
		return nil, cloudflareError("account token authority", err)
	}
	if current.Status != "active" || !cloudflareID.MatchString(current.ID) {
		return nil, errCloudflareMintUnavailable
	}
	currentMetadata, err := api.Get(ctx, current.ID, accounts.TokenGetParams{AccountID: account})
	if err != nil {
		if cloudflareAuthorizationDenied(err) {
			return nil, errCloudflareMintUnavailable
		}
		return nil, cloudflareError("account token authority metadata", err)
	}
	if currentMetadata.ID != current.ID || !hasCloudflareTokenWrite(currentMetadata, o.target.AccountID) {
		return nil, errCloudflareMintUnavailable
	}
	groups, err := api.PermissionGroups.List(ctx, accounts.TokenPermissionGroupListParams{AccountID: account})
	if err != nil {
		if cloudflareAuthorizationDenied(err) {
			return nil, errCloudflareMintUnavailable
		}
		return nil, cloudflareError("account token permission groups", err)
	}
	if groups.JSON.Result.IsNull() || groups.JSON.Result.IsInvalid() {
		return nil, errors.New("Cloudflare account token permission inventory was not verified")
	}
	policies, expected, err := o.exactTokenPolicies(groups.Result, plan)
	if err != nil {
		return nil, err
	}
	issued, err := cloudflareList("account token inventory", func(page int) (*pagination.V4PagePaginationArray[shared.Token], error) {
		return api.List(ctx, accounts.TokenListParams{AccountID: account, IncludeExpired: cloudflare.F(true),
			Page: cloudflare.F(float64(page)), PerPage: cloudflare.F(float64(cloudflarePageSize))})
	})
	if err != nil {
		return nil, err
	}
	if slices.ContainsFunc(issued, func(token shared.Token) bool { return token.Name == plan.name }) {
		o.operator.Notice("A Cloudflare account token already matches the stable issuance name " + plan.name + ". Review the account inventory and use authorized custody. The provider does not return an existing token's secret.")
		return nil, errCloudflareMintUnavailable
	}
	expiry := time.Now().UTC().Truncate(time.Second).Add(90 * 24 * time.Hour)
	review := fmt.Sprintf("Create Cloudflare account token %s for account %s, zone %s, expiry %s, scope %s?",
		plan.name, o.target.AccountID, o.target.ZoneID, expiry.Format(time.RFC3339), plan.description)
	if err := requireApproval(o.operator, review); err != nil {
		return nil, err
	}
	created, err := api.New(ctx, accounts.TokenNewParams{AccountID: account, Name: cloudflare.F(plan.name),
		Policies: cloudflare.F(policies), ExpiresOn: cloudflare.F(expiry)}, option.WithMaxRetries(0))
	if err != nil {
		if cloudflareAuthorizationDenied(err) {
			return nil, errCloudflareMintUnavailable
		}
		return nil, fmt.Errorf("Cloudflare token issuance could not be confirmed; reconcile %s in the account API token inventory before retrying", plan.name)
	}
	secret := []byte(created.Value)
	if created.Name != plan.name || !cloudflareID.MatchString(created.ID) || created.Status != "active" ||
		!created.ExpiresOn.Equal(expiry) || !matchesCloudflareTokenPolicies(created.Policies, expected) || !validCloudflareSecret(secret) {
		clear(secret)
		return nil, fmt.Errorf("Cloudflare may have created %s but its receipt, scopes or credential could not be verified; reconcile its inventory before retrying", plan.name)
	}
	return secret, nil
}

func cloudflareAuthorizationDenied(err error) bool {
	status := cloudflareStatus(err)
	return status == http.StatusUnauthorized || status == http.StatusForbidden || status == http.StatusNotFound
}

func hasCloudflareTokenWrite(token *shared.Token, account string) bool {
	for _, policy := range token.Policies {
		resources, ok := policy.Resources.(shared.TokenPolicyResourcesIAMResourcesTypeObjectString)
		if !ok || len(resources) != 1 || resources[cloudflareAccountScope+"."+account] != "*" || policy.Effect != "allow" {
			continue
		}
		if slices.ContainsFunc(policy.PermissionGroups, func(group shared.TokenPolicyPermissionGroup) bool {
			return group.Name == "Account API Tokens Write" && cloudflareID.MatchString(group.ID)
		}) {
			return true
		}
	}
	return false
}

func (o *cloudflareObservation) exactTokenPolicies(groups []accounts.TokenPermissionGroupListResponse, plan cloudflarePermissionPlan) (
	[]shared.TokenPolicyParam, map[string][]string, error,
) {
	var policies []shared.TokenPolicyParam
	expected := make(map[string][]string)
	for _, scope := range []string{cloudflareAccountScope, cloudflareZoneScope} {
		scopeID := o.target.AccountID
		if scope == cloudflareZoneScope {
			scopeID = o.target.ZoneID
		}
		resource := scope + "." + scopeID
		var permissions []shared.TokenPolicyPermissionGroupParam
		for _, name := range plan.permissions[scope] {
			var matches []string
			for _, group := range groups {
				if group.Name == name && group.IsSelectable && cloudflareID.MatchString(group.ID) &&
					slices.Contains(group.Scopes, accounts.TokenPermissionGroupListResponseScope(scope)) {
					matches = append(matches, group.ID)
				}
			}
			if len(matches) != 1 || slices.Contains(expected[resource], matches[0]) {
				return nil, nil, errCloudflareMintUnavailable
			}
			expected[resource] = append(expected[resource], matches[0])
			permissions = append(permissions, shared.TokenPolicyPermissionGroupParam{ID: cloudflare.F(matches[0])})
		}
		if len(permissions) > 0 {
			policies = append(policies, shared.TokenPolicyParam{
				Effect:           cloudflare.F(shared.TokenPolicyEffectAllow),
				PermissionGroups: cloudflare.F(permissions),
				Resources: cloudflare.F[shared.TokenPolicyResourcesUnionParam](
					shared.TokenPolicyResourcesIAMResourcesTypeObjectStringParam{resource: "*"}),
			})
		}
	}
	return policies, expected, nil
}

func matchesCloudflareTokenPolicies(policies []shared.TokenPolicy, expected map[string][]string) bool {
	observed := make(map[string][]string)
	for _, policy := range policies {
		resources, ok := policy.Resources.(shared.TokenPolicyResourcesIAMResourcesTypeObjectString)
		if !ok || len(resources) != 1 || policy.Effect != "allow" {
			return false
		}
		for resource, permitted := range resources {
			if permitted != "*" || expected[resource] == nil {
				return false
			}
			for _, group := range policy.PermissionGroups {
				observed[resource] = append(observed[resource], group.ID)
			}
		}
	}
	for resource, ids := range expected {
		if !slices.Equal(slices.Sorted(slices.Values(ids)), slices.Sorted(slices.Values(observed[resource]))) {
			return false
		}
	}
	return len(observed) == len(expected)
}

func (o *cloudflareObservation) verifyCloudflareCredential(ctx context.Context, value []byte, role string) error {
	api := newCloudflareAPI(value, o.api.baseURL)
	account := cloudflare.F(o.target.AccountID)
	accountToken, accountErr := api.accountTokens.Verify(ctx, accounts.TokenVerifyParams{AccountID: account})
	if accountErr == nil {
		if accountToken.Status != "active" || !cloudflareID.MatchString(accountToken.ID) || !accountToken.ExpiresOn.After(time.Now()) {
			return errors.New("Cloudflare deployment token must be active and have a future expiry")
		}
	} else {
		if !cloudflareAuthorizationDenied(accountErr) {
			return cloudflareError("deployment token verification", accountErr)
		}
		userToken, err := api.userTokens.Verify(ctx)
		if err != nil {
			return cloudflareError("deployment token verification", err)
		}
		if userToken.Status != "active" || !cloudflareID.MatchString(userToken.ID) || !userToken.ExpiresOn.After(time.Now()) {
			return errors.New("Cloudflare deployment token must be active and have a future expiry")
		}
	}
	workers, err := api.workers.Beta.Workers.List(ctx, workers.BetaWorkerListParams{AccountID: account, PerPage: cloudflare.F(int64(1))})
	if err != nil {
		return cloudflareError("deployment token on the selected Worker account", err)
	}
	if workers.JSON.Result.IsNull() || workers.JSON.Result.IsInvalid() {
		return errors.New("Cloudflare deployment token did not verify the selected Worker account")
	}
	if role != cloudflareReadRole {
		return nil
	}
	dnsRecords, err := api.dns.List(ctx, dns.RecordListParams{ZoneID: cloudflare.F(o.target.ZoneID),
		Name: cloudflare.F(dns.RecordListParamsName{Exact: cloudflare.F(o.host)}), PerPage: cloudflare.F(float64(2))})
	if err != nil {
		return cloudflareError("deployment read token on the selected DNS zone", err)
	}
	if len(dnsRecords.Result) != 1 || dnsRecords.Result[0].Content != o.target.TunnelID+".cfargotunnel.com" {
		return errors.New("Cloudflare read token did not verify the selected DNS and Tunnel identity")
	}
	readTarget := o.target
	return api.verifyCloudflareReadScopes(ctx, o.host, &readTarget)
}

func (api cloudflareAPI) verifyCloudflareReadScopes(ctx context.Context, host string, target *cloudflareTarget) error {
	if err := api.checkWorker(ctx, host, *target); err != nil {
		return err
	}
	account := cloudflare.F(target.AccountID)
	apps, err := api.access.Applications.List(ctx, zero_trust.AccessApplicationListParams{
		AccountID: account, Domain: cloudflare.F(host), Exact: cloudflare.F(true), PerPage: cloudflare.F(int64(2))})
	if err != nil {
		return cloudflareError("deployment read token on production Access", err)
	}
	if len(apps.Result) != 1 || apps.Result[0].Domain != host || !cloudflareUUID.MatchString(apps.Result[0].ID) {
		return errors.New("Cloudflare read token did not verify the selected Access application")
	}
	policies, err := api.cloudflarePolicies(ctx, target.AccountID, apps.Result[0].ID)
	if err != nil {
		return err
	}
	if len(policies) != 1 || policies[0].ID != target.AuthorPolicyID || policies[0].Decision != "allow" {
		return errors.New("Cloudflare read token did not verify the selected author Access policy")
	}
	config, err := api.tunnels.Configurations.Get(ctx, target.TunnelID,
		zero_trust.TunnelCloudflaredConfigurationGetParams{AccountID: account})
	if err != nil {
		return cloudflareError("deployment read token on the selected Tunnel configuration", err)
	}
	if config.Source != "cloudflare" || config.AccountID != target.AccountID || config.TunnelID != target.TunnelID {
		return errors.New("Cloudflare read token did not verify the selected Tunnel configuration")
	}
	return nil
}
