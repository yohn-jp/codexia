package main

import (
	"context"
	"crypto/sha1"
	json "encoding/json/v2"
	"fmt"
	"maps"
	"net"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/google/go-github/v93/github"
)

var releaseVersion = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`)

// productionContract belongs to the selected repository's exact protected main.
// It is passed explicitly so different targets cannot share observed settings.
type productionContract struct {
	PublicOrigin string
	ServiceUID   int
	edge         cloudflareContract
}

type cloudflareContract struct {
	routes, identityProbes, protocolPaths []byte
}

// Check the CLI specification, the operational contracts, the workflows,
// and the local control-plane code they execute. A fork can change application
// code and the documented public production values without changing the
// contract understood by the official CLI.
var releaseContractPaths = []string{
	"docs/deployment/CODEXIACTL.sdoc",
	"docs/deployment/ANSIBLE-AUTH-RUNTIME.sdoc",
	"docs/deployment/ANSIBLE-BASE-RUNTIME.sdoc",
	"docs/deployment/ANSIBLE-BASE-SECRETS.sdoc",
	"docs/deployment/ANSIBLE-PUSH-DEPLOYMENT.sdoc",
	"docs/deployment/BACKUP-CONSOLE-OPERATIONS.sdoc",
	"docs/deployment/ACCESS-POLICY-MIGRATION.sdoc",
	".github/workflows/production-bootstrap.yml",
	".github/workflows/production-preflight.yml",
	".github/workflows/frontend-release.yml",
	".github/workflows/backend-deployment-handoff.yml",
	".github/workflows/backend-handoff-revalidate.yml",
	".github/workflows/backend-release.yml",
	".github/workflows/publish-oci.yml",
	".github/workflows/verify.yml",
	".github/workflows/verify-profile.yml",
	".github/workflows/tailscale-connectivity.yml",
	".github/actions/",
	"scripts/github/",
	"scripts/deployment/",
	"scripts/ci/certification/",
	"scripts/ci/evidence/",
	"scripts/ci/execution/",
	"scripts/ci/impact/",
	"scripts/release/",
	"scripts/verification/artifacts/",
	"scripts/verification/infrastructure/",
	"deploy/production.json",
	"deploy/ansible/",
	"deploy/backup/",
	"deploy/cloudflare/terraform/",
	"edge/frontend/wrangler.jsonc",
	"deploy/quadlet/",
	"deploy/cloudflare/ui-routes.json",
	"deploy/cloudflare/identity-probes.json",
	"deploy/cloudflare/public-protocol-paths.json",
}

func (g *githubControl) productionSettings(ctx context.Context, sha string) (productionContract, error) {
	var settings productionContract
	if !sourceHash.MatchString(sha) || !sourceHash.MatchString(source) {
		return settings, needsAction("Use an official release with a verified source to compare the selected repository's deployment contract")
	}
	officialOwner, officialRepository, _ := strings.Cut(officialDistribution, "/")
	// The official release source is public. The selected repository's
	// temporary App user token never leaves its API session.
	official, err := github.NewClient(github.WithHTTPClient(githubHTTPClient(20 * time.Second)))
	if err != nil {
		return settings, fmt.Errorf("could not read the official CLI release contract")
	}
	expected, err := contractTree(ctx, official, officialOwner, officialRepository, source)
	if err != nil {
		return settings, err
	}
	actual, err := contractTree(ctx, g.client, g.target.Owner, deploymentRepositoryName, sha)
	if err != nil {
		return settings, err
	}
	if err := requireCompatibleContract(expected, actual); err != nil {
		return settings, err
	}

	files := []struct {
		name string
		out  *[]byte
	}{
		{"deploy/production.json", nil},
		{"deploy/cloudflare/ui-routes.json", &settings.edge.routes},
		{"deploy/cloudflare/identity-probes.json", &settings.edge.identityProbes},
		{"deploy/cloudflare/public-protocol-paths.json", &settings.edge.protocolPaths},
	}
	for _, file := range files {
		content, err := g.readSourceFile(ctx, sha, file.name)
		if err != nil {
			return settings, err
		}
		if !strings.HasSuffix(actual[file.name], ":"+sourceBlobSHA(content)) {
			return settings, refused("The exact-source file does not match the deployment contract tree for " + file.name)
		}
		if file.out != nil {
			*file.out = content
		} else if err := validateProductionSettings(content, &settings); err != nil {
			return settings, err
		}
	}
	return settings, nil
}

func requireCompatibleContract(expected, actual map[string]string) error {
	keys := slices.Sorted(maps.Keys(expected))
	for _, path := range keys {
		if path != "deploy/production.json" && expected[path] != actual[path] {
			return refused("The selected main is incompatible with the official CLI release contract at " + path + ". Update the repository contract or use a corresponding official CLI release")
		}
	}
	if len(expected) != len(actual) {
		return refused("The selected main adds files to the official CLI release contract. Update the repository contract or use a corresponding official CLI release")
	}
	return nil
}

func contractTree(ctx context.Context, client *github.Client, owner, repo, sha string) (map[string]string, error) {
	tree, resp, err := client.Git.GetTree(ctx, owner, repo, sha, true)
	if err != nil {
		return nil, githubFailure("read the exact deployment contract for "+owner+"/"+repo, resp, err)
	}
	if tree == nil || tree.Truncated == nil || tree.GetTruncated() {
		return nil, refused("GitHub returned an incomplete deployment contract tree for " + owner + "/" + repo)
	}
	entries := make(map[string]string)
	seen := make(map[string]bool)
	for _, entry := range tree.Entries {
		path := entry.GetPath()
		if entry.GetType() == "tree" {
			continue
		}
		for _, contractPath := range releaseContractPaths {
			if path != contractPath && (!strings.HasSuffix(contractPath, "/") || !strings.HasPrefix(path, contractPath)) {
				continue
			}
			if _, duplicate := entries[path]; duplicate || !sourceHash.MatchString(entry.GetSHA()) ||
				entry.GetType() != "blob" || entry.GetMode() != "100644" && entry.GetMode() != "100755" {
				return nil, refused("GitHub returned ambiguous deployment contract contents")
			}
			entries[path] = entry.GetMode() + ":" + entry.GetSHA()
			seen[contractPath] = true
			break
		}
	}
	for _, path := range releaseContractPaths {
		if !seen[path] {
			return nil, refused("GitHub returned no exact-source deployment contract for " + path)
		}
	}
	return entries, nil
}

func validateProductionSettings(content []byte, settings *productionContract) error {
	var profile struct {
		PublicOrigin          string `json:"publicOrigin"`
		DesktopCallbackPath   string `json:"desktopCallbackPath"`
		WebClientID           string `json:"webClientId"`
		IOSClientID           string `json:"iosClientId"`
		IntrospectionClientID string `json:"introspectionClientId"`
		Scopes                string `json:"scopes"`
		ServiceUID            int    `json:"serviceUid"`
		ServiceGID            int    `json:"serviceGid"`
	}
	if json.Unmarshal(content, &profile, json.RejectUnknownMembers(true)) != nil {
		return refused("The canonical production settings are invalid")
	}
	origin, err := url.Parse(profile.PublicOrigin)
	if err != nil || origin.Scheme != "https" || origin.Hostname() != origin.Host || origin.User != nil ||
		origin.Path != "" || origin.RawQuery != "" || origin.ForceQuery || origin.Fragment != "" ||
		!strings.Contains(origin.Host, ".") || !cloudflareHost.MatchString(origin.Host) || net.ParseIP(origin.Host) != nil ||
		"https://"+origin.Hostname() != profile.PublicOrigin || profile.ServiceUID <= 0 || profile.ServiceGID <= 0 ||
		profile.DesktopCallbackPath != "/desktop" || !safeIdentifier.MatchString(profile.WebClientID) ||
		!safeIdentifier.MatchString(profile.IOSClientID) || !safeIdentifier.MatchString(profile.IntrospectionClientID) ||
		profile.Scopes != "openid codexia:api" || profile.WebClientID == profile.IOSClientID ||
		profile.WebClientID == profile.IntrospectionClientID || profile.IOSClientID == profile.IntrospectionClientID {
		return refused("The canonical production origin, identity, or protocol settings are invalid")
	}
	settings.PublicOrigin, settings.ServiceUID = profile.PublicOrigin, profile.ServiceUID
	return nil
}

func (g *githubControl) readSourceFile(ctx context.Context, sha, path string) ([]byte, error) {
	file, _, resp, err := g.client.Repositories.GetContents(ctx, g.target.Owner, deploymentRepositoryName, path, &github.RepositoryContentGetOptions{Ref: sha})
	if err != nil {
		return nil, githubFailure("read selected repository source for "+path, resp, err)
	}
	const capBytes = 512 << 10
	if file.GetType() != "file" || file.GetPath() != path || file.GetSize() <= 0 || file.GetSize() > capBytes ||
		!sourceHash.MatchString(file.GetSHA()) || file.GetEncoding() != "base64" {
		return nil, refused("Invalid canonical source metadata for " + path)
	}
	data, err := file.GetContent()
	if err != nil || len(data) != file.GetSize() || sourceBlobSHA([]byte(data)) != file.GetSHA() {
		return nil, refused("Invalid canonical source response for " + path)
	}
	return []byte(data), nil
}

// GitHub represents repository blobs using Git's SHA-1 object identifier.
func sourceBlobSHA(data []byte) string {
	digest := sha1.New()
	fmt.Fprintf(digest, "blob %d\x00", len(data))
	digest.Write(data)
	return fmt.Sprintf("%x", digest.Sum(nil))
}
