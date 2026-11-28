package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	cfCLIVersion         = "1.0.0-rc.6"
	cfNodeVersion        = "24.22.3"
	cfNodeArchiveURL     = "https://nodejs.org/dist/v" + cfNodeVersion + "/node-v" + cfNodeVersion + "-linux-x64.tar.gz"
	cfNodeArchiveSHA256  = "061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2"
	cfNPMManifestSHA256  = "d856977aca90a1171da81d82e1ade3b5c64408753aebdfe78bedfd4f04412419"
	cfNPMLockSHA256      = "2cf88a4e7124b76d324401d68db1bb88c595f31beae1359a4e8c854cf52933ca"
	cfNPMPackageSRI      = "sha512-w/L+DmEPrcOVJ9TrqtVJiZ2htnx+/fctGlDMrUZhuuEJSxayfc9QuEk2k3yaeXHPZIF5srovQLFxwB3YfVuwig=="
	cfNodeArchiveMax     = 96 << 20
	cfExtractedMax       = 256 << 20
	cfCommandOutputMax   = 16 << 20
	cfCLIRuntimeTimeout  = 8 * time.Minute
	cfCLICallTimeout     = 2 * time.Minute
	cfDeviceLoginTimeout = 20 * time.Minute
)

var cfNPMIntegrity = regexp.MustCompile(`^sha512-[A-Za-z0-9+/]{86}==$`)

// The lock file is generated from Cloudflare's public cf package and pins all
// direct and transitive npm artifacts. It is verified before npm can install.
//
//go:embed assets/cf-runtime/package.json assets/cf-runtime/package-lock.json
var cfRuntimeAssets embed.FS

type cfPackageLock struct {
	Name            string `json:"name"`
	LockfileVersion int    `json:"lockfileVersion"`
	Packages        map[string]struct {
		Version      string            `json:"version"`
		Resolved     string            `json:"resolved"`
		Integrity    string            `json:"integrity"`
		Dependencies map[string]string `json:"dependencies"`
	} `json:"packages"`
}

type cfPackageManifest struct {
	Name         string            `json:"name"`
	Version      string            `json:"version"`
	Private      bool              `json:"private"`
	Dependencies map[string]string `json:"dependencies"`
}

type cfRuntime struct {
	root, workDir string
	node, cli     string
	baseEnv       []string
	accountID     string
	loggedIn      bool
}

func (runtime *cfRuntime) commandEnv() []string {
	env := append([]string(nil), runtime.baseEnv...)
	if runtime.accountID != "" {
		env = append(env, "CLOUDFLARE_ACCOUNT_ID="+runtime.accountID)
	}
	return env
}

func (runtime *cfRuntime) setAccount(accountID string) error {
	if accountID != "" && !cloudflareID.MatchString(accountID) {
		return errors.New("Cloudflare account identity is invalid")
	}
	runtime.accountID = accountID
	return nil
}

func (runtime *cfRuntime) run(ctx context.Context, args ...string) ([]byte, error) {
	if runtime == nil || runtime.node == "" || runtime.cli == "" {
		return nil, errors.New("official Cloudflare CLI runtime is unavailable")
	}
	bounded, cancel := context.WithTimeout(ctx, cfCLICallTimeout)
	defer cancel()
	commandArgs := append([]string{runtime.cli}, args...)
	command := exec.CommandContext(bounded, runtime.node, commandArgs...)
	command.Dir = runtime.workDir
	command.Env = runtime.commandEnv()
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err != nil {
		if bounded.Err() != nil {
			return nil, bounded.Err()
		}
		return nil, cloudflareCLIError(stderr.Bytes())
	}
	if stdout.Len() > cfCommandOutputMax || stderr.Len() > cfCommandOutputMax {
		return nil, errors.New("Cloudflare returned an oversized command result")
	}
	return bytes.Clone(stdout.Bytes()), nil
}

func cloudflareCLIError(stderr []byte) error {
	// Provider errors can contain resource URLs and request data. Never return
	// raw CLI output to the operator or a structured report.
	text := strings.ToLower(string(stderr))
	switch {
	case strings.Contains(text, "http 401"), strings.Contains(text, "http 403"), strings.Contains(text, "unauthorized"), strings.Contains(text, "forbidden"):
		return needsAction("Cloudflare rejected the requested operation. Verify the selected account and the exact cf scope required for this operation")
	case strings.Contains(text, "timed out"), strings.Contains(text, "timeout"):
		return errors.New("Cloudflare did not complete the requested operation before its deadline")
	default:
		return errors.New("Cloudflare cf could not complete or verify the requested operation")
	}
}

func prepareCloudflareRuntime(ctx context.Context) (*cfRuntime, error) {
	if err := verifyCFPackageAssets(); err != nil {
		return nil, err
	}
	root, err := os.MkdirTemp("", "codexiactl-cf-")
	if err != nil {
		return nil, errors.New("could not create an isolated Cloudflare CLI runtime")
	}
	if err := os.Chmod(root, 0700); err != nil {
		_ = os.RemoveAll(root)
		return nil, errors.New("could not protect the isolated Cloudflare CLI runtime")
	}
	cleanup := func(err error) (*cfRuntime, error) {
		_ = os.RemoveAll(root)
		return nil, err
	}
	for _, name := range []string{"home", "config", "cache", "data", "state", "work", "npm-cache"} {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			return cleanup(errors.New("could not create isolated Cloudflare CLI state"))
		}
	}
	for _, name := range []string{"npmrc", "global-npmrc"} {
		if err := os.WriteFile(filepath.Join(root, name), nil, 0600); err != nil {
			return cleanup(errors.New("could not isolate Cloudflare CLI package-manager settings"))
		}
	}
	archive, err := downloadCloudflareNode(ctx)
	if err != nil {
		return cleanup(err)
	}
	defer clear(archive)
	nodeRoot := filepath.Join(root, "node-v"+cfNodeVersion+"-linux-x64")
	if err := extractCloudflareNode(archive, nodeRoot); err != nil {
		return cleanup(err)
	}
	clear(archive)
	node := filepath.Join(nodeRoot, "bin", "node")
	npmCLI := filepath.Join(nodeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js")
	workDir := filepath.Join(root, "work")
	for _, asset := range []string{"package.json", "package-lock.json"} {
		data, err := cfRuntimeAssets.ReadFile("assets/cf-runtime/" + asset)
		if err != nil || os.WriteFile(filepath.Join(workDir, asset), data, 0600) != nil {
			return cleanup(errors.New("could not prepare the pinned Cloudflare CLI package lock"))
		}
	}
	baseEnv := []string{
		"PATH=" + filepath.Join(nodeRoot, "bin") + ":/usr/bin:/bin",
		"HOME=" + filepath.Join(root, "home"),
		"XDG_CONFIG_HOME=" + filepath.Join(root, "config"),
		"XDG_CACHE_HOME=" + filepath.Join(root, "cache"),
		"XDG_DATA_HOME=" + filepath.Join(root, "data"),
		"XDG_STATE_HOME=" + filepath.Join(root, "state"),
		"NPM_CONFIG_CACHE=" + filepath.Join(root, "npm-cache"),
		"NPM_CONFIG_USERCONFIG=" + filepath.Join(root, "npmrc"),
		"NPM_CONFIG_GLOBALCONFIG=" + filepath.Join(root, "global-npmrc"),
		"NPM_CONFIG_REGISTRY=https://registry.npmjs.org/",
		"NPM_CONFIG_AUDIT=false", "NPM_CONFIG_FUND=false", "NPM_CONFIG_IGNORE_SCRIPTS=true",
		"CF_SEND_TELEMETRY=0", "NO_COLOR=1",
	}
	install, cancel := context.WithTimeout(ctx, cfCLIRuntimeTimeout)
	defer cancel()
	command := exec.CommandContext(install, node, npmCLI, "ci", "--ignore-scripts", "--no-audit", "--no-fund",
		"--no-progress", "--fetch-retries=1", "--fetch-timeout=120000", "--registry=https://registry.npmjs.org/")
	command.Dir, command.Env = workDir, baseEnv
	if err := command.Run(); err != nil {
		if install.Err() != nil {
			return cleanup(errors.New("pinned Cloudflare CLI package installation exceeded its deadline"))
		}
		return cleanup(errors.New("pinned Cloudflare CLI package installation failed its integrity or registry checks"))
	}
	verifySignatures := exec.CommandContext(install, node, npmCLI, "audit", "signatures", "--registry=https://registry.npmjs.org/")
	verifySignatures.Dir, verifySignatures.Env = workDir, baseEnv
	if err := verifySignatures.Run(); err != nil {
		return cleanup(errors.New("pinned Cloudflare CLI package signatures or provenance could not be verified"))
	}
	cli := filepath.Join(workDir, "node_modules", "cf", "bin", "cf")
	if info, err := os.Stat(cli); err != nil || !info.Mode().IsRegular() {
		return cleanup(errors.New("pinned Cloudflare CLI package did not install the expected entry point"))
	}
	runtime := &cfRuntime{root: root, workDir: workDir, node: node, cli: cli, baseEnv: baseEnv}
	versionOutput, err := runtime.run(ctx, "--version")
	if err != nil || strings.TrimSpace(string(versionOutput)) != cfCLIVersion {
		return cleanup(errors.New("installed Cloudflare CLI version did not match the pinned release"))
	}
	return runtime, nil
}

func verifyCFPackageAssets() error {
	manifestBytes, err := cfRuntimeAssets.ReadFile("assets/cf-runtime/package.json")
	if err != nil {
		return errors.New("pinned Cloudflare CLI package manifest is missing")
	}
	lockBytes, err := cfRuntimeAssets.ReadFile("assets/cf-runtime/package-lock.json")
	if err != nil {
		return errors.New("pinned Cloudflare CLI package lock is missing")
	}
	manifestDigest := sha256.Sum256(manifestBytes)
	expectedManifestDigest, err := hex.DecodeString(cfNPMManifestSHA256)
	if err != nil || subtle.ConstantTimeCompare(manifestDigest[:], expectedManifestDigest) != 1 {
		return errors.New("pinned Cloudflare CLI package manifest failed its SHA-256 check")
	}
	lockDigest := sha256.Sum256(lockBytes)
	expectedLockDigest, err := hex.DecodeString(cfNPMLockSHA256)
	if err != nil || subtle.ConstantTimeCompare(lockDigest[:], expectedLockDigest) != 1 {
		return errors.New("pinned Cloudflare CLI package lock failed its SHA-256 check")
	}
	var manifest cfPackageManifest
	var lock cfPackageLock
	if json.Unmarshal(manifestBytes, &manifest) != nil || json.Unmarshal(lockBytes, &lock) != nil ||
		manifest.Name == "" || manifest.Version == "" || !manifest.Private || manifest.Dependencies["cf"] != cfCLIVersion ||
		lock.LockfileVersion != 3 || len(lock.Packages) < 2 || len(lock.Packages) > 128 {
		return errors.New("pinned Cloudflare CLI package manifest or lock is invalid")
	}
	root, ok := lock.Packages[""]
	if !ok || root.Version != manifest.Version || lock.Name != manifest.Name || root.Dependencies["cf"] != cfCLIVersion {
		return errors.New("pinned Cloudflare CLI package lock root does not match its manifest")
	}
	cfPackage, ok := lock.Packages["node_modules/cf"]
	if !ok || cfPackage.Version != cfCLIVersion || cfPackage.Integrity != cfNPMPackageSRI || !validNPMIntegrity(cfPackage.Integrity) {
		return errors.New("pinned Cloudflare CLI package version or integrity is invalid")
	}
	for name, dependency := range lock.Packages {
		if name == "" {
			continue
		}
		u, err := url.Parse(dependency.Resolved)
		if err != nil || u.Scheme != "https" || u.Host != "registry.npmjs.org" || u.User != nil ||
			u.RawQuery != "" || u.Fragment != "" || !strings.HasPrefix(u.Path, "/") || !validNPMIntegrity(dependency.Integrity) {
			return errors.New("Cloudflare CLI package lock contains an unapproved or unpinned npm artifact")
		}
	}
	return nil
}

func validNPMIntegrity(value string) bool {
	if !cfNPMIntegrity.MatchString(value) {
		return false
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(value, "sha512-"))
	return err == nil && len(decoded) == sha512Size
}

const sha512Size = 64

func downloadCloudflareNode(ctx context.Context) ([]byte, error) {
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: systemRootCAs()},
	}
	client := &http.Client{Transport: transport, Timeout: 90 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, cfNodeArchiveURL, nil)
	if err != nil {
		return nil, errors.New("could not prepare the pinned Node.js download")
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("could not download the pinned official Node.js runtime")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Request.URL.Scheme != "https" || response.Request.URL.Host != "nodejs.org" ||
		response.ContentLength > cfNodeArchiveMax {
		return nil, errors.New("the official Node.js runtime response did not match the pinned artifact")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, cfNodeArchiveMax+1))
	if err != nil || len(data) == 0 || len(data) > cfNodeArchiveMax {
		clear(data)
		return nil, errors.New("the official Node.js runtime exceeded its integrity limit")
	}
	digest := sha256.Sum256(data)
	expected, err := hex.DecodeString(cfNodeArchiveSHA256)
	if err != nil || subtle.ConstantTimeCompare(digest[:], expected) != 1 {
		clear(data)
		return nil, errors.New("the official Node.js runtime failed its pinned SHA-256 check")
	}
	return data, nil
}

func systemRootCAs() *x509.CertPool {
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		return nil
	}
	return pool
}

func extractCloudflareNode(archive []byte, destination string) error {
	reader, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return errors.New("the official Node.js runtime archive is invalid")
	}
	defer reader.Close()
	rootPrefix := "node-v" + cfNodeVersion + "-linux-x64/"
	archiveReader := tar.NewReader(reader)
	var extracted int64
	nodeFound, npmFound := false, false
	for {
		header, err := archiveReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil || header.Size < 0 || header.Size > cfExtractedMax {
			return errors.New("the official Node.js runtime archive entry is invalid")
		}
		name := strings.TrimPrefix(header.Name, rootPrefix)
		if name == header.Name || path.IsAbs(name) {
			return errors.New("the official Node.js runtime archive has an unexpected root")
		}
		if name == "" {
			if header.Typeflag == tar.TypeDir {
				continue
			}
			return errors.New("the official Node.js runtime archive has an invalid root entry")
		}
		clean := path.Clean(name)
		if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.ContainsRune(clean, '\\') {
			return errors.New("the official Node.js runtime archive contains an unsafe path")
		}
		include := clean == "bin/node" || strings.HasPrefix(clean, "lib/node_modules/npm/")
		if header.Typeflag == tar.TypeDir {
			if include || clean == "bin" || clean == "lib" || clean == "lib/node_modules" {
				if err := os.MkdirAll(filepath.Join(destination, filepath.FromSlash(clean)), 0700); err != nil {
					return errors.New("could not extract the official Node.js runtime")
				}
			}
			continue
		}
		if header.Typeflag == tar.TypeSymlink || header.Typeflag == tar.TypeLink {
			link := path.Clean(path.Join(path.Dir(clean), header.Linkname))
			if path.IsAbs(header.Linkname) || link == ".." || strings.HasPrefix(link, "../") || strings.ContainsRune(header.Linkname, '\\') {
				return errors.New("the official Node.js runtime archive contains an unsafe link")
			}
			continue
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
			return errors.New("the official Node.js runtime archive contains an unsupported entry")
		}
		if !include {
			continue
		}
		extracted += header.Size
		if extracted > cfExtractedMax || header.Size > 160<<20 {
			return errors.New("the official Node.js runtime exceeded its extraction limit")
		}
		destinationPath := filepath.Join(destination, filepath.FromSlash(clean))
		if err := os.MkdirAll(filepath.Dir(destinationPath), 0700); err != nil {
			return errors.New("could not extract the official Node.js runtime")
		}
		mode := os.FileMode(0600)
		if clean == "bin/node" {
			mode = 0700
		}
		file, err := os.OpenFile(destinationPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
		if err != nil {
			return errors.New("could not extract the official Node.js runtime")
		}
		written, copyErr := io.CopyN(file, archiveReader, header.Size)
		closeErr := file.Close()
		if copyErr != nil || closeErr != nil || written != header.Size {
			return errors.New("could not extract the official Node.js runtime")
		}
		if clean == "bin/node" {
			nodeFound = true
		}
		if clean == "lib/node_modules/npm/bin/npm-cli.js" {
			npmFound = true
		}
	}
	if !nodeFound || !npmFound {
		return errors.New("the official Node.js runtime archive is missing required executables")
	}
	return nil
}

func (runtime *cfRuntime) close() error {
	if runtime == nil {
		return nil
	}
	var logoutErr error
	if runtime.loggedIn {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		_, logoutErr = runtime.run(ctx, "auth", "logout")
		cancel()
	}
	removeErr := os.RemoveAll(runtime.root)
	runtime.root, runtime.node, runtime.cli, runtime.workDir = "", "", "", ""
	if logoutErr != nil {
		return errors.New("official Cloudflare logout could not be confirmed; isolated local profile data was removed")
	}
	if removeErr != nil {
		return errors.New("isolated Cloudflare profile cleanup could not be confirmed")
	}
	return nil
}
