package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/sys/unix"
	"golang.org/x/term"
)

// The controlling terminal is separate from both machine output and stdin.
type terminal struct {
	fd  int
	ctx context.Context
}

func openTerminal() (*terminal, error) {
	fd, err := unix.Open("/dev/tty", unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOCTTY|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, errors.New("an interactive SSH terminal is required")
	}
	if !term.IsTerminal(fd) {
		_ = unix.Close(fd)
		return nil, errors.New("an interactive SSH terminal is required")
	}
	return &terminal{fd: fd, ctx: context.Background()}, nil
}

func (t *terminal) bindContext(ctx context.Context) { t.ctx = ctx }

func (t *terminal) Close() error { return unix.Close(t.fd) }

func (t *terminal) Stage(step int, message string) {
	t.print(headingText, fmt.Sprintf("\n%02d  %s\n    %s", step, stageNames[step-1], message))
}

func (t *terminal) Notice(message string) {
	t.print(bodyText, message)
}

func (t *terminal) Result(role textRole, message string) {
	t.print(role, message)
}

func (t *terminal) ConfirmChoice(prompt string) (bool, error) {
	if !supportsForms(t.fd) {
		return t.Confirm(prompt)
	}
	if err := unix.IoctlSetInt(t.fd, unix.TCFLSH, unix.TCIFLUSH); err != nil {
		return false, errors.New("cannot clear pending SSH terminal input before confirmation")
	}
	choice, err := t.Select(prompt, []string{"Continue"})
	return err == nil && choice == 0, err
}

func (t *terminal) print(role textRole, message string) {
	width, _, _ := term.GetSize(t.fd)
	_ = t.write([]byte(terminalLine(t.displayRole(role), width, message) + "\n"))
}

func (t *terminal) displayRole(role textRole) textRole {
	if _, noColor := os.LookupEnv("NO_COLOR"); noColor || !supportsForms(t.fd) {
		return bodyText
	}
	return role
}

func (t *terminal) PrivateNotice(message string) error {
	return t.write([]byte(safeTerminalText(message) + "\n"))
}

func (t *terminal) askLine(prompt string) (string, error) {
	width, _, _ := term.GetSize(t.fd)
	if err := t.write([]byte(terminalLine(t.displayRole(headingText), width, prompt) + " ")); err != nil {
		return "", err
	}
	line, err := t.readLine()
	return strings.TrimSpace(string(line)), err
}

func (t *terminal) Confirm(prompt string) (bool, error) {
	// Discard input queued before the operator could see this request.
	if err := unix.IoctlSetInt(t.fd, unix.TCFLSH, unix.TCIFLUSH); err != nil {
		return false, errors.New("cannot clear pending SSH terminal input before approval")
	}
	answer, err := t.askLine(prompt + " [y/N]")
	if err != nil {
		return false, err
	}
	return strings.EqualFold(answer, "y") || strings.EqualFold(answer, "yes"), t.ctx.Err()
}

func (t *terminal) Secret(prompt string) ([]byte, error) {
	saved, err := term.GetState(t.fd)
	if err != nil {
		return nil, errors.New("cannot read private terminal settings")
	}
	settings, err := unix.IoctlGetTermios(t.fd, unix.TCGETS)
	if err != nil {
		return nil, errors.New("cannot read private terminal settings")
	}
	// Keep canonical editing and signal delivery, but disable all input echo.
	settings.Lflag &^= unix.ECHO | unix.ECHONL
	if err := unix.IoctlSetTermios(t.fd, unix.TCSETSF, settings); err != nil {
		return nil, errors.New("cannot disable terminal echo")
	}
	defer func() {
		_ = term.Restore(t.fd, saved)
		_ = t.write([]byte("\n"))
	}()
	width, _, _ := term.GetSize(t.fd)
	if err := t.write([]byte(terminalLine(bodyText, width, prompt) + " ")); err != nil {
		return nil, err
	}
	return t.readLine()
}

func (t *terminal) writeGrant(grant []byte) error {
	if err := t.write([]byte("Owner Setup Grant (paste only into the browser form):\n")); err != nil {
		return err
	}
	if err := t.write(grant); err != nil {
		return err
	}
	return t.write([]byte("\n"))
}

func (t *terminal) wait(events int16) error {
	fds := []unix.PollFd{{Fd: int32(t.fd), Events: events}} //nolint:gosec // The descriptor is a Linux signed int returned by open(2).
	for {
		if err := t.ctx.Err(); err != nil {
			return err
		}
		_, err := unix.Poll(fds, 100)
		if err != nil && !errors.Is(err, unix.EINTR) {
			return errors.New("interactive SSH terminal is unavailable")
		}
		if fds[0].Revents&events != 0 {
			return t.ctx.Err()
		}
		if fds[0].Revents&(unix.POLLHUP|unix.POLLERR|unix.POLLNVAL) != 0 {
			return io.EOF
		}
	}
}

func (t *terminal) readLine() ([]byte, error) {
	// Stay below Linux canonical TTY's line limit so truncation can't pass.
	const maxLine = 4094
	var next [1]byte
	line := make([]byte, 0, maxLine)
	for {
		if err := t.wait(unix.POLLIN); err != nil {
			clear(line)
			return nil, err
		}
		n, err := unix.Read(t.fd, next[:])
		switch {
		case errors.Is(err, unix.EAGAIN), errors.Is(err, unix.EINTR):
			continue
		case err != nil || n == 0:
			clear(line)
			return nil, io.EOF
		case next[0] == '\n' || next[0] == '\r':
			return line, nil
		case len(line) == maxLine:
			clear(line)
			return nil, errors.New("interactive input is too long")
		default:
			line = append(line, next[0])
		}
	}
}

func (t *terminal) write(data []byte) error {
	for len(data) != 0 {
		if err := t.wait(unix.POLLOUT); err != nil {
			return err
		}
		n, err := unix.Write(t.fd, data)
		switch {
		case errors.Is(err, unix.EAGAIN), errors.Is(err, unix.EINTR):
			continue
		case err != nil || n <= 0:
			return errors.New("cannot write to the interactive SSH terminal")
		default:
			data = data[n:]
		}
	}
	return nil
}
