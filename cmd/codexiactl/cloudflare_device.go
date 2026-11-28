package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strings"

	"golang.org/x/sys/unix"
	"golang.org/x/term"
)

var cfReadScopes = []string{
	"access-app.read", "access-idp.read", "access-org.read", "access-policy.read", "access-service-token.read",
	"account:read", "argotunnel.read", "dns.read", "workers-routes.read", "workers-scripts.read", "zone:read",
}

var cfWriteScopes = []string{
	"access-app.write", "access-policy.write", "access-service-token.write", "account_api_tokens:create",
	"argotunnel.write", "dns.write", "workers-routes.write", "workers-scripts.write",
}

type cfDeviceRequirements struct {
	accountTokenCreate        bool
	accessTokenWrite          bool
	workerScriptsWrite        bool
	tunnelToken               bool
	managedTunnel             bool
	managedAccess             bool
	managedDNS                bool
	allowTemporaryObservation bool
	routeWrite                bool
	zoneID                    string
}

func (requirements cfDeviceRequirements) scopes() []string {
	result := slices.Clone(cfReadScopes)
	if requirements.accountTokenCreate {
		result = append(result, "account_api_tokens:create")
	}
	if requirements.accessTokenWrite {
		result = append(result, "access-service-token.write")
	}
	if requirements.workerScriptsWrite {
		result = append(result, "workers-scripts.write")
	}
	if requirements.managedAccess {
		result = append(result, "access-app.write", "access-policy.write")
	}
	if requirements.managedDNS {
		result = append(result, "dns.write")
	}
	if requirements.routeWrite {
		result = append(result, "workers-routes.write")
	}
	if requirements.tunnelToken || requirements.managedTunnel {
		result = append(result, "argotunnel.write")
	}
	slices.Sort(result)
	return slices.Compact(result)
}

type cfPrivateTTY interface {
	privateTTYFile() (*os.File, error)
}

func (terminal *terminal) privateTTYFile() (*os.File, error) {
	if terminal == nil || terminal.fd < 0 || !term.IsTerminal(terminal.fd) {
		return nil, needsAction("Cloudflare Device Flow requires the current interactive SSH terminal")
	}
	fd, err := unix.Dup(terminal.fd)
	if err != nil {
		return nil, needsAction("Cloudflare Device Flow could not access the current interactive SSH terminal")
	}
	unix.CloseOnExec(fd)
	return os.NewFile(uintptr(fd), "codexiactl-cloudflare-tty"), nil
}

func (runtime *cfRuntime) deviceLogin(ctx context.Context, o operator, host, managementHost string, requirements cfDeviceRequirements) error {
	if runtime == nil || o == nil || !cloudflareHost.MatchString(host) || !cloudflareHost.MatchString(managementHost) {
		return refused("Cloudflare Device Flow requires a verified production and management hostname")
	}
	scopes := requirements.scopes()
	if len(scopes) == 0 || !cfScopeSetAllowed(scopes) {
		return refused("Cloudflare Device Flow requested an unsupported or unreviewed scope")
	}
	if requirements.zoneID != "" && !cloudflareID.MatchString(requirements.zoneID) {
		return refused("the selected Cloudflare zone hint is invalid")
	}
	accountSelection := "Select the Cloudflare account that owns the matched production hostname in the official browser flow."
	zone := "Zone ID is determined only after sign-in."
	if requirements.zoneID != "" {
		zone = "Existing protected zone ID hint: " + requirements.zoneID + "."
	}
	o.Notice(fmt.Sprintf("Cloudflare Device Flow target: production https://%s; management %s. %s\nRequested official cf scopes: %s\n%s The one-time user code is shown only in this interactive SSH terminal; enter it on the official Cloudflare verification page.",
		host, managementHost, zone, strings.Join(scopes, " "), accountSelection))
	if err := requireApproval(o, "Start the official Cloudflare cf Device Flow with exactly the scopes listed above?"); err != nil {
		return err
	}
	tty, ok := o.(cfPrivateTTY)
	if !ok {
		return needsAction("Cloudflare Device Flow requires a private controlling SSH terminal")
	}
	terminalFile, err := tty.privateTTYFile()
	if err != nil {
		return err
	}
	defer func() { _ = terminalFile.Close() }()
	login, cancel := context.WithTimeout(ctx, cfDeviceLoginTimeout)
	defer cancel()
	args := []string{"auth", "login", "--device", "--no-browser", "--no-use-keyring"}
	if runtime.loggedIn {
		if err := runtime.logout(ctx); err != nil {
			return needsAction("The previous Cloudflare profile could not be logged out before changing scopes")
		}
	}
	args = append(args, "--scopes")
	args = append(args, scopes...)
	command := exec.CommandContext(login, runtime.node, append([]string{runtime.cli}, args...)...) //nolint:gosec // Both runtime entry points and the login scope allowlist are pinned and verified.
	command.Dir, command.Env = runtime.workDir, runtime.commandEnv()
	prompt := cfDevicePrompt{tty: terminalFile}
	command.Stdin, command.Stderr = terminalFile, &prompt
	defer func() { clear(prompt.pending.Bytes()) }()
	if err := command.Start(); err != nil {
		return needsAction("Cloudflare Device Flow could not start in the private terminal")
	}
	// Even a cancelled process can have created a profile before it exited.
	runtime.loggedIn = true
	if err := command.Wait(); err != nil {
		if login.Err() != nil {
			return needsAction("Cloudflare Device Flow expired or was interrupted. No credential was accepted by CodexiaCTL")
		}
		return needsAction("Cloudflare Device Flow was declined or did not complete. No credential was accepted by CodexiaCTL")
	}
	if !prompt.shown {
		return needsAction("Cloudflare cf did not present the verified Device Flow browser prompt")
	}
	identity, err := cfResult[cfDeviceIdentity](ctx, runtime, "auth", "whoami", "--json")
	if err != nil || !identity.Authenticated || !identity.TokenValid ||
		!strings.HasPrefix(identity.AuthSource, "OAuth token from ") || identity.Profile.Overridden ||
		identity.Profile.Source != "default" || identity.Profile.Name != "default" {
		return needsAction("Cloudflare cf could not verify the isolated Device Flow identity")
	}
	if !cfGrantedScopesMatch(identity.Scopes, scopes) {
		return needsAction("Cloudflare granted scopes did not match the exact set approved for this operation")
	}
	accounts := make(map[string]bool, len(identity.Accounts))
	for _, account := range identity.Accounts {
		if !cloudflareID.MatchString(account.ID) || accounts[account.ID] {
			return needsAction("Cloudflare cf returned an invalid or duplicated authorized account")
		}
		accounts[account.ID] = true
	}
	if len(accounts) == 0 || (runtime.accountID != "" && !accounts[runtime.accountID]) {
		return needsAction("The approved Cloudflare grant did not identify the required account")
	}
	runtime.authorizedAccounts = accounts
	return nil
}

func cfScopeSetAllowed(scopes []string) bool {
	for _, scope := range scopes {
		if !slices.Contains(cfReadScopes, scope) && !slices.Contains(cfWriteScopes, scope) {
			return false
		}
	}
	ordered := slices.Clone(scopes)
	slices.Sort(ordered)
	return len(slices.Compact(ordered)) == len(scopes)
}

var cfDeviceChallenge = regexp.MustCompile(`(?m)^To authorize cf, please visit:\s*(https://[^\s]+)\s*and enter the code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})[\t \r]*\n`)

type cfDevicePrompt struct {
	tty     io.Writer
	pending bytes.Buffer
	shown   bool
}

func (p *cfDevicePrompt) Write(b []byte) (int, error) {
	if p.shown {
		return len(b), nil
	}
	if p.pending.Len()+len(b) > 16<<10 {
		return 0, errors.New("the Cloudflare Device Flow prompt exceeded its limit")
	}
	_, _ = p.pending.Write(b)
	match := cfDeviceChallenge.FindSubmatch(p.pending.Bytes())
	if len(match) == 0 {
		return len(b), nil
	}
	verification, err := url.Parse(string(match[1]))
	if err != nil || verification.Scheme != "https" || verification.Host != "dash.cloudflare.com" ||
		verification.User != nil || verification.Fragment != "" || verification.Opaque != "" ||
		verification.Path == "" {
		return 0, errors.New("the Cloudflare cf returned an unverified browser URL")
	}
	_, err = fmt.Fprintf(p.tty, "Open %s on your computer and enter code %s. Approve before the Cloudflare Device Flow expires.\n", verification.String(), match[2])
	if err != nil {
		return 0, errors.New("the Cloudflare Device Flow could not display the one-time code in the current terminal")
	}
	p.shown = true
	clear(p.pending.Bytes())
	p.pending.Reset()
	return len(b), nil
}

type cfDeviceIdentity struct {
	Authenticated bool     `json:"authenticated"`
	AuthSource    string   `json:"authSource"`
	TokenValid    bool     `json:"tokenValid"`
	Scopes        []string `json:"scopes"`
	Accounts      []struct {
		ID string `json:"id"`
	} `json:"accounts"`
	Profile struct {
		Source     string `json:"source"`
		Name       string `json:"name"`
		Overridden bool   `json:"overridden"`
	} `json:"profile"`
}

func cfGrantedScopesMatch(granted, requested []string) bool {
	product := make([]string, 0, len(granted))
	for _, scope := range granted {
		switch scope {
		case "openid", "offline_access":
			continue
		default:
			product = append(product, scope)
		}
	}
	slices.Sort(product)
	expected := slices.Clone(requested)
	slices.Sort(expected)
	return slices.Equal(product, expected)
}

func verifyCFDeviceFlowPrerequisites() error {
	if !slices.Contains(cfWriteScopes, "account_api_tokens:create") ||
		!slices.Contains(cfWriteScopes, "access-service-token.write") ||
		!slices.Contains(cfWriteScopes, "argotunnel.write") {
		return errors.New("the pinned official cf scope allowlist is incomplete")
	}
	return nil
}
