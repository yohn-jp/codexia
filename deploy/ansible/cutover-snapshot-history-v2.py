def validate(prior, target, require):
    require(prior["persistenceFormat"] == 1 and target["persistenceFormat"] == 2 and
            prior["migrationFingerprint"] == target["migrationFingerprint"],
            "Snapshot and history conversion requires its approved persistence formats and unchanged ledger")


def prepare(image, database_maintenance, history_maintenance):
    return database_maintenance(image, "--check") == 2, history_maintenance(image, "--check") == 2


def apply(pending, image, database_maintenance, history_maintenance, require):
    for needed, operation in zip(pending, (database_maintenance, history_maintenance), strict=True):
        if needed:
            operation(image, "--apply")
    require(database_maintenance(image, "--check") == 0 and history_maintenance(image, "--check") == 0,
            "Post-conversion database or history verification still reports unfinished maintenance")
