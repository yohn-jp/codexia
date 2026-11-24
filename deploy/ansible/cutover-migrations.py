import runpy


# Only these checked-in modules may run on the protected host. Operator
# requests provide a resolved ID and never a command or module path.
HANDLERS = {"snapshot-history-v2": "cutover-snapshot-history-v2.py"}


def load_cutover_migration(migration_id, directory, require):
    if migration_id is None:
        return None
    require(isinstance(migration_id, str) and migration_id in HANDLERS,
            "No certified host migration handler matches the plan")
    return runpy.run_path(str(directory / HANDLERS[migration_id]))
