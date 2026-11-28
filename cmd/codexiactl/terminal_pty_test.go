package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"charm.land/lipgloss/v2"
	"golang.org/x/sys/unix"
)

// This subprocess has an independently allocated controlling terminal on fd 3.
// Piped stdin/stdout/stderr therefore cannot accidentally stand in for /dev/tty.
func TestTerminalSessionHelper(t *testing.T) {
	scenario := os.Getenv("CODEXIACTL_TEST_TTY_SCENARIO")
	if scenario == "" {
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	if scenario == "status" {
		os.Exit(runCLI(ctx, []string{"status", "--json"}, os.Stdout, os.Stderr))
	}
	tty, err := openTerminal()
	if err != nil {
		t.Fatal(err)
	}
	defer tty.Close()
	tty.bindContext(ctx)
	switch scenario {
	case "confirm":
		err = requireApproval(tty, "Apply protected fixture?")
		// This marker stands for the protected side effect and must remain absent
		// when the operator declines or the terminal is disconnected.
		if err == nil {
			fmt.Print("approved")
		}
	case "select":
		options := []string{"official/codexia (repository ID 136)", "fork/codexia (repository ID 842)"}
		var choice int
		choice, err = selectOption(tty, "Select deployment repository", options)
		if err == nil {
			fmt.Print(options[choice])
		}
	case "ask":
		var value string
		value, err = tty.Ask("Enter an observed public identifier")
		if err == nil {
			fmt.Print(value)
		}
	case "private":
		if err := tty.PrivateNotice("Open the browser and enter the one-time code TTYC-1234."); err != nil {
			t.Fatal(err)
		}
		var credential []byte
		credential, err = tty.Secret("Enter the fixture credential")
		if err == nil && !bytes.Equal(credential, []byte("fixture-credential")) {
			t.Fatal("credential was not read from the controlling TTY")
		}
		clear(credential)
		if err == nil {
			err = tty.writeGrant([]byte("fixture-owner-grant"))
		}
	case "notice":
		tty.Notice("Target: codexia\x1b[2J\x07\r\u009b; 状態の確認 VM scoped-repository-identity")
	}
	code := reportError(ctx, os.Stderr, err)
	if code != 0 {
		os.Exit(code)
	}
	os.Exit(0)
}

type terminalSession struct {
	cmd            *exec.Cmd
	master, slave  int
	output         []byte
	stdout, stderr bytes.Buffer
}

func startTerminalSession(t *testing.T, scenario, terminalType string, cols uint16, noColor bool) *terminalSession {
	t.Helper()
	slave, master := testPTY(t)
	s := &terminalSession{master: master, slave: slave.fd}
	s.resize(t, cols)
	file, err := os.OpenFile(fmt.Sprintf("/proc/self/fd/%d", slave.fd), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	s.cmd = exec.CommandContext(ctx, os.Args[0], "-test.run=^TestTerminalSessionHelper$")
	s.cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 3}
	s.cmd.ExtraFiles = []*os.File{file}
	s.cmd.Env = slices.DeleteFunc(os.Environ(), func(entry string) bool {
		return strings.HasPrefix(entry, "NO_COLOR=")
	})
	s.cmd.Env = append(s.cmd.Env, "CODEXIACTL_TEST_TTY_SCENARIO="+scenario, "TERM="+terminalType, "SSH_CONNECTION=")
	if noColor {
		s.cmd.Env = append(s.cmd.Env, "NO_COLOR=")
	}
	s.cmd.Stdin = strings.NewReader("yes\n2\nfixture-incorrect-stdin\n")
	s.cmd.Stdout, s.cmd.Stderr = &s.stdout, &s.stderr
	if err := s.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = s.cmd.Process.Kill()
		if s.cmd.ProcessState == nil {
			_ = s.cmd.Wait()
		}
	})
	return s
}

func (s *terminalSession) resize(t *testing.T, cols uint16) {
	t.Helper()
	if err := unix.IoctlSetWinsize(s.master, unix.TIOCSWINSZ, &unix.Winsize{Col: cols, Row: 24}); err != nil {
		t.Fatal(err)
	}
}

func (s *terminalSession) send(t *testing.T, value string) {
	t.Helper()
	if n, err := unix.Write(s.master, []byte(value)); err != nil || n != len(value) {
		t.Fatalf("write to PTY: %d, %v", n, err)
	}
}

func (s *terminalSession) readTTY(t *testing.T) {
	t.Helper()
	var buffer [4096]byte
	for {
		n, err := unix.Read(s.master, buffer[:])
		if n > 0 {
			s.output = append(s.output, buffer[:n]...)
		}
		switch {
		case errors.Is(err, unix.EINTR):
			continue
		case errors.Is(err, unix.EAGAIN), errors.Is(err, unix.EIO), n == 0:
			return
		case err != nil:
			t.Fatal(err)
		}
	}
}

func (s *terminalSession) waitFor(t *testing.T, value string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		s.readTTY(t)
		if bytes.Contains(s.output, []byte(value)) {
			return
		}
		_, err := unix.Poll([]unix.PollFd{{Fd: int32(s.master), Events: unix.POLLIN}}, 50)
		if err != nil && !errors.Is(err, unix.EINTR) {
			t.Fatal(err)
		}
	}
	t.Fatalf("PTY output did not contain %q: %q", value, s.output)
}

func (s *terminalSession) finish(t *testing.T) int {
	t.Helper()
	err := s.cmd.Wait()
	s.readTTY(t)
	var exited *exec.ExitError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &exited) && exited.ExitCode() >= 0:
		return exited.ExitCode()
	default:
		t.Fatalf("subprocess failed: %v (stdout=%q, stderr=%q, tty=%q)", err, &s.stdout, &s.stderr, s.output)
		return -1
	}
}

func (s *terminalSession) checkRestored(t *testing.T) {
	t.Helper()
	mode, err := unix.IoctlGetTermios(s.slave, unix.TCGETS)
	if err != nil || mode.Lflag&(unix.ECHO|unix.ICANON|unix.ISIG) != unix.ECHO|unix.ICANON|unix.ISIG {
		t.Fatalf("terminal modes were not restored: %v (%v)", mode, err)
	}
	if bytes.Contains(s.output, []byte("\x1b[?25l")) && !bytes.Contains(s.output, []byte("\x1b[?25h")) {
		t.Fatal("terminal cursor remained hidden")
	}
}

func TestTerminalProtectedApprovalRequiresExplicitTTYInput(t *testing.T) {
	for _, test := range []struct {
		name, input string
		accepted    bool
	}{
		{name: "empty", input: "\n"},
		{name: "invalid", input: "perhaps\n"},
		{name: "no", input: "no\n"},
		{name: "EOF", input: "\x04"},
		{name: "yes", input: "yes\n", accepted: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := startTerminalSession(t, "confirm", "dumb", 40, false)
			s.waitFor(t, "[y/N]")
			s.send(t, test.input)
			if code := s.finish(t); (code == 0) != test.accepted || (s.stdout.String() == "approved") != test.accepted {
				t.Fatalf("approval delivered through the wrong path: exit=%d, stdout=%q, stderr=%q", code, &s.stdout, &s.stderr)
			}
			s.checkRestored(t)
		})
	}
}

func TestTerminalSelectReturnsObservedCandidate(t *testing.T) {
	t.Run("Huh uses the controlling TTY and survives resize", func(t *testing.T) {
		s := startTerminalSession(t, "select", "xterm-256color", 40, false)
		s.waitFor(t, "Select deployment repository")
		s.resize(t, 80)
		s.send(t, "\x1b[B\x1b[B\r")
		if code := s.finish(t); code != 0 || !strings.HasPrefix(s.stdout.String(), "fork/codexia") {
			t.Fatalf("selected wrong repository: exit=%d, stdout=%q, stderr=%q, tty=%q", code, &s.stdout, &s.stderr, s.output)
		}
		s.checkRestored(t)
	})
	t.Run("plain line mode accepts the same candidates", func(t *testing.T) {
		s := startTerminalSession(t, "select", "dumb", 40, true)
		s.waitFor(t, "fork/codexia")
		s.send(t, "2\n")
		if code := s.finish(t); code != 0 || !strings.HasPrefix(s.stdout.String(), "fork/codexia") || bytes.Contains(s.output, []byte("\x1b")) {
			t.Fatalf("line selection failed: exit=%d, stdout=%q, stderr=%q, tty=%q", code, &s.stdout, &s.stderr, s.output)
		}
	})
}

func TestTerminalSignalsCancelAnUnsubmittedSelection(t *testing.T) {
	for _, test := range []struct {
		name   string
		signal syscall.Signal
	}{
		{name: "Ctrl+C"},
		{name: "SIGTERM", signal: syscall.SIGTERM},
		{name: "SIGHUP", signal: syscall.SIGHUP},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := startTerminalSession(t, "select", "xterm-256color", 80, false)
			s.waitFor(t, "Select deployment repository")
			if test.signal == 0 {
				s.send(t, "\x03")
			} else if err := s.cmd.Process.Signal(test.signal); err != nil {
				t.Fatal(err)
			}
			if code := s.finish(t); code != 130 || s.stdout.Len() != 0 {
				t.Fatalf("selection was not interrupted: exit=%d, stdout=%q, stderr=%q, tty=%q", code, &s.stdout, &s.stderr, s.output)
			}
			s.checkRestored(t)
		})
	}
}

func TestTerminalPublicInputHonorsNoColor(t *testing.T) {
	s := startTerminalSession(t, "ask", "xterm-256color", 80, true)
	s.waitFor(t, "Enter an observed public identifier")
	s.send(t, "public-fixture\r")
	if code := s.finish(t); code != 0 || s.stdout.String() != "public-fixture" {
		t.Fatalf("public form input failed: exit=%d, stdout=%q, stderr=%q", code, &s.stdout, &s.stderr)
	}
	// The xterm-256color form may emit cursor and decoration controls.
	// Foreground/background SGR controls are forbidden with NO_COLOR present.
	if regexp.MustCompile(`\x1b\[[0-9;:]*(38|48)[;:]`).Match(s.output) {
		t.Fatalf("NO_COLOR still emitted form colors: %q", s.output)
	}
	s.checkRestored(t)
}

func TestTerminalUnsubmittedSelectionNeverDefaultsToRepository(t *testing.T) {
	for _, test := range []struct {
		name, term, input, prompt string
	}{
		{name: "Huh default", term: "xterm-256color", input: "\r", prompt: "Select deployment repository"},
		{name: "Huh escape", term: "xterm-256color", input: "\x1b", prompt: "Select deployment repository"},
		{name: "Huh EOF", term: "xterm-256color", input: "\x04", prompt: "Select deployment repository"},
		{name: "line invalid", term: "dumb", input: "99\n", prompt: "Enter an option number"},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := startTerminalSession(t, "select", test.term, 80, true)
			s.waitFor(t, test.prompt)
			s.send(t, test.input)
			if code := s.finish(t); code == 0 || s.stdout.Len() != 0 {
				t.Fatalf("implicitly selected a repository: exit=%d, stdout=%q, stderr=%q, tty=%q", code, &s.stdout, &s.stderr, s.output)
			}
			s.checkRestored(t)
		})
	}
}

func TestTerminalPrivateOutputStaysOffRedirectedStreams(t *testing.T) {
	s := startTerminalSession(t, "private", "xterm-256color", 80, true)
	s.waitFor(t, "Enter the fixture credential")
	s.send(t, "fixture-credential\n")
	if code := s.finish(t); code != 0 || s.stdout.Len() != 0 || s.stderr.Len() != 0 {
		t.Fatalf("private output reached redirected streams: exit=%d, stdout=%q, stderr=%q", code, &s.stdout, &s.stderr)
	}
	for _, want := range []string{"TTYC-1234", "fixture-owner-grant"} {
		if bytes.Count(s.output, []byte(want)) != 1 {
			t.Fatalf("expected one TTY display of fixture %q: %q", want, s.output)
		}
	}
	if bytes.Contains(s.output, []byte("fixture-credential")) || bytes.Contains(s.output, []byte("\x1b")) {
		t.Fatalf("echo or color was enabled: %q", s.output)
	}
	s.checkRestored(t)
}

func TestTerminalNoticeSanitizesControlsAndWraps(t *testing.T) {
	s := startTerminalSession(t, "notice", "dumb", 40, true)
	if code := s.finish(t); code != 0 || s.stdout.Len() != 0 || s.stderr.Len() != 0 {
		t.Fatalf("notice did not stay on the TTY: exit=%d, stdout=%q, stderr=%q", code, &s.stdout, &s.stderr)
	}
	joined := bytes.ReplaceAll(s.output, []byte("\r\n"), nil)
	if bytes.ContainsAny(s.output, "\x1b\x07\u009b") || !bytes.Contains(joined, []byte("状態の確認")) || !bytes.Contains(joined, []byte("scoped-repository-identity")) {
		t.Fatalf("notice was lost or contained terminal controls: %q", s.output)
	}
	for line := range strings.SplitSeq(string(s.output), "\r\n") {
		if width := lipgloss.Width(line); width > 40 {
			t.Fatalf("notice line used %d columns in a 40-column PTY: %q", width, line)
		}
	}
}

func TestTerminalRedirectedJSONIsOnePlainDocument(t *testing.T) {
	s := startTerminalSession(t, "status", "xterm-256color", 80, false)
	if code := s.finish(t); code == 0 {
		t.Fatal("status succeeded without observing the target")
	}
	var report statusReport
	decoder := json.NewDecoder(&s.stdout)
	if err := decoder.Decode(&report); err != nil || report.SchemaVersion != 1 || report.Active != "unknown" || report.Accepted != "unknown" || len(report.Blockers) == 0 {
		t.Fatalf("missing plain failure report: %v, %+v", err, report)
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		t.Fatalf("redirected stdout contained additional output: %v", err)
	}
	if len(s.output) != 0 || s.stderr.Len() == 0 {
		t.Fatalf("unexpected diagnostic streams: tty=%q stderr=%q", s.output, &s.stderr)
	}
}
