package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Run the embedded provisioner against absent fixture paths without sudo.
func TestCloudflareConnectorFreshHostRequiresInstallation(t *testing.T) {
	source, _, ok := strings.Cut(cloudflareConnectorProvisioner, "\ntry:\n  main()\n")
	if !ok {
		t.Fatal("the canonical Cloudflare connector provisioner entrypoint is missing")
	}
	root := filepath.Join(t.TempDir(), "not-installed")
	source += fmt.Sprintf(`
FILE_SPECS={
  'cloudflared':(%q,0o755,64*1024*1024,'binary'),
  'codexia-cloudflared.service':(%q,0o644,16384,'unit'),
  'tunnel.token':(%q,0o600,4096,'token'),
}
protected_parents=lambda create=False: None
service_flag=lambda command: False
print(json.dumps(inspect(),separators=(',',':')))
`, filepath.Join(root, "cloudflared"), filepath.Join(root, "codexia-cloudflared.service"), filepath.Join(root, "tunnel.token"))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "python3", "-c", source).CombinedOutput() //nolint:gosec // This executes the fixed embedded installer against isolated test-only paths.
	if err != nil {
		t.Fatalf("fresh connector inspection failed: %v (%s)", err, output)
	}
	var got cloudflareConnectorProvisionResult
	if err := json.Unmarshal(output, &got); err != nil {
		t.Fatalf("invalid connector inspection response: %v (%s)", err, output)
	}
	if !got.NeedsInstall || got.Active || got.Enabled || len(got.Changed) != 4 {
		t.Fatalf("fresh VM must require connector installation without creating files: %+v", got)
	}
}
