package main

import (
	"context"
	"errors"
)

type bootstrapKeyHost interface {
	BootstrapKeyInstalled(string) (bool, error)
	InstallBootstrapKey(context.Context, string) error
}

type bootstrapKeyControl interface {
	PutSecret(context.Context, string, string, []byte) error
}

func (c *workflowController) registerBootstrapKey(ctx context.Context, control bootstrapKeyControl, host bootstrapKeyHost, present bool) error {
	switch {
	case c.state.BootstrapPublicKey != "":
		installed, err := host.BootstrapKeyInstalled(c.state.BootstrapPublicKey)
		if err != nil {
			return err
		}
		if present {
			switch c.state.BootstrapKeyWrite {
			case "prepared":
				if installed {
					return refused("A prepared key was already installed externally. Verify the bootstrap SSH identity independently")
				}
				return c.clearBootstrapKey()
			case "unresolved", "registered":
				if c.state.SettingsWriterID == "" {
					return refused("The pending upload has no matching settings writer window")
				}
				return c.finishBootstrapKey(ctx, host, installed)
			default:
				return needsAction("An older checkpoint cannot bind the existing Secret to its public key. Verify the SSH identity through the protected runbook")
			}
		}
		if installed {
			return refused("The checkpoint public key is installed without a verified protected Secret. Reconcile it without changing authorized_keys")
		}
		if err := requireApproval(c.operator, "The protected Secret and its local public key are absent. Confirm there is no outstanding GitHub write and discard the unused key checkpoint?"); err != nil {
			return err
		}
		if err := c.clearBootstrapKey(); err != nil {
			return err
		}
	case present:
		return nil
	}

	if err := c.currentMain(ctx); err != nil {
		return err
	}
	private, public, err := newSSHIdentity()
	if err != nil {
		return err
	}
	defer clear(private)
	c.state.BootstrapPublicKey, c.state.BootstrapKeyWrite = public, "prepared"
	if err := c.store.Save(c.state); err != nil {
		return err
	}
	c.state.BootstrapKeyWrite = "unresolved"
	if err := c.store.Save(c.state); err != nil {
		return err
	}
	err = control.PutSecret(ctx, bootstrapEnvironment, bootstrapSSHSecret, private)
	if err != nil {
		if errors.Is(err, errGitHubSecretWriteUnknown) {
			return err
		}
		return errors.Join(err, c.clearBootstrapKey())
	}
	return c.finishBootstrapKey(ctx, host, false)
}

func (c *workflowController) finishBootstrapKey(ctx context.Context, host bootstrapKeyHost, installed bool) error {
	c.state.BootstrapKeyWrite = "registered"
	if err := c.store.Save(c.state); err != nil {
		return err
	}
	if !installed {
		if err := c.currentMain(ctx); err != nil {
			return err
		}
		if err := host.InstallBootstrapKey(ctx, c.state.BootstrapPublicKey); err != nil {
			return err
		}
	}
	return c.clearBootstrapKey()
}

func (c *workflowController) clearBootstrapKey() error {
	c.state.BootstrapPublicKey, c.state.BootstrapKeyWrite = "", ""
	return c.store.Save(c.state)
}
