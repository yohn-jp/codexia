package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	cloudflareConnectorVersion = "2026.11.0"
	cloudflareConnectorURL     = "https://github.com/cloudflare/cloudflared/releases/download/" + cloudflareConnectorVersion + "/cloudflared-linux-amd64"
	cloudflareConnectorSHA256  = "51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd"
	cloudflareConnectorSize    = 40_283_099
	maxCloudflareBinarySize    = 64 << 20
)

// The digest is Cloudflare's SHA-256 for the fixed Linux amd64 asset in its
// official 2026.11.0 GitHub Release. It is independently exposed as the
// GitHub asset digest; never resolve a moving release tag at runtime.
var cloudflareConnectorDigest = mustCloudflareDigest(cloudflareConnectorSHA256)

var cloudflareConnectorVersionLine = regexp.MustCompile(`^cloudflared version ` + regexp.QuoteMeta(cloudflareConnectorVersion) + `(?:\s|$)`)

//go:embed assets/codexia-cloudflared.service
var cloudflareConnectorAssets embed.FS

// CloudflareConnectorNeedsInstall is deliberately read-only. Call it before
// asking Cloudflare for the Tunnel credential so repeat init runs do not
// retrieve or prompt for a secret when the managed service is already ready.
func CloudflareConnectorNeedsInstall(ctx context.Context) (bool, error) {
	checkCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	output, err := runCloudflareConnectorProvisioner(checkCtx, "inspect", "", nil, nil)
	if err != nil {
		return false, errors.New("could not safely inspect the existing Cloudflare connector installation")
	}
	var result cloudflareConnectorProvisionResult
	if err := jsonUnmarshalCloudflareProvisionResult(output, &result); err != nil {
		return false, errors.New("the Cloudflare connector inspection returned an invalid result")
	}
	if result.Active {
		if err := cloudflareConnectorReady(checkCtx); err != nil {
			return false, errors.New("the Cloudflare connector service is active but its loopback readiness endpoint is not ready; preserve the current service and inspect it before continuing")
		}
	}
	return result.NeedsInstall, nil
}

// installCloudflareConnector installs the pinned official cloudflared binary,
// the canonical host unit and a root-only Tunnel credential, then enables and
// starts the service. It never stops or restarts an existing service.
func installCloudflareConnector(ctx context.Context, o operator, token []byte) error {
	if o == nil {
		return errors.New("an operator is required to approve Cloudflare connector installation")
	}
	if !validCloudflareSecret(token) {
		return errors.New("the Cloudflare Tunnel credential is empty or invalid")
	}

	installCtx, cancel := context.WithTimeout(ctx, 6*time.Minute)
	defer cancel()

	unit, err := cloudflareConnectorAssets.ReadFile("assets/codexia-cloudflared.service")
	if err != nil {
		return errors.New("the canonical Cloudflare connector unit is unavailable")
	}
	unitHash := sha256.Sum256(unit)
	if hex.EncodeToString(unitHash[:]) != cloudflareConnectorUnitSHA256 {
		return errors.New("the canonical Cloudflare connector unit does not match its pinned digest")
	}

	directory, err := os.MkdirTemp("", "codexia-cloudflared-")
	if err != nil {
		return errors.New("could not create temporary Cloudflare connector verification storage")
	}
	defer func() { _ = os.RemoveAll(directory) }()

	binaryPath := filepath.Join(directory, "cloudflared")
	if err := downloadCloudflareConnector(installCtx, directory); err != nil {
		return err
	}
	if err := verifyCloudflareConnectorBinary(installCtx, directory, binaryPath); err != nil {
		return err
	}

	checkOutput, err := runCloudflareConnectorProvisioner(installCtx, "check", binaryPath, unit, token)
	if err != nil {
		return cloudflareProvisionError(checkOutput, "the existing VM state conflicts with the requested Cloudflare connector installation")
	}
	var plan cloudflareConnectorProvisionResult
	if err := jsonUnmarshalCloudflareProvisionResult(checkOutput, &plan); err != nil {
		return errors.New("the Cloudflare connector preflight returned an invalid result")
	}
	if !plan.NeedsInstall {
		if !plan.Active || !plan.Enabled {
			return errors.New("the Cloudflare connector preflight did not require installation but the service is not persistently enabled and active")
		}
		if err := waitCloudflareConnectorReady(installCtx); err != nil {
			return errors.New("the Cloudflare connector is active but its loopback readiness endpoint did not become ready; no service restart was attempted")
		}
		o.Notice("The pinned Cloudflare connector is already installed, enabled, active and ready; no host files or services were changed.")
		return nil
	}

	o.Notice("This operation installs the verified Cloudflare-published cloudflared " + cloudflareConnectorVersion + " amd64 binary and the canonical root-owned systemd unit, stores the connector credential in /etc/codexia/cloudflared/tunnel.token (0600), and starts codexia-cloudflared.service. Existing non-matching files cause the operation to stop before replacement.")
	if err := requireApproval(o, "Install and start the Cloudflare Tunnel connector on this VM?"); err != nil {
		return err
	}

	applyOutput, err := runCloudflareConnectorProvisioner(installCtx, "apply", binaryPath, unit, token)
	if err != nil {
		return cloudflareProvisionError(applyOutput, "the Cloudflare connector could not be installed safely")
	}
	var applied cloudflareConnectorProvisionResult
	if err := jsonUnmarshalCloudflareProvisionResult(applyOutput, &applied); err != nil || !applied.Active || !applied.Enabled {
		return errors.New("the Cloudflare connector did not reach the enabled and active systemd state")
	}
	if err := waitCloudflareConnectorReady(installCtx); err != nil {
		return errors.New("the Cloudflare connector service is active but its loopback readiness endpoint did not become ready")
	}
	return nil
}

const cloudflareConnectorUnitSHA256 = "060f006c80ecb874eeaf6dc310df206dddd57bb8703d1685b78796652e4577ce"

type cloudflareConnectorProvisionResult struct {
	NeedsInstall bool     `json:"needsInstall"`
	Active       bool     `json:"active"`
	Enabled      bool     `json:"enabled"`
	Changed      []string `json:"changed"`
	Error        string   `json:"error"`
}

func mustCloudflareDigest(value string) [32]byte {
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size {
		panic("invalid pinned cloudflared release digest")
	}
	var digest [32]byte
	copy(digest[:], decoded)
	return digest
}

func downloadCloudflareConnector(ctx context.Context, directory string) error {
	client := &http.Client{
		Timeout: 2 * time.Minute,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 5 || request.URL.Scheme != "https" || !cloudflareConnectorDownloadHost(request.URL.Hostname()) {
				return errors.New("the Cloudflare connector download used an unexpected redirect")
			}
			return nil
		},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, cloudflareConnectorURL, nil)
	if err != nil {
		return errors.New("could not prepare the pinned Cloudflare connector download")
	}
	response, err := client.Do(request)
	if err != nil {
		return errors.New("could not download the pinned official Cloudflare connector")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK || response.Request == nil || response.Request.URL.Scheme != "https" ||
		!cloudflareConnectorDownloadHost(response.Request.URL.Hostname()) {
		return errors.New("the official Cloudflare connector download returned an unexpected response")
	}
	if response.ContentLength > maxCloudflareBinarySize {
		return errors.New("the official Cloudflare connector asset exceeded its size limit")
	}

	root, err := os.OpenRoot(directory)
	if err != nil {
		return errors.New("could not open temporary Cloudflare connector verification storage")
	}
	defer func() { _ = root.Close() }()
	file, err := root.OpenFile("cloudflared", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return errors.New("could not prepare temporary Cloudflare connector verification storage")
	}
	hasher := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hasher), io.LimitReader(response.Body, maxCloudflareBinarySize+1))
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil || written != cloudflareConnectorSize || written > maxCloudflareBinarySize ||
		!bytes.Equal(hasher.Sum(nil), cloudflareConnectorDigest[:]) {
		_ = root.Remove("cloudflared")
		return errors.New("the Cloudflare connector did not match the pinned official 2026.11.0 amd64 artifact digest")
	}
	return nil
}

func cloudflareConnectorDownloadHost(host string) bool {
	switch strings.ToLower(host) {
	case "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
		return true
	default:
		return false
	}
}

func verifyCloudflareConnectorBinary(ctx context.Context, directory, binaryPath string) error {
	// The verified executable must be runnable by its owner for the version check.
	if err := os.Chmod(binaryPath, 0o700); err != nil { //nolint:gosec // G302 requires data file permissions, whereas this pinned binary needs owner execute.
		return errors.New("could not prepare the verified Cloudflare connector for version inspection")
	}
	check, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	command := exec.CommandContext(check, binaryPath, "--version")
	command.Dir = directory
	command.Env = []string{"HOME=" + directory, "PATH=/usr/bin:/bin"}
	output, err := command.Output()
	if err != nil || !cloudflareConnectorVersionLine.Match(bytes.TrimSpace(output)) {
		return errors.New("the pinned Cloudflare connector binary did not report version 2026.11.0")
	}
	return nil
}

func cloudflareConnectorReady(ctx context.Context) error {
	check, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(check, http.MethodGet, "http://127.0.0.1:2000/ready", nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return errors.New("the local Cloudflare connector readiness endpoint redirected unexpectedly")
	}}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
	if response.StatusCode != http.StatusOK {
		return errors.New("the local Cloudflare connector readiness endpoint is not ready")
	}
	return nil
}

func waitCloudflareConnectorReady(ctx context.Context) error {
	deadline := time.NewTimer(60 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if err := cloudflareConnectorReady(ctx); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("the Cloudflare connector readiness endpoint did not become ready")
		case <-ticker.C:
		}
	}
}

func runCloudflareConnectorProvisioner(ctx context.Context, action, binaryPath string, unit, token []byte) ([]byte, error) {
	switch action {
	case "inspect", "check", "apply":
	default:
		return nil, errors.New("unknown Cloudflare connector provisioning action")
	}
	// The action is a validated enum and the script is a compile-time constant.
	command := exec.CommandContext(ctx, "/usr/bin/sudo", "-n", "/usr/bin/python3", "-c", cloudflareConnectorProvisioner, action) //nolint:gosec // G204 flags the bounded action argument.
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = io.Discard

	if action == "inspect" {
		if err := command.Run(); err != nil {
			return output.Bytes(), err
		}
		return output.Bytes(), nil
	}
	if binaryPath == "" || len(unit) == 0 || !validCloudflareSecret(token) {
		return nil, errors.New("invalid Cloudflare connector provisioning inputs")
	}

	reader, writer := io.Pipe()
	command.Stdin = reader
	if err := command.Start(); err != nil {
		_ = reader.Close()
		_ = writer.Close()
		return nil, err
	}
	streamErr := make(chan error, 1)
	go func() {
		tarWriter := tar.NewWriter(writer)
		for _, entry := range []struct {
			name string
			path string
			data []byte
		}{{name: "cloudflared", path: binaryPath}, {name: "codexia-cloudflared.service", data: unit}, {name: "tunnel.token", data: token}} {
			var source io.Reader
			var file *os.File
			if entry.path != "" {
				var err error
				file, err = os.Open(entry.path)
				if err != nil {
					streamErr <- errors.New("could not stream the verified Cloudflare connector")
					_ = writer.CloseWithError(err)
					return
				}
				source = file
			} else {
				source = bytes.NewReader(entry.data)
			}
			var size int64
			if entry.path != "" {
				info, err := file.Stat()
				if err != nil {
					_ = file.Close()
					streamErr <- errors.New("could not inspect the verified Cloudflare connector")
					_ = writer.CloseWithError(err)
					return
				}
				size = info.Size()
			} else {
				size = int64(len(entry.data))
			}
			header := &tar.Header{Name: entry.name, Mode: 0o600, Size: size, Typeflag: tar.TypeReg}
			if err := tarWriter.WriteHeader(header); err != nil {
				if file != nil {
					_ = file.Close()
				}
				streamErr <- errors.New("could not prepare the Cloudflare connector provisioning stream")
				_ = writer.CloseWithError(err)
				return
			}
			if _, err := io.Copy(tarWriter, source); err != nil {
				if file != nil {
					_ = file.Close()
				}
				streamErr <- errors.New("could not stream Cloudflare connector provisioning data")
				_ = writer.CloseWithError(err)
				return
			}
			if file != nil {
				_ = file.Close()
			}
		}
		if err := tarWriter.Close(); err != nil {
			streamErr <- errors.New("could not finish the Cloudflare connector provisioning stream")
			_ = writer.CloseWithError(err)
			return
		}
		streamErr <- nil
		_ = writer.Close()
	}()

	commandErr := command.Wait()
	_ = reader.Close()
	writerErr := <-streamErr
	if commandErr != nil {
		return output.Bytes(), commandErr
	}
	if writerErr != nil {
		return output.Bytes(), writerErr
	}
	return output.Bytes(), nil
}

func cloudflareProvisionError(output []byte, fallback string) error {
	var result cloudflareConnectorProvisionResult
	if err := jsonUnmarshalCloudflareProvisionResult(output, &result); err == nil && result.Error != "" {
		return errors.New(result.Error)
	}
	return errors.New(fallback)
}

func jsonUnmarshalCloudflareProvisionResult(value []byte, result *cloudflareConnectorProvisionResult) error {
	return json.Unmarshal(value, result)
}

const cloudflareConnectorProvisioner = `import hashlib,json,os,secrets,stat,subprocess,sys,tarfile

BINARY='/usr/bin/cloudflared'
UNIT='/etc/systemd/system/codexia-cloudflared.service'
TOKEN='/etc/codexia/cloudflared/tunnel.token'
BINARY_SHA='51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd'
UNIT_SHA='eaa5f33dabcffc3da71ba521597141ef0e2cb37851296b9e44fbc87398c15423'
FILE_SPECS={
  'cloudflared':(BINARY,0o755,64*1024*1024,'binary'),
  'codexia-cloudflared.service':(UNIT,0o644,16*1024,'unit'),
  'tunnel.token':(TOKEN,0o600,4096,'token'),
}

def abort(message):
  print(json.dumps({'error':message},separators=(',',':')))
  sys.exit(1)

def checked_directory(path,create=False,mode=0o755,exact_mode=None):
  try:
    st=os.lstat(path)
  except FileNotFoundError:
    if not create:
      return False
    os.mkdir(path,mode)
    os.chown(path,0,0)
    os.chmod(path,mode)
    st=os.lstat(path)
  if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or st.st_gid!=0 or (st.st_mode&0o022):
    abort('an existing Cloudflare connector parent directory is not a protected root-owned directory')
  if exact_mode is not None and stat.S_IMODE(st.st_mode)!=exact_mode:
    abort('the existing /etc/codexia/cloudflared directory must be root-owned mode 0700')
  return True

def protected_parents(create=False):
  for path in ('/usr','/usr/bin','/etc','/etc/systemd','/etc/systemd/system','/etc/codexia'):
    checked_directory(path,create=create,mode=0o755)
  checked_directory('/etc/codexia/cloudflared',create=create,mode=0o700,exact_mode=0o700)

def service_flag(command):
  try:
    result=subprocess.run(['/usr/bin/systemctl',command,'codexia-cloudflared.service'],
      stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=15,check=False)
  except Exception:
    abort('systemd could not be inspected safely')
  state=result.stdout.strip()
  if command=='is-active':
    if result.returncode==0 and state=='active': return True
    if state in ('inactive','failed','unknown','') and result.returncode in (0,3,4): return False
  else:
    if result.returncode==0 and state=='enabled': return True
    if state in ('masked','masked-runtime'):
      abort('the existing Cloudflare connector unit is masked; preserve it and reconcile through its owner')
    if state in ('disabled','enabled-runtime','static','indirect','generated','transient','not-found','') and result.returncode in (0,1,3,4): return False
  abort('systemd returned an unexpected Cloudflare connector state')

def read_archive():
  try:
    archive=tarfile.open(fileobj=sys.stdin.buffer,mode='r|')
    result={}
    for member in archive:
      if member.name not in FILE_SPECS or not member.isfile() or member.name in result:
        abort('the Cloudflare connector provisioning stream was invalid')
      _,_,limit,_=FILE_SPECS[member.name]
      if member.size<=0 or member.size>limit:
        abort('the Cloudflare connector provisioning stream exceeded its size limit')
      source=archive.extractfile(member)
      if source is None: abort('the Cloudflare connector provisioning stream was incomplete')
      data=source.read(limit+1)
      if len(data)!=member.size or len(data)>limit: abort('the Cloudflare connector provisioning stream was incomplete')
      result[member.name]=data
    if set(result)!=set(FILE_SPECS): abort('the Cloudflare connector provisioning stream was incomplete')
  except (tarfile.TarError,OSError,EOFError):
    abort('the Cloudflare connector provisioning stream could not be read')
  if hashlib.sha256(result['cloudflared']).hexdigest()!=BINARY_SHA:
    abort('the Cloudflare connector binary did not match the pinned official release digest')
  if hashlib.sha256(result['codexia-cloudflared.service']).hexdigest()!=UNIT_SHA:
    abort('the canonical Cloudflare connector unit did not match its pinned digest')
  token=result['tunnel.token']
  if not token or len(token)>4096 or any(ch<=32 or ch>126 for ch in token):
    abort('the Cloudflare Tunnel credential was invalid')
  return result

def inspect_file(name,data=None):
  path,mode,limit,kind=FILE_SPECS[name]
  parent=os.path.dirname(path)
  basename=os.path.basename(path)
  try:
    parent_fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW)
  except FileNotFoundError:
    return True
  except OSError:
    abort('a Cloudflare connector destination directory could not be opened without following links')
  parent_st=os.fstat(parent_fd)
  if not stat.S_ISDIR(parent_st.st_mode) or parent_st.st_uid!=0 or parent_st.st_gid!=0 or (parent_st.st_mode&0o022):
    os.close(parent_fd)
    abort('a Cloudflare connector destination directory is not root-owned and protected')
  try:
    fd=os.open(basename,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent_fd)
  except FileNotFoundError:
    os.close(parent_fd)
    return True
  except OSError:
    os.close(parent_fd)
    abort('an existing Cloudflare connector file could not be opened without following links')
  try:
    st=os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_gid!=0 or st.st_nlink!=1 or st.st_size<=0 or st.st_size>limit:
      abort('an existing Cloudflare connector file is not a single-link regular root-owned file')
    if stat.S_IMODE(st.st_mode)!=mode:
      abort('an existing Cloudflare connector file does not have its required protected mode')
    if kind=='token':
      if data is not None:
        with os.fdopen(fd,'rb') as source:
          fd=-1
          current=source.read(limit+1)
        if current!=data:
          abort('an existing Tunnel credential differs; preserve it and reconcile through the owning Cloudflare workflow')
    else:
      digest=hashlib.sha256()
      with os.fdopen(fd,'rb') as source:
        fd=-1
        while True:
          chunk=source.read(1024*1024)
          if not chunk: break
          digest.update(chunk)
      expected=BINARY_SHA if kind=='binary' else UNIT_SHA
      if digest.hexdigest()!=expected:
        abort('an existing Cloudflare connector binary or unit differs from the pinned design; preserve it and reconcile its owner')
  except OSError:
    abort('an existing Cloudflare connector file could not be checked safely')
  finally:
    if fd>=0: os.close(fd)
    os.close(parent_fd)
  return False

def inspect(data=None):
  protected_parents(create=False)
  changed=[]
  for name in FILE_SPECS:
    needs=inspect_file(name,None if data is None else data[name])
    if needs: changed.append(name)
  active=service_flag('is-active')
  enabled=service_flag('is-enabled')
  if active and changed:
    abort('the Cloudflare connector is active with incomplete or unsafe managed files; no files or service were changed')
  if active and not os.path.exists(TOKEN):
    abort('the active Cloudflare connector has no protected Tunnel credential file')
  activation=not active or not enabled
  labels=[]
  if 'cloudflared' in changed: labels.append('official cloudflared binary')
  if 'codexia-cloudflared.service' in changed: labels.append('canonical systemd unit')
  if 'tunnel.token' in changed: labels.append('protected Tunnel credential')
  if activation: labels.append('systemd enable/start')
  return {'needsInstall':bool(changed or activation),'active':active,'enabled':enabled,'changed':labels}

def atomic_write(path,data,mode):
  directory=os.path.dirname(path)
  basename=os.path.basename(path)
  try:
    dirfd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC|os.O_NOFOLLOW)
  except OSError:
    abort('a Cloudflare connector destination directory could not be opened without following links')
  st=os.fstat(dirfd)
  if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or st.st_gid!=0 or (st.st_mode&0o022):
    os.close(dirfd)
    abort('a Cloudflare connector destination directory is not root-owned and protected')
  descriptor=-1
  name=None
  try:
    for attempt in range(10):
      name='.codexia-cloudflared-'+secrets.token_hex(16)
      try:
        descriptor=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_CLOEXEC|os.O_NOFOLLOW,0o600,dir_fd=dirfd)
        break
      except FileExistsError:
        name=None
    if descriptor<0 or name is None:
      raise FileExistsError('could not allocate a private staging file')
    os.fchown(descriptor,0,0)
    os.fchmod(descriptor,mode)
    with os.fdopen(descriptor,'wb',closefd=True) as target:
      descriptor=-1
      target.write(data)
      target.flush()
      os.fsync(target.fileno())
    try:
      os.link(name,basename,src_dir_fd=dirfd,dst_dir_fd=dirfd,follow_symlinks=False)
    except FileExistsError:
      try: os.unlink(name,dir_fd=dirfd)
      except OSError: pass
      name=None
      abort('a Cloudflare connector destination appeared during installation; it was preserved without overwrite')
    os.unlink(name,dir_fd=dirfd)
    name=None
    os.fsync(dirfd)
  except Exception:
    if descriptor>=0:
      try: os.close(descriptor)
      except OSError: pass
    if name is not None:
      try: os.unlink(name,dir_fd=dirfd)
      except OSError: pass
    raise
  finally:
    os.close(dirfd)

def main():
  if os.geteuid()!=0: abort('the Cloudflare connector installer requires noninteractive sudo')
  action=sys.argv[1] if len(sys.argv)==2 else ''
  if action=='inspect':
    print(json.dumps(inspect(),separators=(',',':')))
    return
  if action not in ('check','apply'): abort('the Cloudflare connector installer action was invalid')
  data=read_archive()
  plan=inspect(data)
  if action=='check':
    print(json.dumps(plan,separators=(',',':')))
    return
  protected_parents(create=True)
  changed=[]
  for name,(path,mode,_,_) in FILE_SPECS.items():
    if inspect_file(name,data[name]):
      atomic_write(path,data[name],mode)
      changed.append(name)
  if changed or not plan['active']:
    result=subprocess.run(['/usr/bin/systemctl','daemon-reload'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30,check=False)
    if result.returncode!=0: abort('systemd could not reload the canonical Cloudflare connector unit')
  if not service_flag('is-enabled'):
    result=subprocess.run(['/usr/bin/systemctl','enable','codexia-cloudflared.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30,check=False)
    if result.returncode!=0: abort('the Cloudflare connector could not be enabled for VM startup')
  if not service_flag('is-active'):
    result=subprocess.run(['/usr/bin/systemctl','start','codexia-cloudflared.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=120,check=False)
    if result.returncode!=0: abort('the Cloudflare connector service could not be started')
  active=service_flag('is-active')
  enabled=service_flag('is-enabled')
  if not active or not enabled: abort('the Cloudflare connector did not reach the enabled and active state')
  print(json.dumps({'needsInstall':False,'active':active,'enabled':enabled,'changed':plan['changed']},separators=(',',':')))

try:
  main()
except SystemExit:
  raise
except Exception:
  abort('the Cloudflare connector installation failed closed')
`
