package main

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/google/go-github/v93/github"
)

const (
	deploymentRepositoryName = "codexia"
	officialDistribution     = "yohn-jp/codexia"
	githubInstallationsURL   = "https://github.com/settings/installations"
)

var githubOwnerName = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`)

type githubTarget struct {
	Owner                           string
	OwnerID, RepoID, InstallationID int64
}

func (t githubTarget) valid() bool {
	return githubOwnerName.MatchString(t.Owner) && t.OwnerID > 0 && t.RepoID > 0 && t.InstallationID > 0
}

func (t githubTarget) FullName() string { return t.Owner + "/" + deploymentRepositoryName }
func (t githubTarget) URL() string      { return "https://github.com/" + t.FullName() }

func (t githubTarget) matchesRepository(r *github.Repository) bool {
	return t.valid() && r.GetID() == t.RepoID && r.GetFullName() == t.FullName() &&
		r.GetOwner().GetID() == t.OwnerID && r.GetOwner().GetLogin() == t.Owner
}

func (t githubTarget) oidcPrefix() string {
	return fmt.Sprintf("repo:%s@%d/%s@%d", t.Owner, t.OwnerID, deploymentRepositoryName, t.RepoID)
}

func (t githubTarget) imageRepository() string {
	return "ghcr.io/" + strings.ToLower(t.Owner) + "/codexia-backend"
}

func (t githubTarget) matchesFullImage(image string) bool {
	if !t.valid() {
		return false
	}
	digest, ok := strings.CutPrefix(image, t.imageRepository()+"@sha256:")
	return ok && digestHash.MatchString(digest)
}

func githubCanDeploy(r *github.Repository) bool {
	p := r.GetPermissions()
	return p.GetPush() || p.GetMaintain() || p.GetAdmin()
}

func (g *githubControl) installations(ctx context.Context) ([]*github.Installation, error) {
	var result []*github.Installation
	total := -1
	seen := make(map[int64]bool)
	for page := 1; page != 0; {
		req, err := g.client.NewRequest(ctx, http.MethodGet, "user/installations?per_page=100&page="+strconv.Itoa(page), nil)
		if err != nil {
			return nil, errGitHubTarget
		}
		var list struct {
			TotalCount    *int                   `json:"total_count"`
			Installations []*github.Installation `json:"installations"`
		}
		resp, err := g.client.Do(req, &list)
		if err != nil {
			return nil, githubFailure("list App installations accessible to this GitHub user", resp, err)
		}
		if list.TotalCount == nil || *list.TotalCount < 0 || (total >= 0 && total != *list.TotalCount) ||
			list.Installations == nil || resp.NextPage != 0 && resp.NextPage <= page {
			return nil, refused("GitHub returned an incomplete App installation inventory")
		}
		total = *list.TotalCount
		for _, installation := range list.Installations {
			id := installation.GetID()
			if id <= 0 || seen[id] || installation.GetClientID() != g.appClientID {
				return nil, refused("GitHub returned missing, ambiguous, or different App installation identity")
			}
			seen[id] = true
			result = append(result, installation)
		}
		page = resp.NextPage
	}
	if len(result) != total {
		return nil, refused("GitHub returned an incomplete App installation inventory")
	}
	return result, nil
}

func (g *githubControl) installedRepositories(ctx context.Context, installationID int64) ([]*github.Repository, error) {
	var result []*github.Repository
	total := -1
	seen := make(map[int64]*github.Repository)
	for page := 1; page != 0; {
		list, resp, err := g.client.Apps.ListUserRepos(ctx, installationID, &github.ListOptions{Page: page, PerPage: 100})
		if err != nil {
			return nil, githubFailure("list repositories accessible to the App and signed-in user", resp, err)
		}
		if list == nil || list.TotalCount == nil || *list.TotalCount < 0 || (total >= 0 && total != *list.TotalCount) ||
			list.Repositories == nil || resp.NextPage != 0 && resp.NextPage <= page {
			return nil, refused("GitHub returned an incomplete accessible repository inventory")
		}
		total = *list.TotalCount
		for _, r := range list.Repositories {
			if r.GetID() <= 0 || r.GetName() == "" {
				return nil, refused("GitHub returned missing repository identity")
			}
			if previous := seen[r.GetID()]; previous != nil {
				if previous.GetFullName() != r.GetFullName() || previous.GetName() != r.GetName() ||
					previous.GetOwner().GetID() != r.GetOwner().GetID() || previous.GetOwner().GetLogin() != r.GetOwner().GetLogin() ||
					previous.GetDefaultBranch() != r.GetDefaultBranch() || previous.GetArchived() != r.GetArchived() ||
					previous.GetDisabled() != r.GetDisabled() || githubCanDeploy(previous) != githubCanDeploy(r) {
					return nil, refused("GitHub returned conflicting metadata for the same repository ID")
				}
				continue
			}
			seen[r.GetID()] = r
			result = append(result, r)
		}
		page = resp.NextPage
	}
	if len(result) != total {
		return nil, refused("GitHub returned an incomplete accessible repository inventory")
	}
	return result, nil
}

func githubInstallationAdmitted(i *github.Installation) bool {
	p := i.GetPermissions()
	return i.GetRepositorySelection() == "selected" && i.SuspendedAt == nil &&
		githubOwnerName.MatchString(i.GetAccount().GetLogin()) && i.GetAccount().GetID() > 0 &&
		p.GetActions() == "write" && p.GetEnvironments() == "write" &&
		githubHasRead(p.GetContents()) && githubHasRead(p.GetMetadata()) && githubHasRead(p.GetAdministration())
}

func githubCandidate(i *github.Installation, r *github.Repository) (githubTarget, bool) {
	target := githubTarget{Owner: i.GetAccount().GetLogin(), OwnerID: i.GetAccount().GetID(), RepoID: r.GetID(), InstallationID: i.GetID()}
	return target, r.GetName() == deploymentRepositoryName && target.matchesRepository(r) &&
		r.GetDefaultBranch() == "main" && !r.GetArchived() && !r.GetDisabled() && githubCanDeploy(r)
}

func (g *githubControl) discoverTargets(ctx context.Context) ([]githubTarget, error) {
	installations, err := g.installations(ctx)
	if err != nil {
		return nil, err
	}
	var candidates []githubTarget
	byID := make(map[int64]githubTarget)
	byName := make(map[string]int64)
	for _, installation := range installations {
		if !githubInstallationAdmitted(installation) {
			continue
		}
		repos, err := g.installedRepositories(ctx, installation.GetID())
		if err != nil {
			return nil, err
		}
		for _, repo := range repos {
			target, ok := githubCandidate(installation, repo)
			if !ok {
				continue
			}
			if previous, exists := byID[target.RepoID]; exists {
				if previous != target {
					return nil, refused("GitHub returned conflicting installations for the same repository ID")
				}
				continue
			}
			name := strings.ToLower(target.FullName())
			if byName[name] != 0 {
				return nil, refused("GitHub returned multiple repository IDs for one deployment name")
			}
			byName[name], byID[target.RepoID] = target.RepoID, target
			candidates = append(candidates, target)
		}
	}
	slices.SortFunc(candidates, func(a, b githubTarget) int { return strings.Compare(a.FullName(), b.FullName()) })
	return candidates, nil
}

func chooseGitHubTarget(o operator, candidates []githubTarget, state checkpoint) (githubTarget, error) {
	if state.RepositoryID != 0 {
		for _, candidate := range candidates {
			if state.matchesTarget(candidate) {
				return candidate, nil
			}
		}
		return githubTarget{}, refused("The checkpoint repository or installation is no longer available with the same identity and permissions. Restore access to the original target and reconcile its protected deployment")
	}
	switch len(candidates) {
	case 0:
		return githubTarget{}, needsAction("No eligible codexia repository was found. Open " + githubAppInstallationURL +
			", select the intended account or organization, then choose Only select repositories and add codexia. Check for a pending approval or suspended installation at " +
			githubInstallationsURL + ". Ensure the signed-in user can write to the repository and its default branch is main, then retry. " + githubPermissionNotice)
	case 1:
		return candidates[0], nil
	}
	options := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		options = append(options, fmt.Sprintf("%s (repository %d, owner %d, installation %d)",
			candidate.FullName(), candidate.RepoID, candidate.OwnerID, candidate.InstallationID))
	}
	index, err := selectOption(o, "Select the GitHub deployment repository", options)
	if err != nil {
		return githubTarget{}, err
	}
	if index < 0 || index >= len(candidates) {
		return githubTarget{}, refused("Select exactly one repository from the observed candidates")
	}
	return candidates[index], nil
}

func (g *githubControl) verifyDelegation(ctx context.Context, admin bool) error {
	installations, err := g.installations(ctx)
	if err != nil {
		return err
	}
	for _, installation := range installations {
		if installation.GetID() != g.target.InstallationID || !githubInstallationAdmitted(installation) ||
			(admin && installation.GetPermissions().GetAdministration() != "write") {
			continue
		}
		repositories, err := g.installedRepositories(ctx, installation.GetID())
		if err != nil {
			return err
		}
		for _, repository := range repositories {
			candidate, ok := githubCandidate(installation, repository)
			if ok && candidate == g.target {
				return nil
			}
		}
	}
	return refused("The selected repository's GitHub App delegation or user permissions could not be verified")
}

func (g *githubControl) verifyOIDC(ctx context.Context) error {
	value, resp, err := g.client.Actions.GetRepoOIDCSubjectClaimCustomTemplate(ctx, g.target.Owner, deploymentRepositoryName)
	if err != nil {
		return githubFailure("verify the selected repository's immutable OIDC subject (requires Administration read)", resp, err)
	}
	if value == nil || !value.GetUseDefault() || len(value.IncludeClaimKeys) > 0 || !value.GetUseImmutableSubject() || value.GetSubClaimPrefix() != g.target.oidcPrefix() {
		return refused("Enable the default immutable GitHub OIDC subject for " + g.target.FullName() +
			" using the repository OIDC customization API and retry. Expected subject prefix " + g.target.oidcPrefix())
	}
	return nil
}

func (g *githubControl) requireApprovedTarget(ctx context.Context, admin bool) error {
	if err := g.verifyDelegation(ctx, admin); err != nil {
		return err
	}
	repo, err := g.repository(ctx)
	if err != nil {
		return err
	}
	if admin && !repo.GetPermissions().GetAdmin() {
		return refused("The authenticated GitHub user no longer has repository Administration access")
	}
	sha, err := g.mainBranch(ctx)
	if err != nil {
		return err
	}
	if sha != g.approvedSHA {
		return refused("The protected main source changed after target approval. Run the command again to review it")
	}
	return g.verifyOIDC(ctx)
}
