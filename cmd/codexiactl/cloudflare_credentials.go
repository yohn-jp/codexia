package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	cloudflare "github.com/cloudflare/cloudflare-go/v7"
	"github.com/cloudflare/cloudflare-go/v7/accounts"
	"github.com/cloudflare/cloudflare-go/v7/shared"
	"github.com/cloudflare/cloudflare-go/v7/zero_trust"
)

const (
	cloudflareAccountScope    = "com.cloudflare.api.account"
	cloudflareZoneScope       = "com.cloudflare.api.account.zone"
	cloudflareReadRole        = "CODEXIA_DEPLOYMENT_" + "CLOUDFLARE_READ_TOKEN"
	cloudflareWorkerRole      = "CLOUDFLARE_API_TOKEN"
	cloudflareProbeID         = "CODEXIA_ACCESS_CLIENT_ID"
	cloudflareProbeSecret     = "CODEXIA_ACCESS_CLIENT_SECRET"
	cloudflareObservationRole = "observation"
	cloudflareRouteRole       = "routes"
	cloudflareEdgeWorkerRole  = "empty-worker"
)

var errCloudflareMintUnavailable = errors.New("the Cloudflare account token issuance authority and exact deployment scopes were not verified")

func (o *cloudflareObservation) Close() {
	if o.closeAuth != nil {
		o.closeAuth()
		o.closeAuth = nil
	}
	o.cf = nil
	o.operator = nil
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

func (o *cloudflareObservation) Credential(ctx context.Context, environment, name string) ([]byte, error) {
	if environment != bootstrapEnvironment && environment != productionEnvironment {
		return nil, refused("Cloudflare credential role is outside the protected Environments")
	}
	switch name {
	case "CLOUDFLARE_ACCOUNT_ID":
		if environment == productionEnvironment && cloudflareID.MatchString(o.target.AccountID) {
			return []byte(o.target.AccountID), nil
		}
	case cloudflareReadRole:
		return o.issueAccountCredential(ctx, name, environment)
	case cloudflareWorkerRole:
		if environment == productionEnvironment {
			return o.issueAccountCredential(ctx, name, environment)
		}
	}
	return nil, refused("Cloudflare credential role is not recognized for this Environment")
}

func (o *cloudflareObservation) ConnectorToken(ctx context.Context) ([]byte, error) {
	if !cloudflareID.MatchString(o.target.AccountID) || !cloudflareUUID.MatchString(o.target.TunnelID) {
		return nil, refused("Cloudflare connector token requires the verified account and Tunnel")
	}
	value, err := cfResult[string](ctx, o.cf, "tunnels", "token", "get", o.target.TunnelID)
	if err != nil {
		return nil, err
	}
	token := []byte(value)
	if !tokenMatchesTunnel(token, o.target) {
		clear(token)
		return nil, errors.New("the Cloudflare connector token does not match the observed account and Tunnel")
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
	description string
	permissions map[string][]string
	temporary   bool
}

type cloudflarePermissionGroup struct {
	id, name                            string
	accountScope, zoneScope, selectable bool
}

type cfCredentialReceipt struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func cloudflarePermissionFor(role string) (cloudflarePermissionPlan, bool) {
	switch role {
	case cloudflareReadRole:
		return cloudflarePermissionPlan{
			description: "Workers Content Read-Only, Cloudflare Tunnel Read and Access: Apps and Policies Read for the selected account; DNS Read and Workers Routes Read for the selected zone",
			permissions: map[string][]string{
				cloudflareAccountScope: {"Workers Content Read-Only", "Cloudflare Tunnel Read", "Access: Apps and Policies Read"},
				cloudflareZoneScope:    {"DNS Read", "Workers Routes Read"},
			},
		}, true
	case cloudflareObservationRole:
		return cloudflarePermissionPlan{
			description: "Workers Content Read-Only for the selected account and Workers Routes Read for the selected zone",
			permissions: map[string][]string{
				cloudflareAccountScope: {"Workers Content Read-Only"},
				cloudflareZoneScope:    {"Workers Routes Read"},
			},
			temporary: true,
		}, true
	case cloudflareWorkerRole:
		return cloudflarePermissionPlan{
			description: "Workers Editor for the selected account",
			permissions: map[string][]string{cloudflareAccountScope: {"Workers Editor"}},
		}, true
	case cloudflareRouteRole:
		return cloudflarePermissionPlan{
			description: "Workers Routes Write for the selected zone",
			permissions: map[string][]string{cloudflareZoneScope: {"Workers Routes Write"}},
			temporary:   true,
		}, true
	case cloudflareEdgeWorkerRole:
		return cloudflarePermissionPlan{
			description: "Workers Scripts Write for the selected account (empty Worker creation)",
			permissions: map[string][]string{cloudflareAccountScope: {"Workers Scripts Write"}},
			temporary:   true,
		}, true
	default:
		return cloudflarePermissionPlan{}, false
	}
}

func (o *cloudflareObservation) provisionAccountCredential(ctx context.Context, role string) ([]byte, error) {
	plan, ok := cloudflarePermissionFor(role)
	if !ok || !plan.temporary {
		return nil, refused("Cloudflare SDK authority requires a recognized temporary credential role")
	}
	return o.issueAccountCredential(ctx, role, "")
}

type cfAccountTokenVerifier interface {
	verifyAccountToken(context.Context, []byte) (accounts.TokenVerifyResponse, error)
}

type cfTokenCommand struct {
	runtime *cfRuntime
	token   []byte
}

func (c cfTokenCommand) run(ctx context.Context, args ...string) ([]byte, error) {
	return c.runtime.runWithToken(ctx, c.token, args...)
}

func (runtime *cfRuntime) verifyAccountToken(ctx context.Context, token []byte) (accounts.TokenVerifyResponse, error) {
	if runtime.accountID == "" || !validCloudflareSecret(token) {
		return accounts.TokenVerifyResponse{}, refused("Cloudflare account token verification requires the validated target")
	}
	return cfResult[accounts.TokenVerifyResponse](ctx, cfTokenCommand{runtime, token}, "accounts", "tokens", "verify")
}

func cfList[T any](ctx context.Context, runner cfCommandRunner, args ...string) ([]T, error) {
	var result []T
	for page := 1; page <= cloudflareMaxPages; page++ {
		query := append(slices.Clone(args), "--page", fmt.Sprint(page), "--per-page", fmt.Sprint(cloudflarePageSize))
		items, err := cfResult[[]T](ctx, runner, query...)
		if err != nil {
			return nil, err
		}
		if len(items) > cloudflarePageSize {
			return nil, errors.New("the Cloudflare inventory returned an invalid page size")
		}
		result = append(result, items...)
		if len(items) < cloudflarePageSize {
			return result, nil
		}
	}
	return nil, errors.New("the Cloudflare inventory exceeded the supported page limit")
}

func (o *cloudflareObservation) accountTokenName(role, environment string) string {
	suffix := role
	switch role {
	case cloudflareWorkerRole:
		suffix = "publication"
	case cloudflareReadRole:
		suffix = "deployment-read"
	}
	if environment != "" {
		suffix += "-" + environment
	}
	return fmt.Sprintf("codexia-%d-%s-%s", o.target.RepositoryID, o.target.ZoneID[:8], suffix)
}

func (o *cloudflareObservation) issueAccountCredential(ctx context.Context, role, environment string) ([]byte, error) {
	plan, found := cloudflarePermissionFor(role)
	verifier, canVerify := o.cf.(cfAccountTokenVerifier)
	if !found || !canVerify || !cloudflareID.MatchString(o.target.AccountID) ||
		!cloudflareID.MatchString(o.target.ZoneID) || o.target.RepositoryID <= 0 {
		return nil, errCloudflareMintUnavailable
	}
	groups, err := cfResult[[]accounts.TokenPermissionGroupListResponse](ctx, o.cf, "accounts", "tokens", "permission-groups", "list")
	if err != nil {
		return nil, needsAction("The official Cloudflare Device Flow did not authorize the account token permission catalog")
	}
	catalog := make([]cloudflarePermissionGroup, 0, len(groups))
	for _, group := range groups {
		catalog = append(catalog, cloudflarePermissionGroup{
			id: group.ID, name: group.Name, selectable: group.IsSelectable,
			accountScope: slices.Contains(group.Scopes, accounts.TokenPermissionGroupListResponseScopeComCloudflareAPIAccount),
			zoneScope:    slices.Contains(group.Scopes, accounts.TokenPermissionGroupListResponseScopeComCloudflareAPIAccountZone),
		})
	}
	policies, expected, err := o.exactTokenPolicies(catalog, plan, true)
	if err != nil {
		return nil, err
	}
	name := o.accountTokenName(role, environment)
	tokens, err := cfList[shared.Token](ctx, o.cf, "accounts", "tokens", "list", "--include-expired")
	if err != nil {
		return nil, needsAction("The official Cloudflare Device Flow did not authorize account token inventory")
	}
	now := time.Now().UTC().Truncate(time.Second)
	for _, token := range tokens {
		if token.Name == name && (!plan.temporary || token.ExpiresOn.IsZero() || token.ExpiresOn.After(now)) {
			return nil, needsAction("Cloudflare already has an issuance record for " + name + ". Verify its registration or resolve the prior operation in the account inventory before retrying")
		}
	}
	lifetime := 90 * 24 * time.Hour
	purpose := ""
	if plan.temporary {
		lifetime = time.Hour
		purpose = " CodexiaCTL will attempt to retire this temporary token after use."
	}
	expiry := now.Add(lifetime)
	if err := requireApproval(o.operator, fmt.Sprintf("Create %s on account %s, zone %s, expiring at %s UTC (%s)?%s",
		name, o.target.AccountID, o.target.ZoneID, expiry.Format(time.RFC3339), plan.description, purpose)); err != nil {
		return nil, err
	}
	body, err := json.Marshal(policies)
	if err != nil {
		return nil, errCloudflareMintUnavailable
	}
	issued, err := cfResult[accounts.TokenNewResponse](ctx, o.cf, "accounts", "tokens", "create", "--name", name,
		"--expires-on", expiry.Format(time.RFC3339), "--policies", string(body))
	if err != nil {
		return nil, needsAction("Cloudflare did not confirm issuance of " + name + ". Check the exact account token inventory before retrying")
	}
	token := []byte(issued.Value)
	if !validCloudflareSecret(token) || !cloudflareID.MatchString(issued.ID) || issued.Name != name ||
		issued.Status != "active" || !issued.ExpiresOn.Equal(expiry) || issued.NotBefore.After(now) ||
		!matchesCloudflareTokenPolicies(issued.Policies, expected) {
		clear(token)
		return nil, needsAction("Cloudflare returned an unverifiable issuance receipt for " + name)
	}
	if plan.temporary {
		if o.temporaryCredentials == nil {
			o.temporaryCredentials = make(map[string]cfCredentialReceipt)
		}
		o.temporaryCredentials[role] = cfCredentialReceipt{ID: issued.ID, Name: name}
	}
	verified, err := verifier.verifyAccountToken(ctx, token)
	if err != nil || verified.ID != issued.ID || verified.Status != "active" ||
		!verified.ExpiresOn.Equal(expiry) || verified.NotBefore.After(now) {
		clear(token)
		return nil, needsAction("The official Cloudflare API did not verify the newly issued token for " + name)
	}
	metadata, err := cfResult[shared.Token](ctx, o.cf, "accounts", "tokens", "get", issued.ID)
	if err != nil || !verifiedTokenMetadata(metadata, issued.ID, name, expiry, expected, now) {
		clear(token)
		return nil, needsAction("The Cloudflare token inventory did not confirm the approved scope and expiry for " + name)
	}
	return token, nil
}

func verifiedTokenMetadata(token shared.Token, id, name string, expiry time.Time, expected map[string][]string, now time.Time) bool {
	return token.ID == id && token.Name == name && token.Status == "active" && token.ExpiresOn.Equal(expiry) &&
		!token.NotBefore.After(now) && matchesCloudflareTokenPolicies(token.Policies, expected)
}

func (o *cloudflareObservation) retireAccountCredential(ctx context.Context, role string) error {
	receipt, found := o.temporaryCredentials[role]
	if !found {
		return nil
	}
	info, err := cfResult[shared.Token](ctx, o.cf, "accounts", "tokens", "get", receipt.ID)
	if err != nil || info.ID != receipt.ID || info.Name != receipt.Name {
		return needsAction("Could not verify the exact temporary Cloudflare token before retirement")
	}
	data, err := o.cf.run(ctx, "accounts", "tokens", "delete", receipt.ID, "--force")
	clear(data)
	if err != nil {
		return needsAction("Cloudflare did not confirm retirement of the temporary token " + receipt.Name + ". Its configured expiry still applies")
	}
	tokens, err := cfList[shared.Token](ctx, o.cf, "accounts", "tokens", "list", "--include-expired")
	if err != nil || slices.ContainsFunc(tokens, func(token shared.Token) bool { return token.ID == receipt.ID && token.Status == "active" }) {
		return needsAction("Cloudflare did not verify retirement of the temporary token " + receipt.Name)
	}
	delete(o.temporaryCredentials, role)
	return nil
}

func (o *cloudflareObservation) exactTokenPolicies(groups []cloudflarePermissionGroup, plan cloudflarePermissionPlan, requireSelectable bool) (
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
				scopeMatches := (scope == cloudflareAccountScope && group.accountScope) || (scope == cloudflareZoneScope && group.zoneScope)
				if group.name == name && scopeMatches && cloudflareID.MatchString(group.id) && (!requireSelectable || group.selectable) {
					matches = append(matches, group.id)
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

const cloudflareAccessLifetime = 90 * 24 * time.Hour

type cfServiceAuthReceipt struct {
	AccountID string    `json:"accountId"`
	ZoneID    string    `json:"zoneId"`
	TokenID   string    `json:"tokenId"`
	StartedAt time.Time `json:"startedAt"`
}

type serviceAuthRole struct {
	idInput, secretInput, name, tag string
}

func (o *cloudflareObservation) serviceRole(environment, idInput string) (serviceAuthRole, error) {
	if (environment != bootstrapEnvironment && environment != productionEnvironment) ||
		!cloudflareID.MatchString(o.target.AccountID) || !cloudflareID.MatchString(o.target.ZoneID) || o.target.RepositoryID <= 0 {
		return serviceAuthRole{}, refused("Cloudflare Service Auth requires the verified repository, account, zone and Environment")
	}
	purpose, secret, tag := "ssh", sshAccessSecret, fmt.Sprintf("repo-%d-ssh-%s", o.target.RepositoryID, environment)
	if idInput == cloudflareProbeID {
		purpose, secret, tag = "probe", cloudflareProbeSecret, fmt.Sprintf("repo-%d-probe-%s", o.target.RepositoryID, productionEnvironment)
	} else if idInput != sshAccessClientID {
		return serviceAuthRole{}, refused("Cloudflare Service Auth role is outside the deployment contract")
	}
	name := fmt.Sprintf("codexia-%d-%s-%s-%s", o.target.RepositoryID, o.target.ZoneID[:8], purpose, environment)
	return serviceAuthRole{idInput: idInput, secretInput: secret, name: name, tag: tag}, nil
}

func (o *cloudflareObservation) issueServiceAuth(ctx context.Context, role serviceAuthRole) (cfServiceAuthReceipt, []byte, []byte, error) {
	var receipt cfServiceAuthReceipt
	tokens, err := cfList[zero_trust.ServiceToken](ctx, o.cf, "zero-trust", "access", "service-tokens", "list", "--name", role.name)
	if err != nil {
		return receipt, nil, nil, err
	}
	if slices.ContainsFunc(tokens, func(token zero_trust.ServiceToken) bool { return token.Name == role.name }) {
		return receipt, nil, nil, needsAction("Cloudflare already has Service Auth token " + role.name + ". Verify its registration or resolve the prior operation before retrying")
	}
	if err := requireApproval(o.operator, fmt.Sprintf("Create the 90-day Cloudflare Service Auth token %s with %s=%s?",
		role.name, managedEdgeServiceTagKey, role.tag)); err != nil {
		return receipt, nil, nil, err
	}
	tags := map[string]string{managedEdgeServiceTagKey: role.tag}
	tagArg, err := json.Marshal(tags)
	if err != nil {
		return receipt, nil, nil, errors.New("could not prepare exact Cloudflare Service Auth tags")
	}
	started := time.Now().UTC().Truncate(time.Second)
	issued, err := cfResult[zero_trust.AccessServiceTokenNewResponse](ctx, o.cf, "zero-trust", "access", "service-tokens", "create",
		"--name", role.name, "--duration", "2160h", "--enabled", "--tags", string(tagArg))
	if err != nil {
		return receipt, nil, nil, needsAction("Cloudflare did not confirm issuance of " + role.name + ". Check the exact Service Auth inventory before retrying")
	}
	secret := []byte(issued.ClientSecret)
	duration, durationErr := time.ParseDuration(issued.Duration)
	if !cloudflareUUID.MatchString(issued.ID) || issued.Name != role.name || !issued.Enabled ||
		len(issued.Tags) != 1 || issued.Tags[managedEdgeServiceTagKey] != role.tag ||
		durationErr != nil || duration != cloudflareAccessLifetime || !validCloudflareSecret(secret) {
		clear(secret)
		return receipt, nil, nil, needsAction("Cloudflare returned an unverifiable Service Auth issuance receipt for " + role.name)
	}
	receipt = cfServiceAuthReceipt{AccountID: o.target.AccountID, ZoneID: o.target.ZoneID, TokenID: issued.ID, StartedAt: started}
	id, err := o.serviceAuthClientID(ctx, role, receipt)
	if err != nil || string(id) != issued.ClientID {
		clear(secret)
		clear(id)
		return cfServiceAuthReceipt{}, nil, nil, needsAction("Cloudflare Service Auth inventory did not confirm the issued credential for " + role.name)
	}
	return receipt, id, secret, nil
}

func (o *cloudflareObservation) serviceAuthClientID(ctx context.Context, role serviceAuthRole, receipt cfServiceAuthReceipt) ([]byte, error) {
	if receipt.AccountID != o.target.AccountID || receipt.ZoneID != o.target.ZoneID || !cloudflareUUID.MatchString(receipt.TokenID) {
		return nil, refused("Cloudflare Service Auth registration receipt does not match the observed target")
	}
	token, err := cfResult[zero_trust.ServiceToken](ctx, o.cf, "zero-trust", "access", "service-tokens", "get", receipt.TokenID)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	duration, durationErr := time.ParseDuration(token.Duration)
	id, suffix := strings.CutSuffix(token.ClientID, ".access")
	if token.ID != receipt.TokenID || token.Name != role.name || !suffix || !cloudflareID.MatchString(id) || !token.Enabled ||
		durationErr != nil || duration != cloudflareAccessLifetime || !token.ExpiresAt.After(now) ||
		token.ExpiresAt.After(now.Add(cloudflareAccessLifetime+5*time.Minute)) ||
		len(token.Tags) != 1 || token.Tags[managedEdgeServiceTagKey] != role.tag || !token.LeakReportedAt.IsZero() {
		return nil, needsAction("Cloudflare Service Auth credential does not verify the expected binding, policy tag and expiry")
	}
	return []byte(token.ClientID), nil
}
