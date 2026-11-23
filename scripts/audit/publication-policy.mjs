const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{32,}/iu,
];

export function containsCredentialPattern(content) {
  return credentialPatterns.some(pattern => pattern.test(content));
}
