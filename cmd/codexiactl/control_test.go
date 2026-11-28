package main

import (
	"encoding/json"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestProtectedSSHInputsBindBothEnvironmentsToCloudflareManagementHostname(t *testing.T) {
	t.Parallel()
	private, public, err := newSSHIdentity()
	if err != nil {
		t.Fatal(err)
	}
	defer clear(private)
	key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(public))
	if err != nil {
		t.Fatal(err)
	}
	const host = "codexia-ssh.example.test"
	pin := host + " " + public
	vm := vmObservation{User: "operator", hostKeys: []ssh.PublicKey{key}}
	snapshot := githubSnapshot{
		Bootstrap:  githubEnvironment{Variables: map[string]string{"CODEXIA_BOOTSTRAP_HOST": host, "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS": pin}},
		Production: githubEnvironment{Variables: map[string]string{"CODEXIA_DEPLOY_HOST": host, "CODEXIA_DEPLOY_SSH_KNOWN_HOSTS": pin}},
	}
	desired, err := observedProtectedVariables(snapshot, vm, host, pin, `{"repository":"owner/codexia"}`)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range desired {
		if item.name == "CODEXIA_BOOTSTRAP_HOST" || item.name == "CODEXIA_DEPLOY_HOST" {
			if item.value != host {
				t.Errorf("%s = %q, want management hostname %q", item.name, item.value, host)
			}
		}
		if strings.Contains(item.name, "KNOWN_HOSTS") && item.value != pin {
			t.Errorf("%s = %q, want the same verified pin %q", item.name, item.value, pin)
		}
	}
}

func TestProtectedSSHInputsRejectOldDestinationAndHostKey(t *testing.T) {
	t.Parallel()
	private, public, err := newSSHIdentity()
	if err != nil {
		t.Fatal(err)
	}
	defer clear(private)
	key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(public))
	if err != nil {
		t.Fatal(err)
	}
	const host = "codexia-ssh.example.test"
	vm := vmObservation{User: "operator", hostKeys: []ssh.PublicKey{key}}
	if _, err := observedProtectedVariables(githubSnapshot{}, vm, host, "100.64.0.15 "+public, `{}`); err == nil {
		t.Fatal("accepted a pin that was not projected through the management hostname")
	}
	for _, snapshot := range []githubSnapshot{
		{Bootstrap: githubEnvironment{Variables: map[string]string{"CODEXIA_BOOTSTRAP_HOST": "codexia.example.ts.net"}}},
		{Production: githubEnvironment{Variables: map[string]string{"CODEXIA_DEPLOY_HOST": host, "CODEXIA_DEPLOY_SSH_KNOWN_HOSTS": host + ",codexia.example.ts.net " + public + "\n"}}},
	} {
		if _, err := observedProtectedVariables(snapshot, vm, host, host+" "+public, `{}`); err == nil {
			t.Fatal("accepted a legacy destination or a malformed/mismatched known-hosts value")
		}
	}
}

func TestProtectedSecretInventoryHasPerEnvironmentSSHAccessAndNoTunnelToken(t *testing.T) {
	t.Parallel()
	seen := make(map[string]bool)
	for _, input := range protectedSecrets() {
		seen[input.environment+"/"+input.name] = true
		if input.name == "CODEXIA_TUNNEL_TOKEN" {
			t.Fatal("obsolete Tunnel token remains in the protected GitHub inventory")
		}
	}
	for _, environment := range []string{bootstrapEnvironment, productionEnvironment} {
		for _, name := range []string{sshAccessClientID, sshAccessSecret} {
			if !seen[environment+"/"+name] {
				t.Errorf("missing protected SSH service-auth Secret %s/%s", environment, name)
			}
		}
	}
}

func TestServiceAuthCredentialPairsFailClosedWhenOnlyOneSecretExists(t *testing.T) {
	t.Parallel()
	for _, snapshot := range []githubSnapshot{
		{Bootstrap: githubEnvironment{Secrets: map[string]bool{sshAccessClientID: true}}},
		{Production: githubEnvironment{Secrets: map[string]bool{sshAccessSecret: true}}},
		{Bootstrap: githubEnvironment{Secrets: map[string]bool{"CODEXIA_ACCESS_CLIENT_ID": true}}},
		{Production: githubEnvironment{Secrets: map[string]bool{"CODEXIA_ACCESS_CLIENT_SECRET": true}}},
	} {
		if err := validateServiceAuthPairs(snapshot); err == nil {
			t.Fatal("accepted an incomplete, write-only Cloudflare Service Auth credential pair")
		}
	}
	complete := githubSnapshot{
		Bootstrap: githubEnvironment{Secrets: map[string]bool{
			sshAccessClientID: true, sshAccessSecret: true,
			"CODEXIA_ACCESS_CLIENT_ID": true, "CODEXIA_ACCESS_CLIENT_SECRET": true,
		}},
		Production: githubEnvironment{Secrets: map[string]bool{
			sshAccessClientID: true, sshAccessSecret: true,
			"CODEXIA_ACCESS_CLIENT_ID": true, "CODEXIA_ACCESS_CLIENT_SECRET": true,
		}},
	}
	if err := validateServiceAuthPairs(complete); err != nil {
		t.Fatalf("rejected complete Service Auth pairs: %v", err)
	}
}

func TestExistingManagementPathRequiresTheEnvironmentSpecificSSHServiceToken(t *testing.T) {
	t.Parallel()
	variables := map[string]string{
		"CODEXIA_BOOTSTRAP_HOST":            "codexia-ssh.example.test",
		"CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS": "codexia-ssh.example.test ssh-ed25519 AAAA",
		"CODEXIA_BOOTSTRAP_SSH_USER":        "operator",
		edgeTarget:                          `{"repository":"owner/codexia"}`,
	}
	secrets := make(map[string]bool)
	for _, name := range commonSecrets {
		secrets[name] = true
	}
	env := githubEnvironment{Variables: variables, Secrets: secrets}
	if managementInputsExist(env, []string{"CODEXIA_BOOTSTRAP_HOST", "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS", "CODEXIA_BOOTSTRAP_SSH_USER"}, bootstrapSSHSecret) {
		t.Fatal("accepted a management route without per-environment SSH Service Auth")
	}
	secrets[sshAccessClientID], secrets[sshAccessSecret], secrets[bootstrapSSHSecret] = true, true, true
	env.Secrets = secrets
	if !managementInputsExist(env, []string{"CODEXIA_BOOTSTRAP_HOST", "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS", "CODEXIA_BOOTSTRAP_SSH_USER"}, bootstrapSSHSecret) {
		t.Fatal("rejected the complete bootstrap management route")
	}
}

func TestProtectedManagementMigrationKeepsBothPinsThroughInterruptedWrites(t *testing.T) {
	t.Parallel()
	snapshot, vm, host, pin, target := managementMigrationFixture(t)

	for step := range 9 {
		writes, err := plannedProtectedVariables(snapshot, vm, host, pin, target)
		if err != nil {
			t.Fatalf("step %d: %v", step, err)
		}
		if len(writes) != 8-step {
			t.Fatalf("step %d: got %d writes, want %d", step, len(writes), 8-step)
		}
		if step == 8 {
			break
		}
		write := writes[0]
		env := selectEnvironment(snapshot, write.environment)
		current, exists := env.Variables[write.name]
		if !exists || !write.update || current != write.previous {
			t.Fatalf("step %d: write lacks the exact observed previous value: %+v", step, write)
		}
		env.Variables[write.name] = write.value

		for _, pair := range managementVariablePairs {
			values := selectEnvironment(snapshot, pair.environment).Variables
			if err := vm.verifyKnownHosts(values[pair.hostName], values[pair.pinName]); err != nil {
				t.Fatalf("step %d loses its effective host pin: %v", step, err)
			}
		}
	}
	for _, pair := range managementVariablePairs {
		env := selectEnvironment(snapshot, pair.environment)
		if env.Variables[pair.hostName] != host || env.Variables[pair.pinName] != pin ||
			env.Variables[edgeTarget] != target || len(env.Secrets) != 1 || !env.Secrets[sshAccessSecret] {
			t.Fatal("migration changed binding, pins, or existing secrets beyond the approved scope")
		}
	}
}

func TestProtectedManagementMigrationRefusesUnboundOrUnrelatedChanges(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"fresh VM", "missing legacy pin", "other effective host key", "missing target", "unknown target field", "changed account", "changed policy", "changed public protocol", "target duplicate identity", "malformed effective pin", "unknown additional pin"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			snapshot, vm, host, pin, target := managementMigrationFixture(t)
			env := snapshot.Bootstrap
			const pinName = "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS"
			switch name {
			case "fresh VM":
				vm.CodexiaPresent = false
			case "missing legacy pin":
				delete(env.Variables, pinName)
			case "other effective host key":
				private, keyText, err := newSSHIdentity()
				if err != nil {
					t.Fatal(err)
				}
				clear(private)
				key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(keyText))
				if err != nil {
					t.Fatal(err)
				}
				vm.hostKeys = append(vm.hostKeys, key)
				env.Variables[pinName] = env.Variables["CODEXIA_BOOTSTRAP_HOST"] + " " + keyText
			case "missing target":
				delete(env.Variables, edgeTarget)
			case "unknown target field":
				env.Variables[edgeTarget] = strings.Replace(env.Variables[edgeTarget], "{", `{"custom":true,`, 1)
			case "changed account":
				env.Variables[edgeTarget] = strings.Replace(env.Variables[edgeTarget], strings.Repeat("a", 32), strings.Repeat("e", 32), 1)
			case "changed policy":
				env.Variables[edgeTarget] = strings.Replace(env.Variables[edgeTarget], testOldProbePolicy, testManagementPolicy, 1)
			case "changed public protocol":
				env.Variables[edgeTarget] = strings.Replace(env.Variables[edgeTarget], "false", "true", 1)
			case "target duplicate identity":
				env.Variables[edgeTarget] = strings.Replace(env.Variables[edgeTarget], "{", `{"repositoryId":999,`, 1)
			case "unknown additional pin":
				env.Variables[pinName] += "\nother.example.test " + strings.TrimPrefix(pin, host+" ")
			case "malformed effective pin":
				env.Variables[pinName] = strings.Replace(env.Variables[pinName], " ", ",alias.example.test ", 1)
			}
			writes, err := plannedProtectedVariables(snapshot, vm, host, pin, target)
			if err == nil || len(writes) != 0 {
				t.Fatalf("unsafe migration state planned writes: %+v, %v", writes, err)
			}
		})
	}
}

const (
	testOldProbePolicy   = "00000000-0000-4000-8000-000000000002"
	testManagementPolicy = "00000000-0000-4000-8000-000000000003"
)

func managementMigrationFixture(t *testing.T) (githubSnapshot, vmObservation, string, string, string) {
	t.Helper()
	private, public, err := newSSHIdentity()
	if err != nil {
		t.Fatal(err)
	}
	clear(private)
	key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(public))
	if err != nil {
		t.Fatal(err)
	}
	const host = "codexia-ssh.example.test"
	const previous = "100.64.0.25"
	edge := cloudflareTarget{
		Repository: "owner/codexia", RepositoryID: 2, OwnerID: 3, Origin: "https://codexia.example.test",
		AccountID: strings.Repeat("a", 32), ZoneID: strings.Repeat("b", 32),
		TunnelID: "00000000-0000-4000-8000-000000000004", AuthorPolicyID: "00000000-0000-4000-8000-000000000001",
		CIPolicyID: testOldProbePolicy, SSHHostname: host, SSHPolicyID: testManagementPolicy, TunnelTeamName: "codexia",
	}
	raw, err := json.Marshal(edge)
	if err != nil {
		t.Fatal(err)
	}
	var oldFields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &oldFields); err != nil {
		t.Fatal(err)
	}
	delete(oldFields, "sshHostname")
	delete(oldFields, "sshPolicyId")
	old, err := json.Marshal(oldFields)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := githubSnapshot{
		Bootstrap: githubEnvironment{
			Variables: map[string]string{"CODEXIA_BOOTSTRAP_HOST": previous, "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS": previous + " " + public, "CODEXIA_BOOTSTRAP_SSH_USER": "operator", edgeTarget: string(old)},
			Secrets:   map[string]bool{sshAccessSecret: true},
		},
		Production: githubEnvironment{
			Variables: map[string]string{"CODEXIA_DEPLOY_HOST": previous, "CODEXIA_DEPLOY_SSH_KNOWN_HOSTS": previous + " " + public, edgeTarget: string(old)},
			Secrets:   map[string]bool{sshAccessSecret: true},
		},
	}
	return snapshot, vmObservation{User: "operator", CodexiaPresent: true, hostKeys: []ssh.PublicKey{key}}, host, host + " " + public, string(raw)
}
