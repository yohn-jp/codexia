package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"
)

const (
	vmStage = iota + 1
	githubStage
	tailnetStage
	cloudflareStage
	settingsStage
	managementStage
	bootstrapStage
	frontendStage
	ownerSetupStage
	handoffStage
)

func reportStage(o operator, step int, detail string) {
	if presentation, ok := o.(interface{ Stage(int, string) }); ok {
		presentation.Stage(step, detail)
		return
	}
	o.Notice(fmt.Sprintf("[%02d/10] %s", step, detail))
}

func runInit(ctx context.Context) (resultErr error) {
	if !releaseVersion.MatchString(version) || !sourceHash.MatchString(source) {
		return needsAction("Use the provenance-verified immutable GitHub Release binary to run init")
	}
	tty, err := openTerminal()
	if err != nil {
		return needsAction("Open an interactive SSH session with a controlling terminal on the target VM and run codexiactl init")
	}
	defer tty.Close()
	tty.bindContext(ctx)
	reportResult(tty, headingText, "CodexiaCTL | "+version+" | guided installation")
	reportStage(tty, vmStage, "Checking the local OpenSSH session, OS, clock and administrator access")
	vm, err := observeVM(ctx)
	if err != nil {
		return err
	}
	store, err := openCheckpoint(vm.HostID)
	if err != nil {
		return err
	}
	defer store.Close()
	state, err := store.Load()
	if err != nil {
		return err
	}
	tty.Notice("VM observed: " + vm.HostID + ", administrator " + vm.User + ", sshd host key " + vm.HostFingerprint + ", clock " + vm.Clock + ".")
	reportStage(tty, githubStage, "Authenticate with the official App and confirm the deployment repository")
	gh, err := githubLogin(ctx, tty, githubAppClientID)
	if err != nil {
		return err
	}
	defer closeGitHub(ctx, gh)
	settings, err := gh.selectTarget(ctx, tty, vm, state)
	if err != nil {
		return err
	}
	if err := gh.verifyOIDC(ctx); err != nil {
		return err
	}
	snapshot, err := gh.Observe(ctx)
	if err := validateProtectedCloudflareTarget(snapshot, gh.target, settings.PublicOrigin); err != nil {
		return err
	}
	if errors.Is(err, errGitHubProtection) && !vm.CodexiaPresent {
		changed, offerErr := gh.OfferMissingMainRestriction(ctx, tty)
		if offerErr != nil {
			return offerErr
		}
		if changed {
			snapshot, err = gh.Observe(ctx)
		}
	}
	if err != nil {
		return err
	}
	if snapshot.MainSHA != gh.approvedSHA {
		return refused("GitHub main changed after deployment target confirmation. Run codexiactl init again and review the new source")
	}
	reportResult(tty, successText, "Selected repository, main, OIDC and Environment restrictions verified")
	c := workflowController{github: gh, operator: tty, store: store, state: state, target: gh.target,
		sha: snapshot.MainSHA, hostID: vm.HostID, origin: settings.PublicOrigin}
	c.state.HostID = vm.HostID
	c.state.bindTarget(gh.target)
	defer func() {
		cleanupErr := c.finishSettingsWindow(ctx, resultErr)
		if cleanupErr != nil {
			tty.Notice(cleanupErr.Error())
		}
		resultErr = errors.Join(resultErr, cleanupErr)
	}()
	if c.state.SettingsWriterID != "" {
		if err := c.requireSettingsWindow(ctx, gh); err != nil {
			return err
		}
	}
	err = c.reconcilePrevious(ctx, gh)
	if err != nil {
		return err
	}
	c.state.MainSHA = c.sha
	if err := c.store.Save(c.state); err != nil {
		return err
	}
	if err := c.requireIdle(ctx, gh); err != nil {
		return err
	}
	// Inspect the existing runtime through its owning lifecycle path first.
	// This prevents changing protected inputs on an enrolled installation.
	if vm.CodexiaPresent {
		management := existingManagement(snapshot)
		if management == "" {
			return needsAction("Existing Codexia resources were detected and neither protected SSH configuration is complete. Verify the installation through " +
				c.target.URL() + "/blob/main/docs/deployment/PROTECTED-RECOVERY.md")
		}
		tty.Notice("Existing Codexia resources detected. Observe the protected lifecycle before changing provider or repository settings.")
		receipt, id, err := c.preflight(ctx, management)
		if err != nil {
			return err
		}
		if _, err := receipt.initialOperation(); err != nil {
			return c.lifecycleBlocker(id, err)
		}
	}
	if err := c.prepareInputs(ctx, gh, tty, vm, settings, snapshot); err != nil {
		return err
	}
	return c.install(ctx, gh, settings)
}

func closeGitHub(ctx context.Context, gh *githubControl) {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	gh.Close(cleanup)
}

func existingManagement(snapshot githubSnapshot) string {
	// R4 can leave the administrator reachable while the rootless account
	// is still missing its runtime public key.
	if managementInputsExist(snapshot.Bootstrap,
		[]string{"CODEXIA_BOOTSTRAP_HOST", "CODEXIA_BOOTSTRAP_SSH_KNOWN_HOSTS", "CODEXIA_BOOTSTRAP_SSH_USER"}, bootstrapSSHSecret) {
		return "bootstrap"
	}
	if managementInputsExist(snapshot.Production,
		[]string{"CODEXIA_DEPLOY_HOST", "CODEXIA_DEPLOY_SSH_KNOWN_HOSTS"}, runtimeSSHSecret) {
		return "runtime"
	}
	return ""
}

func managementInputsExist(env githubEnvironment, names []string, sshSecret string) bool {
	if env.Variables[edgeTarget] == "" || !env.Secrets[sshSecret] {
		return false
	}
	for _, name := range names {
		if env.Variables[name] == "" {
			return false
		}
	}
	for _, name := range commonSecrets {
		if !env.Secrets[name] {
			return false
		}
	}
	return true
}

func (c *workflowController) prepareInputs(ctx context.Context, gh *githubControl, o operator, vm vmObservation,
	settings productionContract, snapshot githubSnapshot) error {
	reportStage(o, tailnetStage, "Verify this VM's Tailnet, runner access policy and repository OIDC trust")
	tailnet, err := prepareTailnet(ctx, o, vm, gh, snapshot, false)
	if err != nil {
		return err
	}
	pin, err := vm.ConfirmPin(o, tailnet.Address)
	if err != nil {
		return err
	}
	o.Notice("Verified the Tailnet node, CI policy and effective OpenSSH pin for " + tailnet.Address + ".")
	reportStage(o, cloudflareStage, "Verify the existing edge for "+settings.PublicOrigin)
	edge, err := observeCloudflare(ctx, o, gh.target, settings, true)
	if err != nil {
		return err
	}
	defer edge.Close()
	if err := verifyInitialEdge(ctx, vm, edge); err != nil {
		return err
	}
	reportStage(o, settingsStage, "Compare checked VM and provider values against the selected repository's protected inputs")
	if err := c.requireIdle(ctx, gh); err != nil {
		return err
	}
	return registerInputs(ctx, o, gh, c, vm, tailnet, edge, snapshot, pin)
}

func (c *workflowController) reconcilePrevious(ctx context.Context, gh *githubControl) error {
	if !c.state.Pending {
		return c.restoreGates(ctx, gh)
	}
	if c.state.RunID < 1 {
		if err := c.reconcileUnknownRun(ctx, gh); err != nil {
			return err
		}
		if !c.state.Pending {
			return c.restoreGates(ctx, gh)
		}
	}
	id, operation := c.state.RunID, c.state.Operation
	c.operator.Notice("Resuming verification of " + c.target.runLink(id) + ".")
	done, err := c.wait(ctx, operation, c.state.MainSHA, id)
	if !done {
		return err
	}
	if err == nil {
		c.recordSuccessfulOperation(operation, id)
	}
	err = errors.Join(err, c.clearDispatch())
	return errors.Join(err, c.restoreGates(ctx, gh))
}

func (c *workflowController) recordSuccessfulOperation(operation string, id int64) {
	switch operation {
	case "frontend":
		c.state.FrontendRunID = id
	case "owner-setup":
		c.state.OwnerSetupRunID = id
	}
}

func dispatchTitle(operation string, preflight int64) string {
	if preflight <= 0 {
		return ""
	}
	switch operation {
	case "bootstrap", "owner-setup":
		return fmt.Sprintf("Production bootstrap [%s] Preflight %d", operation, preflight)
	case "frontend":
		return fmt.Sprintf("Initial Frontend Preflight %d", preflight)
	default:
		return ""
	}
}

func correlateRun(state checkpoint, runs []githubRunSummary) (int64, error) {
	title := dispatchTitle(state.Operation, state.PreflightRunID)
	spec := operations[state.Operation]
	var match int64
	for _, run := range runs {
		if title == "" || run.File != spec.file || run.SHA != state.MainSHA || run.DisplayTitle != title {
			continue
		}
		if match != 0 || run.Attempt != 1 || run.ID < 1 {
			return 0, refused("GitHub returned ambiguous or rerun evidence for the same reviewed Preflight")
		}
		match = run.ID
	}
	return match, nil
}

func (c *workflowController) reconcileUnknownRun(ctx context.Context, gh *githubControl) error {
	runs, err := gh.Recent(ctx)
	if err != nil {
		return err
	}
	id, err := correlateRun(c.state, runs)
	if err != nil {
		return err
	}
	if id > 0 {
		c.state.RunID = id
		return c.store.Save(c.state)
	}
	if c.state.Operation == "management" || c.state.Operation == "lifecycle" {
		for _, run := range runs {
			if run.Status != "completed" {
				return needsAction("Observe the pending protected workflow before re-planning: " + c.target.runLink(run.ID))
			}
		}
		if err := requireApproval(c.operator, "The earlier read-only dispatch has no known result. Discard its local record and request a new observation?"); err != nil {
			return err
		}
		return c.clearDispatch()
	}
	return needsAction("A prior write dispatch has no verified workflow ID for its exact Preflight. Review GitHub Actions and the protected recovery runbook. The request will not be replayed")
}

func (c *workflowController) requireIdle(ctx context.Context, gh *githubControl) error {
	runs, err := gh.Recent(ctx)
	if err != nil {
		return err
	}
	for _, run := range runs {
		if run.Status != "completed" {
			return needsAction("A protected deployment workflow is already in progress: " + c.target.runLink(run.ID))
		}
	}
	return nil
}

func (c *workflowController) install(ctx context.Context, gh *githubControl, settings productionContract) error {
	reportStage(c.operator, managementStage, "Check pinned administrator SSH and sudo through GitHub Actions, then inspect the certified pair")
	if err := requireApproval(c.operator, "Run the protected read-only administrator SSH and sudo check?"); err != nil {
		return err
	}
	if _, err := c.execute(ctx, "management", nil); err != nil {
		return err
	}
	receipt, id, err := c.preflight(ctx, "bootstrap")
	if err != nil {
		return err
	}
	next, err := receipt.initialOperation()
	if err != nil {
		return c.lifecycleBlocker(id, err)
	}
	c.operator.Notice("Verified the management connection and a certified candidate pair in " + c.target.runLink(id) + ".")
	if next != publishFrontend {
		reportStage(c.operator, bootstrapStage, "Review the candidate and the approved database operation")
		c.operator.Notice(receipt.reviewSummary(c.target, id))
		if err := requireApproval(c.operator, "Run R4 through the existing protected Bootstrap workflow?"); err != nil {
			return err
		}
		question := "Separately approve initializing the positively absent logical Codexia database?"
		if next == resumeAuthOnly {
			question = "Separately approve continuing Auth from the verified database checkpoint?"
		}
		if err := requireApproval(c.operator, question); err != nil {
			return err
		}
		err = c.withBootstrapGates(ctx, gh, true, func() error {
			if err := requireFresh(receipt); err != nil {
				return err
			}
			_, err := c.execute(ctx, "bootstrap", map[string]string{
				"preflight_run_id": strconv.FormatInt(id, 10), "initialize_database": strconv.FormatBool(next == initializeDatabase),
			})
			return err
		})
		if err != nil {
			return err
		}
	} else {
		reportStage(c.operator, bootstrapStage, "Existing VM and Auth evidence make another R4 dispatch unnecessary")
	}
	// With setup already running, a fresh bootstrap receipt can authorize
	// delivery. The canonical on-host reader rechecks the live API and grant.
	if next == publishFrontend && receipt.setupForDelivery() && c.state.OwnerSetupRunID > 0 {
		reportStage(c.operator, frontendStage, "The certified Frontend is already live")
		reportStage(c.operator, ownerSetupStage, "The recorded Owner setup has a verified live grant")
		return c.deliver(ctx, gh, settings, receipt, nil)
	}
	if err := c.publishInitialFrontend(ctx); err != nil {
		return err
	}
	reportStage(c.operator, ownerSetupStage, "Verify the live Frontend and decide how to deliver the Owner grant")
	receipt, id, err = c.preflight(ctx, "bootstrap")
	if err != nil {
		return err
	}
	if _, err := receipt.initialOperation(); err != nil {
		return c.lifecycleBlocker(id, err)
	}
	if !receipt.frontendReady() {
		return needsAction("The certified Frontend was not observed on the normal Worker. Review the edge evidence and candidate in " + c.target.runLink(id))
	}
	if receipt.setupForDelivery() && c.state.OwnerSetupRunID > 0 {
		c.operator.Notice("The recorded Owner setup has a verified live grant.")
		return c.deliver(ctx, gh, settings, receipt, nil)
	}
	if err := c.requireSettingsWindow(ctx, gh); err != nil {
		return err
	}
	current, err := gh.Observe(ctx)
	if err != nil {
		return err
	}
	existing := current.Bootstrap.Variables[ownerRecipient]
	if receipt.Evidence.Host.Database.OwnerSetupCheckpoint.GrantBindingSHA != "" && existing == "" {
		return refused("An existing grant has no bound delivery recipient. Use the protected owner recovery procedure")
	}
	handoff, err := c.selectOwnerHandoff(receipt, existing)
	if err != nil {
		return err
	}
	c.operator.Notice(receipt.reviewSummary(c.target, id))
	if err := requireApproval(c.operator, "Run protected R5 owner-setup on the normal HTTPS origin and prepare the encrypted handoff?"); err != nil {
		return err
	}
	if err := requireFresh(receipt); err != nil {
		return err
	}
	if handoff.Recipient != existing {
		if err := c.currentMain(ctx); err != nil {
			return err
		}
		if err := c.requireSettingsWindow(ctx, gh); err != nil {
			return err
		}
		var expected *string
		if existing != "" {
			expected = &existing
		}
		if handoff.Ephemeral() {
			c.state.EphemeralRecipient = handoff.Recipient
			if err := c.store.Save(c.state); err != nil {
				return err
			}
		}
		if err := gh.PutVariable(ctx, bootstrapEnvironment, ownerRecipient, handoff.Recipient, expected); err != nil {
			return err
		}
		if !handoff.Ephemeral() && c.state.EphemeralRecipient != "" {
			c.state.EphemeralRecipient = ""
			if err := c.store.Save(c.state); err != nil {
				return err
			}
		}
	}
	if err := c.withBootstrapGates(ctx, gh, false, func() error {
		if err := c.requireSettingsWindow(ctx, gh); err != nil {
			return err
		}
		latest, err := gh.Observe(ctx)
		if err != nil {
			return err
		}
		if err := requireApprovedOwnerRecipient(latest, c.sha, handoff.Recipient); err != nil {
			return err
		}
		if err := requireFresh(receipt); err != nil {
			return err
		}
		_, err = c.execute(ctx, "owner-setup", map[string]string{"preflight_run_id": strconv.FormatInt(id, 10)})
		return err
	}); err != nil {
		return err
	}
	after, afterID, err := c.preflight(ctx, "bootstrap")
	if err != nil {
		return err
	}
	// The approved pair must still be the one being served after R5.
	if after.Plan.Target != receipt.Plan.Target || !after.setupForDelivery() {
		return refused("Post-setup evidence did not establish the same certified Frontend, setup-only API and live encrypted grant. Review " + c.target.runLink(afterID))
	}
	return c.deliver(ctx, gh, settings, after, handoff)
}

func requireApprovedOwnerRecipient(snapshot githubSnapshot, sha, recipient string) error {
	if snapshot.MainSHA != sha || recipient == "" || snapshot.Bootstrap.Variables[ownerRecipient] != recipient {
		return refused("The source or Owner recipient changed after approval. No Owner setup was dispatched")
	}
	return nil
}

func (c *workflowController) selectOwnerHandoff(receipt lifecycleReceipt, existing string) (*ownerHandoff, error) {
	grant := receipt.Evidence.Host.Database.OwnerSetupCheckpoint
	canReplace := grant.GrantBindingSHA == "" && !grant.PendingHandoff && !grant.EncryptedHandoffPresent &&
		receipt.Plan.Observation.State.B == "absent"
	if existing != "" && existing == c.state.EphemeralRecipient {
		if !canReplace {
			return nil, needsAction("The temporary decryption key was lost. Follow the independently approved Owner reissue procedure")
		}
		if err := requireApproval(c.operator, "The temporary recipient has no recoverable key and Preflight confirms no grant. Replace the public recipient?"); err != nil {
			return nil, err
		}
		return chooseHandoff(c.operator, "")
	}
	return chooseHandoff(c.operator, existing)
}

func (c *workflowController) publishInitialFrontend(ctx context.Context) error {
	reportStage(c.operator, frontendStage, "Verify the runtime SSH identity and the certified Frontend on the normal Worker")
	receipt, id, err := c.preflight(ctx, "runtime")
	if err != nil {
		return err
	}
	op, err := receipt.initialOperation()
	if err != nil {
		return c.lifecycleBlocker(id, err)
	}
	if op != publishFrontend {
		return refused("R4 completion was not established by the runtime Preflight. Review " + c.target.runLink(id))
	}
	if receipt.setupForDelivery() ||
		(receipt.frontendReady() && c.state.FrontendRunID > 0 && c.state.FrontendTarget == receipt.Plan.Target.FrontendArtifactSHA) {
		c.operator.Notice("The certified Frontend is already live. No publish workflow was dispatched.")
		return nil
	}
	c.operator.Notice(receipt.reviewSummary(c.target, id))
	if err := requireApproval(c.operator, "Publish the certified Full Frontend on the normal Worker for initial enrollment?"); err != nil {
		return err
	}
	if err := requireFresh(receipt); err != nil {
		return err
	}
	c.state.FrontendRunID, c.state.FrontendTarget = 0, receipt.Plan.Target.FrontendArtifactSHA
	_, err = c.execute(ctx, "frontend", map[string]string{"preflight_run_id": strconv.FormatInt(id, 10)})
	return err
}

func (c *workflowController) withBootstrapGates(ctx context.Context, gh *githubControl, database bool, run func() error) (err error) {
	if err := c.requireSettingsWindow(ctx, gh); err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		cleanupErr := c.restoreGates(cleanup, gh)
		if cleanupErr != nil {
			c.operator.Notice(cleanupErr.Error())
		}
		err = errors.Join(err, cleanupErr)
	}()
	if err := c.setGate(ctx, gh, enableBootstrap); err != nil {
		return err
	}
	if database {
		if err := c.setGate(ctx, gh, enableDatabase); err != nil {
			return err
		}
	}
	return run()
}

func requireFresh(receipt lifecycleReceipt) error {
	if !receipt.fresh(time.Now()) {
		return needsAction("The approved observation expired. Run a fresh protected Preflight")
	}
	return nil
}

func (c *workflowController) deliver(ctx context.Context, gh *githubControl, settings productionContract, receipt lifecycleReceipt, handoff *ownerHandoff) error {
	reportStage(c.operator, handoffStage, "Verify the live grant and deliver it to the Owner")
	if !receipt.setupForDelivery() || !c.target.matchesFullImage(receipt.Evidence.Candidate.BackendImage) {
		return refused("The setup API, Frontend and grant do not have verified live evidence")
	}
	current, err := gh.Observe(ctx)
	if err != nil {
		return err
	}
	recipient := current.Bootstrap.Variables[ownerRecipient]
	if current.MainSHA != c.sha || recipient == "" || (handoff != nil && handoff.Recipient != recipient) {
		return refused("The approved source or Owner recipient changed before delivery")
	}
	if handoff == nil {
		if recipient == c.state.EphemeralRecipient {
			return needsAction("The temporary decryption key was lost. Follow the independently approved Owner reissue procedure")
		}
		handoff, err = chooseHandoff(c.operator, recipient)
		if err != nil {
			return err
		}
	}
	if err := requireFresh(receipt); err != nil {
		return err
	}
	handoff.BackendImage = receipt.Evidence.Candidate.BackendImage
	handoff.GrantBindingSHA = receipt.Evidence.Host.Database.OwnerSetupCheckpoint.GrantBindingSHA
	if err := handoff.Deliver(ctx, c.operator, c.target, settings.PublicOrigin, settings.ServiceUID); err != nil {
		if errors.Is(err, errHandoffUnavailable) {
			c.operator.Notice("Owner recovery instructions: " + c.target.URL() + "/blob/main/deploy/ansible/AUTH-RUNTIME.md#first-owner-through-the-browser")
		}
		return err
	}
	c.operator.Notice("SETUP_PENDING. The Owner can enroll on " + settings.PublicOrigin + "/console/setup. ACTIVE: false. ACCEPTED: false.")
	c.operator.Notice("After the Owner enrolls in their browser, use the protected preparation and activation steps at " +
		c.target.URL() + "/blob/main/docs/deployment/PRODUCTION-BOOTSTRAP.md#run-r4-and-r5.")
	return nil
}
