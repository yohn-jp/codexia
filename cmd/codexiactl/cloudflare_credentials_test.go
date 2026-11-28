package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/cloudflare/cloudflare-go/v7/accounts"
	"github.com/stretchr/testify/require"
)

type cfCredentialFixture struct {
	cfFixtureRunner
	verify func([]byte) (accounts.TokenVerifyResponse, error)
}

func (f cfCredentialFixture) verifyAccountToken(_ context.Context, value []byte) (accounts.TokenVerifyResponse, error) {
	return f.verify(value)
}

func TestCloudflareAccountTokenIssuanceUsesVerifiedExactRole(t *testing.T) {
	const (
		account      = "12121212121212121212121212121212"
		zone         = "34343434343434343434343434343434"
		group        = "56565656565656565656565656565656"
		tokenID      = "78787878787878787878787878787878"
		fixtureValue = "fixture-secret"
	)
	for _, tc := range []struct {
		name                                             string
		approve, alreadyIssued, wrongPolicy, loss, stale bool
		wantWrites                                       int
	}{
		{name: "verified issuance", approve: true, wantWrites: 1},
		{name: "operator rejection", approve: false},
		{name: "invalidated approval sends no writes", approve: true, stale: true},
		{name: "existing named token is never replaced", approve: true, alreadyIssued: true},
		{name: "mismatched permission group is rejected", approve: true, wrongPolicy: true, wantWrites: 1},
		{name: "response loss does not replay", approve: true, loss: true, wantWrites: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			o := &cloudflareObservation{
				target:   cloudflareTarget{AccountID: account, ZoneID: zone, RepositoryID: 12},
				operator: cloudflareTestOperator{tc.approve},
			}
			o.credentialWriteGuard = func(context.Context) error {
				if tc.stale {
					return refused("the approved source changed")
				}
				return nil
			}
			var writes, verifies int
			var expiry time.Time
			var policy []map[string]any
			name := o.accountTokenName(cloudflareWorkerRole, productionEnvironment)
			receipt := func(value string) []byte {
				data, err := json.Marshal(map[string]any{
					"id": tokenID, "name": name, "status": "active", "expires_on": expiry, "policies": policy, "value": value,
				})
				require.NoError(t, err)
				return data
			}
			o.cf = cfCredentialFixture{
				cfFixtureRunner: func(_ context.Context, args ...string) ([]byte, error) {
					switch strings.Join(args, " ") {
					case "accounts tokens permission-groups list":
						return []byte(`[{"id":"` + group + `","name":"Workers Editor","scopes":["` + cloudflareAccountScope + `"],"is_selectable":true}]`), nil
					case "accounts tokens list --include-expired --page 1 --per-page 50":
						if tc.alreadyIssued {
							return []byte(`[{"name":"` + name + `"}]`), nil
						}
						return []byte("[]"), nil
					case "accounts tokens get " + tokenID:
						if tc.wrongPolicy {
							policy[0]["resources"] = map[string]string{cloudflareAccountScope + ".*": "*"}
						}
						return receipt(""), nil
					}
					require.Equal(t, []string{"accounts", "tokens", "create", "--name", name, "--expires-on"}, args[:6])
					require.Equal(t, "--policies", args[7])
					require.NotContains(t, strings.Join(args, " "), fixtureValue)
					parsed, err := time.Parse(time.RFC3339, args[6])
					require.NoError(t, err)
					expiry = parsed
					require.NoError(t, json.Unmarshal([]byte(args[8]), &policy))
					require.Equal(t, []map[string]any{{
						"effect":            "allow",
						"permission_groups": []any{map[string]any{"id": group}},
						"resources":         map[string]any{cloudflareAccountScope + "." + account: "*"},
					}}, policy)
					writes++
					if tc.loss {
						return nil, errors.New("provider response contains " + fixtureValue)
					}
					return receipt(fixtureValue), nil
				},
				verify: func(value []byte) (accounts.TokenVerifyResponse, error) {
					require.Equal(t, fixtureValue, string(value))
					verifies++
					return accounts.TokenVerifyResponse{ID: tokenID, Status: "active", ExpiresOn: expiry}, nil
				},
			}
			value, err := o.Credential(t.Context(), productionEnvironment, cloudflareWorkerRole)
			defer clear(value)
			require.Equal(t, tc.wantWrites, writes)
			if tc.name != "verified issuance" {
				require.Error(t, err)
				require.NotContains(t, err.Error(), fixtureValue)
				require.Empty(t, value)
				return
			}
			require.NoError(t, err)
			require.Equal(t, fixtureValue, string(value))
			require.Equal(t, 1, verifies)
		})
	}
}

func TestCloudflareServiceAuthRecoveryOnlyCompletesRecordedSecretFirstPair(t *testing.T) {
	const id = "00000000000000000000000000000001"
	const tokenID = "00000000-0000-0000-0000-000000000001"
	edge := &cloudflareObservation{target: cloudflareTarget{AccountID: id, ZoneID: id, RepositoryID: 12}}
	bootstrap, err := edge.serviceRole(bootstrapEnvironment, sshAccessClientID)
	require.NoError(t, err)
	production, err := edge.serviceRole(productionEnvironment, sshAccessClientID)
	require.NoError(t, err)
	probe, err := edge.serviceRole(productionEnvironment, cloudflareProbeID)
	require.NoError(t, err)
	require.Equal(t, []string{"repo-12-ssh-codexia-bootstrap", "repo-12-ssh-codexia-production"}, []string{bootstrap.tag, production.tag})
	require.Equal(t, "repo-12-probe-codexia-production", probe.tag)

	started := time.Now().UTC().Truncate(time.Second)
	receipt := cfServiceAuthReceipt{AccountID: id, ZoneID: id, TokenID: tokenID, StartedAt: started}
	key := bootstrapEnvironment + "/" + sshAccessClientID
	state := map[string]cfServiceAuthReceipt{key: receipt}
	snapshot := githubSnapshot{Bootstrap: githubEnvironment{
		Secrets: map[string]bool{sshAccessSecret: true}, SecretUpdatedAt: map[string]time.Time{sshAccessSecret: started},
	}}
	require.Error(t, validateServiceAuthRegistration(snapshot, nil))
	require.NoError(t, validateServiceAuthRegistration(snapshot, state))
	snapshot.Bootstrap.SecretUpdatedAt[sshAccessSecret] = started.Add(-time.Second)
	require.Error(t, validateServiceAuthRegistration(snapshot, state))
	delete(snapshot.Bootstrap.Secrets, sshAccessSecret)
	require.Error(t, validateServiceAuthRegistration(snapshot, state))
	snapshot.Bootstrap.Secrets[sshAccessClientID] = true
	require.Error(t, validateServiceAuthRegistration(snapshot, state))

	edge.cf = cfFixtureRunner(func(_ context.Context, args ...string) ([]byte, error) {
		require.True(t, slices.Equal(args, []string{"zero-trust", "access", "service-tokens", "get", tokenID}))
		return json.Marshal(map[string]any{
			"id": tokenID, "name": bootstrap.name, "client_id": id + ".access",
			"enabled": true, "duration": "2160h", "expires_at": time.Now().Add(time.Hour),
			"tags": map[string]string{managedEdgeServiceTagKey: bootstrap.tag},
		})
	})
	result, err := edge.serviceAuthClientID(t.Context(), bootstrap, receipt)
	require.NoError(t, err)
	require.Equal(t, id+".access", string(result))
	_, err = edge.serviceAuthClientID(t.Context(), production, receipt)
	require.Error(t, err)
}

func FuzzCloudflareConnectorTokenBinding(f *testing.F) {
	const targetAccount = "11111111111111111111111111111111"
	const targetTunnel = "00000000-0000-0000-0000-000000000001"
	encode := func(payload string) []byte {
		return []byte(base64.StdEncoding.EncodeToString([]byte(payload)))
	}
	f.Add(encode(`{"a":"` + targetAccount + `","t":"` + targetTunnel + `","s":"Zml4dHVyZQ=="}`))
	f.Add(encode(`{"a":"foreign","a":"` + targetAccount + `","t":"` + targetTunnel + `","s":"Zml4dHVyZQ=="}`))
	f.Add(encode(`{"a":"` + targetAccount + `","t":"` + targetTunnel + `","s":""}`))
	f.Add([]byte("malformed"))
	target := cloudflareTarget{AccountID: targetAccount, TunnelID: targetTunnel}
	f.Fuzz(func(t *testing.T, raw []byte) {
		if !tokenMatchesTunnel(raw, target) {
			return
		}
		otherAccount := target
		otherAccount.AccountID = "22222222222222222222222222222222"
		otherTunnel := target
		otherTunnel.TunnelID = "00000000-0000-0000-0000-000000000002"
		require.False(t, tokenMatchesTunnel(raw, otherAccount))
		require.False(t, tokenMatchesTunnel(raw, otherTunnel))
	})
}

func TestCloudflareCredentialDeadlineStopsBeforeProviderWrite(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		<-ctx.Done()
		require.Equal(t, time.Second, time.Since(started))
		o := &cloudflareObservation{credentialWriteGuard: func(context.Context) error {
			t.Fatal("an expired credential operation entered the protected write window")
			return nil
		}}
		require.ErrorIs(t, o.requireCredentialWriteGuard(ctx), context.DeadlineExceeded)
	})
}
