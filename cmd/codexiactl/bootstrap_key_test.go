package main

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type keyControlFixture struct {
	puts int
	err  error
}

func (f *keyControlFixture) PutSecret(context.Context, string, string, []byte) error {
	f.puts++
	return f.err
}

type keyHostFixture struct {
	installed  bool
	installing []string
}

func (f *keyHostFixture) BootstrapKeyInstalled(string) (bool, error) { return f.installed, nil }

func (f *keyHostFixture) InstallBootstrapKey(_ context.Context, public string) error {
	f.installing = append(f.installing, public)
	return nil
}

func TestBootstrapSSHKeyRecoversAtRegistrationEntry(t *testing.T) {
	private, public, err := newSSHIdentity()
	if err != nil {
		t.Fatal(err)
	}
	clear(private)
	for _, tc := range []struct {
		name        string
		phase       string
		present     bool
		installed   bool
		putError    error
		wantPut     int
		wantInstall int
		wantError   bool
		wantKeep    bool
		reuseKey    bool
	}{
		{name: "interrupted before sending", phase: "prepared", wantPut: 1, wantInstall: 1},
		{name: "service clearly refused the PUT", putError: errors.New("GitHub denied this request with HTTP 403"), wantPut: 1, wantError: true},
		{name: "lost response before restart", putError: errGitHubSecretWriteUnknown, wantPut: 1, wantError: true, wantKeep: true},
		{name: "lost response with confirmed registered Secret", phase: "unresolved", present: true, wantInstall: 1, reuseKey: true},
		{name: "unresolved write with confirmed absence", phase: "unresolved", wantPut: 1, wantInstall: 1},
		{name: "new external Secret while key had not been sent", phase: "prepared", present: true},
		{name: "existing installed key with missing Secret", phase: "registered", installed: true, wantError: true, wantKeep: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &memoryCheckpoint{}
			host := &keyHostFixture{installed: tc.installed}
			gh := &keyControlFixture{err: tc.putError}
			c := workflowController{github: &fakeWorkflow{}, store: store, operator: acceptingOperator{}, sha: strings.Repeat("a", 40)}
			if tc.phase != "" {
				c.state.BootstrapPublicKey, c.state.BootstrapKeyWrite = public, tc.phase
				c.state.SettingsWriterID = strings.Repeat("a", 32)
			}
			err := c.registerBootstrapKey(context.Background(), gh, host, tc.present)
			if (err != nil) != tc.wantError || gh.puts != tc.wantPut || len(host.installing) != tc.wantInstall {
				t.Fatalf("error %v, PUTs %d, local installs %d", err, gh.puts, len(host.installing))
			}
			if got := c.state.BootstrapPublicKey != ""; got != tc.wantKeep {
				t.Fatalf("unexpected retained checkpoint: %v", got)
			}
			if tc.reuseKey && host.installing[0] != public {
				t.Fatal("a confirmed upload was paired with a different key")
			}
		})
	}
}
