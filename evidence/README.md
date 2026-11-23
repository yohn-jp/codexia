# Archived migration proof

`migration/` is the closed PostgreSQL migration ledger and its original acceptance evidence. This is retained as an immutable provenance input; it is not a runtime compatibility requirement.

To recheck it against the implementation at the archived source revision, use `node scripts/verify-migration-ledger.mjs` from the [archived campaign checkout](https://github.com/yohn-jp/codexia/tree/e143820b22641634d03f841d0aa8d0d875ff83cd). The recorded locators belong to that revision.

Historical performance measurements, test-audit ledgers, and UI redesign captures were removed from the active tree. Their exact versions remain accessible in [Git history](https://github.com/yohn-jp/codexia/tree/91b6cb64a85da6c8f4b864a5843ac7fb776e08fa/evidence); current verification produces independent GitHub Actions artifacts instead of checking in runs.
