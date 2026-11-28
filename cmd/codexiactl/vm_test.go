package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestBootstrapKeyPreservesExistingAuthorizedKeys(t *testing.T) {
	home := t.TempDir()
	directory := filepath.Join(home, ".ssh")
	if err := os.Mkdir(directory, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(directory, 0o750); err != nil { //nolint:gosec // Exercise a valid existing SSH directory mode regardless of the test process umask.
		t.Fatal(err)
	}
	path := filepath.Join(directory, "authorized_keys")
	original := "# account provisioning left a comment without a newline"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o640); err != nil { //nolint:gosec // The fixture verifies that a preexisting group-readable file keeps its mode.
		t.Fatal(err)
	}
	_, public, err := newSSHIdentity()
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := installAuthorizedKey(context.Background(), home, ".ssh/authorized_keys", public, os.Getuid()); err != nil {
			t.Fatal(err)
		}
	}
	current, err := os.ReadFile(path) //nolint:gosec // Verify only the controlled test fixture's existing file.
	if err != nil {
		t.Fatal(err)
	}
	if string(current) != original+"\nrestrict "+public+" codexiactl-bootstrap\n" {
		t.Fatalf("authorized_keys was not appended once: %q", current)
	}
	for path, expected := range map[string]os.FileMode{directory: 0o750, path: 0o640} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != expected {
			t.Errorf("%s mode changed to %o", path, info.Mode().Perm())
		}
	}
}

func TestBootstrapKeyRefusesLinks(t *testing.T) {
	home := t.TempDir()
	outside := t.TempDir()
	target := filepath.Join(outside, "authorized_keys")
	if err := os.WriteFile(target, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, public, err := newSSHIdentity()
	if err != nil {
		t.Fatal(err)
	}
	sshDir := filepath.Join(home, ".ssh")
	if err := os.Symlink(outside, sshDir); err != nil {
		t.Fatal(err)
	}
	if err := installAuthorizedKey(context.Background(), home, ".ssh/authorized_keys", public, os.Getuid()); err == nil {
		t.Fatal("accepted a symlinked .ssh directory")
	}
	if err := os.Remove(sshDir); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(sshDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(target, filepath.Join(sshDir, "authorized_keys")); err != nil {
		t.Fatal(err)
	}
	if err := installAuthorizedKey(context.Background(), home, ".ssh/authorized_keys", public, os.Getuid()); err == nil {
		t.Fatal("accepted a hard-linked authorized_keys")
	}
	actual, err := os.ReadFile(target) //nolint:gosec // Compare the synthetic file outside the test's temporary home.
	if err != nil || string(actual) != "original" {
		t.Fatalf("external file changed: %q %v", actual, err)
	}
}

func TestNewSSHIdentityIsOpenSSHCompatible(t *testing.T) {
	private, public, err := newSSHIdentity()
	if err != nil {
		t.Fatal(err)
	}
	defer clear(private)
	key, err := ssh.ParsePrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key.PublicKey()))); got != public {
		t.Fatalf("public and private halves disagree: %q, %q", got, public)
	}
}

func TestAdministratorIdentityUsesSelectedRepositoryServiceUID(t *testing.T) {
	for _, test := range []struct {
		admin, service int
		allowed        bool
	}{
		{1001, 2001, true},
		{1001, 1001, false},
		{2001, 2001, false},
		{2001, 1001, true},
		{0, 1001, false},
		{1000, 0, false},
	} {
		if got := independentAdministratorUID(test.admin, test.service); got != test.allowed {
			t.Errorf("admin UID %d, service UID %d: got %v, want %v", test.admin, test.service, got, test.allowed)
		}
	}
}

func TestSSHConnectionRejectsForgedFlagsAndAcceptsIPv6(t *testing.T) {
	for _, input := range []string{
		"192.0.2.1 65536 192.0.2.2 22",
		"192.0.2.1,host=inject 46022 192.0.2.2 22",
		"192.0.2.1 0 192.0.2.2 22",
		"192.0.2.1 46022 192.0.2.2 22 extra",
	} {
		if _, err := parseSSHSession(input); err == nil {
			t.Errorf("accepted unsupported connection %q", input)
		}
	}
	if _, err := parseSSHSession("2001:db8::1 46022 2001:db8::2 22"); err != nil {
		t.Fatal(err)
	}
}

func TestVMSelectsAnIndependentlyKnownEffectiveKey(t *testing.T) {
	_, public, err := newSSHIdentity()
	if err != nil {
		t.Fatal(err)
	}
	key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(public))
	if err != nil {
		t.Fatal(err)
	}
	vm := vmObservation{hostKeys: []ssh.PublicKey{key}}
	const host = "codexia-ssh.example.test"
	if _, err := vm.pinForFingerprint(host, "SHA256:wrong"); err == nil {
		t.Fatal("trusted a fingerprint before comparing it")
	}
	pin, err := vm.pinForFingerprint(host, ssh.FingerprintSHA256(key))
	if err != nil {
		t.Fatal(err)
	}
	if pin != host+" "+public {
		t.Fatalf("unexpected known_hosts line: %q", pin)
	}
	for _, invalid := range []string{"100.64.0.15", "codexia-ssh.example.test.", "codexia..example.test", "ssh.example.test:22"} {
		if _, err := vm.pinForFingerprint(invalid, ssh.FingerprintSHA256(key)); err == nil {
			t.Errorf("accepted a noncanonical management hostname %q", invalid)
		}
	}
}

type fingerprintOperator struct {
	acceptingOperator
	approve bool
	options []string
}

func (o *fingerprintOperator) Select(_ string, options []string) (int, error) {
	o.options = options
	return 1, nil
}

func (o *fingerprintOperator) Ask(string) (string, error) { return "", io.EOF }

func (o *fingerprintOperator) Confirm(question string) (bool, error) {
	return o.approve && strings.Contains(question, "independently verified"), nil
}

func TestVMRequiresIndependentApprovalOfTheSelectedFingerprint(t *testing.T) {
	var vm vmObservation
	for range 2 {
		private, public, err := newSSHIdentity()
		if err != nil {
			t.Fatal(err)
		}
		clear(private)
		key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(public))
		if err != nil {
			t.Fatal(err)
		}
		vm.hostKeys = append(vm.hostKeys, key)
	}
	vm.verifiedPin = new(string)
	operator := new(fingerprintOperator)
	if _, err := vm.confirmHostFingerprint(operator); err == nil || *vm.verifiedPin != "" {
		t.Fatalf("fingerprint was accepted without independent approval: %v", err)
	}
	operator.approve = true
	fingerprint, err := vm.confirmHostFingerprint(operator)
	want := ssh.FingerprintSHA256(vm.hostKeys[1])
	if err != nil || fingerprint != want || *vm.verifiedPin != want ||
		len(operator.options) != 2 || !strings.Contains(operator.options[1], want) {
		t.Fatalf("selected fingerprint = %q, approved fingerprint = %q, options = %v, error = %v",
			fingerprint, *vm.verifiedPin, operator.options, err)
	}
}

func TestExistingKnownHostsRecordsRetainTheirFormatting(t *testing.T) {
	_, public, err := newSSHIdentity()
	if err != nil {
		t.Fatal(err)
	}
	key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(public))
	if err != nil {
		t.Fatal(err)
	}
	vm := vmObservation{hostKeys: []ssh.PublicKey{key}}
	const host = "codexia-ssh.example.test"
	pin := "# retained comment\n" + host + " " + public + " VPS host key\n"
	if err := vm.verifyKnownHosts(host, pin); err != nil {
		t.Fatal(err)
	}
	if err := vm.verifyKnownHosts("codexia-other.example.test", pin); err == nil {
		t.Fatal("an unrelated host was accepted")
	}
	if err := vm.verifyKnownHosts(host, strings.Replace(pin, host+" ", host+",codexia-alt.example.test ", 1)); err == nil {
		t.Fatal("a shared host alias was accepted as a compatible pin")
	}
	if err := vm.verifyKnownHosts(host, pin+"@revoked "+host+" "+public+"\n"); err == nil {
		t.Fatal("a revoked pin was accepted")
	}
}

func TestBootstrapKeyInstalledOnlyReadsAuthorizedKeys(t *testing.T) {
	home := t.TempDir()
	vm := vmObservation{home: home, uid: os.Getuid(), authorizedFile: ".ssh/authorized_keys"}
	private, public, err := newSSHIdentity()
	if err != nil {
		t.Fatal(err)
	}
	clear(private)
	sshDir := filepath.Join(home, ".ssh")
	pin := filepath.Join(sshDir, "authorized_keys")
	if found, err := vm.BootstrapKeyInstalled(public); found || err != nil {
		t.Fatalf("missing .ssh = %v, %v", found, err)
	}
	if _, err := os.Lstat(sshDir); !os.IsNotExist(err) {
		t.Fatalf("bootstrap lookup created .ssh: %v", err)
	}
	if err := os.Mkdir(sshDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if found, err := vm.BootstrapKeyInstalled(public); found || err != nil {
		t.Fatalf("missing authorized_keys = %v, %v", found, err)
	}
	if _, err := os.Lstat(pin); !os.IsNotExist(err) {
		t.Fatalf("bootstrap lookup created authorized_keys: %v", err)
	}

	otherPrivate, otherPublic, err := newSSHIdentity()
	if err != nil {
		t.Fatal(err)
	}
	clear(otherPrivate)
	original := []byte("# existing entry\nrestrict " + otherPublic + "\n")
	if err := os.WriteFile(pin, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if found, err := vm.BootstrapKeyInstalled(public); found || err != nil {
		t.Fatalf("unrelated key = %v, %v", found, err)
	}
	if err := installAuthorizedKey(context.Background(), home, vm.authorizedFile, public, vm.uid); err != nil {
		t.Fatal(err)
	}
	if found, err := vm.BootstrapKeyInstalled(public); !found || err != nil {
		t.Fatalf("exact appended key = %v, %v", found, err)
	}
	actual, err := os.ReadFile(pin) //nolint:gosec // Compare the synthetic file under the test's temporary home.
	if err != nil || string(actual) != string(original)+"restrict "+public+" codexiactl-bootstrap\n" {
		t.Fatalf("lookup changed the existing bytes: %q, %v", actual, err)
	}
}

func TestBootstrapKeyInstalledRefusesUntrustedLocations(t *testing.T) {
	home := t.TempDir()
	vm := vmObservation{home: home, uid: os.Getuid(), authorizedFile: ".ssh/authorized_keys"}
	private, public, err := newSSHIdentity()
	if err != nil {
		t.Fatal(err)
	}
	clear(private)
	if err := os.Mkdir(filepath.Join(home, ".ssh"), 0o700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "authorized_keys")
	if err := os.WriteFile(outside, []byte(public), 0o600); err != nil {
		t.Fatal(err)
	}
	pin := filepath.Join(home, vm.authorizedFile)
	if err := os.Symlink(outside, pin); err != nil {
		t.Fatal(err)
	}
	if found, err := vm.BootstrapKeyInstalled(public); found || err == nil {
		t.Fatalf("symlinked key lookup = %v, %v", found, err)
	}
	if err := os.Remove(pin); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(outside, pin); err != nil {
		t.Fatal(err)
	}
	if found, err := vm.BootstrapKeyInstalled(public); found || err == nil {
		t.Fatalf("hard-linked key lookup = %v, %v", found, err)
	}
}
