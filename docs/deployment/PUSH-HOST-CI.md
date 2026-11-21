# Push host bootstrap acceptance

The dedicated [push-host workflow](../../.github/workflows/push-host.yml) is manually runnable and also validates relevant pull requests. It uses an isolated Ubuntu 26.04 runner and holds no production SSH, registry or application secrets.

The fixture executes the canonical `host` stage twice under a dedicated bootstrap account, checks the `codexia` rootless account, systemd lingering, network generator and rootless Podman. It emits source-SHA/run-bound JSON evidence, a bounded redacted log and verifies cleanup of the fixture-owned account.

This is **not** acceptance of production deployment, backup restoration, application health, or reboot recovery. Reboot is explicitly `NOT_CHECKED`. The production deployment workflow and the backup/restore acceptance are separate proof boundaries.

No polling, signed update channel or alternate deployment controller is present.
