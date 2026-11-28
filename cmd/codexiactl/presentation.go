package main

import (
	"fmt"
	"io"
	"os"
	"strings"
	"unicode"

	"charm.land/huh/v2"
	"charm.land/lipgloss/v2"
	"golang.org/x/term"
)

type textRole int

const (
	bodyText textRole = iota
	headingText
	detailText
	warningText
	errorText
	successText
)

func terminalStyle(role textRole, dark bool) lipgloss.Style {
	style := lipgloss.NewStyle()
	palette := lipgloss.LightDark(dark)
	switch role {
	case headingText:
		return style.Bold(true).Foreground(palette(lipgloss.Color("#254D68"), lipgloss.Color("#A9CDE4")))
	case detailText:
		return style.Foreground(palette(lipgloss.Color("#4E5C68"), lipgloss.Color("#A9B7C3")))
	case warningText:
		return style.Bold(true).Foreground(palette(lipgloss.Color("#76470F"), lipgloss.Color("#E8BA7D")))
	case errorText:
		return style.Bold(true).Foreground(palette(lipgloss.Color("#922E35"), lipgloss.Color("#FFABA8")))
	default:
		return style
	}
}

func formTheme(dark bool) *huh.Styles {
	theme := huh.ThemeBase(dark)
	theme.Focused.Base = lipgloss.NewStyle()
	theme.Focused.Title = terminalStyle(headingText, dark)
	theme.Focused.Description = terminalStyle(detailText, dark)
	theme.Focused.SelectSelector = terminalStyle(headingText, dark).SetString("> ")
	theme.Focused.SelectedOption = terminalStyle(headingText, dark)
	theme.Focused.ErrorMessage = terminalStyle(errorText, dark)
	theme.Focused.TextInput.Placeholder = terminalStyle(detailText, dark)
	return theme
}

// Preserve intentional multi-line guidance. Remove control characters and
// invisible formatting controls before applying any trusted styles.
func safeTerminalText(message string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r == '\n':
			return r
		case r == '\t':
			return ' '
		case unicode.IsControl(r), unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp):
			return -1
		default:
			return r
		}
	}, message)
}

func terminalLine(role textRole, width int, message string) string {
	message = safeTerminalText(message)
	if width > 0 {
		message = lipgloss.Wrap(message, width, "/.-")
	}
	// Without a background report, leave color choice to the terminal palette.
	switch role {
	case headingText:
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Cyan).Render(message)
	case successText:
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Green).Render(message)
	case warningText:
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Yellow).Render(message)
	case errorText:
		return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Red).Render(message)
	default:
		return message
	}
}

func printTerminalLine(w io.Writer, role textRole, message string) {
	if f, ok := w.(*os.File); ok && term.IsTerminal(int(f.Fd())) && supportsForms(int(f.Fd())) {
		width, _, _ := term.GetSize(int(f.Fd()))
		if _, noColor := os.LookupEnv("NO_COLOR"); !noColor {
			_, _ = fmt.Fprintln(w, terminalLine(role, width, message))
			return
		}
		_, _ = fmt.Fprintln(w, terminalLine(bodyText, width, message))
		return
	}
	_, _ = fmt.Fprintln(w, safeTerminalText(message))
}

var stageNames = [...]string{
	"VM", "GitHub App and repository", "Cloudflare Device Flow", "Management SSH host pin", "Protected inputs",
	"Management SSH and certified candidates", "R4 Bootstrap", "R5 Frontend",
	"R5 Owner setup", "Handoff",
}

// reportResult assigns presentation semantics at the observed result, not by
// parsing provider messages. Plain operators retain the same textual evidence.
func reportResult(o operator, role textRole, message string) {
	switch role {
	case successText:
		message = "OK | " + message
	case warningText:
		message = "BLOCKED | " + message
	case errorText:
		message = "ERROR | " + message
	}
	if presentation, ok := o.(interface{ Result(textRole, string) }); ok {
		presentation.Result(role, message)
		return
	}
	o.Notice(message)
}
