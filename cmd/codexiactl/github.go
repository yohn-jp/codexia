package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/go-github/v93/github"
	"golang.org/x/crypto/nacl/box"
)

const (
	githubBootstrapEnvironment  = "codexia-bootstrap"
	githubProductionEnvironment = "codexia-production"
)

var (
	githubSHA           = regexp.MustCompile(`^[0-9a-f]{40}$`)
	errGitHubProtection = errors.New("GitHub Environment protection requires maintainer configuration")
	errGitHubTarget     = errors.New("GitHub repository or main identity does not match the certified target")
)

type githubControl struct {
	client         *github.Client
	download       *http.Client
	token          []byte
	actor          string
	appClientID    string
	target         githubTarget
	approvedSHA    string
	settingsMu     sync.Mutex
	settingsWriter *githubSecretWriteWindow
}

type githubEnvironment struct {
	Variables         map[string]string `json:"-"`
	Secrets           map[string]bool
	SecretUpdatedAt   map[string]time.Time
	Protected         bool
	ProtectionBlocker string
}

type githubSnapshot struct {
	MainSHA    string
	Actor      string
	Bootstrap  githubEnvironment
	Production githubEnvironment
}

func (g *githubControl) Main(ctx context.Context) (string, error) {
	if err := g.verifyRepository(ctx); err != nil {
		return "", err
	}
	return g.mainBranch(ctx)
}

func (g *githubControl) mainBranch(ctx context.Context) (string, error) {
	branch, resp, err := g.client.Repositories.GetBranch(ctx, g.target.Owner, deploymentRepositoryName, "main", 0)
	if err != nil {
		return "", githubFailure("read the main branch", resp, err)
	}
	if branch.GetName() != "main" || !branch.GetProtected() || !githubSHA.MatchString(branch.GetCommit().GetSHA()) {
		return "", errGitHubTarget
	}
	return branch.GetCommit().GetSHA(), nil
}

func (g *githubControl) verifyRepository(ctx context.Context) error {
	_, err := g.repository(ctx)
	return err
}

func (g *githubControl) repository(ctx context.Context) (*github.Repository, error) {
	repo, resp, err := g.client.Repositories.Get(ctx, g.target.Owner, deploymentRepositoryName)
	if err != nil {
		return nil, githubFailure("verify the deployment repository", resp, err)
	}
	if repo.GetName() != deploymentRepositoryName || !g.target.matchesRepository(repo) || repo.GetDefaultBranch() != "main" || repo.GetArchived() || repo.GetDisabled() {
		return nil, errGitHubTarget
	}
	if !githubCanDeploy(repo) {
		return nil, errors.New("GitHub deployment requires user write access to " + g.target.FullName())
	}
	return repo, nil
}

func (g *githubControl) Observe(ctx context.Context) (githubSnapshot, error) {
	snapshot := githubSnapshot{Actor: g.actor}
	var err error
	snapshot.MainSHA, err = g.Main(ctx)
	if err != nil {
		return snapshot, err
	}
	for _, file := range githubWorkflows {
		workflow, resp, err := g.client.Actions.GetWorkflowByFileName(ctx, g.target.Owner, deploymentRepositoryName, file)
		if err != nil {
			return snapshot, githubFailure("read the active "+file+" workflow", resp, err)
		}
		if workflow.GetState() != "active" || workflow.GetPath() != githubWorkflowPath(file) || workflow.GetID() <= 0 {
			return snapshot, fmt.Errorf("GitHub does not report an active %s at its expected path", file)
		}
	}
	var bootstrapErr, productionErr error
	snapshot.Bootstrap, bootstrapErr = g.observeEnvironment(ctx, githubBootstrapEnvironment)
	snapshot.Production, productionErr = g.observeEnvironment(ctx, githubProductionEnvironment)
	return snapshot, errors.Join(bootstrapErr, productionErr)
}

func (g *githubControl) observeEnvironment(ctx context.Context, name string) (githubEnvironment, error) {
	env := githubEnvironment{
		Variables: make(map[string]string), Secrets: make(map[string]bool), SecretUpdatedAt: make(map[string]time.Time),
	}
	protectionErr := g.requireProtection(ctx, name)
	if protectionErr == nil {
		env.Protected = true
	} else {
		env.ProtectionBlocker = protectionErr.Error()
	}
	variableErr := g.listVariables(ctx, name, env.Variables)
	if variableErr != nil {
		env.Variables = nil
	}
	secretErr := g.listSecrets(ctx, name, env)
	if secretErr != nil {
		env.Secrets, env.SecretUpdatedAt = nil, nil
	}
	return env, errors.Join(protectionErr, variableErr, secretErr)
}

func (g *githubControl) requireProtection(ctx context.Context, name string) error {
	env, err := g.environment(ctx, name)
	if err != nil {
		return err
	}
	return g.requireMainOnly(ctx, name, env.GetDeploymentBranchPolicy())
}

func (g *githubControl) environment(ctx context.Context, name string) (*github.Environment, error) {
	if name != githubBootstrapEnvironment && name != githubProductionEnvironment {
		return nil, errGitHubProtection
	}
	env, resp, err := g.client.Repositories.GetEnvironment(ctx, g.target.Owner, deploymentRepositoryName, name)
	if err != nil {
		return nil, githubFailure("read protection for "+name, resp, err)
	}
	if env.GetID() <= 0 || env.GetName() != name {
		return nil, errGitHubTarget
	}
	return env, nil
}

func (g *githubControl) requireMainOnly(ctx context.Context, name string, policy *github.BranchPolicy) error {
	protectionErr := fmt.Errorf("%w: %s must use Selected branches and tags with exactly one rule: branch main (no tags). Configure this at %s/settings/environments before retrying", errGitHubProtection, name, g.target.URL())
	if !policy.GetCustomBranchPolicies() || policy.GetProtectedBranches() {
		return protectionErr
	}
	rules, resp, err := g.client.Repositories.ListDeploymentBranchPolicies(ctx, g.target.Owner, deploymentRepositoryName, name, &github.ListOptions{PerPage: 2})
	if err != nil {
		return githubFailure("read deployment-branch restrictions for "+name, resp, err)
	}
	if rules.GetTotalCount() != 1 || len(rules.BranchPolicies) != 1 || resp.NextPage != 0 {
		return protectionErr
	}
	rule := rules.BranchPolicies[0]
	if rule.GetType() != "branch" || rule.GetName() != "main" {
		return protectionErr
	}
	return nil
}

func (g *githubControl) listVariables(ctx context.Context, name string, variables map[string]string) error {
	for page := 1; page != 0; {
		list, resp, err := g.client.Actions.ListEnvVariables(ctx, g.target.Owner, deploymentRepositoryName, name, &github.ListOptions{Page: page, PerPage: 100})
		if err != nil {
			return githubFailure("list Environment variables for "+name, resp, err)
		}
		if list == nil {
			return errors.New("GitHub returned no Environment variable inventory")
		}
		for _, v := range list.Variables {
			if v == nil || v.Name == "" {
				return errors.New("GitHub returned invalid Environment variable metadata")
			}
			key := strings.ToUpper(v.Name)
			if _, ok := variables[key]; ok {
				return errors.New("GitHub returned duplicate Environment variable metadata")
			}
			variables[key] = v.Value
		}
		page = resp.NextPage
	}
	return nil
}

func (g *githubControl) listSecrets(ctx context.Context, name string, env githubEnvironment) error {
	for page := 1; page != 0; {
		list, resp, err := g.client.Actions.ListEnvSecrets(ctx, g.target.Owner, deploymentRepositoryName, name, &github.ListOptions{Page: page, PerPage: 100})
		if err != nil {
			return githubFailure("list Environment secrets for "+name, resp, err)
		}
		if list == nil {
			return errors.New("GitHub returned no Environment secret inventory")
		}
		for _, s := range list.Secrets {
			key := strings.ToUpper(s.GetName())
			if key == "" || env.Secrets[key] || s.UpdatedAt.IsZero() {
				return errors.New("GitHub returned invalid Environment secret metadata")
			}
			env.Secrets[key] = true
			env.SecretUpdatedAt[key] = s.UpdatedAt.Time
		}
		page = resp.NextPage
	}
	return nil
}

var githubCommonVariables = map[string]bool{"CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET": true}
var githubBootstrapVariables = map[string]bool{
	"CODEXIA_BOOTSTRAP_HOST": true, "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS": true,
	"CODEXIA_BOOTSTRAP_SSH_USER": true, "CODEXIA_OWNER_SETUP_AGE_RECIPIENT": true,
	"CODEXIA_BOOTSTRAP_ENABLED": true, "CODEXIA_DATABASE_INITIALIZATION_APPROVED": true,
}
var githubProductionVariables = map[string]bool{
	"CODEXIA_DEPLOY_HOST": true, "CODEXIA_DEPLOY_SSH_KNOWN_HOSTS": true,
}

var githubCommonSecrets = map[string]bool{
	"CODEXIA_DEPLOYMENT_CLOUDFLARE_READ_TOKEN": true,
	"CODEXIA_ACCESS_CLIENT_ID":                 true, "CODEXIA_ACCESS_CLIENT_SECRET": true,
}
var githubBootstrapSecrets = map[string]bool{
	"CODEXIA_BOOTSTRAP_SSH_PRIVATE_KEY": true,
	sshAccessClientID:                   true, sshAccessSecret: true,
}
var githubProductionSecrets = map[string]bool{
	"CODEXIA_DEPLOY_SSH_PRIVATE_KEY": true,
	sshAccessClientID:                true, sshAccessSecret: true,
	"CLOUDFLARE_API_TOKEN": true, "CLOUDFLARE_ACCOUNT_ID": true,
}

func githubInputAllowed(env, name string, common, bootstrap, production map[string]bool) bool {
	switch env {
	case githubBootstrapEnvironment:
		return common[name] || bootstrap[name]
	case githubProductionEnvironment:
		return common[name] || production[name]
	default:
		return false
	}
}

func (g *githubControl) PutVariable(ctx context.Context, environment, name, value string, expected *string) error {
	if !githubInputAllowed(environment, name, githubCommonVariables, githubBootstrapVariables, githubProductionVariables) {
		return errors.New("GitHub Environment variable is outside the initial-install contract")
	}
	if err := g.requireWriteTarget(ctx, environment); err != nil {
		return err
	}
	g.settingsMu.Lock()
	defer g.settingsMu.Unlock()
	window := g.settingsWriter
	if window == nil {
		return errGitHubSettingsWriterUnavailable
	}
	current, resp, err := g.client.Actions.GetEnvVariable(ctx, g.target.Owner, deploymentRepositoryName, environment, name)
	if expected == nil {
		if githubStatus(resp) != http.StatusNotFound {
			if err == nil {
				return fmt.Errorf("GitHub Environment variable %s already exists", name)
			}
			return githubFailure("check Environment variable absence for "+name, resp, err)
		}
	} else {
		if err != nil {
			return githubFailure("check the existing Environment variable "+name, resp, err)
		}
		if current.Name != name || current.Value != *expected {
			return fmt.Errorf("GitHub Environment variable %s changed since the approved observation", name)
		}
		if current.Value == value {
			return nil
		}
	}
	if err := window.verify(ctx); err != nil {
		return err
	}
	if expected == nil {
		resp, err = g.client.Actions.CreateEnvVariable(ctx, g.target.Owner, deploymentRepositoryName, environment, github.ActionsCreateVariableRequest{Name: name, Value: value})
	} else {
		resp, err = g.client.Actions.UpdateEnvVariable(ctx, g.target.Owner, deploymentRepositoryName, environment, name, github.ActionsUpdateVariableRequest{Value: &value})
	}
	if err != nil {
		return githubFailure("register Environment variable "+name, resp, err)
	}
	current, resp, err = g.client.Actions.GetEnvVariable(ctx, g.target.Owner, deploymentRepositoryName, environment, name)
	if err != nil {
		return githubFailure("verify Environment variable "+name, resp, err)
	}
	if current.Name != name || current.Value != value {
		return fmt.Errorf("GitHub Environment variable %s could not be verified", name)
	}
	return nil
}

func (g *githubControl) DeleteVariable(ctx context.Context, environment, name, expected string) error {
	if environment != githubBootstrapEnvironment || (name != "CODEXIA_BOOTSTRAP_ENABLED" && name != "CODEXIA_DATABASE_INITIALIZATION_APPROVED") {
		return errors.New("GitHub Environment variable is outside the temporary gate contract")
	}
	if err := g.requireWriteTarget(ctx, environment); err != nil {
		return err
	}
	g.settingsMu.Lock()
	defer g.settingsMu.Unlock()
	window := g.settingsWriter
	if window == nil {
		return errGitHubSettingsWriterUnavailable
	}
	current, resp, err := g.client.Actions.GetEnvVariable(ctx, g.target.Owner, deploymentRepositoryName, environment, name)
	if githubStatus(resp) == http.StatusNotFound {
		return nil
	}
	if err != nil {
		return githubFailure("check the temporary Environment variable "+name, resp, err)
	}
	if current.Name != name || current.Value != expected {
		return fmt.Errorf("GitHub Environment variable %s changed since the approved observation", name)
	}
	if err := window.verify(ctx); err != nil {
		return err
	}
	resp, err = g.client.Actions.DeleteEnvVariable(ctx, g.target.Owner, deploymentRepositoryName, environment, name)
	if err != nil {
		return githubFailure("restore the temporary Environment variable "+name, resp, err)
	}
	_, resp, err = g.client.Actions.GetEnvVariable(ctx, g.target.Owner, deploymentRepositoryName, environment, name)
	if githubStatus(resp) != http.StatusNotFound {
		return githubFailure("verify removal of temporary Environment variable "+name, resp, err)
	}
	return nil
}

func (g *githubControl) PutSecret(ctx context.Context, environment, name string, value []byte) error {
	if !githubInputAllowed(environment, name, githubCommonSecrets, githubBootstrapSecrets, githubProductionSecrets) || len(value) == 0 {
		return errors.New("GitHub Environment secret is outside the initial-install contract or empty")
	}
	g.settingsMu.Lock()
	defer g.settingsMu.Unlock()
	window := g.settingsWriter
	if window == nil {
		return errGitHubSettingsWriterUnavailable
	}
	if err := g.requireWriteTarget(ctx, environment); err != nil {
		return err
	}
	key, resp, err := g.client.Actions.GetEnvPublicKey(ctx, g.target.Owner, deploymentRepositoryName, environment)
	if err != nil {
		return githubFailure("get the encryption key for "+environment, resp, err)
	}
	pubKey, err := base64.StdEncoding.Strict().DecodeString(key.GetKey())
	if err != nil || len(pubKey) != 32 || key.GetKeyID() == "" {
		return errors.New("GitHub returned an invalid Environment encryption key")
	}
	ciphertext, err := box.SealAnonymous(nil, value, (*[32]byte)(pubKey), rand.Reader)
	if err != nil {
		return errors.New("seal the GitHub Environment secret")
	}
	// The approved exclusive Settings window covers cooperating GitHub writers.
	// GitHub's unconditional PUT does not protect against administrators outside that scope.
	_, resp, err = g.client.Actions.GetEnvSecret(ctx, g.target.Owner, deploymentRepositoryName, environment, name)
	if githubStatus(resp) != http.StatusNotFound {
		if err == nil {
			return fmt.Errorf("GitHub Environment secret %s already exists", name)
		}
		return githubFailure("check Environment secret absence for "+name, resp, err)
	}
	if err := window.verify(ctx); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	resp, err = g.client.Actions.CreateOrUpdateEnvSecret(ctx, g.target.Owner, deploymentRepositoryName, environment, name, github.SecretRequest{
		KeyID: key.GetKeyID(), EncryptedValue: base64.StdEncoding.EncodeToString(ciphertext),
	})
	if err != nil {
		failure := githubFailure("register Environment secret "+name, resp, err)
		if githubDefiniteSecretRejection(resp) {
			return failure
		}
		return errors.Join(errGitHubSecretWriteUnknown, failure)
	}
	if githubStatus(resp) != http.StatusCreated {
		return fmt.Errorf("%w: GitHub did not confirm creation of %s as a new Environment secret", errGitHubSecretWriteUnknown, name)
	}
	secret, resp, err := g.client.Actions.GetEnvSecret(ctx, g.target.Owner, deploymentRepositoryName, environment, name)
	if err != nil {
		return errors.Join(errGitHubSecretWriteUnknown, githubFailure("verify Environment secret metadata for "+name, resp, err))
	}
	if secret.GetName() != name || secret.UpdatedAt.IsZero() {
		return fmt.Errorf("%w: GitHub could not verify Environment secret metadata for %s", errGitHubSecretWriteUnknown, name)
	}
	return nil
}

func githubDefiniteSecretRejection(resp *github.Response) bool {
	switch githubStatus(resp) {
	case http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound,
		http.StatusMethodNotAllowed, http.StatusConflict, http.StatusRequestEntityTooLarge,
		http.StatusUnsupportedMediaType, http.StatusUnprocessableEntity, http.StatusTooManyRequests:
		return true
	default:
		return false
	}
}

func (g *githubControl) requireWriteTarget(ctx context.Context, environment string) error {
	if err := g.requireApprovedTarget(ctx, false); err != nil {
		return err
	}
	return g.requireProtection(ctx, environment)
}

type githubOperationError struct {
	action string
	status int
	after  time.Duration
}

func (e *githubOperationError) Error() string {
	switch {
	case e.after > 0 || e.status == http.StatusTooManyRequests:
		return fmt.Sprintf("GitHub could not %s because of rate limiting (retry after %s)", e.action, e.after.Round(time.Second))
	case e.status == http.StatusUnauthorized:
		return fmt.Sprintf("GitHub could not %s: authentication was rejected or expired", e.action)
	case e.status == http.StatusForbidden || e.status == http.StatusNotFound:
		return fmt.Sprintf("GitHub could not %s: resource missing or required permission denied (HTTP %d)", e.action, e.status)
	case e.status >= 400:
		return fmt.Sprintf("GitHub could not %s (HTTP %d)", e.action, e.status)
	default:
		return fmt.Sprintf("GitHub could not %s; the response could not be verified", e.action)
	}
}

func githubStatus(resp *github.Response) int {
	if resp == nil || resp.Response == nil {
		return 0
	}
	return resp.StatusCode
}

func githubFailure(action string, resp *github.Response, err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return errors.Join(errors.New("GitHub could not "+action), contextError(err))
	}
	result := &githubOperationError{action: action, status: githubStatus(resp)}
	var rate *github.RateLimitError
	var abuse *github.AbuseRateLimitError
	if errors.As(err, &rate) {
		result.after = time.Until(rate.Rate.Reset.Time)
	} else if errors.As(err, &abuse) {
		result.after = time.Minute
		if abuse.RetryAfter != nil {
			result.after = *abuse.RetryAfter
		}
	}
	if resp != nil && resp.Response != nil {
		header := resp.Header.Get("Retry-After")
		if seconds, parseErr := strconv.ParseInt(header, 10, 32); parseErr == nil && seconds >= 0 {
			result.after = max(result.after, time.Duration(seconds)*time.Second)
		} else if date, parseErr := http.ParseTime(header); parseErr == nil {
			result.after = max(result.after, time.Until(date))
		}
	}
	result.after = max(result.after, 0)
	if result.after == 0 && result.status == http.StatusTooManyRequests {
		result.after = time.Minute
	}
	return result
}

func contextError(err error) error {
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	return context.DeadlineExceeded
}

func githubRetryAfter(err error) time.Duration {
	var result *githubOperationError
	if errors.As(err, &result) {
		return result.after
	}
	return 0
}
