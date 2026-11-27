package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"filippo.io/age"
)

func TestCheckpointRoundTripAndLock(t *testing.T) {
	home := t.TempDir()
	host := strings.Repeat("a", 64)
	store, err := openCheckpointAt(home, host)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := openCheckpointAt(home, host); !errors.Is(err, errCheckpointBusy) {
		t.Fatalf("concurrent access got %v", err)
	}
	if absent, err := store.Load(); err != nil || absent.HostID != "" {
		t.Fatalf("missing checkpoint = %+v, %v", absent, err)
	}
	previous := "false"
	delivery, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	saved := checkpoint{
		RepositoryID: 1450072993, HostID: host, MainSHA: strings.Repeat("b", 40),
		Operation: "r4", StartedAt: time.Date(2026, 11, 27, 1, 2, 3, 0, time.UTC), Pending: true, PreflightRunID: 43,
		GateOriginal:       map[string]*string{"CODEXIA_BOOTSTRAP_ENABLED": &previous, "CODEXIA_DATABASE_INITIALIZATION_APPROVED": nil},
		EphemeralRecipient: delivery.Recipient().String(),
		BootstrapKeyWrite:  "unresolved",
		SettingsWriterID:   strings.Repeat("d", 32),
	}
	if err := store.Save(saved); err != nil {
		t.Fatal(err)
	}
	saved.RunID = 387
	saved.Pending = false
	if err := store.Save(saved); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load()
	if err != nil || !reflect.DeepEqual(loaded, saved) {
		t.Fatalf("checkpoint reload = %+v, %v", loaded, err)
	}
	info, err := os.Stat(filepath.Join(home, ".codexiactl", host+".json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatal("checkpoint is not private")
	}
	saved.HostID = strings.Repeat("c", 64)
	if err := store.Save(saved); !errors.Is(err, errCheckpointUnsafe) {
		t.Fatalf("foreign checkpoint got %v", err)
	}
	saved.HostID, saved.BootstrapKeyWrite = host, "unknown"
	if err := store.Save(saved); !errors.Is(err, errCheckpointUnsafe) {
		t.Fatalf("invalid key-write state got %v", err)
	}
	saved.BootstrapKeyWrite, saved.SettingsWriterID = "registered", "short"
	if err := store.Save(saved); !errors.Is(err, errCheckpointUnsafe) {
		t.Fatalf("invalid protected-settings writer got %v", err)
	}
}

func TestCheckpointRejectsCorruptAndSymlinkedState(t *testing.T) {
	home := t.TempDir()
	host := strings.Repeat("a", 64)
	store, err := openCheckpointAt(home, host)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	checkpointPath := filepath.Join(home, ".codexiactl", host+".json")
	if err := os.WriteFile(checkpointPath, []byte(`{"repositoryId":123,"repositoryId":124}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(); !errors.Is(err, errCheckpointUnsafe) {
		t.Fatalf("corrupt state got %v", err)
	}
	if err := os.Remove(checkpointPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(home, "missing"), checkpointPath); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(); !errors.Is(err, errCheckpointUnsafe) {
		t.Fatalf("symlinked state got %v", err)
	}
}
