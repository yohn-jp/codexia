export function fixtureOrigin(value) {
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u.exec(value);
  if (!match || match[0] !== value || Number(match[1]) > 65535) {
    throw new Error('k6 requires a numeric loopback HTTP origin with an explicit port');
  }
  return value;
}
