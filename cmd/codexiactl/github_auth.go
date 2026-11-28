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

func githubLogin(ctx context.Context, o operator, clientID string) (*githubControl, error) {
	if !githubAppClientIDPattern.MatchString(clientID) {
		return nil, needsAction("The official release has no configured GitHub App Client ID. Ask the yohn-jp/codexia release maintainer to enable Device Flow and expiring user tokens in the public App at https://github.com/settings/apps, then bind its Client ID to the official release")
	}
	o.Notice(githubPermissionNotice)
	if err := requireApproval(o, "Start the official Codexia GitHub App Device Flow at https://github.com/login/device? The browser code expires within 15 minutes."); err != nil {
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
	ctx = context.WithValue(ctx, oauth2.HTTPClient, client)
	code, err := cfg.DeviceAuth(ctx)
	if err != nil {
		return nil, githubDeviceError(ctx, err, "start")
	}
	if !githubDeviceCodeValid(code, time.Now()) {
		return nil, errors.New("GitHub returned an invalid Device Flow URL, code or lifetime")
	}
	// githubLogin has already confirmed an interactive terminal. The operator
	// sends this notice only to its controlling TTY.
	o.Notice(fmt.Sprintf("Open https://github.com/login/device on your computer and enter %s by %s UTC. SSH forwarding is unnecessary.",
		code.UserCode, code.Expiry.UTC().Format("15:04:05")))
	code.UserCode = ""
	tok, err := cfg.DeviceAccessToken(ctx, code)
	code.DeviceCode = ""
	if err != nil {
		return nil, githubDeviceError(ctx, err, "complete")
	}
	if tok.Expiry.IsZero() || !tok.Expiry.After(time.Now()) || !strings.HasPrefix(tok.AccessToken, "ghu_") {
		return nil, errors.New("GitHub did not return an expiring GitHub App user access token")
	}
	credential := []byte(tok.AccessToken)
	tok.AccessToken = ""
	tok.RefreshToken = ""
	return credential, nil
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
		return errors.New("GitHub Device Flow expired or its endpoint timed out")
	}
	var oauthErr *oauth2.RetrieveError
	if errors.As(err, &oauthErr) {
		switch oauthErr.ErrorCode {
		case "access_denied":
			return errors.New("GitHub Device Flow was denied by the browser user")
		case "expired_token":
			return errors.New("GitHub Device Flow code expired")
		case "device_flow_disabled", "incorrect_client_credentials":
			return errors.New("The release's GitHub App must be configured to support Device Flow")
		}
	}
	return errors.New("Could not " + phase + " the GitHub Device Flow")
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
