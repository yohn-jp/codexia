from pathlib import Path

from strictdoc.core.project_config import ProjectConfig


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def create_config() -> ProjectConfig:
    return ProjectConfig(
        project_title="Codexia Requirements",
        source_root_path=str(REPOSITORY_ROOT),
        include_doc_paths=[
            "/REQUIREMENT-REGISTER.md",
            "/STRICTDOC-GRAMMAR.gra.md",
        ],
    )
