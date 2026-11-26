#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/../.." && pwd -P)"
backup_script="$script_dir/backup.sh"
silo_image='docker.io/pgsty/silo@sha256:c20d112390b9a9ce8c11b8af95ad35bcaa62f4759663c09c936cd8d2b511f329'
mc_version='RELEASE.2025-08-13T08-35-41Z'
mc_sha256='01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891'
mc_url="https://github.com/minio/mc/releases/download/$mc_version/mc.linux-amd64.$mc_version"

die(){ printf '%s\n' "$*" >&2; exit 1; }
transfer_only=false
transfer_artifact=''
transfer_source_identity=''
transfer_output=''
if [[ "${1:-}" == --transfer-only ]]; then
  [[ $# == 4 ]] || die 'Usage: s3-fixture.sh --transfer-only /absolute/codexia-backup-artifact <source-sha> /absolute/private-output-dir'
  transfer_only=true
  transfer_artifact="$2"
  transfer_source_identity="$3"
  transfer_output="$4"
  [[ "$transfer_artifact" == /* && -d "$transfer_artifact" && ! -L "$transfer_artifact" ]] || die 'Transfer-only mode requires an absolute ciphertext artifact directory'
  [[ "$transfer_source_identity" =~ ^[a-f0-9]{40}$ ]] || die 'Transfer-only mode requires a source SHA identity'
  [[ "$transfer_output" == /* && -d "$transfer_output" && ! -L "$transfer_output" ]] || die 'Transfer-only mode requires an existing private output directory'
  [[ "$(stat -Lc '%a' -- "$transfer_output")" == 700 && "$(stat -Lc '%u' -- "$transfer_output")" == "$(id -u)" ]] || die 'Transfer-only output directory must be owned by this user with mode 0700'
  [[ -z "$(find "$transfer_output" -mindepth 1 -maxdepth 1 -print -quit)" ]] || die 'Transfer-only output directory must be empty'
  transfer_backup_name="$(basename -- "$transfer_artifact")"
  [[ "$transfer_backup_name" == codexia-* ]] || die 'Transfer-only artifact directory must use its canonical codexia backup ID'
  transfer_backup_id="${transfer_backup_name#codexia-}"
  [[ "$transfer_backup_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ && "$transfer_backup_id" != *..* ]] || die 'Transfer-only backup ID is invalid'
elif [[ $# != 0 ]]; then
  die 'Usage: s3-fixture.sh [--transfer-only /absolute/codexia-backup-artifact <source-sha> /absolute/private-output-dir]'
fi
for command in docker openssl curl sha256sum python3 tar git flock find grep sed cut basename cmp; do
  command -v "$command" >/dev/null || die "Missing fixture dependency: $command"
done
[[ -f "$backup_script" && -x "$script_dir/install-s3-runtime.sh" ]] || die 'Backup helper or pinned runtime installer is missing'

pg_image="$(sed -n "s/^readonly PG_IMAGE='\(.*\)'$/\1/p" "$backup_script")"
[[ "$pg_image" == docker.io/library/postgres:17-bookworm@sha256:* ]] || die 'Backup helper does not declare the pinned PostgreSQL 17 image'

work_root="$repo_root/work"
mkdir -p -- "$work_root"
work="$(mktemp -d "$work_root/s3-fixture.XXXXXX")"
token="$(openssl rand -hex 8)"
container_prefix="codexia-657-fixture-$token"
silo_container="$container_prefix-silo"
source_db="$container_prefix-source-db"
silo_volume="$container_prefix-silo-data"
database_volume="$container_prefix-source-db-data"
history_volume="$container_prefix-source-history"
bucket="codexia-657-$token"
object_prefix='codexia/backups'
state_dir="$work/state"

cleanup_fixture(){
  local status=$? cleanup_failed=0 resource
  trap - EXIT
  set +e
  for resource in "$silo_container" "$source_db"; do
    if docker inspect --type container "$resource" >/dev/null 2>&1; then
      docker rm -f "$resource" >/dev/null 2>&1 || cleanup_failed=1
    fi
  done
  for resource in "$silo_volume" "$database_volume" "$history_volume"; do
    if docker volume inspect "$resource" >/dev/null 2>&1; then
      docker volume rm "$resource" >/dev/null 2>&1 || cleanup_failed=1
    fi
  done
  rm -rf -- "$work" || cleanup_failed=1
  if [[ "$cleanup_failed" == 1 ]]; then
    printf '%s\n' 'S3 fixture cleanup was incomplete' >&2
    status=1
  fi
  exit "$status"
}
trap cleanup_fixture EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

certs="$work/certs"
mkdir -m 0700 -p -- "$certs/CAs" "$work/mc-config/certs/CAs" "$work/artifacts" \
  "$work/receipts" "$work/downloads" "$work/tools" "$work/shims" "$state_dir"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$certs/ca.key" -out "$certs/ca.crt" \
  -days 2 -subj "/CN=Codexia S3 fixture $token" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout "$certs/private.key" -out "$work/server.csr" \
  -subj '/CN=127.0.0.1' >/dev/null 2>&1
cat > "$work/server.ext" <<'EOF'
subjectAltName=DNS:localhost,IP:127.0.0.1
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
basicConstraints=CA:FALSE
EOF
openssl x509 -req -in "$work/server.csr" -CA "$certs/ca.crt" -CAkey "$certs/ca.key" \
  -CAcreateserial -out "$certs/public.crt" -days 2 -extfile "$work/server.ext" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$certs/untrusted-ca.key" \
  -out "$certs/untrusted-ca.crt" -days 2 -subj "/CN=Untrusted S3 fixture $token" >/dev/null 2>&1
cp -- "$certs/ca.crt" "$certs/CAs/ca.crt"
chmod 0600 "$certs/ca.key" "$certs/ca.crt" "$certs/CAs/ca.crt" "$certs/private.key" \
  "$certs/public.crt" "$certs/untrusted-ca.key" "$certs/untrusted-ca.crt"

root_user="codexia657root$token"
root_secret="$(openssl rand -hex 32)"
writer_user="codexia657writer$token"
writer_secret="$(openssl rand -hex 32)"
docker volume create "$silo_volume" >/dev/null
docker volume create "$database_volume" >/dev/null
docker volume create "$history_volume" >/dev/null
docker run --pull=missing -d --name "$silo_container" -p 127.0.0.1::9000 \
  -e "MINIO_ROOT_USER=$root_user" -e "MINIO_ROOT_PASSWORD=$root_secret" \
  -v "$certs:/tmp/.silo/certs:ro" -v "$silo_volume:/data" \
  "$silo_image" --anonymous server /data --address ':9000' --console-address ':9001' >/dev/null

silo_port=''
for attempt in $(seq 1 30); do
  silo_port="$(docker port "$silo_container" 9000/tcp 2>/dev/null | sed -n 's#^127\.0\.0\.1:\([0-9][0-9]*\)$#\1#p')"
  [[ -n "$silo_port" ]] && break
  sleep 1
done
[[ -n "$silo_port" ]] || die 'Silo fixture did not publish its loopback endpoint'
for attempt in $(seq 1 30); do
  if python3 - "$silo_port" "$certs/ca.crt" <<'PY' >/dev/null 2>&1
import ssl, sys, urllib.request
url = f"https://127.0.0.1:{sys.argv[1]}/minio/health/ready"
with urllib.request.urlopen(url, context=ssl.create_default_context(cafile=sys.argv[2]), timeout=1) as response:
    raise SystemExit(0 if response.status == 200 else 1)
PY
  then
    break
  fi
  sleep 1
done

mc_path="$work/tools/mc"
curl --fail --silent --show-error --location --retry 3 --connect-timeout 10 --max-time 120 \
  "$mc_url" -o "$mc_path"
printf '%s  %s\n' "$mc_sha256" "$mc_path" | sha256sum --check --status || die 'Pinned MinIO Client checksum mismatch'
chmod 0700 "$mc_path"
cp -- "$certs/ca.crt" "$work/mc-config/certs/CAs/fixture-ca.crt"
export MC_CONFIG_DIR="$work/mc-config"
export MC_HOST_silo="https://${root_user}:${root_secret}@127.0.0.1:${silo_port}"
"$mc_path" mb --ignore-existing "silo/$bucket" >/dev/null
"$mc_path" admin user add silo "$writer_user" "$writer_secret" >/dev/null
cat > "$work/writer-policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BackupPrefixObjects",
      "Effect": "Allow",
      "Action": ["s3:AbortMultipartUpload", "s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::$bucket/$object_prefix/*"
    },
    {
      "Sid": "BackupPrefixList",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::$bucket",
      "Condition": {"StringLike": {"s3:prefix": ["$object_prefix/*"]}}
    },
    {
      "Sid": "BucketCapabilities",
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:GetBucketVersioning", "s3:GetBucketObjectLockConfiguration"],
      "Resource": "arn:aws:s3:::$bucket"
    }
  ]
}
EOF
"$mc_path" admin policy create silo codexia-backup-writer "$work/writer-policy.json" >/dev/null
"$mc_path" admin policy attach silo codexia-backup-writer --user "$writer_user" >/dev/null

profile_path="$work/s3-profile.json"
cat > "$profile_path" <<EOF
{
  "schemaVersion": 1,
  "provider": "s3-compatible",
  "region": "us-east-1",
  "bucket": "$bucket",
  "prefix": "$object_prefix",
  "endpointUrl": "https://127.0.0.1:$silo_port",
  "allowedOrigins": ["https://127.0.0.1:$silo_port"],
  "addressingStyle": "path",
  "multipartThresholdBytes": 5242880,
  "multipartPartBytes": 5242880,
  "caBundle": "$certs/ca.crt"
}
EOF
chmod 0600 "$profile_path"

if [[ "$transfer_only" != true ]]; then
docker run --pull=missing -d --name "$source_db" --network none \
  -e POSTGRES_DB=codexia -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$database_volume:/var/lib/postgresql/data" "$pg_image" >/dev/null
database_ready=false
for attempt in $(seq 1 60); do
  if docker exec "$source_db" psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d codexia -c 'SELECT 1' >/dev/null 2>&1; then
    database_ready=true
    break
  fi
  sleep 1
done
[[ "$database_ready" == true ]] || die 'Isolated PostgreSQL 17 fixture did not become ready'
docker exec -i "$source_db" psql -X -v ON_ERROR_STOP=1 -U postgres -d codexia <<'SQL' >/dev/null
CREATE ROLE codexia LOGIN;
CREATE ROLE codexia_admin LOGIN SUPERUSER;
CREATE SCHEMA codexia_auth;
CREATE TABLE public.s3_fixture_manuscript (id integer PRIMARY KEY, body text NOT NULL);
INSERT INTO public.s3_fixture_manuscript (id, body)
SELECT row_id,
       string_agg(md5(row_id::text || ':' || chunk_id::text), '' ORDER BY chunk_id)
FROM generate_series(1, 4096) AS row_id
CROSS JOIN generate_series(1, 128) AS chunk_id
GROUP BY row_id;
CREATE TABLE codexia_auth.s3_fixture_session (session_id text PRIMARY KEY, owner_ref text NOT NULL);
INSERT INTO codexia_auth.s3_fixture_session VALUES ('fixture-session-1', 'synthetic-owner');
SQL
docker run --rm --pull=never --network none --user 0:0 \
  -v "$history_volume:/history" --entrypoint /bin/bash "$pg_image" \
  -euo pipefail -c 'mkdir -m 0700 -p /history/jobs; printf "%s\n" "synthetic restore fixture" > /history/jobs/fixture.json; chown -R 1000:1000 /history; chmod 0700 /history /history/jobs; chmod 0600 /history/jobs/fixture.json' >/dev/null
fi

"$script_dir/install-s3-runtime.sh" "$work/tools/python-env" >/dev/null
python_bin="$work/tools/python-env/bin/python"
(
  cd -- "$repo_root"
  "$python_bin" -B -m unittest -v \
    deploy.backup.test_s3_admission.ProxyAdmissionTests.test_pinned_sdk_uses_direct_tls_with_ambient_proxies_set
)
if [[ "$transfer_only" == true ]]; then
  artifact="$transfer_artifact"
  backup_id="$transfer_backup_id"
  source_identity="$transfer_source_identity"
  receipt_path="$transfer_output/receipt-$backup_id.json"
  download_dir="$transfer_output"
else
age_dir="$work/tools/age"
mkdir -m 0700 "$age_dir"
curl --fail --silent --show-error --location --retry 3 --connect-timeout 10 --max-time 120 \
  'https://github.com/FiloSottile/age/releases/download/v1.2.1/age-v1.2.1-linux-amd64.tar.gz' \
  -o "$work/tools/age-v1.2.1-linux-amd64.tar.gz"
age_sha256='7df45a6cc87d4da11cc03a539a7470c15b1041ab2b396af088fe9990f7c79d50'
printf '%s  %s\n' "$age_sha256" "$work/tools/age-v1.2.1-linux-amd64.tar.gz" | sha256sum --check --status || die 'Pinned age checksum mismatch'
tar --extract --gzip --file "$work/tools/age-v1.2.1-linux-amd64.tar.gz" --directory "$work/tools" \
  --no-same-owner --no-same-permissions age/age age/age-keygen
chmod 0700 "$work/tools/age/age" "$work/tools/age/age-keygen"
age_dir="$work/tools/age"
identity="$work/recovery-identity.txt"
"$age_dir/age-keygen" -o "$identity" >/dev/null 2>&1
chmod 0600 "$identity"
recipient="$("$age_dir/age-keygen" -y "$identity")"

cat > "$work/shims/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" == 4 && "$1" == --user && "$2" == is-active && "$3" == --quiet && "$4" =~ ^codexia-(api|tunnel)\.service$ ]]; then
  exit 3
fi
printf '%s\n' 'Fixture rejected an unexpected systemctl command' >&2
exit 2
SH
cat > "$work/shims/podman" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
fixture_db="${CODEXIA_FIXTURE_DB_CONTAINER:?}"
fixture_history="${CODEXIA_FIXTURE_HISTORY_VOLUME:?}"
fixture_empty_api="${CODEXIA_FIXTURE_EMPTY_API_CONTAINER:?}"
fixture_pg_image="${CODEXIA_FIXTURE_PG_IMAGE:?}"
map_container(){
  case "$1" in
    codexia-db) printf '%s' "$fixture_db";;
    codexia-api|codexia-tunnel) printf '%s' "$fixture_empty_api";;
    *) printf '%s' "$1";;
  esac
}
map_volume(){ case "$1" in codexia-history) printf '%s' "$fixture_history";; *) printf '%s' "$1";; esac; }

operation="${1:-}"
[[ -n "$operation" ]] || exit 2
shift
case "$operation" in
  container)
    [[ "${1:-}" == exists && "$#" == 2 ]] || exit 2
    docker inspect --type container "$(map_container "$2")" >/dev/null 2>&1
    ;;
  volume)
    subcommand="${1:-}"
    [[ -n "$subcommand" ]] || exit 2
    shift
    case "$subcommand" in
      create) docker volume create "$@";;
      exists)
        [[ "$#" == 1 ]] || exit 2
        docker volume inspect "$(map_volume "$1")" >/dev/null 2>&1
        ;;
      inspect)
        format=''
        if [[ "${1:-}" == --format ]]; then format="$2"; shift 2; fi
        [[ "$#" == 1 ]] || exit 2
        volume="$(map_volume "$1")"
        if [[ -n "$format" ]]; then docker volume inspect --format "$format" "$volume"; else docker volume inspect "$volume"; fi
        ;;
      rm)
        [[ "$#" == 1 ]] || exit 2
        docker volume rm "$(map_volume "$1")"
        ;;
      export)
        [[ "$#" == 1 ]] || exit 2
        volume="$(map_volume "$1")"
        docker run --rm --pull=never --network none -v "$volume:/fixture:ro" \
          --entrypoint /bin/bash "$fixture_pg_image" -c 'tar -C /fixture -cf - .'
        ;;
      import)
        [[ "$#" == 2 && "$2" == - ]] || exit 2
        volume="$(map_volume "$1")"
        docker run --rm --pull=never --network none -i -v "$volume:/fixture" \
          --entrypoint /bin/bash "$fixture_pg_image" -c 'tar -C /fixture -xf -'
        ;;
      *) exit 2;;
    esac
    ;;
  exec)
    exec_args=()
    while (($#)) && [[ "$1" == -i || "$1" == -t || "$1" == -it || "$1" == -ti || "$1" == --interactive || "$1" == --tty ]]; do
      exec_args+=("$1")
      shift
    done
    [[ "$#" -ge 1 ]] || exit 2
    name="$(map_container "$1")"
    shift
    docker exec "${exec_args[@]}" "$name" "$@"
    ;;
  inspect)
    args=()
    while (($#)); do
      if [[ "$1" == --format ]]; then args+=(--format "$2"); shift 2
      elif [[ "$1" == -* ]]; then args+=("$1"); shift
      else args+=("$(map_container "$1")"); shift
      fi
    done
    docker inspect "${args[@]}"
    ;;
  run)
    args=()
    while (($#)); do
      if [[ "$1" == -v || "$1" == --volume ]]; then
        args+=("$1")
        shift
        mount="$1"
        shift
        case "$mount" in codexia-history:*) mount="$fixture_history${mount#codexia-history}";; esac
        args+=("$mount")
      else
        args+=("$1")
        shift
      fi
    done
    docker run "${args[@]}"
    ;;
  rm)
    args=()
    while (($#)); do
      if [[ "$1" == -f || "$1" == --force ]]; then args+=("$1"); shift
      else args+=("$(map_container "$1")"); shift
      fi
    done
    docker rm "${args[@]}"
    ;;
  *)
    printf '%s\n' 'Fixture rejected an unexpected Podman command' >&2
    exit 2
    ;;
esac
SH
chmod 0700 "$work/shims/systemctl" "$work/shims/podman"

export CODEXIA_FIXTURE_DB_CONTAINER="$source_db"
export CODEXIA_FIXTURE_HISTORY_VOLUME="$history_volume"
export CODEXIA_FIXTURE_EMPTY_API_CONTAINER="$container_prefix-no-api"
export CODEXIA_FIXTURE_PG_IMAGE="$pg_image"
export CODEXIA_PUSH_STATE_DIR="$state_dir"
lock_file="$state_dir/host.lock"
exec 9>"$lock_file"
flock --exclusive --nonblock 9 || die 'Could not obtain isolated fixture host lock'
if ! PATH="$work/shims:$age_dir:$PATH" bash "$backup_script" backup-locked \
  "$work/artifacts" "$recipient" --approved --lock-file "$lock_file" --lock-fd 9 9>&9 \
  >"$work/backup.log" 2>&1; then
  cat "$work/backup.log" >&2
  die 'Canonical backup.sh could not produce a v2 fixture artifact'
fi
flock --unlock 9
exec 9>&-
artifact="$(find "$work/artifacts" -mindepth 1 -maxdepth 1 -type d -name 'codexia-*' -print -quit)"
[[ -n "$artifact" && ! -L "$artifact" ]] || die 'Canonical backup.sh did not publish a fixture artifact'
backup_id="$(basename -- "$artifact" | sed 's/^codexia-//')"
source_identity="$(git -C "$repo_root" rev-parse HEAD)"
[[ "$source_identity" =~ ^[a-f0-9]{40}$ ]] || die 'Could not determine the fixture source identity'
receipt_path="$work/receipts/$backup_id.json"
download_dir="$work/downloads"
fi
artifact_hash="$(sha256sum "$artifact/SHA256SUMS" | cut -d' ' -f1)"

AWS_ACCESS_KEY_ID="$writer_user" AWS_SECRET_ACCESS_KEY="$writer_secret" \
"$python_bin" - "$script_dir" "$profile_path" "$artifact" "$backup_id" \
  "$source_identity" "$receipt_path" "$certs/untrusted-ca.crt" "$download_dir" "$transfer_only" <<'PY'
import json, pathlib, sys
script_dir, profile_path, artifact, backup_id, source_identity, receipt_path, untrusted_ca, download_dir, mode = sys.argv[1:]
full_lane = mode != 'true'
sys.path.insert(0, script_dir)
import s3_transfer
from botocore.exceptions import SSLError

try:
    profile = s3_transfer.load_profile(pathlib.Path(profile_path))
    transfer = s3_transfer.S3BackupTransfer(profile, _allow_private_test_addresses=True)
    rejected_profiles = {
        'bucket': {**profile, 'bucket': profile['bucket'] + '-wrong'},
        'prefix': {**profile, 'prefix': 'codexia/not-authorized'},
    }
    for label, rejected_profile in rejected_profiles.items():
        rejected_receipt = pathlib.Path(receipt_path).with_name(f'{backup_id}-{label}-rejected.json')
        try:
            s3_transfer.S3BackupTransfer(
                rejected_profile, _allow_private_test_addresses=True,
            ).upload_artifact(
                pathlib.Path(artifact), backup_id=backup_id,
                source_identity=source_identity, receipt_path=rejected_receipt,
            )
        except s3_transfer.TransferError:
            if rejected_receipt.exists():
                raise s3_transfer.TransferError(f'Wrong S3 {label} unexpectedly wrote an external receipt')
        else:
            raise s3_transfer.TransferError(f'Fixture S3 accepted a wrong {label}')
    untrusted_profile = {**profile, 'caBundle': untrusted_ca}
    untrusted_client = s3_transfer.S3BackupTransfer(
        untrusted_profile, _allow_private_test_addresses=True,
    ).client
    try:
        untrusted_client.get_bucket_location(Bucket=profile['bucket'])
    except SSLError as error:
        if 'CERTIFICATE_VERIFY_FAILED' not in str(error) and 'certificate verify failed' not in str(error).lower():
            raise s3_transfer.TransferError('Fixture S3 TLS request failed for a reason other than certificate verification') from error
    else:
        raise s3_transfer.TransferError('Fixture S3 endpoint accepted an untrusted TLS authority')
    receipt = transfer.upload_artifact(
        pathlib.Path(artifact), backup_id=backup_id,
        source_identity=source_identity, receipt_path=pathlib.Path(receipt_path),
    )
    restored = transfer.download_artifact(
        backup_id=backup_id, receipt_path=pathlib.Path(receipt_path),
        output_dir=pathlib.Path(download_dir),
    )
    if s3_transfer.validate_artifact(restored)['sha256sumsSha256'] != receipt['sha256sumsSha256']:
        raise s3_transfer.TransferError('Downloaded artifact does not match the external receipt')
    client = transfer.client
    object_record = receipt['objects']['database.dump.age']
    evidence = {
        'status': 'VERIFIED', 'provider': 'Silo', 'backupId': backup_id,
        'manifestSha256': receipt['sha256sumsSha256'],
        'databaseCiphertextBytes': object_record['size'],
        'receiptMode': '0600', 'wrongBucketRejected': True, 'wrongPrefixRejected': True,
    }
    if full_lane:
        if object_record['size'] <= profile['multipartThresholdBytes']:
            raise s3_transfer.TransferError('Fixture database dump did not exercise multipart upload')
        head = client.head_object(Bucket=profile['bucket'], Key=object_record['key'])
        if '-' not in str(head.get('ETag', '')).strip('"'):
            raise s3_transfer.TransferError('Silo did not report a multipart ETag for the database artifact')
        try:
            client.list_multipart_uploads(Bucket=profile['bucket'], Prefix=profile['prefix'] + '/')
        except Exception as error:
            if s3_transfer._error_code(error) not in ('AccessDenied', '403'):
                raise s3_transfer.TransferError('Multipart listing denial probe returned an unexpected result') from error
        else:
            raise s3_transfer.TransferError('Fixture writer unexpectedly has multipart listing permission')
        interrupted_key = f"{profile['prefix']}/{source_identity}/{backup_id}/INTERRUPTED-MULTIPART-PROBE"
        interrupted = client.create_multipart_upload(Bucket=profile['bucket'], Key=interrupted_key)
        client.upload_part(
            Bucket=profile['bucket'], Key=interrupted_key, UploadId=interrupted['UploadId'],
            PartNumber=1, Body=b'x' * (5 * 1024 * 1024),
        )
        client.abort_multipart_upload(
            Bucket=profile['bucket'], Key=interrupted_key, UploadId=interrupted['UploadId'],
        )
        try:
            client.head_object(Bucket=profile['bucket'], Key=interrupted_key)
        except Exception as error:
            if s3_transfer._error_code(error) not in ('404', 'NoSuchKey', 'NotFound'):
                raise s3_transfer.TransferError('Multipart abort left an unexpected provider error') from error
        else:
            raise s3_transfer.TransferError('Aborted multipart upload became a visible object')
        probe_key = f"{profile['prefix']}/{source_identity}/{backup_id}/DELETE-DENY-PROBE"
        client.put_object(Bucket=profile['bucket'], Key=probe_key, Body=b'fixture probe', IfNoneMatch='*')
        try:
            client.delete_object(Bucket=profile['bucket'], Key=probe_key)
        except Exception as error:
            if s3_transfer._error_code(error) not in ('AccessDenied', '403'):
                raise s3_transfer.TransferError('Delete denial probe returned an unexpected result') from error
        else:
            raise s3_transfer.TransferError('Fixture writer unexpectedly has object delete permission')
        transfer.upload_artifact(
            pathlib.Path(artifact), backup_id=backup_id,
            source_identity=source_identity, receipt_path=pathlib.Path(receipt_path),
        )
        evidence.update({
            'multipartEtagObserved': head['ETag'], 'writerDeletePermission': 'denied',
            'writerMultipartListingPermission': 'denied', 'multipartAbort': 'verified',
        })
    if pathlib.Path(receipt_path).stat().st_mode & 0o777 != 0o600:
        raise s3_transfer.TransferError('External receipt file is not mode 0600')
    print(json.dumps(evidence, sort_keys=True))
except s3_transfer.TransferError as error:
    print(str(error), file=sys.stderr)
    raise SystemExit(1)
PY

restored_artifact="$download_dir/codexia-$backup_id"
[[ -d "$restored_artifact" && ! -L "$restored_artifact" ]] || die 'S3 transfer did not publish the restored ciphertext directory'
cmp -- "$artifact/SHA256SUMS" "$restored_artifact/SHA256SUMS" || die 'S3 download changed the checksum manifest'
downloaded_hash="$(sha256sum "$restored_artifact/SHA256SUMS" | cut -d' ' -f1)"
[[ "$downloaded_hash" == "$artifact_hash" ]] || die 'S3 download manifest digest differs from the source artifact'
if [[ "$transfer_only" == true ]]; then
  [[ -f "$receipt_path" && ! -L "$receipt_path" && "$(stat -Lc '%a' -- "$receipt_path")" == 600 ]] || die 'Transfer-only mode did not preserve its protected external receipt'
  printf 'S3 transfer-only verified: Silo upload, readback, protected receipt, and exact ciphertext download.\n'
  printf 'Downloaded artifact: %s\nExternal receipt: %s\nSHA256SUMS: %s\n' \
    "$restored_artifact" "$receipt_path" "$downloaded_hash"
  printf '%s\n' 'AWS S3: NOT_RUN (no AWS sandbox or credentials were provisioned).'
  exit 0
fi
if ! PATH="$work/shims:$age_dir:$PATH" bash "$backup_script" drill \
  "$restored_artifact" "$identity" --approved >"$work/restore.log" 2>&1; then
  cat "$work/restore.log" >&2
  die 'Canonical backup.sh isolated PostgreSQL/history restore drill failed'
fi
grep -F 'Isolated restore verified: database and history fingerprints match' "$work/restore.log" >/dev/null ||
  die 'Restore drill did not report matching database and history fingerprints'
grep -F "Verified checksum manifest sha256: $artifact_hash" "$work/restore.log" >/dev/null ||
  die 'Restore drill did not report the original checksum manifest digest'

printf 'S3 fixture verified: Silo transfer, pinned Boto3, age v2, PostgreSQL 17, multipart, receipt, and isolated restore.\n'
printf 'Source identity: %s\nBackup ID: %s\nSHA256SUMS: %s\n' "$source_identity" "$backup_id" "$artifact_hash"
printf '%s\n' 'AWS S3: NOT_RUN (no AWS sandbox or credentials were provisioned).'
