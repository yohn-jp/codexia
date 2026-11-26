"""Schemathesis 4.34.2: verify domain-aware acceptance without status-only exceptions."""
import atexit
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlsplit

import schemathesis
from schemathesis.specs.openapi.checks import positive_data_acceptance

ROOT = Path(__file__).resolve().parents[3]
WORKER = Path(__file__).with_name("semantic-worker.mjs")
EVIDENCE = Path(os.environ["CODEXIA_HTTP_SEMANTIC_EVIDENCE"])
OPERATIONS = {
    "GET /api/v1/persistence/projects",
    "GET /api/v1/persistence/projects/{projectId}/nodes",
    "POST /api/v1/persistence/import",
    "POST /api/v1/persistence/projects/{projectId}/changesets",
    "PATCH /api/v1/persistence/projects/{projectId}/documents/{documentId}",
    "POST /api/v1/persistence/projects/{projectId}/nodes/{nodeId}/merge-preview",
}
_worker = None


def expected_rejection(case, response):
    global _worker
    if _worker is None:
        env = {
            key: value for key, value in os.environ.items()
            if not any(word in key.upper() for word in ("TOKEN", "SECRET", "PASSWORD", "DATABASE_URL"))
        }
        _worker = subprocess.Popen(
            ["node", "--import", "tsx", str(WORKER)], cwd=ROOT, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8",
        )
    request = response.request
    headers = {
        name: request.headers[name]
        for name in ("x-client-id", "idempotency-key")
        if name in request.headers
    }
    _worker.stdin.write(json.dumps({
        "operation": case.operation.label,
        "params": case.path_parameters or {},
        "query": urlsplit(request.url).query,
        "headers": headers,
        "body": json.loads(request.body) if request.body else None,
    }) + "\n")
    _worker.stdin.flush()
    line = _worker.stdout.readline()
    assert line, "semantic oracle exited without a result"
    reply = json.loads(line)
    assert "error" not in reply, f"semantic oracle failed: {reply.get('error')}"
    return reply["result"]


@atexit.register
def close_worker():
    if _worker is None:
        return
    _worker.stdin.close()
    try:
        _worker.wait(timeout=5)
    except subprocess.TimeoutExpired:
        _worker.kill()
        _worker.wait()


@schemathesis.check
def codexia_positive_data_acceptance(ctx, response, case):
    if (
        case.meta is not None
        and case.meta.generation.mode.is_positive
        and response.status_code in (400, 413)
        and case.operation.label in OPERATIONS
    ):
        expected = expected_rejection(case, response)
        if expected is not None:
            actual = response.json()
            assert response.status_code == expected["status"], "incorrect semantic rejection status"
            assert actual.get("code") == expected["code"], "incorrect semantic rejection code"
            assert actual.get("error") == expected["error"], "incorrect semantic rejection detail"
            with EVIDENCE.open("a", encoding="utf-8") as evidence:
                evidence.write(json.dumps({
                    "caseId": case.id, "operation": case.operation.label,
                    "status": expected["status"], "code": expected["code"],
                    "reason": expected["error"],
                }) + "\n")
            return None
    return positive_data_acceptance(ctx, response, case)
