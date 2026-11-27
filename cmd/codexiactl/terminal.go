package main

import (
	"context"
	"errors"
	"io"
	"strings"
	"unicode"

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
		unix.Close(fd)
		return nil, errors.New("an interactive SSH terminal is required")
	}
	return &terminal{fd: fd, ctx: context.Background()}, nil
}

func (t *terminal) bindContext(ctx context.Context) { t.ctx = ctx }

func (t *terminal) Close() error { return unix.Close(t.fd) }

func (t *terminal) Notice(message string) {
	_ = t.write([]byte(safeTerminalText(message) + "\n"))
}

func (t *terminal) Ask(prompt string) (string, error) {
	if err := t.write([]byte(safeTerminalText(prompt) + " ")); err != nil {
		return "", err
	}
	line, err := t.readLine()
	return strings.TrimSpace(string(line)), err
}

func (t *terminal) Confirm(prompt string) (bool, error) {
	answer, err := t.Ask(prompt + " [y/N]")
	return strings.EqualFold(answer, "y") || strings.EqualFold(answer, "yes"), err
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
	if err := t.write([]byte(safeTerminalText(prompt) + " ")); err != nil {
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

func safeTerminalText(text string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return -1
		}
		return r
	}, text)
}

func (t *terminal) wait(events int16) error {
	fds := []unix.PollFd{{Fd: int32(t.fd), Events: events}}
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
