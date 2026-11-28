package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"

	"golang.org/x/sys/unix"
	"golang.org/x/term"
)

var cfAllowedScopes = []string{
	"account:read", "zone:read", "account_api_tokens:create", "access-app.read", "access-policy.read",
	"access-service-token.read", "access-service-token.write", "argotunnel.read", "argotunnel.write",
	"dns_records:read", "workers-routes.read", "workers-scripts.read", "workers-scripts.write",
}

var cfReadScopes = []string{
	"access-app.read", "access-policy.read", "access-service-token.read", "account:read", "argotunnel.read",
	"dns_records:read", "workers-routes.read", "workers-scripts.read", "zone:read",
}

type cfDeviceRequirements struct {
	accountTokenCreate bool
	accessTokenWrite   bool
	workerScriptsWrite bool
	tunnelToken        bool
	zoneID             string
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
	if requirements.tunnelToken {
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
	defer terminalFile.Close()
	login, cancel := context.WithTimeout(ctx, cfDeviceLoginTimeout)
	defer cancel()
	args := []string{"auth", "login", "--device", "--no-browser", "--no-use-keyring", "--scopes"}
	args = append(args, scopes...)
	command := exec.CommandContext(login, runtime.node, append([]string{runtime.cli}, args...)...)
	command.Dir, command.Env = runtime.workDir, runtime.commandEnv()
	command.Stdin, command.Stdout, command.Stderr = terminalFile, terminalFile, terminalFile
	if err := command.Run(); err != nil {
		if login.Err() != nil {
			return needsAction("Cloudflare Device Flow expired or was interrupted. No credential was accepted by CodexiaCTL")
		}
		return needsAction("Cloudflare Device Flow was declined or did not complete. No credential was accepted by CodexiaCTL")
	}
	runtime.loggedIn = true
	granted, err := runtime.run(ctx, "auth", "scopes", "--all")
	if err != nil {
		return needsAction("Cloudflare cf could not verify the scopes granted to this Device Flow")
	}
	if !cfGrantedScopesContain(granted, scopes) {
		return needsAction("Cloudflare granted scopes did not contain the complete, exact set requested by CodexiaCTL")
	}
	return nil
}

func cfScopeSetAllowed(scopes []string) bool {
	for _, scope := range scopes {
		if !slices.Contains(cfAllowedScopes, scope) {
			return false
		}
	}
	ordered := slices.Clone(scopes)
	slices.Sort(ordered)
	return len(slices.Compact(ordered)) == len(scopes)
}

func cfGrantedScopesContain(output []byte, requested []string) bool {
	text := string(output)
	for _, scope := range requested {
		if !strings.Contains(text, scope) {
			return false
		}
	}
	return true
}

func verifyCFDeviceFlowPrerequisites() error {
	if !slices.Contains(cfAllowedScopes, "account_api_tokens:create") ||
		!slices.Contains(cfAllowedScopes, "access-service-token.write") ||
		!slices.Contains(cfAllowedScopes, "argotunnel.write") {
		return errors.New("the pinned official cf scope allowlist is incomplete")
	}
	return nil
}
