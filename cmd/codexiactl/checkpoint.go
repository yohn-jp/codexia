package main

import (
	"crypto/rand"
	json "encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/sys/unix"
)

const (
	privateStateDirectory = ".codexiactl"
	maxCheckpointSize     = 16 * 1024
)

var (
	errCheckpointBusy   = errors.New("another codexiactl init is running for this administrator and VM")
	errCheckpointUnsafe = errors.New("local checkpoint could not be verified; reobserve the target before continuing")
	checkpointHost      = regexp.MustCompile(`^[a-f0-9]{64}$`)
	checkpointSource    = regexp.MustCompile(`^[a-f0-9]{40}$`)
	settingsWriterID    = regexp.MustCompile(`^[a-f0-9]{32}$`)
	checkpointOperation = regexp.MustCompile(`^[a-z][a-z0-9-]{0,40}$`)
)

type checkpoint struct {
	RepositoryID          int64                           `json:"repositoryId"`
	Owner                 string                          `json:"owner"`
	OwnerID               int64                           `json:"ownerId"`
	InstallationID        int64                           `json:"installationId"`
	HostID                string                          `json:"hostId"`
	MainSHA               string                          `json:"mainSha"`
	Operation             string                          `json:"operation,omitempty"`
	StartedAt             time.Time                       `json:"startedAt,omitzero"`
	RunID                 int64                           `json:"runId,omitzero"`
	PreflightRunID        int64                           `json:"preflightRunId,omitzero"`
	Pending               bool                            `json:"pending,omitzero"`
	GateOriginal          map[string]*string              `json:"gateOriginal,omitempty"`
	BootstrapPublicKey    string                          `json:"bootstrapPublicKey,omitempty"`
	BootstrapKeyWrite     string                          `json:"bootstrapKeyWrite,omitempty"`
	SettingsWriterID      string                          `json:"settingsWriterId,omitempty"`
	CloudflareServiceAuth map[string]cfServiceAuthReceipt `json:"cloudflareServiceAuth,omitempty"`
	FrontendRunID         int64                           `json:"frontendRunId,omitzero"`
	FrontendTarget        string                          `json:"frontendTarget,omitempty"`
	OwnerSetupRunID       int64                           `json:"ownerSetupRunId,omitzero"`
	EphemeralRecipient    string                          `json:"ephemeralRecipient,omitempty"`
}

type checkpointDisk struct {
	Version int        `json:"version"`
	State   checkpoint `json:"state"`
}

type checkpointStore struct {
	dir    *os.File
	lock   *os.File
	hostID string
}

func administratorHome() (string, error) {
	current, err := user.LookupId(strconv.Itoa(os.Geteuid()))
	if err != nil || !filepath.IsAbs(current.HomeDir) || filepath.Clean(current.HomeDir) != current.HomeDir {
		return "", errors.New("cannot locate the administrator's private home directory")
	}
	return current.HomeDir, nil
}

func openPrivateStateDirectory(home string, create bool) (*os.File, error) {
	flags := unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	homeFD, err := unix.Open(home, flags, 0)
	if err != nil {
		return nil, errCheckpointUnsafe
	}
	defer func() { _ = unix.Close(homeFD) }()
	var info unix.Stat_t
	if err := unix.Fstat(homeFD, &info); err != nil || int(info.Uid) != os.Geteuid() || info.Mode&0o022 != 0 {
		return nil, errCheckpointUnsafe
	}
	if create {
		switch err := unix.Mkdirat(homeFD, privateStateDirectory, 0o700); {
		case err == nil:
			if err := unix.Fsync(homeFD); err != nil {
				return nil, errCheckpointUnsafe
			}
		case !errors.Is(err, unix.EEXIST):
			return nil, errCheckpointUnsafe
		}
	}
	dir, err := unix.Openat(homeFD, privateStateDirectory, flags, 0)
	if errors.Is(err, unix.ENOENT) && !create {
		return nil, err
	}
	if err != nil {
		return nil, errCheckpointUnsafe
	}
	if err := unix.Fstat(dir, &info); err != nil || int(info.Uid) != os.Geteuid() || info.Mode&0o7777 != 0o700 {
		_ = unix.Close(dir)
		return nil, errCheckpointUnsafe
	}
	return os.NewFile(uintptr(dir), privateStateDirectory), nil
}

func openCheckpoint(hostID string) (*checkpointStore, error) {
	home, err := administratorHome()
	if err != nil {
		return nil, err
	}
	return openCheckpointAt(home, hostID)
}

func openCheckpointAt(home, hostID string) (*checkpointStore, error) {
	if !checkpointHost.MatchString(hostID) {
		return nil, errCheckpointUnsafe
	}
	dir, err := openPrivateStateDirectory(home, true)
	if err != nil {
		return nil, err
	}
	lock, err := openStateFile(dir, hostID+".lock", unix.O_RDWR|unix.O_CREAT)
	if err != nil {
		_ = dir.Close()
		return nil, errCheckpointUnsafe
	}
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = lock.Close()
		_ = dir.Close()
		if errors.Is(err, unix.EWOULDBLOCK) {
			return nil, errCheckpointBusy
		}
		return nil, errCheckpointUnsafe
	}
	return &checkpointStore{dir: dir, lock: lock, hostID: hostID}, nil
}

func openStateFile(dir *os.File, name string, flags int) (*os.File, error) {
	fd, err := unix.Openat(int(dir.Fd()), name, flags|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0o600)
	if err != nil {
		return nil, err
	}
	var info unix.Stat_t
	if err := unix.Fstat(fd, &info); err != nil || info.Mode&unix.S_IFMT != unix.S_IFREG ||
		info.Mode&0o7777 != 0o600 || int(info.Uid) != os.Geteuid() || info.Nlink != 1 {
		_ = unix.Close(fd)
		return nil, errCheckpointUnsafe
	}
	return os.NewFile(uintptr(fd), name), nil
}

func readCheckpoint(hostID string) (checkpoint, error) {
	home, err := administratorHome()
	if err != nil {
		return checkpoint{}, err
	}
	dir, err := openPrivateStateDirectory(home, false)
	if errors.Is(err, unix.ENOENT) {
		return checkpoint{}, nil
	}
	if err != nil {
		return checkpoint{}, err
	}
	defer func() { _ = dir.Close() }()
	return loadCheckpoint(dir, hostID)
}

func (s *checkpointStore) Load() (checkpoint, error) {
	return loadCheckpoint(s.dir, s.hostID)
}

func loadCheckpoint(dir *os.File, hostID string) (checkpoint, error) {
	if !checkpointHost.MatchString(hostID) {
		return checkpoint{}, errCheckpointUnsafe
	}
	file, err := openStateFile(dir, hostID+".json", unix.O_RDONLY)
	if errors.Is(err, unix.ENOENT) {
		return checkpoint{}, nil
	}
	if err != nil {
		return checkpoint{}, errCheckpointUnsafe
	}
	defer func() { _ = file.Close() }()
	data, err := io.ReadAll(io.LimitReader(file, maxCheckpointSize+1))
	if err != nil || len(data) > maxCheckpointSize {
		return checkpoint{}, errCheckpointUnsafe
	}
	var disk checkpointDisk
	if err := json.Unmarshal(data, &disk, json.RejectUnknownMembers(true)); err != nil {
		return checkpoint{}, errCheckpointUnsafe
	}
	if disk.Version == 1 {
		return checkpoint{}, fmt.Errorf("%w: the previous checkpoint lacks owner and App installation identity. Retain it and reconcile its run and Settings evidence through the original repository's protected runbook", errCheckpointUnsafe)
	}
	if disk.Version != 2 || !disk.State.validFor(hostID) {
		return checkpoint{}, errCheckpointUnsafe
	}
	return disk.State, nil
}

func (s *checkpointStore) Save(value checkpoint) error {
	if !value.validFor(s.hostID) {
		return errCheckpointUnsafe
	}
	data, err := json.Marshal(checkpointDisk{Version: 2, State: value})
	if err != nil || len(data) > maxCheckpointSize {
		return errCheckpointUnsafe
	}
	tmp := ".checkpoint-" + rand.Text()
	if err := writeStateFile(s.dir, tmp, data); err != nil {
		return errCheckpointUnsafe
	}
	dirFD := int(s.dir.Fd())
	defer func() { _ = unix.Unlinkat(dirFD, tmp, 0) }()
	if err := unix.Renameat(dirFD, tmp, dirFD, s.hostID+".json"); err != nil {
		return errCheckpointUnsafe
	}
	if err := s.dir.Sync(); err != nil {
		return errCheckpointUnsafe
	}
	return nil
}

func writeStateFile(dir *os.File, name string, data []byte) error {
	file, err := openStateFile(dir, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	if err := errors.Join(writeErr, file.Sync(), file.Close()); err != nil {
		_ = unix.Unlinkat(int(dir.Fd()), name, 0)
		return err
	}
	return nil
}

func (s *checkpointStore) Close() error {
	return errors.Join(s.lock.Close(), s.dir.Close())
}

func (c checkpoint) validFor(hostID string) bool {
	if c.HostID != hostID || !c.target().valid() || !checkpointSource.MatchString(c.MainSHA) ||
		c.RunID < 0 || c.PreflightRunID < 0 || c.FrontendRunID < 0 || c.OwnerSetupRunID < 0 {
		return false
	}
	if c.Operation != "" && !checkpointOperation.MatchString(c.Operation) {
		return false
	}
	if (c.Pending || c.RunID != 0) && (c.Operation == "" || c.StartedAt.IsZero()) {
		return false
	}
	if c.FrontendTarget != "" && !checkpointHost.MatchString(c.FrontendTarget) {
		return false
	}
	if c.EphemeralRecipient != "" && !validAgeRecipient(c.EphemeralRecipient) {
		return false
	}
	if c.SettingsWriterID != "" && !settingsWriterID.MatchString(c.SettingsWriterID) {
		return false
	}
	switch c.BootstrapKeyWrite {
	case "", "prepared", "unresolved", "registered":
	default:
		return false
	}
	if c.BootstrapPublicKey != "" {
		key, comment, options, rest, err := ssh.ParseAuthorizedKey([]byte(c.BootstrapPublicKey))
		if err != nil || key.Type() != ssh.KeyAlgoED25519 || comment != "" || len(options) != 0 || len(rest) != 0 ||
			strings.TrimSuffix(string(ssh.MarshalAuthorizedKey(key)), "\n") != c.BootstrapPublicKey {
			return false
		}
	}
	for key, receipt := range c.CloudflareServiceAuth {
		environment, idInput, _ := strings.Cut(key, "/")
		if (environment != bootstrapEnvironment && environment != productionEnvironment) ||
			(idInput != sshAccessClientID && idInput != cloudflareProbeID) ||
			!cloudflareID.MatchString(receipt.AccountID) || !cloudflareID.MatchString(receipt.ZoneID) ||
			!cloudflareUUID.MatchString(receipt.TokenID) || receipt.StartedAt.IsZero() || c.SettingsWriterID == "" {
			return false
		}
	}
	for name, previous := range c.GateOriginal {
		if name != "CODEXIA_BOOTSTRAP_ENABLED" && name != "CODEXIA_DATABASE_INITIALIZATION_APPROVED" {
			return false
		}
		if previous != nil && *previous != "true" && *previous != "false" && *previous != "" {
			return false
		}
	}
	return true
}

func (c checkpoint) target() githubTarget {
	return githubTarget{Owner: c.Owner, OwnerID: c.OwnerID, RepoID: c.RepositoryID, InstallationID: c.InstallationID}
}

func (c checkpoint) matchesTarget(target githubTarget) bool {
	return target.valid() && c.target() == target
}

func (c *checkpoint) bindTarget(target githubTarget) {
	c.Owner, c.OwnerID, c.RepositoryID, c.InstallationID = target.Owner, target.OwnerID, target.RepoID, target.InstallationID
}
