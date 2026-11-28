package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/stretchr/testify/require"
)

type cfFixtureRunner func(context.Context, ...string) ([]byte, error)

func (f cfFixtureRunner) run(ctx context.Context, args ...string) ([]byte, error) {
	return f(ctx, args...)
}

func TestCloudflareRequirementsFollowProtectedInputInventory(t *testing.T) {
	snapshot := githubSnapshot{
		Bootstrap:  githubEnvironment{Secrets: map[string]bool{}},
		Production: githubEnvironment{Secrets: map[string]bool{}},
	}
	for _, input := range protectedSecrets() {
		selectEnvironment(snapshot, input.environment).Secrets[input.name] = true
	}
	require.Equal(t, cfDeviceRequirements{accountTokenCreate: true, allowTemporaryObservation: true}, cloudflareRequirementsFor(snapshot))
	delete(snapshot.Bootstrap.Secrets, sshAccessSecret)
	require.True(t, cloudflareRequirementsFor(snapshot).accessTokenWrite)
	delete(snapshot.Production.Secrets, cloudflareWorkerRole)
	require.True(t, cloudflareRequirementsFor(snapshot).workerScriptsWrite)
	require.Equal(t, cfDeviceRequirements{}, cfDeviceRequirements{}.requireConnectorToken(false))
	require.True(t, cfDeviceRequirements{}.requireConnectorToken(true).tunnelToken)
}

func TestCloudflareVerifiesExactDeviceGrant(t *testing.T) {
	requested := []string{"account:read", "zone:read"}
	for _, tc := range []struct {
		name    string
		granted []string
		want    bool
	}{
		{"exact", []string{"zone:read", "openid", "account:read", "offline_access"}, true},
		{"missing", []string{"account:read"}, false},
		{"write grant", []string{"account:read", "zone:read", "argotunnel.write"}, false},
		{"unknown", []string{"account:read", "zone:read", "unexpected"}, false},
		{"duplicate", []string{"account:read", "zone:read", "account:read"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, cfGrantedScopesMatch(tc.granted, requested))
		})
	}
}

func TestCloudflareCommandDecodesOnlyStructuredResult(t *testing.T) {
	ctx := t.Context()
	args := []string{"accounts", "tokens", "list", "--page", "1"}
	run := func(body string, err error) cfFixtureRunner {
		return func(received context.Context, actual ...string) ([]byte, error) {
			require.Same(t, ctx, received)
			require.Empty(t, cmp.Diff(args, actual))
			return []byte(body), err
		}
	}
	valid, err := cfResult[[]string](ctx, run(`["first","second"]`, nil), args...)
	require.NoError(t, err)
	require.True(t, slices.Equal(valid, []string{"first", "second"}))
	for _, body := range []string{`null`, `{"result":[]}`, `[] []`, "malformed response holding private fixture data"} {
		_, err := cfResult[[]string](ctx, run(body, nil), args...)
		require.Error(t, err)
		require.NotContains(t, err.Error(), body)
	}
	sentinel := errors.New("sanitized cloudflare operation failure")
	_, err = cfResult[[]string](ctx, run(`[]`, sentinel), args...)
	require.ErrorIs(t, err, sentinel)
}

func TestCloudflareDevicePromptOnlyForwardsOfficialBrowserChallenge(t *testing.T) {
	var tty bytes.Buffer
	prompt := cfDevicePrompt{tty: &tty}
	lines := []string{
		"Starting login. Fixture diagnostic with confidential value.\nTo authorize cf, please visit:\n",
		"\n  https://dash.cloudflare.com/device\n\nand enter the code:\n",
		"\n  WXYZ-0123\n\n",
		"Set CLOUDFLARE_API_TOKEN to retry.\n",
	}
	for _, chunk := range lines {
		_, err := prompt.Write([]byte(chunk))
		require.NoError(t, err)
	}
	require.True(t, prompt.shown)
	require.Contains(t, tty.String(), "https://dash.cloudflare.com/device")
	require.Contains(t, tty.String(), "WXYZ-0123")
	require.NotContains(t, tty.String(), "confidential")
	require.NotContains(t, tty.String(), "CLOUDFLARE_API_TOKEN")

	tty.Reset()
	invalid := cfDevicePrompt{tty: &tty}
	_, err := invalid.Write([]byte("To authorize cf, please visit:\n https://dash.cloudflare.com.invalid/device\n and enter the code:\n WXYZ-0123\n"))
	require.Error(t, err)
	require.Empty(t, tty.String())
}

type cloudflareTTYFixture struct {
	operator
	file *os.File
}

func (o cloudflareTTYFixture) privateTTYFile() (*os.File, error) {
	return os.OpenFile(o.file.Name(), os.O_RDWR|os.O_APPEND, 0o600)
}

func TestCloudflareDeviceSessionUsesPrivateProcessAndExactScope(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLOUDFLARE_API_TOKEN", "ambient-fixture-credential")
	t.Setenv("CLOUDFLARE_AUTH_PROFILE", "ambient-fixture-profile")
	const account = "00000000000000000000000000000001"
	script := filepath.Join(dir, "cf.sh")
	identity, err := json.Marshal(map[string]any{
		"authenticated": true, "tokenValid": true, "authSource": "OAuth token from an isolated fixture",
		"accounts": []map[string]string{{"id": account}},
		"scopes":   append(slices.Clone(cfReadScopes), "offline_access"),
		"profile":  map[string]any{"name": "default", "source": "default", "overridden": false},
	})
	require.NoError(t, err)
	source := `#!/usr/bin/bash
set -eu
[[ -z "${CLOUDFLARE_API_TOKEN:-}" && -z "${CLOUDFLARE_AUTH_PROFILE:-}" ]]
[[ "$1" == auth ]]
case "$2" in
  login)
    [[ "$3 $4 $5 $6" == "--device --no-browser --no-use-keyring --scopes" ]]
    shift 6
    [[ "$*" == "` + strings.Join(cfReadScopes, " ") + `" ]]
    printf '\nTo authorize cf, please visit:\n\n  https://dash.cloudflare.com/fixture\n\nand enter the code:\n\n  WXYZ-0123\n' >&2
    printf 'unstructured provider output holding fixture-login-secret\n' >&2
    touch authenticated
    ;;
  whoami)
    [[ "$3" == --json && -f authenticated ]]
    printf '%s\n' '` + string(identity) + `'
    ;;
  logout)
    rm authenticated
    ;;
  *) exit 42 ;;
esac
`
	require.NoError(t, os.WriteFile(script, []byte(source), 0o600))
	private, err := os.CreateTemp(dir, "tty-")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, private.Close()) })
	runtime := &cfRuntime{
		root: dir, workDir: dir, node: "/usr/bin/bash", cli: script,
		baseEnv: []string{"PATH=/usr/bin:/bin", "HOME=" + dir},
	}
	tty := cloudflareTTYFixture{operator: cloudflareTestOperator{approves: true}, file: private}
	require.NoError(t, runtime.deviceLogin(t.Context(), tty, "codexia.example.test", "ssh.example.test", cfDeviceRequirements{}))
	require.NoError(t, runtime.setAccount(account))
	require.Error(t, runtime.setAccount("00000000000000000000000000000002"))
	challenge, err := os.ReadFile(private.Name())
	require.NoError(t, err)
	require.Contains(t, string(challenge), "WXYZ-0123")
	require.NotContains(t, string(challenge), "fixture-login-secret")
	require.NoError(t, runtime.logout(t.Context()))
	require.NoFileExists(t, filepath.Join(dir, "authenticated"))
}
