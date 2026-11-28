from os import environ
from pathlib import Path

from strictdoc.core.project_config import ProjectConfig


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
# The operational Access procedure contains provider account and policy IDs.
PUBLIC_EXCLUSIONS = ["/deployment/ACCESS-POLICY-MIGRATION.sdoc"]


def create_config() -> ProjectConfig:
    return ProjectConfig(
        project_title="Codexia Design and Requirements",
        source_root_path=str(REPOSITORY_ROOT),
        include_doc_paths=["/*.sdoc", "/**/*.sdoc", "/requirements/codexia.sgra"],
        exclude_doc_paths=PUBLIC_EXCLUSIONS if environ.get("CODEXIA_STRICTDOC_PUBLIC") == "1" else [],
        lazy_document_loading_threshold=0,
        grammars={"@codexia": "requirements/codexia.sgra"},
    )
