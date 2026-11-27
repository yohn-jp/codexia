package main

import (
	"bytes"
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
	githubPATPrefix          = []byte("github_pat_")
)

const githubPermissionNotice = "GitHub access to yohn-jp/codexia requires Contents and Metadata read, Actions and Environments read/write. " +
	"The existing protected workflows may also require Pull requests read for release evidence."

const githubPATSetup = "https://github.com/settings/personal-access-tokens/new?" +
	"name=Codexia+initial+deployment&target_name=yohn-jp&expires_in=1&contents=read&actions=write&environments=write"

func githubLogin(ctx context.Context, o operator, clientID string) (*githubControl, error) {
	o.Notice(githubPermissionNotice)
	useDevice := githubAppClientIDPattern.MatchString(clientID)
	if useDevice {
		o.Notice("Use the repository-only installation of the release's Codexia GitHub App at https://github.com/settings/installations for this short-lived session.")
		choice, err := o.Confirm("Start GitHub Device Flow at https://github.com/login/device? The browser code expires within 15 minutes")
		if err != nil {
			return nil, err
		}
		useDevice = choice
	} else {
		o.Notice("This build has no provisioned release-bound GitHub App client ID. A maintainer must configure the release app for Device Flow.")
	}

	var credential []byte
	var err error
	if useDevice {
		credential, err = githubDeviceAccess(ctx, o, clientID, githubHTTPClient(20*time.Second))
	} else {
		credential, err = githubPAT(o)
	}
	if err != nil {
		return nil, err
	}
	control, err := newGitHubControl(credential)
	if err != nil {
		clear(credential)
		return nil, err
	}
	user, resp, err := control.client.Users.Get(ctx, "")
	if err != nil || user.GetID() <= 0 || user.GetLogin() == "" {
		control.Close(ctx)
		return nil, githubFailure("verify the authenticated GitHub user", resp, err)
	}
	if !useDevice {
		// GitHub only includes this documented header for applicable credentials.
		// Check present expiry metadata and require the operator to select an expiring PAT.
		expiry := resp.Header.Get("GitHub-Authentication-Token-Expiration")
		if expiry != "" && !githubPATExpiry(expiry, time.Now()) {
			control.Close(ctx)
			return nil, errors.New("GitHub fine-grained PAT has an invalid or expired lifetime")
		}
	}
	control.actor = user.GetLogin()
	control.appSession = useDevice
	approved, err := o.Confirm(fmt.Sprintf("Use GitHub account %s for the yohn-jp/codexia initial installation", control.actor))
	if err != nil || !approved {
		control.Close(ctx)
		if err != nil {
			return nil, err
		}
		return nil, errors.New("GitHub account declined")
	}
	if useDevice {
		if err := control.verifyInstallation(ctx); err != nil {
			control.Close(ctx)
			return nil, err
		}
	}
	return control, nil
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

func githubPAT(o operator) ([]byte, error) {
	ok, err := o.Confirm("Use an expiring fine-grained PAT restricted to yohn-jp/codexia instead")
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("GitHub authentication was not approved")
	}
	o.Notice("Create a one-day token at " + githubPATSetup + " and choose only the codexia repository.")
	raw, err := o.Secret("Enter the expiring, repository-limited GitHub fine-grained PAT")
	defer clear(raw)
	if err != nil {
		return nil, err
	}
	value := bytes.TrimSpace(raw)
	if !bytes.HasPrefix(value, githubPATPrefix) || len(value) <= len(githubPATPrefix) || len(value) > 256 ||
		bytes.ContainsAny(value, " \t\r\n\x00") {
		return nil, errors.New("GitHub requires a fine-grained PAT")
	}
	return bytes.Clone(value), nil
}

func githubPATExpiry(value string, now time.Time) bool {
	for _, format := range []string{"2006-01-02 15:04:05 MST", time.RFC3339} {
		if expiry, err := time.Parse(format, value); err == nil {
			return expiry.After(now)
		}
	}
	return false
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

func (g *githubControl) verifyInstallation(ctx context.Context) error {
	const help = "Configure the release's GitHub App installation for yohn-jp/codexia only at https://github.com/settings/installations"
	for page := 1; page != 0; {
		list, resp, err := g.client.Apps.ListUserInstallations(ctx, &github.ListOptions{PerPage: 100, Page: page})
		if err != nil {
			return githubFailure("inspect the authenticated GitHub App installation", resp, err)
		}
		for _, installation := range list {
			if !strings.EqualFold(installation.GetAccount().GetLogin(), githubOwner) || installation.GetID() <= 0 ||
				installation.GetRepositorySelection() != "selected" || installation.SuspendedAt != nil {
				continue
			}
			repos, repoResp, err := g.client.Apps.ListUserRepos(ctx, installation.GetID(), &github.ListOptions{PerPage: 2})
			if err != nil {
				return githubFailure("inspect repositories available to the GitHub App and signed-in user", repoResp, err)
			}
			if repos.GetTotalCount() != 1 || len(repos.Repositories) != 1 || repoResp.NextPage != 0 ||
				repos.Repositories[0].GetID() != githubRepoID {
				continue
			}
			perms := installation.GetPermissions()
			if perms.GetActions() != "write" || perms.GetEnvironments() != "write" ||
				!githubHasRead(perms.GetContents()) || !githubHasRead(perms.GetMetadata()) {
				return errors.New("The GitHub App installation permissions are insufficient. " + githubPermissionNotice)
			}
			g.appAdministration = perms.GetAdministration() == "write"
			return nil
		}
		page = resp.NextPage
	}
	return errors.New(help)
}

func githubHasRead(permission string) bool {
	return permission == "read" || permission == "write"
}
