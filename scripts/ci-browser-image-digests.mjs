// Runtime image identities shared by task input proofs and live browser preflight.
// The immutable workflow container pins are independently checked for parity.
export const PLAYWRIGHT_IMAGE_DIGESTS = Object.freeze({
  chromium: 'sha256:d11b4fa1128d937fcda9dd0106d138b65c3e72cbad07d4801547aa66fc1c4725',
  webkit: 'sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579',
});
