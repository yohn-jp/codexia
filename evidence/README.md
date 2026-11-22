# Verification inputs

`migration/` contains the closed migration ledger and supporting inputs. The files retain their original bytes and repository-relative locators. To recheck the target implementation paths, run `node scripts/verify-migration-ledger.mjs` from a checkout of the [archived campaign revision](https://github.com/yohn-jp/codexia/tree/e143820b22641634d03f841d0aa8d0d875ff83cd). That revision contains the implementation paths named by the ledger. Its verifier resolves the `docs/` locators inside `migration/`. Locators within retained narrative evidence describe the source revision recorded by that evidence.

`performance/` contains immutable runtime and artifact identities required by performance probes. New measurement output belongs outside the checkout or under the ignored `artifacts/` directory.

Historical references (not current performance or implementation claims):

- [Original reboot RFC](history/CODEXIA-REBOOT-RFC.md) preserves predecessor source observations and provenance; current authority remains in the maintained documentation.
- [Original raw measurement archive manifest](performance/wave0/INDEX.json) identifies the historical Scriptorium release asset and exact bytes. Follow the [manifest-driven verification procedure](../docs/performance/README.md#immutable-historical-evidence).
- [Legacy Core64 measurements](performance/legacy-core64/README.md) retain the previously tracked build and memory evidence without modification to raw files.

Product documentation is in [docs](../docs/README.md). Git history retains removed execution reports and planning material.
