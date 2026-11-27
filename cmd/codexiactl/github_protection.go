package main

import (
	"context"
	"fmt"

	"github.com/google/go-github/v93/github"
)

// OfferMissingMainRestriction can add a branch policy to an empty list.
// The Environment upsert replaces existing reviewer and protection settings
// and has no conditional-write contract. Reviewer setup stays with the maintainer.
func (g *githubControl) OfferMissingMainRestriction(ctx context.Context, o operator) (bool, error) {
	repo, err := g.repository(ctx)
	if err != nil {
		return false, err
	}
	if !repo.GetPermissions().GetAdmin() || (g.appSession && !g.appAdministration) {
		return false, nil
	}
	changed := false
	for _, env := range []string{githubBootstrapEnvironment, githubProductionEnvironment} {
		eligible, err := g.hasEmptyBranchPolicy(ctx, env)
		if err != nil {
			return changed, err
		}
		if !eligible {
			continue
		}
		approved, err := o.Confirm("With GitHub Administration write, add only the main branch to the empty selected-branches restriction for yohn-jp/codexia " + env + "?")
		if err != nil || !approved {
			return changed, err
		}
		if _, err := g.Main(ctx); err != nil {
			return changed, err
		}
		eligible, err = g.hasEmptyBranchPolicy(ctx, env)
		if err != nil {
			return changed, err
		}
		if !eligible {
			return changed, fmt.Errorf("%w: %s changed since the branch restriction was approved", errGitHubProtection, env)
		}
		// POST adds just this entry, leaving independent reviews and existing policies owned by GitHub.
		branch := "branch"
		policy, resp, err := g.client.Repositories.CreateDeploymentBranchPolicy(ctx, githubOwner, githubRepo, env, github.CreateDeploymentBranchPolicyRequest{
			Name: "main", Type: &branch,
		})
		if err != nil {
			return changed, githubFailure("add main to "+env+" (reobserve before retrying)", resp, err)
		}
		changed = true
		if policy.GetID() <= 0 || policy.GetType() != branch || policy.GetName() != "main" {
			return changed, fmt.Errorf("%w: could not verify added branch restriction for %s", errGitHubProtection, env)
		}
		if err := g.requireProtection(ctx, env); err != nil {
			return changed, err
		}
	}
	return changed, nil
}

func (g *githubControl) hasEmptyBranchPolicy(ctx context.Context, name string) (bool, error) {
	env, err := g.environment(ctx, name)
	if err != nil {
		return false, err
	}
	policy := env.GetDeploymentBranchPolicy()
	if !githubIndependentReview(env) || !policy.GetCustomBranchPolicies() || policy.GetProtectedBranches() {
		return false, nil
	}
	rules, resp, err := g.client.Repositories.ListDeploymentBranchPolicies(ctx, githubOwner, githubRepo, name, &github.ListOptions{PerPage: 2})
	if err != nil {
		return false, githubFailure("read deployment-branch restrictions for "+name, resp, err)
	}
	return rules.TotalCount != nil && rules.GetTotalCount() == 0 && len(rules.BranchPolicies) == 0 && resp.NextPage == 0, nil
}
