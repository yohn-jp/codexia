package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"
	"strconv"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/huh/v2"
	"golang.org/x/sys/unix"
	"golang.org/x/term"
)

var errTerminalInterrupt = errors.New("operator interrupted interactive input")

// Select returns an index into the supplied, observed options. A blank
// submission never selects a candidate.
func selectOption(o operator, title string, labels []string) (int, error) {
	if picker, ok := o.(interface {
		Select(string, []string) (int, error)
	}); ok {
		return picker.Select(title, labels)
	}
	return selectLine(o, title, labels, o.Ask)
}

func selectLine(o operator, title string, labels []string, ask func(string) (string, error)) (int, error) {
	o.Notice(title)
	for i, label := range labels {
		o.Notice(fmt.Sprintf("%d. %s", i+1, label))
	}
	answer, err := ask("Enter an option number, or press Enter to cancel:")
	if err != nil {
		return -1, err
	}
	if answer == "" {
		return -1, needsAction("Selection canceled. Rerun the command to choose an option.")
	}
	n, err := strconv.Atoi(answer)
	if err != nil || n < 1 || n > len(labels) {
		return -1, refused("Invalid selection. Rerun the command and choose a displayed option.")
	}
	return n - 1, nil
}

func (t *terminal) Select(title string, labels []string) (int, error) {
	if !supportsForms(t.fd) {
		return selectLine(t, title, labels, t.askLine)
	}
	options := []huh.Option[int]{huh.NewOption("Cancel", -1)}
	for i, label := range labels {
		options = append(options, huh.NewOption(safeTerminalText(label), i))
	}
	value := -1
	field := huh.NewSelect[int]().
		Title(safeTerminalText(title)).
		Description("Use Up/Down to choose and Enter to submit. Esc cancels.").
		Options(options...).
		Filtering(false).
		Value(&value)
	if err := t.runForm(field); err != nil {
		return -1, err
	}
	if value < 0 || value >= len(labels) {
		return -1, needsAction("Selection canceled. Rerun the command to choose an option.")
	}
	return value, nil
}

func (t *terminal) Ask(prompt string) (string, error) {
	if !supportsForms(t.fd) {
		return t.askLine(prompt)
	}
	var value string
	field := huh.NewInput().Title(safeTerminalText(prompt)).CharLimit(512).Value(&value)
	if err := t.runForm(field); err != nil {
		return "", err
	}
	return strings.TrimSpace(value), nil
}

func supportsForms(fd int) bool {
	terminalType := os.Getenv("TERM")
	switch terminalType {
	case "", "dumb", "unknown", "cons25":
		return false
	}
	width, height, err := term.GetSize(fd)
	return err == nil && width >= 20 && height >= 5
}

// Huh consumes background reports but does not request one for input and
// selection. Request it while Huh owns the terminal and handles its reply.
type backgroundAwareField struct{ huh.Field }

func (f backgroundAwareField) Focus() tea.Cmd {
	return tea.Batch(f.Field.Focus(), tea.RequestBackgroundColor)
}

func (t *terminal) runForm(field huh.Field) error {
	if err := t.ctx.Err(); err != nil {
		return err
	}
	file, err := os.OpenFile("/dev/tty", os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		return needsAction("Could not open the controlling SSH terminal for the form. Reconnect with a PTY and rerun the command.")
	}
	defer func() { _ = file.Close() }()
	var canceledBy string
	keys := huh.NewDefaultKeyMap()
	keys.Quit.SetKeys("ctrl+c", "ctrl+d", "esc")
	// Huh owns form input. Capture the abort reason without adding a second
	// input reader or letting Bubble Tea install a competing signal handler.
	// Bubble Tea v2.0.2 handles an explicit RequestWindowSize by starting
	// checkResize in a goroutine, concurrently with its SIGWINCH listener.
	// Both write Program.width/height without synchronization. Huh sends
	// that request during Init. Resolve it on the event loop using the
	// controlling TTY instead; automatic SIGWINCH WindowSizeMsg delivery
	// remains intact. Identify the private request type via the public
	// command, not a hard-coded type name or a dependency fork.
	windowSizeRequest := reflect.TypeOf(tea.RequestWindowSize())
	filter := tea.WithFilter(func(_ tea.Model, msg tea.Msg) tea.Msg {
		if reflect.TypeOf(msg) == windowSizeRequest {
			width, height, err := term.GetSize(int(file.Fd()))
			if err != nil {
				// Bubble Tea already supplies the initial and subsequent
				// automatic size events. Do not invent dimensions.
				return nil
			}
			return tea.WindowSizeMsg{Width: width, Height: height}
		}
		if key, ok := msg.(tea.KeyPressMsg); ok {
			switch key.String() {
			case "ctrl+c", "ctrl+d", "esc":
				canceledBy = key.String()
			}
		}
		return msg
	})
	program := []tea.ProgramOption{tea.WithoutSignalHandler(), filter}
	if _, noColor := os.LookupEnv("NO_COLOR"); noColor {
		env := os.Environ()
		// Normalize presence for the renderer, which parses NO_COLOR as a bool.
		for i, entry := range env {
			if strings.HasPrefix(entry, "NO_COLOR=") {
				env[i] = "NO_COLOR=1"
				break
			}
		}
		program = append(program, tea.WithEnvironment(env))
	} else {
		field = backgroundAwareField{field}
	}
	form := huh.NewForm(huh.NewGroup(field)).
		WithProgramOptions(program...).
		WithInput(file).
		WithOutput(file).
		WithTheme(huh.ThemeFunc(formTheme)).
		WithKeyMap(keys).
		WithShowHelp(false)
	err = form.RunWithContext(t.ctx)
	switch {
	case t.ctx.Err() != nil:
		return t.ctx.Err()
	case canceledBy == "ctrl+c":
		return errTerminalInterrupt
	case canceledBy == "ctrl+d":
		return io.EOF
	case errors.Is(err, huh.ErrUserAborted):
		return needsAction("Input canceled. Rerun the command to continue.")
	case err != nil, form.State != huh.StateCompleted:
		return needsAction("The terminal form did not complete. Reconnect with a PTY, or rerun with TERM=dumb for line input.")
	default:
		return nil
	}
}

func privateNotice(o operator, message string) error {
	if dst, ok := o.(interface{ PrivateNotice(string) error }); ok {
		return dst.PrivateNotice(message)
	}
	return needsAction("This operation requires a private controlling SSH terminal.")
}

// Routine read-only confirmation may use the observed-choice form. Protected
// write approval continues through requireApproval and the explicit line input.
func requireConfirmation(o operator, prompt string) error {
	if choice, ok := o.(interface{ ConfirmChoice(string) (bool, error) }); ok {
		accepted, err := choice.ConfirmChoice(prompt)
		if err != nil {
			return err
		}
		if !accepted {
			return needsAction("Confirmation declined")
		}
		return nil
	}
	return requireApproval(o, prompt)
}
