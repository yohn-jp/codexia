package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const tailnetPackageRepository = "https://pkgs.tailscale.com/stable/ubuntu"

var tailscaleDeb = regexp.MustCompile(`^tailscale_[A-Za-z0-9.+%:~_-]+_amd64\.deb$`)

func installTailscalePackage(ctx context.Context) error {
	install, cancel := context.WithTimeout(ctx, 8*time.Minute)
	defer cancel()
	dir, err := os.MkdirTemp("", "codexiactl-tailscale-")
	if err != nil {
		return errors.New("could not create temporary Tailscale package verification storage")
	}
	defer os.RemoveAll(dir)

	keyring := filepath.Join(dir, "tailscale.gpg")
	if err := downloadTailscaleSigningKey(install, keyring); err != nil {
		return err
	}
	list := filepath.Join(dir, "tailscale.list")
	source := fmt.Sprintf("deb [arch=amd64 signed-by=%s] %s resolute main\n", keyring, tailnetPackageRepository)
	if err := os.WriteFile(list, []byte(source), 0o600); err != nil {
		return errors.New("could not prepare the temporary signed Tailscale APT source")
	}

	// Download in a separate APT state directory using only the HTTPS-acquired
	// Tailscale signing key. A different configured source cannot supply the
	// Tailscale package and the local APT sources remain intact.
	lists := filepath.Join(dir, "lists")
	if err := os.Mkdir(lists, 0o700); err != nil {
		return errors.New("could not prepare temporary APT metadata storage")
	}
	options := []string{
		"-o", "Dir::Etc::sourcelist=" + list,
		"-o", "Dir::Etc::sourceparts=-",
		"-o", "Dir::State::lists=" + lists,
		"-o", "Dir::Cache::pkgcache=",
		"-o", "Dir::Cache::srcpkgcache=",
		"-o", "Acquire::AllowInsecureRepositories=false",
		"-o", "Acquire::AllowDowngradeToInsecureRepositories=false",
		"-o", "Acquire::AllowWeakRepositories=false",
		"-o", "APT::Get::AllowUnauthenticated=false",
		"-o", "Acquire::https::AllowRedirect=false",
	}
	if err := runTailscaleAPT(install, dir, append(options, "update")...); err != nil {
		return errors.New("APT could not validate the official signed Tailscale repository for Ubuntu 26.04")
	}
	if err := runTailscaleAPT(install, dir, append(options, "download", "tailscale")...); err != nil {
		return errors.New("APT could not download and verify the official Tailscale package")
	}
	packagePath, err := downloadedTailscalePackage(dir)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(install, "/usr/bin/sudo", "-n", "/usr/bin/apt-get",
		"-o", "APT::Get::AllowUnauthenticated=false", "install", "-y", "--no-remove", "--no-upgrade", packagePath)
	if err := cmd.Run(); err != nil {
		return errors.New("could not install the signed Tailscale package without removing or upgrading existing packages")
	}
	if err := exec.CommandContext(install, "/usr/bin/sudo", "-n", "/usr/bin/systemctl", "start", "tailscaled.service").Run(); err != nil {
		return errors.New("Tailscale is installed but its daemon could not start")
	}
	return nil
}

func downloadTailscaleSigningKey(ctx context.Context, path string) error {
	client := &http.Client{
		Timeout: 20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("Tailscale package repository redirects are not accepted")
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, tailnetPackageRepository+"/resolute.noarmor.gpg", nil)
	if err != nil {
		return errors.New("could not prepare the Tailscale signing key request")
	}
	response, err := client.Do(req)
	if err != nil {
		return errors.New("could not reach the official Tailscale package signing key")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("the Tailscale package signing key returned HTTP %d", response.StatusCode)
	}
	const maxKeySize = 128 * 1024
	data, err := io.ReadAll(io.LimitReader(response.Body, maxKeySize+1))
	if err != nil || len(data) == 0 || len(data) > maxKeySize {
		return errors.New("the official Tailscale package signing key response was invalid")
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return errors.New("could not prepare the temporary Tailscale signing keyring")
	}
	return nil
}

func runTailscaleAPT(ctx context.Context, directory string, args ...string) error {
	cmd := exec.CommandContext(ctx, "/usr/bin/apt-get", args...)
	cmd.Dir = directory
	return cmd.Run()
}

func downloadedTailscalePackage(directory string) (string, error) {
	files, err := os.ReadDir(directory)
	if err != nil {
		return "", errors.New("could not inspect the verified Tailscale download")
	}
	var match string
	for _, entry := range files {
		if !strings.HasSuffix(entry.Name(), ".deb") {
			continue
		}
		if match != "" || !tailscaleDeb.MatchString(entry.Name()) || !entry.Type().IsRegular() {
			return "", errors.New("Tailscale package verification did not produce exactly one amd64 package")
		}
		match = entry.Name()
	}
	if match == "" {
		return "", errors.New("Tailscale package verification produced no amd64 package")
	}
	return filepath.Join(directory, match), nil
}
