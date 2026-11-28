package main

import (
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
