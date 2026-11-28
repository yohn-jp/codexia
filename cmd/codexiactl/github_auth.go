package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/google/go-github/v93/github"
	"golang.org/x/oauth2"
)

var (
	githubAppClientIDPattern = regexp.MustCompile(`^Iv[A-Za-z0-9.]{10,62}$`)
	githubUserCode           = regexp.MustCompile(`^[A-Z0-9]{4}-[A-Z0-9]{4}$`)
)

const githubPermissionNotice = "GitHub requires Metadata and Contents read, Actions and Environments read/write, and Administration read for OIDC settings. " +
	"Changing branch restrictions requires Administration write with separate approval. The official App maintainer configures these permissions."

const githubAppInstallationURL = "https://github.com/apps/codexiactl/installations/new"
const githubAppSettingsURL = "https://github.com/organizations/yohn-jp/settings/apps"
const githubDeviceURL = "https://github.com/login/device"
const officialReleaseURL = "https://github.com/" + officialDistribution + "/releases"

func githubLogin(ctx context.Context, o operator, clientID string) (*githubControl, error) {
	if !githubAppClientIDPattern.MatchString(clientID) {
		return nil, needsAction("This build has no valid official GitHub App Client ID. Download the current verified release at " + officialReleaseURL +
			". If the release is affected, ask the yohn-jp maintainer to check CODEXIACTL_GITHUB_APP_CLIENT_ID and the official App settings at " + githubAppSettingsURL)
	}
	o.Notice("Before signing in, install the official CodexiaCTL App at " + githubAppInstallationURL +
		". On your account or organization, choose Only select repositories and grant access to the intended codexia repository.")
	o.Notice(githubPermissionNotice)
	if err := requireApproval(o, "Start GitHub Device Flow for the official CodexiaCTL App? The browser code expires within 15 minutes."); err != nil {
		return nil, err
	}
	credential, err := githubDeviceAccess(ctx, o, clientID, githubHTTPClient(20*time.Second))
	if err != nil {
		return nil, err
	}
	control, err := newGitHubControl(credential)
	if err != nil {
		clear(credential)
		return nil, err
	}
	user, resp, err := control.client.Users.Get(ctx, "")
	if err != nil || user.GetID() <= 0 || !githubOwnerName.MatchString(user.GetLogin()) {
		control.Close(ctx)
		return nil, githubFailure("verify the authenticated GitHub user", resp, err)
	}
	control.actor = user.GetLogin()
	control.appClientID = clientID
	o.Notice("Signed in to GitHub as " + control.actor + ". Checking repositories delegated to the CodexiaCTL App.")
	return control, nil
}

func (g *githubControl) selectTarget(ctx context.Context, o operator, vm vmObservation, state checkpoint) (productionContract, error) {
	candidates, err := g.discoverTargets(ctx)
	if err != nil {
		return productionContract{}, err
	}
	g.target, err = chooseGitHubTarget(o, candidates, state)
	if err != nil {
		return productionContract{}, err
	}
	sha, err := g.Main(ctx)
	if err != nil {
		return productionContract{}, err
	}
	settings, err := g.productionSettings(ctx, sha)
	if err != nil {
		return productionContract{}, err
	}
	o.Notice(fmt.Sprintf("Target %s (owner ID %d, repository ID %d, installation %d), GitHub user %s, protected main %s, public origin %s, VM %s.",
		g.target.FullName(), g.target.OwnerID, g.target.RepoID, g.target.InstallationID, g.actor, sha, settings.PublicOrigin, vm.HostID))
	if err := requireApproval(o, "Confirm the observed deployment repository and VM?"); err != nil {
		return productionContract{}, err
	}
	g.approvedSHA = sha
	return settings, nil
}

func githubDeviceAccess(ctx context.Context, o operator, clientID string, client *http.Client) ([]byte, error) {
	cfg := oauth2.Config{
		ClientID: clientID,
		Endpoint: oauth2.Endpoint{
			DeviceAuthURL: "https://github.com/login/device/code",
			TokenURL:      "https://github.com/login/oauth/access_token",
			AuthStyle:     oauth2.AuthStyleInParams,
		},
	}
	code, err := githubStartDeviceAuth(ctx, &cfg, client)
	if err != nil {
		return nil, githubDeviceError(ctx, err, "start")
	}
	if !githubDeviceCodeValid(code, time.Now()) {
		return nil, errors.New("GitHub returned an invalid Device Flow URL, code or lifetime. Retry this command to request a fresh code")
	}
	defer func() { code.DeviceCode = "" }()
	err = privateNotice(o, fmt.Sprintf("Open %s on your computer. Sign in as the user with repository access and enter %s by %s UTC. SSH forwarding is unnecessary.",
		githubDeviceURL, code.UserCode, code.Expiry.UTC().Format("15:04:05")))
	code.UserCode = ""
	if err != nil {
		return nil, err
	}
	tok, err := cfg.DeviceAccessToken(context.WithValue(ctx, oauth2.HTTPClient, client), code)
	if err != nil {
		return nil, githubDeviceError(ctx, err, "complete")
	}
	if tok.Expiry.IsZero() || !tok.Expiry.After(time.Now()) || !strings.HasPrefix(tok.AccessToken, "ghu_") {
		return nil, needsAction("GitHub did not return an expiring GitHub App user access token. Ask the yohn-jp maintainer to check Expire user authorization tokens at " + githubAppSettingsURL)
	}
	credential := []byte(tok.AccessToken)
	tok.AccessToken = ""
	tok.RefreshToken = ""
	return credential, nil
}

// oauth2.DeviceAuth creates the initial request without the supplied context.
// Bind its HTTP request to the command and preserve the configured time limit.
func githubStartDeviceAuth(ctx context.Context, cfg *oauth2.Config, client *http.Client) (*oauth2.DeviceAuthResponse, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	startClient := *client
	if startClient.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, startClient.Timeout)
		defer cancel()
		startClient.Timeout = 0
	}
	next := startClient.Transport
	if next == nil {
		next = http.DefaultTransport
	}
	startClient.Transport = githubDeviceStartTransport{ctx: ctx, next: next}
	return cfg.DeviceAuth(context.WithValue(ctx, oauth2.HTTPClient, &startClient))
}

type githubDeviceStartTransport struct {
	ctx  context.Context
	next http.RoundTripper
}

func (t githubDeviceStartTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return t.next.RoundTrip(r.WithContext(t.ctx))
}

func githubDeviceCodeValid(code *oauth2.DeviceAuthResponse, now time.Time) bool {
	if code == nil || code.DeviceCode == "" || !githubUserCode.MatchString(code.UserCode) ||
		code.Expiry.IsZero() || !code.Expiry.After(now) || code.Expiry.Sub(now) > 15*time.Minute ||
		code.Interval > 60 {
		return false
	}
	uri, err := url.Parse(code.VerificationURI)
	return err == nil && uri.Scheme == "https" && uri.Host == "github.com" && uri.User == nil &&
		uri.Path == "/login/device" && uri.EscapedPath() == uri.Path && uri.RawQuery == "" && uri.Fragment == ""
}

func githubDeviceError(ctx context.Context, err error, phase string) error {
	if errors.Is(ctx.Err(), context.Canceled) {
		return context.Canceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return errors.New("GitHub Device Flow expired or its endpoint timed out. Check GitHub connectivity and retry this command for a fresh code")
	}
	var oauthErr *oauth2.RetrieveError
	if errors.As(err, &oauthErr) {
		if phase == "start" && oauthErr.Response != nil && oauthErr.Response.StatusCode == http.StatusNotFound {
			return githubDeviceAppUnavailable()
		}
		switch oauthErr.ErrorCode {
		case "access_denied":
			return refused("GitHub Device Flow was denied in the browser. Retry this command and authorize the official CodexiaCTL App as the intended GitHub user")
		case "expired_token":
			return needsAction("GitHub Device Flow code expired. Retry this command and enter the new code before its deadline")
		case "device_flow_disabled", "incorrect_client_credentials", "client_id_not_found":
			return githubDeviceAppUnavailable()
		}
	}
	return errors.New("Could not " + phase + " GitHub Device Flow. Check access to https://github.com and retry this command")
}

func githubDeviceAppUnavailable() error {
	return needsAction("GitHub could not authorize this release's App. Use the current verified release at " + officialReleaseURL +
		" or ask the yohn-jp maintainer to check Device Flow and the Client ID at " + githubAppSettingsURL)
}

func newGitHubControl(token []byte) (*githubControl, error) {
	api := githubHTTPClient(20 * time.Second)
	api.Transport = &githubAPITransport{next: http.DefaultTransport, token: token}
	client, err := github.NewClient(github.WithHTTPClient(api))
	if err != nil {
		return nil, errors.New("could not initialize the GitHub API client")
	}
	return &githubControl{client: client, download: githubHTTPClient(30 * time.Second), token: token}, nil
}

type githubAPITransport struct {
	next  http.RoundTripper
	token []byte
}

func (t *githubAPITransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme != "https" || req.URL.Host != "api.github.com" || req.URL.User != nil {
		return nil, errors.New("GitHub API request is outside the official API origin")
	}
	request := req.Clone(req.Context())
	request.Header.Set("Authorization", "Bearer "+string(t.token))
	request.Header.Set("X-GitHub-Api-Version", "2026-03-10")
	return t.next.RoundTrip(request)
}

func githubHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}

func (g *githubControl) Close(context.Context) {
	// Revoking a GitHub App user token requires the app's confidential client secret.
	// The installer uses only its public ID and never persists the short-lived token.
	clear(g.token)
	g.token = nil
}

func githubHasRead(permission string) bool {
	return permission == "read" || permission == "write"
}
