"""Validate the service user's rootless subordinate-ID mappings; no writes."""
import sys
from pathlib import Path


def validate_ranges(text, user, uid):
    ranges = []
    for line in text.splitlines():
        if not line.strip():
            continue
        fields = line.split(":")
        if len(fields) != 3 or not fields[0] or not all(v.isascii() and v.isdecimal() for v in fields[1:]):
            raise ValueError("Malformed subordinate-ID entry")
        owner, start, count = fields[0], int(fields[1]), int(fields[2])
        if start < 0 or count < 1 or start + count > 2**32 - 1:
            raise ValueError("Invalid subordinate-ID interval")
        ranges.append((owner, start, start + count))
    own = [i for i, (owner, _, _) in enumerate(ranges) if owner in (user, str(uid))]
    if not any(ranges[i][2] - ranges[i][1] >= 65536 for i in own):
        raise ValueError("Service account lacks a contiguous 65536-ID mapping")
    for i in own:
        _, start, end = ranges[i]
        if start < 65536 or start <= uid < end:
            raise ValueError("Service mapping overlaps reserved IDs or service UID")
        if any(j != i and start < other_end and other_start < end
               for j, (_, other_start, other_end) in enumerate(ranges)):
            raise ValueError("Service subordinate-ID mapping overlaps another mapping")


if __name__ == "__main__":
    try:
        user, uid, gid = sys.argv[1:]
        validate_ranges(Path("/etc/subuid").read_text(), user, int(uid))
        validate_ranges(Path("/etc/subgid").read_text(), user, int(gid))
    except (OSError, ValueError) as exc:
        sys.exit(str(exc))
    print("Validated subordinate UID/GID mappings")
