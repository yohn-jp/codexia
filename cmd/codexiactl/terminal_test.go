package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func testPTY(t *testing.T) (*terminal, int) {
	t.Helper()
	master, err := unix.Open("/dev/ptmx", unix.O_RDWR|unix.O_NOCTTY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { unix.Close(master) })
	if err := unix.IoctlSetPointerInt(master, unix.TIOCSPTLCK, 0); err != nil {
		t.Fatal(err)
	}
	number, err := unix.IoctlGetInt(master, unix.TIOCGPTN)
	if err != nil {
		t.Fatal(err)
	}
	slave, err := unix.Open(fmt.Sprintf("/dev/pts/%d", number), unix.O_RDWR|unix.O_NOCTTY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	tty := &terminal{fd: slave, ctx: context.Background()}
	t.Cleanup(func() { tty.Close() })
	return tty, master
}

func waitForTTYPrompt(t *testing.T, master int) {
	t.Helper()
	status, err := unix.Poll([]unix.PollFd{{Fd: int32(master), Events: unix.POLLIN}}, 2_000)
	if err != nil || status != 1 {
		t.Fatalf("PTY did not receive prompt: %v", err)
	}
	var prompt [4096]byte
	if n, err := unix.Read(master, prompt[:]); err != nil || !bytes.Contains(prompt[:n], []byte("credential")) {
		t.Fatal("PTY did not receive the secret prompt")
	}
}

func TestTerminalSecretDoesNotEcho(t *testing.T) {
	tty, master := testPTY(t)
	type secretResult struct {
		secret []byte
		err    error
	}
	result := make(chan secretResult, 1)
	go func() {
		secret, err := tty.Secret("credential")
		result <- secretResult{secret, err}
	}()
	waitForTTYPrompt(t, master)
	if _, err := unix.Write(master, []byte("fixture-secret\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-result:
		if got.err != nil || !bytes.Equal(got.secret, []byte("fixture-secret")) {
			t.Fatalf("credential capture failed: %v", got.err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("TTY did not return hidden input")
	}
	var output [4096]byte
	if n, err := unix.Read(master, output[:]); err != nil || bytes.Contains(output[:n], []byte("fixture-secret")) {
		t.Fatal("credential was echoed")
	}
	info, err := unix.IoctlGetTermios(tty.fd, unix.TCGETS)
	if err != nil || info.Lflag&unix.ECHO == 0 {
		t.Fatal("TTY echo was not restored")
	}
}

func TestTerminalSecretInterruptionRestoresEcho(t *testing.T) {
	tty, master := testPTY(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tty.bindContext(ctx)
	result := make(chan error, 1)
	go func() {
		_, err := tty.Secret("credential")
		result <- err
	}()
	waitForTTYPrompt(t, master)
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("TTY did not honor cancellation")
	}
	info, err := unix.IoctlGetTermios(tty.fd, unix.TCGETS)
	if err != nil || info.Lflag&unix.ECHO == 0 {
		t.Fatal("TTY echo was not restored after cancellation")
	}
}
