package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func TestPinnedCloudflareRuntimeAssetsAndScopes(t *testing.T) {
	if err := verifyCFPackageAssets(); err != nil {
		t.Fatal(err)
	}
	if err := verifyCFDeviceFlowPrerequisites(); err != nil {
		t.Fatal(err)
	}
	requirements := cfDeviceRequirements{
		accountTokenCreate: true, accessTokenWrite: true,
		workerScriptsWrite: true, tunnelToken: true,
	}
	want := []string{
		"access-app.read", "access-idp.read", "access-org.read", "access-policy.read", "access-service-token.read", "access-service-token.write",
		"account:read", "account_api_tokens:create", "argotunnel.read", "argotunnel.write",
		"dns.read", "workers-routes.read", "workers-scripts.read", "workers-scripts.write", "zone:read",
	}
	if got := requirements.scopes(); !slices.Equal(got, want) {
		t.Fatalf("Cloudflare scopes=%v, want %v", got, want)
	}
	if got := (cfDeviceRequirements{}).scopes(); !slices.Equal(got, cfReadScopes) {
		t.Fatalf("read-only scopes=%v, want %v", got, cfReadScopes)
	}
	if !cfScopeSetAllowed(want) || cfScopeSetAllowed(append(slices.Clone(want), want[0])) ||
		cfScopeSetAllowed([]string{"account.read"}) {
		t.Fatal("Cloudflare scope validation accepted a duplicate or unsupported scope")
	}
}

func TestCloudflareNodeExtractionAllowsOnlyPrivateRuntimeFiles(t *testing.T) {
	archive := nodeArchiveFixture(t, []tar.Header{
		{Name: "node-v" + cfNodeVersion + "-linux-x64/", Typeflag: tar.TypeDir, Mode: 0o755},
		{Name: "node-v" + cfNodeVersion + "-linux-x64/bin/", Typeflag: tar.TypeDir, Mode: 0o755},
		{Name: "node-v" + cfNodeVersion + "-linux-x64/bin/node", Typeflag: tar.TypeReg, Mode: 0o755, Size: 4},
		{Name: "node-v" + cfNodeVersion + "-linux-x64/lib/node_modules/npm/bin/", Typeflag: tar.TypeDir, Mode: 0o755},
		{Name: "node-v" + cfNodeVersion + "-linux-x64/lib/node_modules/npm/bin/npm-cli.js", Typeflag: tar.TypeReg, Mode: 0o644, Size: 3},
		{Name: "node-v" + cfNodeVersion + "-linux-x64/README.md", Typeflag: tar.TypeReg, Mode: 0o644, Size: 7},
	})
	root := t.TempDir()
	destination := filepath.Join(root, "node")
	if err := extractCloudflareNode(archive, destination); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"bin/node", "lib/node_modules/npm/bin/npm-cli.js"} {
		if _, err := os.Stat(filepath.Join(destination, name)); err != nil {
			t.Fatalf("expected runtime file %s: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(destination, "README.md")); !os.IsNotExist(err) {
		t.Fatal("unexpected Node distribution files were extracted")
	}
}

func TestCloudflareNodeExtractionRejectsTraversal(t *testing.T) {
	archive := nodeArchiveFixture(t, []tar.Header{
		{Name: "node-v" + cfNodeVersion + "-linux-x64/", Typeflag: tar.TypeDir, Mode: 0o755},
		{Name: "node-v" + cfNodeVersion + "-linux-x64/../../escape", Typeflag: tar.TypeReg, Mode: 0o600, Size: 1},
	})
	root := t.TempDir()
	if err := extractCloudflareNode(archive, filepath.Join(root, "node")); err == nil {
		t.Fatal("Node archive traversal was accepted")
	}
	if _, err := os.Stat(filepath.Join(root, "escape")); !os.IsNotExist(err) {
		t.Fatal("archive traversal wrote outside its private root")
	}
}

func TestPinnedCloudflareRuntimeAgainstPublicArtifacts(t *testing.T) {
	if os.Getenv("CODEXIACTL_QUALIFY_CF_RUNTIME") != "1" {
		t.Skip("set CODEXIACTL_QUALIFY_CF_RUNTIME=1 to fetch pinned public Node.js/npm artifacts; no Cloudflare login is started")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	runtime, err := prepareCloudflareRuntime(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := runtime.close(); err != nil {
			t.Error(err)
		}
	}()
	version, err := runtime.run(ctx, "--version")
	if err != nil || string(bytes.TrimSpace(version)) != cfCLIVersion {
		t.Fatalf("pinned cf release check: output=%q err=%v", bytes.TrimSpace(version), err)
	}
	_, err = runtime.run(ctx, "auth", "login", "--dry-run", "--device", "--no-browser", "--no-use-keyring", "--scopes", "account:read")
	if err != nil {
		t.Fatalf("pinned cf Device Flow help/argument check failed: %v", err)
	}
}

func nodeArchiveFixture(t *testing.T, entries []tar.Header) []byte {
	t.Helper()
	var buffer bytes.Buffer
	compressed := gzip.NewWriter(&buffer)
	writer := tar.NewWriter(compressed)
	for _, entry := range entries {
		if err := writer.WriteHeader(&entry); err != nil {
			t.Fatal(err)
		}
		if entry.Typeflag == tar.TypeReg {
			body := bytes.Repeat([]byte("x"), int(entry.Size))
			if _, err := writer.Write(body); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
