package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json/jsontext"
	json "encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os/exec"
	"os/user"
	"regexp"
	"strconv"
	"strings"
	"time"

	"filippo.io/age"
	"golang.org/x/sys/unix"
)

const maxEnvelopeSize = 16 * 1024
const maxGrantPayloadSize = 4 * 1024
const ownerRecoveryRunbook = "https://github.com/yohn-jp/codexia/blob/main/deploy/ansible/AUTH-RUNTIME.md#first-owner-through-the-browser"

var (
	errHandoffUnavailable  = errors.New("the live Owner Setup Grant and its recipient binding could not be verified. Follow the independently approved reissue procedure if the grant or its binding is unavailable. " + ownerRecoveryRunbook)
	errHandoffNeedsConsent = errors.New("Owner handoff requires an independently verified recipient or explicit same-Owner VM trust")
	ownerBackendImage      = regexp.MustCompile(`^ghcr\.io/yohn-jp/codexia-backend@sha256:[a-f0-9]{64}$`)
	ownerGrantKey          = regexp.MustCompile(`^"[A-Za-z0-9_-]{43}"$`)
)

type ownerHandoff struct {
	Recipient       string
	BackendImage    string
	GrantBindingSHA string
	identity        *age.X25519Identity
	displayed       bool
}

func (h *ownerHandoff) Ephemeral() bool { return h.identity != nil || h.displayed }

func validAgeRecipient(recipient string) bool {
	key, err := age.ParseX25519Recipient(recipient)
	return err == nil && key.String() == recipient
}

func chooseHandoff(o operator, existingRecipient string) (*ownerHandoff, error) {
	recipient := existingRecipient
	if recipient == "" {
		method, err := o.Ask("Owner handoff method [owner/key-on-vm] (owner):")
		if err != nil {
			return nil, err
		}
		switch method {
		case "", "owner":
			recipient, err = o.Ask("Enter the Owner's independently verified age public recipient:")
			if err != nil {
				return nil, err
			}
		case "key-on-vm":
			approved, err := o.Confirm("I am the Owner and trust this VM and terminal for one private grant display. If interrupted, this temporary decryption key cannot be recovered. Continue?")
			if err != nil {
				return nil, err
			}
			if !approved {
				return nil, errHandoffNeedsConsent
			}
			identity, err := age.GenerateX25519Identity()
			if err != nil {
				return nil, errors.New("could not generate an in-memory age identity")
			}
			return &ownerHandoff{Recipient: identity.Recipient().String(), identity: identity}, nil
		default:
			return nil, errHandoffNeedsConsent
		}
	}
	if !validAgeRecipient(recipient) {
		return nil, errors.New("the configured Owner age recipient is invalid")
	}
	approved, err := o.Confirm("I independently verified the Owner controls the private key for " + recipient + ". Deliver to this recipient?")
	if err != nil {
		return nil, err
	}
	if !approved {
		if existingRecipient != "" {
			o.Notice("The registered recipient is kept. If the private key was lost or the grant expired, use the independently approved reissue procedure. " + ownerRecoveryRunbook)
		}
		return nil, errHandoffNeedsConsent
	}
	return &ownerHandoff{Recipient: recipient}, nil
}

func (h *ownerHandoff) Deliver(ctx context.Context, o operator, origin string, serviceUID int) error {
	location, err := url.Parse(origin)
	if err != nil || location.Scheme != "https" || location.Hostname() == "" || location.User != nil ||
		location.Path != "" || location.RawQuery != "" || location.ForceQuery || location.Fragment != "" ||
		location.String() != origin {
		return errHandoffUnavailable
	}
	if !ownerBackendImage.MatchString(h.BackendImage) || !checkpointHost.MatchString(h.GrantBindingSHA) ||
		!validAgeRecipient(h.Recipient) || h.displayed {
		return errHandoffUnavailable
	}
	envelope, err := readOwnerEnvelope(ctx, h.BackendImage, h.Recipient, h.GrantBindingSHA, serviceUID)
	if err != nil {
		return err
	}
	setupURL := origin + "/console/setup"
	o.Notice("Owner registration is available at " + setupURL + " on the trusted browser. Complete Cloudflare Access authentication if prompted.")
	if h.identity != nil {
		return h.showGrant(o, setupURL, envelope, time.Now())
	}
	home, err := administratorHome()
	if err != nil {
		return err
	}
	name, err := saveOwnerEnvelope(home, envelope)
	if err != nil {
		return err
	}
	o.Notice("Encrypted handoff ready at ~/" + privateStateDirectory + "/" + name + " on this VM. Copy the file through the pinned SSH connection or another approved private operator channel. The Owner decrypts it on their own device, confirms the setup URL above and pastes the key into the form. Remove the operator's copy after successful delivery.")
	return nil
}

func readOwnerEnvelope(ctx context.Context, image, recipient, grantBinding string, serviceUID int) ([]byte, error) {
	const serviceName = "codexia"
	const serviceHome = "/home/codexia"
	account, err := user.Lookup(serviceName)
	uid := strconv.Itoa(serviceUID)
	if serviceUID <= 0 || err != nil || account.Username != serviceName || account.Uid != uid || account.HomeDir != serviceHome {
		return nil, errHandoffUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	runtime := "/run/user/" + uid
	cmd := exec.CommandContext(ctx, "/usr/bin/sudo", "-n", "-H", "-u", serviceName, "--", "/usr/bin/env",
		"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "XDG_RUNTIME_DIR="+runtime, "DBUS_SESSION_BUS_ADDRESS=unix:path="+runtime+"/bus",
		serviceHome+"/.local/bin/codexia-owner-setup", "--export-handoff", image, recipient, grantBinding)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C"}
	cmd.Stderr = io.Discard
	pipe, err := cmd.StdoutPipe()
	if err != nil || cmd.Start() != nil {
		return nil, errHandoffUnavailable
	}
	raw, readErr := io.ReadAll(io.LimitReader(pipe, maxEnvelopeSize+1))
	// Closing the pipe also bounds failure if the process writes more than the limit.
	_ = pipe.Close()
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if readErr != nil || waitErr != nil || len(raw) == 0 || len(raw) > maxEnvelopeSize {
		return nil, errHandoffUnavailable
	}
	return raw, nil
}

// Use age's parser and X25519 Unwrap. The canonical operator emits a single
// X25519 stanza for the independently reviewed recipient.
type ownerAgeIdentity struct{ *age.X25519Identity }

func (i ownerAgeIdentity) Unwrap(stanzas []*age.Stanza) ([]byte, error) {
	if len(stanzas) != 1 || stanzas[0].Type != "X25519" {
		return nil, errHandoffUnavailable
	}
	return i.X25519Identity.Unwrap(stanzas)
}

func (h *ownerHandoff) showGrant(o operator, setupURL string, envelope []byte, now time.Time) error {
	if h.displayed || h.identity == nil || h.identity.Recipient().String() != h.Recipient {
		return errHandoffUnavailable
	}
	terminal, ok := o.(interface{ writeGrant([]byte) error })
	if !ok {
		return errHandoffUnavailable
	}
	reader, err := age.Decrypt(bytes.NewReader(envelope), ownerAgeIdentity{h.identity})
	if err != nil {
		return errHandoffUnavailable
	}
	raw, err := io.ReadAll(io.LimitReader(reader, maxGrantPayloadSize+1))
	defer clear(raw)
	if err != nil || len(raw) > maxGrantPayloadSize {
		return errHandoffUnavailable
	}
	var payload struct {
		SetupURL  string         `json:"setupUrl"`
		Key       jsontext.Value `json:"key"`
		ExpiresAt time.Time      `json:"expiresAt"`
	}
	err = json.Unmarshal(raw, &payload, json.RejectUnknownMembers(true))
	defer clear(payload.Key)
	if err != nil || payload.SetupURL != setupURL || !ownerGrantKey.Match(payload.Key) ||
		!payload.ExpiresAt.After(now) || payload.ExpiresAt.After(now.Add(24*time.Hour+time.Minute)) {
		return errHandoffUnavailable
	}
	o.Notice("Copy the following key directly into the Owner setup form. It expires at " + payload.ExpiresAt.UTC().Format(time.RFC3339) + ".")
	h.displayed, h.identity = true, nil
	return terminal.writeGrant(payload.Key[1 : len(payload.Key)-1])
}

func saveOwnerEnvelope(home string, envelope []byte) (string, error) {
	if len(envelope) == 0 || len(envelope) > maxEnvelopeSize {
		return "", errHandoffUnavailable
	}
	testIdentity, err := age.GenerateX25519Identity()
	if err != nil {
		return "", errHandoffUnavailable
	}
	// The locked host exporter has already bound these bytes to the live grant and
	// approved recipient. The age parser checks the format without the Owner's key.
	_, err = age.Decrypt(bytes.NewReader(envelope), ownerAgeIdentity{testIdentity})
	var noMatch *age.NoIdentityMatchError
	if !errors.As(err, &noMatch) {
		return "", errHandoffUnavailable
	}
	directory, err := openPrivateStateDirectory(home)
	if err != nil {
		return "", err
	}
	defer directory.Close()
	name := "owner-setup-" + strings.ToLower(rand.Text()) + ".age"
	const message = "could not stage the encrypted handoff in the administrator's private directory"
	if err := writeStateFile(directory, name, envelope); err != nil {
		return "", errors.New(message)
	}
	if err := directory.Sync(); err != nil {
		if cleanupErr := unix.Unlinkat(int(directory.Fd()), name, 0); cleanupErr != nil {
			return "", fmt.Errorf("%s. Inspect ~/%s/%s", message, privateStateDirectory, name)
		}
		return "", errors.New(message)
	}
	return name, nil
}
