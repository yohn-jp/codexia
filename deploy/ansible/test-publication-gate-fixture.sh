#!/usr/bin/env bash
# Sourced only by disposable Ubuntu CI jobs. The management readiness listener
# stays on loopback and never uses a Cloudflare account or connector credential.

fixture_management_owned=false

start_fixture_management() {
  local repo="$1" scratch="$2" path
  [[ "${GITHUB_ACTIONS:-}" == true && "$(lsb_release -rs)" == 26.04 ]] || return 1
  for path in /usr/bin/cloudflared /etc/systemd/system/codexia-cloudflared.service \
    /run/systemd/system/codexia-cloudflared.service.d /run/codexia-fixture-management.py \
    /usr/local/lib/systemd/system/codexia-api.socket /usr/local/lib/systemd/system/codexia-api-gate.service \
    /etc/systemd/system/codexia-api.socket /etc/systemd/system/codexia-api-gate.service \
    /etc/systemd/system/sockets.target.wants/codexia-api.socket \
    /usr/local/sbin/codexia-api-gate /etc/sudoers.d/codexia-api-gate; do
    if [[ -e "$path" || -L "$path" ]]; then
      printf 'Refusing to replace pre-existing publication fixture input: %s\n' "$path" >&2
      return 1
    fi
  done
  mkdir -m 0700 "$scratch/cloudflared-download"
  RUNNER_TEMP="$scratch/cloudflared-download" bash "$repo/scripts/deployment/ssh/install-cloudflared.sh"
  fixture_management_owned=true
  sudo install -m 0755 "$scratch/cloudflared-download/cloudflared" /usr/bin/cloudflared
  sudo install -m 0644 "$repo/cmd/codexiactl/assets/codexia-cloudflared.service" /etc/systemd/system/
  cat > "$scratch/management.py" <<'PY'
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class ManagementFixture(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == "/ready" else 404)
        self.end_headers()

ThreadingHTTPServer(("127.0.0.1", 2000), ManagementFixture).serve_forever()
PY
  # The production unit uses DynamicUser. The fixture runs under umask 077,
  # so copy the public test script with explicit read access for that UID.
  sudo install -m 0644 "$scratch/management.py" /run/codexia-fixture-management.py
  sudo install -d -m 0755 /run/systemd/system/codexia-cloudflared.service.d
  sudo tee /run/systemd/system/codexia-cloudflared.service.d/fixture.conf >/dev/null <<'UNIT'
[Service]
LoadCredential=
ExecStart=
ExecStart=/usr/bin/python3 /run/codexia-fixture-management.py
UNIT
  sudo systemctl daemon-reload
  sudo systemctl start codexia-cloudflared.service
  if ! curl --noproxy '*' --fail --silent --show-error --retry 10 --retry-connrefused \
      --retry-delay 1 --retry-max-time 15 --max-time 3 http://127.0.0.1:2000/ready; then
    sudo journalctl -u codexia-cloudflared.service -n 30 --no-pager >&2
    return 1
  fi
  fixture_management_pid=$(systemctl show --property=MainPID --value codexia-cloudflared.service)
  [[ "$fixture_management_pid" -gt 1 ]]
}

assert_fixture_management_continues() {
  systemctl is-active --quiet codexia-cloudflared.service &&
    [[ "$(systemctl show --property=MainPID --value codexia-cloudflared.service)" == "$fixture_management_pid" ]] &&
    curl --noproxy '*' --fail --silent --show-error --max-time 3 http://127.0.0.1:2000/ready
}

cleanup_fixture_management() {
  [[ "$fixture_management_owned" == true ]] || return 0
  local result=0
  sudo systemctl stop codexia-api.socket codexia-api-gate.service codexia-cloudflared.service >/dev/null 2>&1 || true
  sudo rm -f -- /usr/bin/cloudflared /etc/systemd/system/codexia-cloudflared.service \
    /run/systemd/system/codexia-cloudflared.service.d/fixture.conf /run/codexia-fixture-management.py \
    /usr/local/lib/systemd/system/codexia-api.socket /usr/local/lib/systemd/system/codexia-api-gate.service \
    /etc/systemd/system/codexia-api.socket /etc/systemd/system/codexia-api-gate.service \
    /etc/systemd/system/sockets.target.wants/codexia-api.socket \
    /usr/local/sbin/codexia-api-gate /etc/sudoers.d/codexia-api-gate || result=1
  sudo rmdir /run/systemd/system/codexia-cloudflared.service.d || result=1
  sudo systemctl daemon-reload || result=1
  return "$result"
}

verify_fixture_publication_gate() {
  local service_user="$1" base_requires
  base_requires=$(systemctl show --property=Requires --property=After --value codexia-cloudflared.service)
  [[ "$base_requires" != *codexia-api* && "$base_requires" != *codexia-db* ]]
  if sudo -u "$service_user" sudo -n /usr/bin/systemctl show codexia-cloudflared.service >/dev/null 2>&1; then
    echo 'The runtime account gained unrestricted systemctl access' >&2
    return 1
  fi
  python3 - "$service_user" <<'PY'
import socket
import subprocess
import sys
import threading

service_user = sys.argv[1]
gate_address = ("127.0.0.1", 18080)

def gate(verb):
    return subprocess.check_output(
        ["sudo", "-u", service_user, "sudo", "-n", "/usr/local/sbin/codexia-api-gate", verb],
        text=True,
    ).strip()

def reject_connection():
    try:
        connection = socket.create_connection(gate_address, timeout=3)
    except ConnectionRefusedError:
        return
    connection.close()
    raise AssertionError("Closed publication gate accepted a new TCP connection")

def echo_from_backend(listener):
    connection, _ = listener.accept()
    with connection:
        data = connection.recv(256)
        connection.sendall(data)
        assert connection.recv(256) == b""

assert gate("status") == "closed"
reject_connection()
message = b"codexia-publication-gate"
with socket.create_server(("127.0.0.1", 18081)) as listener:
    echo = threading.Thread(target=echo_from_backend, args=(listener,), daemon=True)
    echo.start()
    gate("open")
    try:
        assert gate("status") == "open"
        with socket.create_connection(gate_address, timeout=5) as connection, connection.makefile("rb") as reader:
            connection.sendall(message)
            assert reader.read(len(message)) == message
            gate("close")
            assert reader.read(1) == b"", "Existing connection survived closure"
        echo.join(timeout=5)
        assert not echo.is_alive(), "The existing backend connection survived closure"
    finally:
        gate("close")
    assert gate("status") == "closed"
    reject_connection()
PY
  sudo systemctl daemon-reload
  if sudo systemctl start codexia-api.socket >/dev/null 2>&1; then
    echo 'The publication socket started after closing and reloading systemd' >&2
    return 1
  fi
  [[ "$(sudo -u "$service_user" sudo -n /usr/local/sbin/codexia-api-gate status)" == closed ]]
  assert_fixture_management_continues
}
