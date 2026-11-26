"""Independent, bounded S3 connectivity probe for console destination drafts.

The operator policy is supplied by protected executor configuration. A probe
never accepts an arbitrary URL or bucket/prefix and writes only a unique key
under the already-approved prefix. It does not alter retention or bucket policy.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import secrets
from typing import Any

import s3_transfer


class ProbeError(Exception):
    """Redacted and classifiable destination-probe failure."""

    def __init__(self, reason_code: str):
        super().__init__(reason_code)
        self.reason_code = reason_code


def validate_destination(draft: dict[str, Any], operator_policy: dict[str, Any]) -> dict[str, Any]:
    """Validate caller draft against immutable operator egress/object bounds."""
    try:
        profile = s3_transfer.validate_profile({
            "schemaVersion": 1,
            "provider": draft.get("provider"),
            "region": draft.get("region"),
            "bucket": draft.get("bucket"),
            "prefix": draft.get("prefix"),
            "endpointUrl": draft.get("endpoint"),
            "allowedOrigins": (list(dict.fromkeys(item.get("origin") for item in operator_policy.get("destinations", [])
                                if isinstance(item, dict) and item.get("provider") == "s3-compatible"
                                and isinstance(item.get("origin"), str)))
                               if draft.get("provider") == "s3-compatible" else []),
            "addressingStyle": draft.get("addressingStyle", "virtual" if draft.get("provider") == "aws-s3" else "path"),
        })
    except (s3_transfer.TransferError, AttributeError, TypeError) as error:
        raise ProbeError("invalid_destination") from error

    destinations = operator_policy.get("destinations")
    if not isinstance(destinations, list):
        raise ProbeError("destination_policy_unavailable")
    expected_origin = profile["endpointUrl"]
    if profile["provider"] == "aws-s3":
        if not re.fullmatch(r"(?:af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-\d+", profile["region"]):
            raise ProbeError("unsupported_aws_region")
        expected_origin = f"https://s3.{profile['region']}.amazonaws.com"
    match = next((item for item in destinations if isinstance(item, dict)
                  and item.get("provider") == profile["provider"]
                  and item.get("bucket") == profile["bucket"]
                  and _prefix_allowed(profile["prefix"], item.get("prefix"))
                  and item.get("origin") == expected_origin), None)
    if match is None:
        raise ProbeError("destination_not_allowed")
    # Endpoint TLS and exceptional private fixture policy come only from
    # protected operator configuration, never from a browser draft.
    if match.get("caBundle") is not None:
        ca_bundle = match["caBundle"]
        if not isinstance(ca_bundle, str) or not ca_bundle.startswith("/"):
            raise ProbeError("invalid_operator_policy")
        profile["caBundle"] = ca_bundle
    profile["_allowedPrivateAddresses"] = _private_allowlist(match.get("allowedPrivateAddresses", []))
    profile["_allowProbeCleanup"] = match.get("allowProbeCleanup", False) is True
    return profile


def _prefix_allowed(prefix: str, allowed: Any) -> bool:
    return isinstance(allowed, str) and (prefix == allowed.rstrip("/") or prefix.startswith(allowed.rstrip("/") + "/"))


def _private_allowlist(value: Any) -> tuple[str, ...]:
    try:
        return s3_transfer.validate_private_addresses(value)
    except s3_transfer.TransferError as error:
        raise ProbeError("invalid_operator_policy") from error


def probe_destination(
    draft: dict[str, Any],
    operator_policy: dict[str, Any],
    *,
    client: Any | None = None,
) -> dict[str, Any]:
    """PUT and GET a unique synthetic payload, verify exact bytes, then clean up.

    `client` is an injected fixture boundary only. Production clients are made
    through s3_transfer._make_client, which pins DNS answers, rejects private
    addresses and proxies, validates every request origin, and does not follow
    redirects. The probe does not return endpoint or bucket details.
    """
    profile = validate_destination(draft, operator_policy)
    if client is None:
        try:
            credentials = draft.get("credential")
            if not isinstance(credentials, dict):
                raise ProbeError("credentials_unavailable")
            if set(credentials) - {"accessKeyId", "secretAccessKey", "sessionToken"}:
                raise ProbeError("invalid_credentials")
            if not all(isinstance(credentials.get(name), str) and credentials[name]
                       for name in ("accessKeyId", "secretAccessKey")):
                raise ProbeError("invalid_credentials")
            client = _make_explicit_client(profile, credentials)
        except Exception as error:
            if isinstance(error, ProbeError):
                raise
            raise ProbeError("transport_unavailable") from error

    token = secrets.token_hex(24)
    key = f"{profile['prefix']}/.codexia-probes/{token}"
    body = ("codexia-s3-probe/v1:" + token).encode("ascii")
    digest = hashlib.sha256(body).hexdigest()
    written = False
    failure_reason: str | None = None
    capabilities = {"bucketVersioning": "unknown", "objectLock": "unknown", "defaultRetentionDays": None}
    try:
        put_result = client.put_object(Bucket=profile["bucket"], Key=key, Body=body,
                                       Metadata={"sha256": digest}, IfNoneMatch="*")
        written = True
        response = client.get_object(Bucket=profile["bucket"], Key=key)
        stream = response.get("Body")
        if stream is None:
            raise ProbeError("readback_failed")
        try:
            actual = stream.read(len(body) + 1)
        finally:
            close = getattr(stream, "close", None)
            if callable(close):
                close()
        if actual != body:
            raise ProbeError("readback_mismatch")
        capabilities = _observe_retention_capabilities(client, profile, draft.get("retentionRequest"))
    except ProbeError as error:
        failure_reason = error.reason_code
    except Exception as error:
        failure_reason = _classify_failure(error)
    finally:
        cleanup_succeeded = not written
        cleanup_allowed = profile["_allowProbeCleanup"]
        cleanup_attempted = written and cleanup_allowed
        if cleanup_attempted:
            try:
                delete_args = {"Bucket": profile["bucket"], "Key": key}
                version_id = put_result.get("VersionId") if isinstance(put_result, dict) else None
                if version_id:
                    delete_args["VersionId"] = version_id
                client.delete_object(**delete_args)
                cleanup_succeeded = True
            except Exception:
                # Probe outcome remains readback-based; report cleanup state to
                # the caller so the orphaned unique test key can be investigated.
                pass
    return {"status": "FAILED" if failure_reason else "PASSED", "reasonCode": failure_reason,
            "cleanupAttempted": cleanup_attempted,
            "cleanupStatus": "removed" if cleanup_succeeded and cleanup_attempted else
                             "orphaned_unique_probe_key" if cleanup_attempted else
                             "unknown_maybe_orphaned" if failure_reason and not written else "retained_by_policy",
            **capabilities}


def _make_explicit_client(profile: dict[str, Any], credential: dict[str, str]) -> Any:
    """Build through the existing guarded S3 transport, with no ambient-chain fallback."""
    try:
        import boto3
        from botocore.config import Config
    except ImportError as error:
        raise ProbeError("transport_unavailable") from error
    session = boto3.session.Session(
        aws_access_key_id=credential["accessKeyId"],
        aws_secret_access_key=credential["secretAccessKey"],
        aws_session_token=credential.get("sessionToken"),
    )
    config = Config(signature_version="s3v4", proxies={}, s3={"addressing_style": profile["addressingStyle"]},
                    retries={"mode": "standard", "total_max_attempts": 2}, connect_timeout=5, read_timeout=15,
                    request_checksum_calculation="when_required", response_checksum_validation="when_required")
    endpoint_url = profile.get("endpointUrl")
    if profile["provider"] == "aws-s3":
        endpoint_url = f"https://s3.{profile['region']}.amazonaws.com"
    client = session.client("s3", region_name=profile["region"], endpoint_url=endpoint_url,
                            config=config, verify=profile.get("caBundle") or True)
    guard = s3_transfer.EndpointGuard(profile, client.meta.endpoint_url,
                                      allowed_private_addresses=profile.get("_allowedPrivateAddresses", ()))
    s3_transfer._install_pinned_https_transport(client, guard)
    client.meta.events.register_first("before-send.s3", guard.before_send)
    client.meta.events.register_first("needs-retry.s3", guard.needs_retry)
    return client


def _is_denied(error: Exception) -> bool:
    response = getattr(error, "response", None)
    if isinstance(response, dict):
        code = response.get("Error", {}).get("Code")
        return code in {"AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "ExpiredToken"}
    return False


def _classify_failure(error: Exception) -> str:
    if _is_denied(error):
        return "access_denied"
    if isinstance(error, s3_transfer.TransferError):
        message = str(error).lower()
        if "redirect" in message:
            return "redirect_rejected"
        if "dns" in message or "resolved" in message:
            return "dns_validation_failed"
        if "endpoint" in message or "proxy" in message or "address" in message:
            return "egress_policy_blocked"
    return "transport_failed"


def _observe_retention_capabilities(client: Any, profile: dict[str, Any], request: Any) -> dict[str, Any]:
    result = {"bucketVersioning": "unknown", "objectLock": "unknown", "defaultRetentionDays": None}
    if request is None:
        return result
    if not isinstance(request, dict):
        raise ProbeError("invalid_retention_request")
    try:
        versioning = client.get_bucket_versioning(Bucket=profile["bucket"])
        result["bucketVersioning"] = "enabled" if versioning.get("Status") == "Enabled" else "disabled"
    except Exception:
        result["bucketVersioning"] = "unknown"
    try:
        response = client.get_object_lock_configuration(Bucket=profile["bucket"])
        configuration = response.get("ObjectLockConfiguration", {})
        result["objectLock"] = "enabled" if configuration.get("ObjectLockEnabled") == "Enabled" else "disabled"
        default = configuration.get("Rule", {}).get("DefaultRetention", {})
        days = default.get("Days")
        years = default.get("Years")
        if type(days) is int and days > 0 and years is None:
            result["defaultRetentionDays"] = days
        elif type(years) is int and years > 0 and days is None:
            # A calendar year always covers at least 365 days, including leap years.
            result["defaultRetentionDays"] = years * 365
    except Exception as error:
        code = getattr(error, "response", {}).get("Error", {}).get("Code") if isinstance(getattr(error, "response", None), dict) else None
        if code == "ObjectLockConfigurationNotFoundError":
            result["objectLock"] = "disabled"
    return result


def main() -> int:
    """Read one bounded JSON request from stdin; never echo input or exceptions."""
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict) or set(request) != {"draft", "operatorPolicy"}:
            raise ProbeError("invalid_request")
        draft = request["draft"]
        policy = request["operatorPolicy"]
        if not isinstance(draft, dict) or not isinstance(policy, dict):
            raise ProbeError("invalid_request")
        result = probe_destination(draft, policy)
        sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
        return 0
    except ProbeError as error:
        sys.stdout.write(json.dumps({"status": "FAILED", "reasonCode": error.reason_code}, separators=(",", ":")) + "\n")
        return 1
    except Exception:
        sys.stdout.write('{"status":"FAILED","reasonCode":"internal_error"}\n')
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
