package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
)

const (
	enableBootstrap    = "CODEXIA_BOOTSTRAP_ENABLED"
	enableDatabase     = "CODEXIA_DATABASE_INITIALIZATION_APPROVED"
	ownerRecipient     = "CODEXIA_OWNER_SETUP_AGE_RECIPIENT"
	bootstrapSSHSecret = "CODEXIA_BOOTSTRAP_SSH_PRIVATE_KEY"
	runtimeSSHSecret   = "CODEXIA_DEPLOY_SSH_PRIVATE_KEY"
	wifSecret          = "TS_OAUTH_CLIENT_ID"
	edgeTarget         = "CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET"
)

var commonSecrets = []string{
	wifSecret, "CODEXIA_DEPLOYMENT_CLOUDFLARE_READ_TOKEN", "CODEXIA_ACCESS_CLIENT_ID", "CODEXIA_ACCESS_CLIENT_SECRET",
}

type environmentInput struct {
	environment, name string
	value             string
}

func protectedVariables(address, pin, user, target string) []environmentInput {
	return []environmentInput{
		{bootstrapEnvironment, "CODEXIA_BOOTSTRAP_HOST", address},
		{bootstrapEnvironment, "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS", pin},
		{bootstrapEnvironment, "CODEXIA_BOOTSTRAP_SSH_USER", user},
		{bootstrapEnvironment, edgeTarget, target},
		{productionEnvironment, "CODEXIA_DEPLOY_HOST", address},
		{productionEnvironment, "CODEXIA_DEPLOY_SSH_KNOWN_HOSTS", pin},
		{productionEnvironment, edgeTarget, target},
	}
}

func observedProtectedVariables(snapshot githubSnapshot, vm vmObservation, tailnet tailnetObservation,
	pin, edge string) ([]environmentInput, error) {
	values := protectedVariables(tailnet.Address, pin, vm.User, edge)
	for _, pair := range []struct{ host, known int }{{0, 1}, {4, 5}} {
		env := selectEnvironment(snapshot, values[pair.host].environment)
		host := env.Variables[values[pair.host].name]
		if host == "" {
			continue
		}
		if host != tailnet.Address && !slices.ContainsFunc(tailnet.Aliases, func(alias string) bool {
			return strings.EqualFold(alias, host)
		}) {
			return nil, refused("An existing protected SSH destination belongs to a different VM")
		}
		values[pair.host].value = host
		existingPin := env.Variables[values[pair.known].name]
		if existingPin != "" {
			if err := vm.verifyKnownHosts(host, existingPin); err != nil {
				return nil, err
			}
			values[pair.known].value = existingPin
		} else {
			values[pair.known].value = host + strings.TrimPrefix(pin, tailnet.Address)
		}
	}
	return values, nil
}

func protectedSecrets() []environmentInput {
	results := []environmentInput{
		{bootstrapEnvironment, bootstrapSSHSecret, ""},
		{productionEnvironment, runtimeSSHSecret, ""},
		{bootstrapEnvironment, "CODEXIA_TUNNEL_TOKEN", ""},
		{productionEnvironment, "CLOUDFLARE_API_TOKEN", ""},
		{productionEnvironment, "CLOUDFLARE_ACCOUNT_ID", ""},
	}
	for _, name := range commonSecrets {
		results = append(results, environmentInput{bootstrapEnvironment, name, ""}, environmentInput{productionEnvironment, name, ""})
	}
	return results
}

func selectEnvironment(snapshot githubSnapshot, name string) githubEnvironment {
	if name == bootstrapEnvironment {
		return snapshot.Bootstrap
	}
	return snapshot.Production
}

func missingVariables(snapshot githubSnapshot, planned []environmentInput) ([]environmentInput, error) {
	var missing []environmentInput
	for _, desired := range planned {
		current, exists := selectEnvironment(snapshot, desired.environment).Variables[desired.name]
		if !exists {
			missing = append(missing, desired)
			continue
		}
		var equal = strings.TrimSpace(current) == strings.TrimSpace(desired.value)
		if desired.name == edgeTarget {
			var left, right any
			equal = json.Unmarshal([]byte(current), &left) == nil && json.Unmarshal([]byte(desired.value), &right) == nil &&
				reflect.DeepEqual(left, right)
		}
		if !equal {
			return nil, refused("Existing " + desired.environment + "/" + desired.name + " differs from the observed target. Reconcile it through the owning control plane")
		}
	}
	return missing, nil
}

func missingSecrets(snapshot githubSnapshot) []environmentInput {
	var results []environmentInput
	for _, input := range protectedSecrets() {
		if !selectEnvironment(snapshot, input.environment).Secrets[input.name] {
			results = append(results, input)
		}
	}
	return results
}

func registerInputs(ctx context.Context, o operator, control *githubControl, c *workflowController, vm vmObservation,
	tailnet tailnetObservation, edge *cloudflareObservation, snapshot githubSnapshot, pin string) error {
	desired, err := observedProtectedVariables(snapshot, vm, tailnet, pin, edge.Target)
	if err != nil {
		return err
	}
	variables, err := missingVariables(snapshot, desired)
	if err != nil {
		return err
	}
	secrets := missingSecrets(snapshot)
	if !snapshot.Bootstrap.Secrets[bootstrapSSHSecret] && vm.authorizedFile == "" {
		return needsAction("Configure the independently managed SSH administrator's supported authorized_keys path before registering a new bootstrap identity")
	}
	if len(variables)+len(secrets) == 0 && c.state.BootstrapPublicKey == "" {
		return nil
	}
	for _, item := range append(variables, secrets...) {
		o.Notice("Absent protected input " + item.environment + "/" + item.name)
	}
	if c.state.BootstrapPublicKey != "" {
		o.Notice("A previously issued bootstrap SSH identity requires reconciliation with authorized_keys.")
	}
	if err := requireApproval(o, "Register only the missing inputs shown above, including any new SSH keys?"); err != nil {
		return err
	}
	if err := c.requireSettingsWindow(ctx, control); err != nil {
		return err
	}
	snapshot, err = control.Observe(ctx)
	if err != nil {
		return err
	}
	if snapshot.MainSHA != c.sha {
		return refused("GitHub main advanced before protected Settings registration")
	}
	desired, err = observedProtectedVariables(snapshot, vm, tailnet, pin, edge.Target)
	if err != nil {
		return err
	}
	freshVariables, err := missingVariables(snapshot, desired)
	if err != nil {
		return err
	}
	freshSecrets := missingSecrets(snapshot)
	if !settingsApprovalMatches(variables, freshVariables) || !settingsApprovalMatches(secrets, freshSecrets) {
		return refused("The protected input inventory changed before the exclusive writer window. Review the new plan before writing")
	}
	variables, secrets = freshVariables, freshSecrets
	for _, input := range variables {
		if err := c.currentMain(ctx); err != nil {
			return err
		}
		if err := control.PutVariable(ctx, input.environment, input.name, input.value, nil); err != nil {
			return err
		}
	}
	if err := c.registerBootstrapKey(ctx, control, vm, snapshot.Bootstrap.Secrets[bootstrapSSHSecret]); err != nil {
		return err
	}
	credentials := make(map[string][]byte)
	defer func() {
		for _, value := range credentials {
			clear(value)
		}
	}()
	for _, input := range secrets {
		switch input.name {
		case bootstrapSSHSecret:
			continue
		case runtimeSSHSecret:
			private, _, err := newSSHIdentity()
			if err != nil {
				return err
			}
			err = putMissingSecret(ctx, c, control, input, private)
			clear(private)
			if err != nil {
				return err
			}
		case wifSecret:
			if err := putMissingSecret(ctx, c, control, input, []byte(tailnet.ClientID)); err != nil {
				return err
			}
		default:
			peer := snapshot.Bootstrap
			if input.environment == bootstrapEnvironment {
				peer = snapshot.Production
			}
			credential := edge.Credential
			if peer.Secrets[input.name] {
				credential = edge.ExistingCredential
			}
			value, observed := credentials[input.name]
			if !observed {
				value, err = credential(ctx, input.name)
				if err != nil {
					return err
				}
				credentials[input.name] = value
			}
			if err := putMissingSecret(ctx, c, control, input, value); err != nil {
				return err
			}
		}
	}
	updated, err := control.Observe(ctx)
	if err != nil {
		return err
	}
	remaining, err := missingVariables(updated, desired)
	if err != nil {
		return err
	}
	if len(remaining) != 0 || len(missingSecrets(updated)) != 0 {
		return needsAction("Some protected inputs could not be verified after registration")
	}
	return nil
}

func settingsApprovalMatches(approved, current []environmentInput) bool {
	for _, input := range current {
		if !slices.Contains(approved, input) {
			return false
		}
	}
	return true
}

func putMissingSecret(ctx context.Context, c *workflowController, control *githubControl, input environmentInput, value []byte) error {
	if len(value) == 0 {
		return needsAction("Required protected input is unavailable: " + input.name)
	}
	if err := c.currentMain(ctx); err != nil {
		return err
	}
	return control.PutSecret(ctx, input.environment, input.name, value)
}

func (c *workflowController) setGate(ctx context.Context, control *githubControl, name string) error {
	if err := c.currentMain(ctx); err != nil {
		return err
	}
	current, err := control.Observe(ctx)
	if err != nil {
		return err
	}
	value, exists := current.Bootstrap.Variables[name]
	if value == "true" {
		return nil
	}
	var previous *string
	if exists {
		if value != "false" {
			return refused("An existing bootstrap gate has an unknown value: " + name)
		}
		previous = &value
	}
	if c.state.GateOriginal == nil {
		c.state.GateOriginal = make(map[string]*string)
	}
	c.state.GateOriginal[name] = previous
	if err := c.store.Save(c.state); err != nil {
		return err
	}
	return control.PutVariable(ctx, bootstrapEnvironment, name, "true", previous)
}

func (c *workflowController) restoreGates(ctx context.Context, control *githubControl) error {
	if len(c.state.GateOriginal) == 0 {
		return nil
	}
	if c.state.Pending {
		return needsAction("Temporary bootstrap gates remain tied to an unresolved run. Resume init to reconcile them")
	}
	if err := c.requireSettingsWindow(ctx, control); err != nil {
		return err
	}
	current, err := control.Observe(ctx)
	if err != nil {
		return errors.Join(needsAction("Temporary bootstrap gates could not be reconciled"), err)
	}
	for _, name := range []string{enableDatabase, enableBootstrap} {
		original, changed := c.state.GateOriginal[name]
		if !changed {
			continue
		}
		value, exists := current.Bootstrap.Variables[name]
		switch {
		case original == nil && !exists, original != nil && exists && *original == value:
			// The gate was already restored or the original write did not take effect.
		case value != "true":
			return refused("A temporary gate changed externally: " + name + ". Review it on GitHub")
		case original == nil:
			err = control.DeleteVariable(ctx, bootstrapEnvironment, name, value)
		default:
			err = control.PutVariable(ctx, bootstrapEnvironment, name, *original, &value)
		}
		if err != nil {
			return fmt.Errorf("restore temporary gate %s: %w", name, err)
		}
		delete(c.state.GateOriginal, name)
		if err := c.store.Save(c.state); err != nil {
			return err
		}
	}
	return nil
}
