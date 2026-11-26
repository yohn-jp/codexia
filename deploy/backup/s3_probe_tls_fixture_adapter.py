"""Test-only stdin adapter: run the production probe CLI against local TLS S3.

The caller must provide an otherwise valid compatible destination. Its exact
admission is checked first; only then is the origin remapped to the local TLS
fixture, whose address and CA are installed in test-only protected policy.
"""
from __future__ import annotations

import io
import json
import sys
from unittest.mock import patch

from test_s3_probe_tls_fixture import ProbeTlsFixtureTests
import s3_probe


def main() -> int:
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict) or set(request) != {"draft", "operatorPolicy"}:
            raise s3_probe.ProbeError("invalid_request")
        draft, policy = request["draft"], request["operatorPolicy"]
        admitted = s3_probe.validate_destination(draft, policy)
        if admitted["provider"] != "s3-compatible":
            raise s3_probe.ProbeError("fixture_requires_s3_compatible")

        fixture = ProbeTlsFixtureTests("runTest")
        ProbeTlsFixtureTests.setUpClass()
        fixture.setUp()
        try:
            # Keep the caller's bucket/prefix and post-decryption test identity,
            # while redirecting only the already-admitted endpoint into a local
            # TLS fixture. No external hostname or public network is contacted.
            new_draft = dict(draft)
            new_draft["endpoint"] = f"https://objects.fixture.test:{ProbeTlsFixtureTests.port}"
            new_draft["addressingStyle"] = "path"
            new_policy = {"destinations": [{
                "provider": "s3-compatible", "bucket": admitted["bucket"],
                "prefix": admitted["prefix"], "origin": new_draft["endpoint"],
                "caBundle": str(ProbeTlsFixtureTests.ca),
                "allowedPrivateAddresses": [ProbeTlsFixtureTests.private_ip],
                "allowProbeCleanup": True,
            }]}
            stdin_data = json.dumps({"draft": new_draft, "operatorPolicy": new_policy})
            with patch.object(sys, "stdin", io.StringIO(stdin_data)), patch.object(sys, "stdout", io.StringIO()) as output:
                status = s3_probe.main()
                result = output.getvalue()
            sys.stdout.write(result)
            return status
        finally:
            fixture.doCleanups()
            ProbeTlsFixtureTests.tearDownClass()
    except s3_probe.ProbeError as error:
        sys.stdout.write(json.dumps({"status": "FAILED", "reasonCode": error.reason_code}, separators=(",", ":")) + "\n")
        return 1
    except Exception:
        sys.stdout.write('{"status":"FAILED","reasonCode":"fixture_error"}\n')
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
