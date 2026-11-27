package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/sys/unix"
)

const serviceUID = 1001
const maxAuthorizedKeys = 1024 * 1024

var unixUsername = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
var machineIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var tailnetIPv4 = netip.MustParsePrefix("100.64.0.0/10")
var tailnetIPv6 = netip.MustParsePrefix("fd7a:115c:a1e0::/48")

type vmObservation struct {
	User            string
	HostID          string
	HostFingerprint string
	CodexiaPresent  bool
	ObservedAt      time.Time
	Clock           string
	home            string
	uid             int
	connection      sshSession
	hostKeys        []ssh.PublicKey
	authorizedFile  string
	verifiedPin     *string
}

type sshSession struct {
	peer, local netip.Addr
	localPort   uint16
}

func parseSSHSession(connection string) (sshSession, error) {
	parts := strings.Fields(connection)
	if len(parts) != 4 {
		return sshSession{}, refused("run codexiactl from the independently authenticated SSH session on the target VM")
	}
	peer, peerErr := netip.ParseAddr(parts[0])
	local, localErr := netip.ParseAddr(parts[2])
	peerPort, ppErr := strconv.ParseUint(parts[1], 10, 16)
	localPort, lpErr := strconv.ParseUint(parts[3], 10, 16)
	if peerErr != nil || localErr != nil || ppErr != nil || lpErr != nil ||
		peer.Zone() != "" || local.Zone() != "" || peerPort == 0 || localPort == 0 {
		return sshSession{}, refused("unsupported SSH connection identity")
	}
	return sshSession{peer.Unmap(), local.Unmap(), uint16(localPort)}, nil
}

func observeVM(ctx context.Context) (vmObservation, error) {
	vm := vmObservation{ObservedAt: time.Now().UTC(), Clock: "unknown", uid: os.Getuid(), verifiedPin: new(string)}
	if vm.uid == 0 || vm.uid == serviceUID || vm.uid != os.Geteuid() {
		return vm, refused("use an independent non-root SSH administrator, distinct from the Codexia service account")
	}
	account, err := user.LookupId(strconv.Itoa(vm.uid))
	if err != nil || !unixUsername.MatchString(account.Username) ||
		account.Username == "codexia" || account.Username == "root" || !filepath.IsAbs(account.HomeDir) {
		return vm, errors.New("cannot identify the independent local SSH administrator")
	}
	vm.User, vm.home = account.Username, account.HomeDir
	vm.connection, err = parseSSHSession(os.Getenv("SSH_CONNECTION"))
	if err != nil {
		return vm, err
	}
	osRelease, err := os.ReadFile("/etc/os-release")
	if err != nil || !isUbuntu2604(osRelease) {
		return vm, refused("the initial deployment VM must run Ubuntu 26.04 x86-64")
	}
	var machine unix.Utsname
	if err := unix.Uname(&machine); err != nil || unix.ByteSliceToString(machine.Machine[:]) != "x86_64" {
		return vm, refused("the initial deployment VM must run Ubuntu 26.04 x86-64")
	}
	machineID, err := os.ReadFile("/etc/machine-id")
	machineID = bytes.TrimSpace(machineID)
	if err != nil || !machineIDPattern.Match(machineID) || len(bytes.Trim(machineID, "0")) == 0 {
		return vm, errors.New("cannot establish the VM identity from /etc/machine-id")
	}
	hash := sha256.Sum256(machineID)
	vm.HostID = hex.EncodeToString(hash[:])
	vm.CodexiaPresent = hasLocalCodexiaResources()
	if status, err := commandOutput(ctx, "/usr/bin/timedatectl", "show", "--property=NTPSynchronized", "--value"); err == nil {
		switch strings.TrimSpace(string(status)) {
		case "yes":
			vm.Clock = "synchronized"
		case "no":
			vm.Clock = "unsynchronized"
		}
	}

	const sudo = "/usr/bin/sudo"
	if _, err := commandOutput(ctx, sudo, "-n", "/usr/bin/true"); err != nil {
		return vm, needsAction("the independent SSH administrator needs working noninteractive sudo")
	}
	config, err := effectiveSSHConfig(ctx, vm)
	if err != nil {
		return vm, err
	}
	if !slices.Contains(config["port"], "22") ||
		!slices.Contains(config["pubkeyauthentication"], "yes") {
		return vm, needsAction("effective OpenSSH configuration must support public-key authentication and TCP/22 for the protected runner")
	}

	vm.hostKeys, err = effectiveHostKeys(ctx, config["hostkey"])
	if err != nil {
		return vm, err
	}
	vm.HostFingerprint = ssh.FingerprintSHA256(vm.hostKeys[0])
	vm.authorizedFile = supportedAuthorizedKeys(config["authorizedkeysfile"], vm.home)
	return vm, nil
}

func isUbuntu2604(release []byte) bool {
	values := make(map[string]string)
	for _, line := range strings.Split(string(release), "\n") {
		key, value, found := strings.Cut(line, "=")
		if found {
			values[key] = strings.Trim(value, "`'\"")
		}
	}
	return values["ID"] == "ubuntu" && values["VERSION_ID"] == "26.04"
}

func hasLocalCodexiaResources() bool {
	if _, err := user.Lookup("codexia"); err == nil {
		return true
	}
	for _, path := range []string{"/home/codexia", "/etc/containers/systemd/users/" + strconv.Itoa(serviceUID)} {
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			return true
		}
	}
	return false
}

func effectiveSSHConfig(ctx context.Context, vm vmObservation) (map[string][]string, error) {
	connection := fmt.Sprintf("user=%s,addr=%s,host=%s,laddr=%s,lport=%d", vm.User,
		vm.connection.peer, vm.connection.peer, vm.connection.local, vm.connection.localPort)
	output, err := commandOutput(ctx, "/usr/bin/sudo", "-n", "/usr/sbin/sshd", "-T", "-C", connection)
	if err != nil {
		return nil, errors.New("cannot inspect effective OpenSSH configuration using sudo -n sshd -T")
	}
	config := make(map[string][]string)
	for _, line := range strings.Split(string(output), "\n") {
		key, value, found := strings.Cut(line, " ")
		if found {
			config[key] = append(config[key], strings.TrimSpace(value))
		}
	}
	return config, nil
}

func effectiveHostKeys(ctx context.Context, paths []string) ([]ssh.PublicKey, error) {
	var keys []ssh.PublicKey
	for _, path := range paths {
		if !filepath.IsAbs(path) {
			return nil, errors.New("OpenSSH reported an unsupported host key path")
		}
		// ssh-keygen reads the configured private file and emits its public half.
		// A separate .pub file can be stale after a host key rotation.
		output, err := commandOutput(ctx, "/usr/bin/sudo", "-n", "/usr/bin/ssh-keygen", "-y", "-P", "", "-f", path)
		if err != nil {
			continue // sshd -T can list configured key paths that do not exist.
		}
		key, _, _, rest, err := ssh.ParseAuthorizedKey(output)
		if err == nil && len(bytes.TrimSpace(rest)) == 0 {
			keys = append(keys, key)
		}
	}
	if len(keys) == 0 {
		return nil, errors.New("cannot read the public half of an effective OpenSSH host key")
	}
	sort.SliceStable(keys, func(i, j int) bool {
		return keys[i].Type() == ssh.KeyAlgoED25519 && keys[j].Type() != ssh.KeyAlgoED25519
	})
	return keys, nil
}

func supportedAuthorizedKeys(config []string, home string) string {
	for _, setting := range config {
		for _, path := range strings.Fields(setting) {
			switch path {
			case ".ssh/authorized_keys", "%h/.ssh/authorized_keys", filepath.Join(home, ".ssh/authorized_keys"):
				return ".ssh/authorized_keys"
			}
		}
	}
	return ""
}

func commandOutput(ctx context.Context, path string, args ...string) ([]byte, error) {
	bounded, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return exec.CommandContext(bounded, path, args...).Output()
}

func (vm vmObservation) ConfirmPin(o operator, address string) (string, error) {
	fingerprint, err := vm.confirmHostFingerprint(o)
	if err != nil {
		return "", err
	}
	return vm.pinForFingerprint(address, fingerprint)
}

func (vm vmObservation) confirmHostFingerprint(o operator) (string, error) {
	if vm.verifiedPin != nil && *vm.verifiedPin != "" {
		return *vm.verifiedPin, nil
	}
	for _, key := range vm.hostKeys {
		o.Notice(fmt.Sprintf("Effective VM OpenSSH host key %s %s", key.Type(), ssh.FingerprintSHA256(key)))
	}
	fingerprint, err := o.Ask("Enter the SHA256 host fingerprint independently verified on your SSH client or VM provider console.")
	if err != nil {
		return "", err
	}
	fingerprint = strings.TrimSpace(fingerprint)
	for _, key := range vm.hostKeys {
		if ssh.FingerprintSHA256(key) == fingerprint {
			if vm.verifiedPin != nil {
				*vm.verifiedPin = fingerprint
			}
			return fingerprint, nil
		}
	}
	return "", refused("independently verified fingerprint does not match an effective VM OpenSSH host key")
}

func (vm vmObservation) pinForFingerprint(address, fingerprint string) (string, error) {
	ip, err := netip.ParseAddr(address)
	if err != nil || !isTailnetAddress(ip) {
		return "", errors.New("the OpenSSH pin requires an observed Tailscale VM address")
	}
	for _, key := range vm.hostKeys {
		if ssh.FingerprintSHA256(key) == fingerprint {
			return ip.String() + " " + strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))), nil
		}
	}
	return "", refused("independently verified fingerprint does not match an effective VM OpenSSH host key")
}

// verifyKnownHosts checks existing literal pins without rewriting their entries.
func (vm vmObservation) verifyKnownHosts(host, pins string) error {
	matched := false
	remaining := []byte(pins)
	for len(remaining) > 0 {
		marker, hosts, key, _, rest, err := ssh.ParseKnownHosts(remaining)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil || len(remaining) <= len(rest) {
			return errors.New("the existing protected SSH pin is malformed")
		}
		remaining = rest
		if !slices.ContainsFunc(hosts, func(pattern string) bool { return strings.EqualFold(pattern, host) }) {
			continue
		}
		localKey := slices.ContainsFunc(vm.hostKeys, func(local ssh.PublicKey) bool {
			return bytes.Equal(local.Marshal(), key.Marshal())
		})
		if marker != "" || !localKey {
			return errors.New("an existing protected SSH pin for this host differs from the effective VM identity")
		}
		matched = true
	}
	if !matched {
		return errors.New("no existing protected SSH pin binds the observed VM address to an effective host key")
	}
	return nil
}

func isTailnetAddress(ip netip.Addr) bool {
	return ip.Zone() == "" && (tailnetIPv4.Contains(ip) || tailnetIPv6.Contains(ip))
}

func newSSHIdentity() ([]byte, string, error) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, "", errors.New("generate Ed25519 deployment identity")
	}
	defer clear(private)
	key, err := ssh.NewPublicKey(public)
	if err != nil {
		return nil, "", errors.New("encode Ed25519 public deployment identity")
	}
	block, err := ssh.MarshalPrivateKey(private, "codexiactl")
	if err != nil {
		return nil, "", errors.New("encode OpenSSH private deployment identity")
	}
	defer clear(block.Bytes)
	return pem.EncodeToMemory(block), strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))), nil
}

func (vm vmObservation) InstallBootstrapKey(ctx context.Context, public string) error {
	config, err := effectiveSSHConfig(ctx, vm)
	if err != nil {
		return err
	}
	path := supportedAuthorizedKeys(config["authorizedkeysfile"], vm.home)
	if path == "" || path != vm.authorizedFile {
		return errors.New("effective OpenSSH AuthorizedKeysFile is not the observed administrator-owned .ssh/authorized_keys; review the SSH policy before retrying")
	}
	return installAuthorizedKey(ctx, vm.home, path, public, vm.uid)
}

func installAuthorizedKey(ctx context.Context, home, path, public string, uid int) error {
	key, _, options, rest, err := ssh.ParseAuthorizedKey([]byte(public))
	normalized := ""
	if err == nil {
		normalized = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
	}
	if err != nil || key.Type() != ssh.KeyAlgoED25519 || len(options) != 0 ||
		len(bytes.TrimSpace(rest)) != 0 || public != normalized || path != ".ssh/authorized_keys" {
		return errors.New("bootstrap requires one OpenSSH Ed25519 public key and the administrator's authorized_keys")
	}

	homeFD, err := openOwnedDirectory(unix.AT_FDCWD, home, uid)
	if err != nil {
		return errors.New("the administrator home must be owned by the administrator and have secure directory permissions")
	}
	defer unix.Close(homeFD)
	dirFD, err := openOwnedDirectory(homeFD, ".ssh", uid)
	if errors.Is(err, unix.ENOENT) {
		if err := unix.Mkdirat(homeFD, ".ssh", 0o700); err != nil && !errors.Is(err, unix.EEXIST) {
			return errors.New("cannot create the administrator .ssh directory")
		}
		dirFD, err = openOwnedDirectory(homeFD, ".ssh", uid)
	}
	if err != nil {
		return errors.New("administrator .ssh must be a real, securely owned directory")
	}
	defer unix.Close(dirFD)

	fd, err := unix.Openat(dirFD, "authorized_keys", unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK|unix.O_APPEND|unix.O_RDWR|unix.O_CREAT, 0o600)
	if err != nil {
		return errors.New("cannot safely open the administrator's authorized_keys")
	}
	file := os.NewFile(uintptr(fd), "authorized_keys")
	defer file.Close()
	if err := lockAuthorizedKeys(ctx, fd); err != nil {
		return err
	}
	var info unix.Stat_t
	if err := unix.Fstat(fd, &info); err != nil || info.Mode&unix.S_IFMT != unix.S_IFREG ||
		int(info.Uid) != uid || info.Mode&0o022 != 0 || info.Nlink != 1 {
		return errors.New("authorized_keys must be a securely owned regular file without additional links")
	}

	original, err := io.ReadAll(io.LimitReader(file, maxAuthorizedKeys+1))
	if err != nil || len(original) > maxAuthorizedKeys {
		return errors.New("cannot safely inspect the existing authorized_keys")
	}
	if keyExists(original, key) {
		return nil
	}
	entry := "restrict " + normalized + " codexiactl-bootstrap\n"
	if len(original) != 0 && original[len(original)-1] != '\n' {
		entry = "\n" + entry
	}
	if _, err := file.WriteString(entry); err != nil {
		return errors.New("could not append the bootstrap public key; inspect authorized_keys before retrying")
	}
	if err := file.Sync(); err != nil {
		return errors.New("could not sync the public key append; inspect authorized_keys before retrying")
	}
	return nil
}

func openOwnedDirectory(parent int, path string, uid int) (int, error) {
	fd, err := unix.Openat(parent, path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return -1, err
	}
	var info unix.Stat_t
	if err := unix.Fstat(fd, &info); err != nil || int(info.Uid) != uid || info.Mode&0o022 != 0 {
		unix.Close(fd)
		return -1, errors.New("unsafe SSH directory permissions or ownership")
	}
	return fd, nil
}

func lockAuthorizedKeys(ctx context.Context, fd int) error {
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) {
			return errors.New("cannot lock the administrator's authorized_keys")
		}
		select {
		case <-wait.Done():
			return errors.New("another operation is using the administrator's authorized_keys")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func keyExists(content []byte, wanted ssh.PublicKey) bool {
	for line := range bytes.SplitSeq(content, []byte{'\n'}) {
		key, _, _, _, err := ssh.ParseAuthorizedKey(line)
		if err == nil && bytes.Equal(key.Marshal(), wanted.Marshal()) {
			return true
		}
	}
	return false
}
