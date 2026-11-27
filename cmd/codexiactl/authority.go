package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"time"
)

var releaseVersion = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`)

type productionContract struct {
	PublicOrigin string
	ServiceUID   int
}

// These are exact-source views of the existing Terraform inputs. No separate CLI
// route settings are shipped or maintained.
var productionCloudflareRoutes, productionIdentityProbes, productionProtocolPaths []byte

func productionSettings(ctx context.Context, current string, mutating bool) (productionContract, error) {
	var settings productionContract
	if !sourceHash.MatchString(current) {
		return settings, refused("GitHub did not supply a valid main source")
	}
	if mutating && (!releaseVersion.MatchString(version) || !sourceHash.MatchString(source)) {
		return settings, needsAction("Use the provenance-verified immutable GitHub Release binary to run init")
	}
	reader := &http.Client{
		Timeout:       20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	files := []struct {
		name string
		out  *[]byte
	}{
		{"docs/deployment/CODEXIACTL.md", nil},
		{".github/workflows/production-bootstrap.yml", nil},
		{".github/workflows/production-preflight.yml", nil},
		{".github/workflows/frontend-release.yml", nil},
		{".github/workflows/backend-deployment-handoff.yml", nil},
		{"deploy/production.json", nil},
		{"deploy/cloudflare/ui-routes.json", &productionCloudflareRoutes},
		{"deploy/cloudflare/identity-probes.json", &productionIdentityProbes},
		{"deploy/cloudflare/public-protocol-paths.json", &productionProtocolPaths},
	}
	for _, file := range files {
		content, err := readSourceFile(ctx, reader, current, file.name)
		if err != nil {
			return settings, err
		}
		if sourceHash.MatchString(source) && source != current {
			prior, err := readSourceFile(ctx, reader, source, file.name)
			if err != nil {
				return settings, err
			}
			if !bytes.Equal(content, prior) {
				return settings, refused("The release and current main differ for " + file.name + ". Use a release certified for the current contract")
			}
		}
		if file.name == "deploy/production.json" && json.Unmarshal(content, &settings) != nil {
			return settings, refused("The canonical production settings are invalid")
		}
		if file.out != nil {
			*file.out = content
		}
	}
	origin, err := url.Parse(settings.PublicOrigin)
	if err != nil || origin.Scheme != "https" || origin.Hostname() == "" || origin.User != nil ||
		origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || origin.Port() != "" ||
		"https://"+origin.Hostname() != settings.PublicOrigin || settings.ServiceUID <= 0 {
		return settings, refused("The canonical production HTTPS origin or service UID is invalid")
	}
	return settings, nil
}

func readSourceFile(ctx context.Context, client *http.Client, sha, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://raw.githubusercontent.com/yohn-jp/codexia/"+sha+"/"+path, nil)
	if err != nil {
		return nil, refused("The canonical source reference is invalid")
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("could not read canonical source for %s", path)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("canonical source %s returned HTTP %d", path, response.StatusCode)
	}
	const capBytes = 512 << 10
	data, err := io.ReadAll(io.LimitReader(response.Body, capBytes+1))
	if err != nil || len(data) == 0 || len(data) > capBytes {
		return nil, fmt.Errorf("invalid canonical source response for %s", path)
	}
	return data, nil
}
