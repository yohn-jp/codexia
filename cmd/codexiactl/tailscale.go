package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strings"
	"syscall"
	"time"
	"unicode"

	ts "tailscale.com/client/tailscale/v2"
)

const tailnetCLI = "/usr/bin/tailscale"

const wifIssuer = "https://token.actions.githubusercontent.com"
const wifTrustConsole = "https://login.tailscale.com/admin/settings/trust-credentials"

var tailnetNodeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var tailnetBrowserPath = regexp.MustCompile(`^/a/[A-Za-z0-9_-]+$`)
var tailnetDNSName = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$`)
var tailnetToken = regexp.MustCompile(`^tskey-api-[A-Za-z0-9_-]{8,512}$`)

type tailnetObservation struct {
	Address  string
	ClientID string
	Tailnet  string
	NodeID   string
	Aliases  []string
}

type localTailnet struct {
	BackendState   string
	HaveNodeKey    bool
	CurrentTailnet *localTailnetIdentity
	Self           *localTailnetNode
}

type localTailnetIdentity struct {
	Name     string
	StableID string
}

type localTailnetNode struct {
	ID           string
	PublicKey    string
	DNSName      string
	TailscaleIPs []string
}

func prepareTailnet(ctx context.Context, o operator, vm vmObservation, gh *githubControl, snapshot githubSnapshot, plan bool) (tailnetObservation, error) {
	clientID, err := protectedWIFClientID(snapshot)
	if err != nil {
		return tailnetObservation{}, err
	}
	if _, err := os.Stat(tailnetCLI); errors.Is(err, os.ErrNotExist) {
		o.Notice("Tailscale can be installed from its signed Ubuntu 26.04 stable APT repository over HTTPS.")
		if plan {
			return tailnetObservation{}, needsAction("Tailscale's official package and node login are missing")
		}
		if err := confirmIndependentSSH(o, vm); err != nil {
			return tailnetObservation{}, err
		}
		approved, err := o.Confirm("Install the official Tailscale package on this VM and start its local service?")
		if err := requireTailnetApproval(approved, err, "Tailscale installation was declined"); err != nil {
			return tailnetObservation{}, err
		}
		if err := gh.requireApprovedTarget(ctx, false); err != nil {
			return tailnetObservation{}, err
		}
		if err := installTailscalePackage(ctx); err != nil {
			return tailnetObservation{}, err
		}
	} else if err != nil {
		return tailnetObservation{}, errors.New("could not inspect the installed Tailscale package")
	}

	local, err := observeLocalTailnet(ctx)
	if err != nil {
		return tailnetObservation{}, err
	}
	if local.BackendState == "NeedsMachineAuth" && !plan {
		o.Notice("The device is awaiting approval in https://login.tailscale.com/admin/machines. Approve only this VM's independent Tailnet identity.")
		local, err = waitForTailnetApproval(ctx)
		if err != nil {
			return tailnetObservation{}, err
		}
	}
	if local.BackendState != "Running" {
		if plan || !freshTailnetProfile(local) {
			return tailnetObservation{}, needsAction("Tailscale node is not ready; confirm its existing profile, device approval and service in the official Machines console")
		}
		if err := confirmIndependentSSH(o, vm); err != nil {
			return tailnetObservation{}, err
		}
		approved, err := o.Confirm("Connect this unconfigured node to the intended Codexia Tailnet using the official browser login?")
		if err := requireTailnetApproval(approved, err, "Tailscale node login was declined"); err != nil {
			return tailnetObservation{}, err
		}
		if err := gh.requireApprovedTarget(ctx, false); err != nil {
			return tailnetObservation{}, err
		}
		if err := joinTailnet(ctx, o); err != nil {
			return tailnetObservation{}, err
		}
		local, err = observeLocalTailnet(ctx)
		if err != nil {
			return tailnetObservation{}, err
		}
	}

	identity, err := local.identity()
	if err != nil {
		return tailnetObservation{}, err
	}
	o.Notice(fmt.Sprintf("Tailscale observed Tailnet %s, node %s, address %s.", identity.Tailnet, identity.NodeID, identity.Address))
	approved, err := o.Confirm("Is this the intended Tailnet and target VM?")
	if err := requireTailnetApproval(approved, err, "the observed Tailscale Tailnet and node were not confirmed"); err != nil {
		return identity, err
	}
	o.Notice("Tailscale administration is needed to verify this VM, the CI SSH policy and GitHub Actions OIDC trust. This is NOT an auth key or the GitHub token; it is used only during this CLI session.")
	o.Notice("Use a short-lived Tailscale API access token from https://login.tailscale.com/admin/settings/keys (an API access token is fully privileged), or an existing scoped management credential. Scoped read access needs devices:core:read, devices:posture_attributes:read, policy_file:read and federated_keys:read; approved OIDC credential creation additionally requires federated_keys (write). Never provide a device Auth Key.")
	token, err := o.Secret("Tailscale administration access token")
	if err != nil {
		return identity, err
	}
	defer clear(token)
	token = bytes.TrimSpace(token)
	if !tailnetToken.Match(token) {
		return identity, errors.New("expected a Tailscale administration access token")
	}

	client := &ts.Client{
		APIKey:    string(token),
		Tailnet:   local.CurrentTailnet.StableID,
		UserAgent: "codexiactl",
		HTTP: &http.Client{
			Timeout: 15 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return errors.New("Tailscale API redirects are not accepted")
			},
		},
	}
	defer func() { client.APIKey = "" }()
	if plan {
		return inspectTailnetWithApproval(ctx, client, local, gh.target, clientID, o, nil)
	}
	return inspectTailnetWithApproval(ctx, client, local, gh.target, clientID, o, func(ctx context.Context) error {
		return gh.requireApprovedTarget(ctx, false)
	})
}

func requireTailnetApproval(approved bool, err error, denied string) error {
	if err != nil {
		return err
	}
	if !approved {
		return needsAction(denied)
	}
	return nil
}

func confirmIndependentSSH(o operator, vm vmObservation) error {
	if isTailnetAddress(vm.connection.peer) || isTailnetAddress(vm.connection.local) {
		return refused("use an independent, verified SSH session before installing or connecting Tailscale")
	}
	_, err := vm.confirmHostFingerprint(o)
	return err
}

func observeLocalTailnet(ctx context.Context) (localTailnet, error) {
	data, err := commandOutput(ctx, tailnetCLI, "status", "--json", "--peers=false")
	if err != nil {
		return localTailnet{}, errors.New("tailscale status could not reach the installed daemon; inspect systemctl status tailscaled and retry")
	}
	var state localTailnet
	if err := json.Unmarshal(data, &state); err != nil || state.BackendState == "" {
		return localTailnet{}, errors.New("the installed Tailscale CLI did not provide a valid node status")
	}
	return state, nil
}

func freshTailnetProfile(state localTailnet) bool {
	return !state.HaveNodeKey && state.CurrentTailnet == nil &&
		(state.BackendState == "NeedsLogin" || state.BackendState == "NoState")
}

func waitForTailnetApproval(ctx context.Context) (localTailnet, error) {
	wait, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	for {
		select {
		case <-wait.Done():
			return localTailnet{}, needsAction("Tailscale device approval did not complete before the deadline")
		case <-time.After(3 * time.Second):
		}
		local, err := observeLocalTailnet(wait)
		if err != nil {
			return local, err
		}
		if local.BackendState != "NeedsMachineAuth" && local.BackendState != "Starting" {
			return local, nil
		}
	}
}

func joinTailnet(ctx context.Context, o operator) error {
	wait, cancel := context.WithTimeout(ctx, 11*time.Minute)
	defer cancel()
	// Manage only a fresh profile. Preserve the VM resolver and avoid applying
	// subnet or exit-node routes to the independent SSH management path.
	cmd := exec.CommandContext(wait, "/usr/bin/sudo", "-n", tailnetCLI, "up",
		"--json", "--timeout=10m", "--accept-dns=false", "--accept-routes=false")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
	cmd.WaitDelay = 2 * time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil || cmd.Start() != nil {
		return errors.New("could not start the official Tailscale node login")
	}
	defer func() {
		cancel()
		_ = cmd.Wait()
	}()
	decoder := json.NewDecoder(io.LimitReader(stdout, 1024*1024))
	var displayedURL string
	for {
		var message struct {
			AuthURL string
		}
		if err := decoder.Decode(&message); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return errors.New("official Tailscale CLI returned an unexpected node login message")
		}
		if message.AuthURL == "" || message.AuthURL == displayedURL {
			continue
		}
		if !validTailscaleBrowserURL(message.AuthURL) {
			return errors.New("official Tailscale CLI returned an unexpected node authentication URL")
		}
		displayedURL = message.AuthURL
		o.Notice("On your own browser, sign in to the intended Tailnet. This node link expires and requires no port forwarding: " + message.AuthURL)
		o.Notice("When required, approve the VM in https://login.tailscale.com/admin/machines.")
	}
	if err := cmd.Wait(); err != nil {
		return errors.New("the Tailscale node login was denied, interrupted, or did not finish before its deadline")
	}
	return nil
}

func validTailscaleBrowserURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host == "login.tailscale.com" &&
		u.User == nil && u.RawQuery == "" && !u.ForceQuery && u.Fragment == "" && u.RawPath == "" &&
		tailnetBrowserPath.MatchString(u.Path)
}

func (local localTailnet) identity() (tailnetObservation, error) {
	if local.BackendState != "Running" || local.CurrentTailnet == nil ||
		local.Self == nil || !tailnetNodeID.MatchString(local.CurrentTailnet.StableID) ||
		!tailnetNodeID.MatchString(local.Self.ID) || local.Self.PublicKey == "" ||
		!tailnetDNSName.MatchString(strings.TrimSuffix(local.Self.DNSName, ".")) || local.CurrentTailnet.Name == "" ||
		strings.ContainsFunc(local.CurrentTailnet.Name, func(r rune) bool { return !unicode.IsPrint(r) }) {
		return tailnetObservation{}, errors.New("cannot identify the running Tailscale Tailnet, node and DNS registration")
	}
	dns := strings.TrimSuffix(local.Self.DNSName, ".")
	identity := tailnetObservation{
		NodeID: local.Self.ID, Tailnet: local.CurrentTailnet.Name, Aliases: []string{dns, dns + "."},
	}
	var preferred netip.Addr
	for _, address := range local.Self.TailscaleIPs {
		ip, err := netip.ParseAddr(address)
		if err != nil || !isTailnetAddress(ip) {
			continue
		}
		identity.Aliases = append(identity.Aliases, ip.String())
		if !preferred.IsValid() || ip.Is4() && !preferred.Is4() {
			preferred = ip
		}
	}
	if !preferred.IsValid() {
		return tailnetObservation{}, errors.New("running Tailscale node has no supported address")
	}
	identity.Address = preferred.String()
	return identity, nil
}

func inspectTailnetWithApproval(ctx context.Context, client *ts.Client, local localTailnet, target githubTarget, clientID string, o operator, approveTarget func(context.Context) error) (tailnetObservation, error) {
	identity, err := local.identity()
	if err != nil {
		return identity, err
	}
	if !target.valid() {
		return identity, refused("Tailscale trust requires a verified deployment repository")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	devices, err := client.Devices().List(ctx, ts.WithFields(ts.IncludeFieldsAll))
	if err != nil {
		return identity, tailnetAPIError("list devices in the observed Tailnet", err)
	}
	if err := verifyTailnetNode(devices, identity, local.Self); err != nil {
		return identity, err
	}

	// Establish CI ingress authorization before any WIF creation. Creating a
	// credential for a Tailnet whose existing policy blocks this VM would leave
	// an unnecessary trust principal behind after an otherwise avoidable failure.
	if _, err := client.PolicyFile().Get(ctx); err != nil {
		return identity, tailnetAPIError("read the Tailnet access policy", err)
	}
	destination := net.JoinHostPort(identity.Address, "22")
	if err := client.PolicyFile().Validate(ctx, []ts.ACLTest{{Source: "tag:ci", Accept: []string{destination}}}); err != nil {
		return identity, tailnetAPIError("validate CI policy for tag:ci to this VM on TCP/22; use the authorized Tailnet policy owner to reconcile", err)
	}

	keyID, mismatches, err := discoverTailnetWIF(ctx, client, target, clientID)
	if err != nil {
		return identity, err
	}
	if keyID == "" {
		for _, mismatch := range mismatches {
			if o != nil {
				o.Notice("Tailscale OIDC trust mismatch: " + mismatch)
			}
		}
		if clientID != "" {
			return identity, refused("The protected TS_OAUTH_CLIENT_ID does not identify a matching credential for the selected repository. Reconcile it through the owning Environment")
		}
		if approveTarget == nil || o == nil {
			return identity, needsAction("No exact GitHub Actions OIDC trust exists. Inspect " + wifTrustConsole + "; init can create a separate, scoped credential after approval. Existing credentials are not changed")
		}
		o.Notice("A new credential will trust only " + target.wifSubject() + ", main-branch workflows, auth_keys and tag:ci; no existing credential will be modified.")
		if err := requireApproval(o, "Create a separate minimal GitHub Actions OIDC trust credential in this Tailnet?"); err != nil {
			return identity, err
		}
		if err := approveTarget(ctx); err != nil {
			return identity, err
		}
		created, createErr := client.Keys().CreateFederatedIdentity(ctx, ts.CreateFederatedIdentityRequest{
			Description: "Codexia protected GitHub Actions",
			Issuer:      wifIssuer, Subject: target.wifSubject(),
			Scopes: []string{"auth_keys"}, Tags: []string{"tag:ci"},
			CustomClaimRules: map[string]string{
				"ref":          "refs/heads/main",
				"workflow_ref": target.workflowClaim(),
			},
		})
		if createErr != nil {
			// Reobserve after an ambiguous transport failure. Never replay creation.
			recovered, _, observeErr := discoverTailnetWIF(ctx, client, target, clientID)
			if observeErr == nil && recovered != "" {
				identity.ClientID = recovered
				return identity, nil
			}
			return identity, errors.Join(tailnetAPIError("create approved scoped GitHub OIDC trust (requires federated_keys (write))", createErr), observeErr)
		}
		if created == nil || !tailnetNodeID.MatchString(created.ID) {
			return identity, refused("Tailscale returned no valid identity for the created OIDC credential; inspect " + wifTrustConsole + " before retrying")
		}
		verified, getErr := client.Keys().Get(ctx, created.ID)
		if getErr != nil {
			return identity, tailnetAPIError("verify newly created OIDC trust", getErr)
		}
		if verified == nil || verified.ID != created.ID || !matchesWIF(target, *verified) {
			return identity, refused("New OIDC credential is not an exact match. Inspect " + wifTrustConsole + " before retrying; do not create another credential")
		}
		keyID = created.ID
		o.Notice("Created and reverified scoped Tailscale OIDC credential " + keyID + ". Its audience is api.tailscale.com/" + keyID + ".")
	}
	identity.ClientID = keyID
	return identity, nil
}

func verifyTailnetNode(devices []ts.Device, identity tailnetObservation, local *localTailnetNode) error {
	var found *ts.Device
	for i := range devices {
		device := &devices[i]
		if device.NodeID != identity.NodeID {
			continue
		}
		if found != nil {
			return errors.New("Tailscale returned more than one identity for the observed node")
		}
		found = device
	}
	if found == nil || found.IsExternal || !found.Authorized || found.IsEphemeral ||
		found.NodeKey != local.PublicKey || !slices.Contains(found.Addresses, identity.Address) ||
		!strings.EqualFold(strings.TrimSuffix(found.Name, "."), strings.TrimSuffix(local.DNSName, ".")) {
		return refused("the authenticated Tailnet does not contain the approved local VM identity")
	}
	if !found.ConnectedToControl {
		return needsAction("the observed Tailscale node is disconnected from the Tailnet control plane")
	}
	if found.BlocksIncomingConnections || found.SSHEnabled || found.TailnetLockError != "" {
		return needsAction("the observed Tailscale node blocks protected OpenSSH or requires a Tailnet Lock correction")
	}
	return nil
}

func discoverTailnetWIF(ctx context.Context, client *ts.Client, target githubTarget, clientID string) (string, []string, error) {
	keys, err := client.Keys().List(ctx, true)
	if err != nil {
		return "", nil, tailnetAPIError("list federated identities in the Tailnet", err)
	}
	var matching string
	var mismatches []string
	seen := make(map[string]bool)
	for _, item := range keys {
		if !tailnetNodeID.MatchString(item.ID) || seen[item.ID] {
			continue
		}
		seen[item.ID] = true
		if clientID != "" && item.ID != clientID || item.KeyType != "" && item.KeyType != "federated" {
			continue
		}
		key, err := client.Keys().Get(ctx, item.ID)
		if err != nil {
			return "", nil, tailnetAPIError("read federated identity restrictions", err)
		}
		if key == nil || key.ID != item.ID {
			return "", nil, refused("Tailscale federated identity changed while being inspected")
		}
		problems := wifProblems(target, *key)
		if len(problems) != 0 {
			// Only report credentials for this repository, not other unrelated
			// workloads sharing the Tailnet.
			if key.Issuer == wifIssuer && strings.Contains(key.Subject, "codexia") {
				mismatches = append(mismatches, "credential "+item.ID+": "+strings.Join(problems, "; "))
			}
			continue
		}
		if matching != "" {
			return "", nil, refused("Multiple valid GitHub OIDC credentials match this deployment. Resolve the ambiguity in " + wifTrustConsole)
		}
		matching = key.ID
	}
	return matching, mismatches, nil
}

func wifProblems(target githubTarget, key ts.Key) []string {
	var problems []string
	if key.KeyType != "federated" || key.Invalid || !key.Revoked.IsZero() ||
		(!key.Expires.IsZero() && !time.Now().Before(key.Expires)) {
		problems = append(problems, "credential is not an active federated identity")
	}
	if !tailnetNodeID.MatchString(key.ID) || key.Audience != "api.tailscale.com/"+key.ID {
		problems = append(problems, "audience must equal api.tailscale.com/<this credential client ID>")
	}
	if key.Issuer != wifIssuer {
		problems = append(problems, "issuer must be "+wifIssuer)
	}
	if key.Subject != target.wifSubject() {
		problems = append(problems, "subject must be "+target.wifSubject()+" (GitHub immutable owner/repository IDs, both protected Environments)")
	}
	if !slices.Equal(key.Scopes, []string{"auth_keys"}) {
		problems = append(problems, "scopes must contain only auth_keys, not all or broader permissions")
	}
	if !slices.Equal(key.Tags, []string{"tag:ci"}) {
		problems = append(problems, "tags must contain only tag:ci")
	}
	if key.CustomClaimRules["ref"] != "refs/heads/main" {
		problems = append(problems, "custom claim ref must equal refs/heads/main")
	}
	if repository := key.CustomClaimRules["repository"]; repository != "" && repository != target.FullName() {
		problems = append(problems, "custom claim repository must equal "+target.FullName())
	}
	if key.CustomClaimRules["workflow_ref"] != target.workflowClaim() {
		problems = append(problems, "custom claim workflow_ref must equal "+target.workflowClaim()+"")
	}
	return problems
}

func matchesWIF(target githubTarget, key ts.Key) bool {
	return target.valid() && len(wifProblems(target, key)) == 0
}

func tailnetAPIError(operation string, err error) error {
	var response ts.APIError
	if errors.As(err, &response) && response.Status != 0 {
		return fmt.Errorf("Tailscale could not %s (HTTP %d); check the selected Tailnet and management token scopes", operation, response.Status)
	}
	return fmt.Errorf("Tailscale could not %s; check API reachability, policy and management token permissions", operation)
}

func protectedWIFClientID(snapshot githubSnapshot) (string, error) {
	var clientID string
	for _, e := range []githubEnvironment{snapshot.Bootstrap, snapshot.Production} {
		value, registered := e.Variables[wifClientIDInput]
		if !registered {
			continue
		}
		if !tailnetNodeID.MatchString(value) || clientID != "" && clientID != value {
			return "", refused("The protected Environments contain invalid or different TS_OAUTH_CLIENT_ID values")
		}
		clientID = value
	}
	return clientID, nil
}
