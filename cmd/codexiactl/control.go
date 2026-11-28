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
	bootstrapSSHSecret = "CODEXIA_BOOTSTRAP_SSH_PRIVATE_KEY" //nolint:gosec // This is a GitHub Environment input name.
	runtimeSSHSecret   = "CODEXIA_DEPLOY_SSH_PRIVATE_KEY"    //nolint:gosec // This is a GitHub Environment input name.
	sshAccessClientID  = "CODEXIA_SSH_ACCESS_CLIENT_ID"
	sshAccessSecret    = "CODEXIA_SSH_ACCESS_CLIENT_SECRET" //nolint:gosec // This is a GitHub Environment input name.
	edgeTarget         = "CODEXIA_DEPLOYMENT_CLOUDFLARE_TARGET"
)

var commonSecrets = []string{
	cloudflareReadRole, cloudflareProbeID, cloudflareProbeSecret,
}

func managementSecrets() []string {
	return append(append([]string(nil), commonSecrets...), sshAccessClientID, sshAccessSecret)
}

type environmentInput struct {
	environment, name string
	value             string
}

func protectedVariables(managementHostname, pin, user, target string) []environmentInput {
	return []environmentInput{
		{bootstrapEnvironment, "CODEXIA_BOOTSTRAP_HOST", managementHostname},
		{bootstrapEnvironment, "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS", pin},
		{bootstrapEnvironment, "CODEXIA_BOOTSTRAP_SSH_USER", user},
		{bootstrapEnvironment, edgeTarget, target},
		{productionEnvironment, "CODEXIA_DEPLOY_HOST", managementHostname},
		{productionEnvironment, "CODEXIA_DEPLOY_SSH_KNOWN_HOSTS", pin},
		{productionEnvironment, edgeTarget, target},
	}
}

func observedProtectedVariables(snapshot githubSnapshot, vm vmObservation, managementHostname, pin, edge string) ([]environmentInput, error) {
	if !validDNSHostname(managementHostname) {
		return nil, refused("The observed Cloudflare management hostname is invalid")
	}
	if !strings.HasPrefix(pin, managementHostname+" ") {
		return nil, refused("The independently verified OpenSSH pin is not bound to the Cloudflare management hostname")
	}
	values := protectedVariables(managementHostname, pin, vm.User, edge)
	for _, pair := range []struct{ host, known int }{{0, 1}, {4, 5}} {
		env := selectEnvironment(snapshot, values[pair.host].environment)
		host := env.Variables[values[pair.host].name]
		if host == "" {
			continue
		}
		if host != managementHostname {
			return nil, refused("An existing protected SSH destination differs from the verified Cloudflare management hostname")
		}
		values[pair.host].value = host
		existingPin := env.Variables[values[pair.known].name]
		if existingPin != "" {
			if err := vm.verifyKnownHosts(host, existingPin); err != nil {
				return nil, err
			}
			values[pair.known].value = existingPin
		} else {
			values[pair.known].value = host + strings.TrimPrefix(pin, managementHostname)
		}
	}
	return values, nil
}

func protectedSecrets() []environmentInput {
	results := []environmentInput{
		{bootstrapEnvironment, bootstrapSSHSecret, ""},
		{bootstrapEnvironment, sshAccessClientID, ""},
		{bootstrapEnvironment, sshAccessSecret, ""},
		{productionEnvironment, runtimeSSHSecret, ""},
		{productionEnvironment, sshAccessClientID, ""},
		{productionEnvironment, sshAccessSecret, ""},
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
		equal := strings.TrimSpace(current) == strings.TrimSpace(desired.value)
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

func validateServiceAuthPairs(snapshot githubSnapshot) error {
	return validateServiceAuthRegistration(snapshot, nil)
}

func validateServiceAuthRegistration(snapshot githubSnapshot, receipts map[string]cfServiceAuthReceipt) error {
	for _, environment := range []string{bootstrapEnvironment, productionEnvironment} {
		env := selectEnvironment(snapshot, environment)
		inputs := env.Secrets
		for _, pair := range [][2]string{{sshAccessClientID, sshAccessSecret}, {cloudflareProbeID, cloudflareProbeSecret}} {
			receipt, pending := receipts[environment+"/"+pair[0]]
			if pending && inputs[pair[1]] &&
				(env.SecretUpdatedAt[pair[1]].Before(receipt.StartedAt) || receipt.StartedAt.IsZero()) {
				return refused("GitHub did not confirm the Service Auth secret was registered during the recorded operation")
			}
			if pending && inputs[pair[0]] && env.SecretUpdatedAt[pair[0]].Before(receipt.StartedAt) {
				return refused("GitHub did not confirm the Service Auth ID was registered during the recorded operation")
			}
			switch {
			case inputs[pair[0]] && inputs[pair[1]]:
			case !inputs[pair[0]] && inputs[pair[1]] && pending:
			case !inputs[pair[0]] && !inputs[pair[1]] && !pending:
			default:
				return needsAction("The protected " + environment + " Cloudflare Service Auth pair could not be reconciled with the registration receipt. Inspect the owning Environment and Cloudflare inventory before rerunning init")
			}
		}
	}
	return nil
}

func registerInputs(ctx context.Context, o operator, control *githubControl, c *workflowController, vm vmObservation,
	managementHostname string, edge *cloudflareObservation, snapshot githubSnapshot, pin string,
) error {
	if err := validateServiceAuthRegistration(snapshot, c.state.CloudflareServiceAuth); err != nil {
		return err
	}
	variables, err := plannedProtectedVariables(snapshot, vm, managementHostname, pin, edge.Target)
	if err != nil {
		return err
	}
	secrets := missingSecrets(snapshot)
	if !snapshot.Bootstrap.Secrets[bootstrapSSHSecret] && vm.authorizedFile == "" {
		return needsAction("Configure the independently managed SSH administrator's supported authorized_keys path before registering a new bootstrap identity")
	}
	if len(variables)+len(secrets) == 0 && c.state.BootstrapPublicKey == "" && len(c.state.CloudflareServiceAuth) == 0 {
		o.Notice("Protected inputs are already registered. The runner checks actual connectivity in the next stage.")
		return ensureCloudflareConnector(ctx, o, edge)
	}
	for _, item := range variables {
		description := "Add missing Variable "
		if item.update {
			description = "Migrate verified Variable "
		}
		label := item.environment + "/" + item.name
		if item.update && (item.name == "CODEXIA_BOOTSTRAP_HOST" || item.name == "CODEXIA_DEPLOY_HOST") {
			label += " from " + item.previous + " to " + item.value
		}
		o.Notice(description + label)
	}
	if slices.ContainsFunc(variables, func(write protectedVariableWrite) bool { return write.update }) {
		o.Notice("Migrate the independently verified VM host key and unchanged Cloudflare resource identity to " + managementHostname + ". Current Variable values will be checked before each write.")
	}
	for _, item := range secrets {
		o.Notice("Add missing Secret " + item.environment + "/" + item.name)
	}
	if c.state.BootstrapPublicKey != "" {
		o.Notice("A previously issued bootstrap SSH identity requires reconciliation with authorized_keys.")
	}
	o.Notice("This change requires write access to the selected GitHub Environments. Existing Secrets stay in place. New bootstrap SSH credentials also add a dedicated public key to this administrator's authorized_keys.")
	if err := requireApproval(o, "Apply the protected input changes shown above for "+c.target.FullName()+"?"); err != nil {
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
	if err := validateServiceAuthRegistration(snapshot, c.state.CloudflareServiceAuth); err != nil {
		return err
	}
	freshVariables, err := plannedProtectedVariables(snapshot, vm, managementHostname, pin, edge.Target)
	if err != nil {
		return err
	}
	freshSecrets := missingSecrets(snapshot)
	if !slices.Equal(variables, freshVariables) || !settingsApprovalMatches(secrets, freshSecrets) {
		return refused("The protected input inventory changed before the exclusive writer window. Review the new plan before writing")
	}
	variables, secrets = freshVariables, freshSecrets
	for key := range c.state.CloudflareServiceAuth {
		environment, idInput, _ := strings.Cut(key, "/")
		if selectEnvironment(snapshot, environment).Secrets[idInput] {
			delete(c.state.CloudflareServiceAuth, key)
			if err := c.store.Save(c.state); err != nil {
				return err
			}
		}
	}
	if err := ensureCloudflareConnector(ctx, o, edge); err != nil {
		return err
	}
	for _, input := range variables {
		if err := c.currentMain(ctx); err != nil {
			return err
		}
		var expected *string
		if input.update {
			if err := requireCloudflarePublicationClosed(ctx, vm); err != nil {
				return err
			}
			expected = &input.previous
		}
		if err := control.PutVariable(ctx, input.environment, input.name, input.value, expected); err != nil {
			return err
		}
	}
	if err := c.registerBootstrapKey(ctx, control, vm, snapshot.Bootstrap.Secrets[bootstrapSSHSecret]); err != nil {
		return err
	}
	for _, input := range secrets {
		if err := c.registerProtectedSecret(ctx, control, edge, snapshot, input); err != nil {
			return err
		}
	}
	updated, err := control.Observe(ctx)
	if err != nil {
		return err
	}
	remaining, err := plannedProtectedVariables(updated, vm, managementHostname, pin, edge.Target)
	if err != nil {
		return err
	}
	if len(remaining) != 0 || len(missingSecrets(updated)) != 0 {
		return needsAction("Some protected inputs could not be verified after registration. Check " +
			c.target.URL() + "/settings/environments and run codexiactl doctor before resuming")
	}
	o.Notice("Protected input registration verified. The runner checks actual connectivity in the next stage.")
	return nil
}

func (c *workflowController) registerProtectedSecret(ctx context.Context, control *githubControl, edge *cloudflareObservation,
	snapshot githubSnapshot, input environmentInput,
) error {
	switch input.name {
	case bootstrapSSHSecret, sshAccessSecret, cloudflareProbeSecret:
		// Bootstrap SSH has its own recoverable key write. Service Auth secrets
		// are written with their corresponding ID input below.
		return nil
	case sshAccessClientID, cloudflareProbeID:
		return c.registerServiceAuth(ctx, control, edge, snapshot, input)
	case runtimeSSHSecret:
		private, _, err := newSSHIdentity()
		if err != nil {
			return err
		}
		defer clear(private)
		return putMissingSecret(ctx, c, control, input, private)
	default:
		value, err := edge.Credential(ctx, input.environment, input.name)
		if err != nil {
			return err
		}
		defer clear(value)
		return putMissingSecret(ctx, c, control, input, value)
	}
}

func (c *workflowController) registerServiceAuth(ctx context.Context, control *githubControl, edge *cloudflareObservation,
	snapshot githubSnapshot, input environmentInput,
) error {
	role, err := edge.serviceRole(input.environment, input.name)
	if err != nil {
		return err
	}
	key := input.environment + "/" + input.name
	receipt, pending := c.state.CloudflareServiceAuth[key]
	var id []byte
	defer func() { clear(id) }()
	if pending {
		if !selectEnvironment(snapshot, input.environment).Secrets[role.secretInput] {
			return needsAction("The Cloudflare Service Auth secret was never confirmed in the intended Environment. Resolve the pending issuance in the provider and GitHub inventories")
		}
		id, err = edge.serviceAuthClientID(ctx, role, receipt)
		if err != nil {
			return err
		}
	} else {
		var secret []byte
		receipt, id, secret, err = edge.issueServiceAuth(ctx, role)
		defer clear(secret)
		if err != nil {
			return err
		}
		if c.state.CloudflareServiceAuth == nil {
			c.state.CloudflareServiceAuth = make(map[string]cfServiceAuthReceipt)
		}
		c.state.CloudflareServiceAuth[key] = receipt
		if err := c.store.Save(c.state); err != nil {
			return err
		}
		secretInput := environmentInput{environment: input.environment, name: role.secretInput}
		if err := putMissingSecret(ctx, c, control, secretInput, secret); err != nil {
			return err
		}
	}
	if err := putMissingSecret(ctx, c, control, input, id); err != nil {
		return err
	}
	delete(c.state.CloudflareServiceAuth, key)
	return c.store.Save(c.state)
}

func ensureCloudflareConnector(ctx context.Context, o operator, edge *cloudflareObservation) error {
	needed, err := CloudflareConnectorNeedsInstall(ctx)
	if err != nil {
		return err
	}
	if !needed {
		return nil
	}
	token, err := edge.ConnectorToken(ctx)
	if err != nil {
		return err
	}
	defer clear(token)
	if len(token) == 0 {
		return needsAction("The verified Cloudflare Tunnel did not provide a connector token")
	}
	return installCloudflareConnector(ctx, o, token)
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
