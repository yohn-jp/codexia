# Infrastructure as code

**Normative lifecycle:** [Deployment lifecycle](DEPLOYMENT-LIFECYCLE.md) defines cross-component admission, route selection, shared exclusion and recovery. [Initial VM deployment](INITIAL-DEPLOYMENT-FLOW.md), [Compatible backend updates](UPDATE-FLOW.md), and [system design](../architecture/SYSTEM-DESIGN.md) specify the approved state transitions. The implemented `bootstrap` operation and individually supported stages must conform to them.

The sole backend delivery path is **GitHub Actions → Tailscale OIDC → pinned SSH → Ansible → rootless Podman Quadlet**. Cloudflare Tunnel remains application ingress, not the administration channel. No pull updater, polling timer, signed release channel, reverse-proxy selector or alternate writer controller is maintained.

The canonical production tasks are in [Ansible](../../deploy/ansible/README.md) and the Quadlet definitions in [Quadlet](../../deploy/quadlet). The protected production workflow verifies a certified immutable Full GHCR digest and its provenance, serializes deployment under a rootless host lock, requires a verified encrypted backup for compatible image changes and probes readiness. Pull-request validation receives no production credentials.

対象 VM の SSH セッションから実行する [codexiactl](CODEXIACTL.md) は初回の管理接続準備、外部認証、GitHub の保護入力整備と既存 operation の起動に限定する。Ansible は従来どおり Runner で実行し、CLI は Ansible の代替構成管理・常駐配備主体ではない。

## VMから管理者登録までの責務

- **入力VMの基準:** AnsibleからSSH接続でき、権限付きで構成変更できること。Ubuntu 26.04 x86-64、systemd/cgroup v2、UID/GIDと既存データの同一性はAnsibleが検査する。VM提供基盤やTerraformを必須の前提としない。
- **Ansibleの責務:** host/secrets/base/auth-runtimeを宣言的に構成し、DBが明示承認された新規空状態である場合に限ってCSPRNGの256-bit一回限りの初期登録キーを発行する。所有者とPasskeyをAnsible/SQLで登録しない。キー本体は一度だけ承認された安全な経路で所有者本人へ配送し、ログ・fact・CI artifactには載せない。再実行してもキーやownerを再生成しない。
- **ブラウザーとAPIの責務:** Workers Static Assetsの`/console/setup`から、初期キー＋Better Auth WebAuthnでownerを一人だけ登録する。VMのFastify APIは本番展開前にsetup-only経路だけを許可し、原稿・MCPと一般登録を拒否する。管理者用のSSH一時登録サーバー起動は通常操作にしない。
- **配備の責務:** setup成功後もWorkersの管理コンソールからインフラを変更しない。正本DB、owner、OAuth clients、暗号化backup、証明済みdigest、公開経路を確認して保護されたactivationへ移行する。初回は R5 で通常 Frontend を配備してから、R6 で Backend を起動する。
- **復旧の責務:** VM再構築時は独立バックアップ、PostgreSQL roles、Podman Secrets等を復元して同じBetter Auth owner IDを維持する。owner/認証DBの復旧が不明なら初回キーを発行しない。詳細は[初期導入・復旧の状態遷移](INITIAL-DEPLOYMENT-FLOW.md)を正本とする。

承認済みの新規 VM では、R4 が認証 DB を準備する。続く R5 の owner-setup が初回登録キーを発行し、暗号化した配送用ファイルを作成して、setup-only API と Tunnel を起動する。
配備先の VM と Cloudflare 経路を検証してから、登録キーを所有者に引き渡す。[ブラウザーでの初回登録手順](../../deploy/ansible/AUTH-RUNTIME.md#first-owner-through-the-browser)

## Supported Ansible operations

| Stage | Responsibility |
| --- | --- |
| `inspect` | Read-only host and Podman inventory |
| `bootstrap` | Converge the declared host, SSH deployment key, protected base secrets and base runtime. Include authentication provisioning when approved. |
| `host` | Rootless service account and host prerequisites |
| `secrets` | Initial protected Podman credential convergence |
| `base` | Networks, persistent volumes, PostgreSQL and Tunnel Quadlets |
| `auth-runtime` | Approved application schema initialization for a pristine database, Better Auth role, schema and protected runtime secrets |
| `deploy` | Approved pristine-schema first activation or certified image update, with verified encrypted backup for the update. Both verify application health and support rollback |
| `deploy-lifecycle-fixture` | GitHub Actions disposable-host verification only; local `localhost` connection, run-bound source evidence and the shared deployment transaction, with production admission kept on `deploy` |
| `restore-drill` | Isolated encrypted backup restoration and checksum verification |

Unsupported operations fail closed. The lifecycle fixture stage targets only a local `localhost` inventory entry and requires a matching GitHub Actions run with exact run-bound image evidence. It is not a production deployment input. Database schema changes require a separate approved migration process; image-only deployment refuses incompatible migration fingerprints, persistence formats and API epochs.

Runtime state lives only in `~/.local/state/codexia-deploy`, with the host lock, deployment release record and interruption recovery intent. There is no polling journal or route selector.

Require pinned SSH host keys, explicit operator approval and main-only GitHub Environment restrictions and a run-local inventory generated from the [public configuration](../../deploy/production.json) and protected target inputs. The VM generates internal credentials on approved fresh storage. No backup or recovery input is required for a genuine fresh R4–R6. Independent key custody and recovery acceptance follow normal Console availability; recovery of existing data uses the [independent recovery procedure](BACKUP.md#通常運用のバックアップと災害復旧). Never put credentials or private keys in Git.

`bootstrap` runs `host`, `secrets`, `base`, and the approved `auth-runtime` tasks in order. It initializes the application schema from the reviewed immutable Full image before provisioning the auth schema on a pristine database. Complete the protected browser enrollment procedure before requesting activation. Full activation requires both protected first-install and database-use approvals and a certified image. [Push deployment](PUSH-DEPLOYMENT.md#first-application-activation)

[Backup](BACKUP.md) and [Host bootstrap acceptance](PUSH-HOST-CI.md) describe independent restore and disposable-host verification. Production acceptance also requires observations on the target VM and its public route.
