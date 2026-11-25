# MCP v2 API epoch transition

**Approved API-only compatibility transition.** This contract covers the coordinated transition from API epoch 2 to 3 for the MCP SDK v2 cutover. The frontend change is coordinated separately. The pair must be deployed through the existing epoch cutover workflow; ordinary backend or frontend release admission must continue to reject an epoch mismatch.

## Transition identity

| Axis | Source | Target | Required evidence |
| --- | --- | --- | --- |
| API epoch | 2 | 3 | Backend and frontend compatibility manifests, generated OpenAPI and release identity agree |
| Persistence format | 2 | 2 | Exact equality; no data conversion is permitted |
| SQL migration fingerprint | unchanged | unchanged | Exact equality; no schema migration is permitted |
| Authentication mode | `better-auth` | `better-auth` | Exact equality |
| Authentication schema | existing catalog | same catalog | Existing auth-schema fingerprint set is unchanged |

The transition only changes the supported MCP HTTP protocol contract. It does not change PostgreSQL state, persistence representation, Better Auth mode or schema, owner identity, project assignment, scopes, proposal review, or approval authority.

## Compatibility proof

The generated OpenAPI comparison uses the immutable approved base commit and that commit's own backend and frontend compatibility manifests. The candidate OpenAPI artifact must agree with the candidate manifests. The comparator may accept only the registered 2→3 transition descriptor and only when persistence and authentication evidence is unchanged.

At the HTTP-contract level, the only permitted breaking differences are removal of the `200` success responses from these four old session-method operations:

- `GET /mcp` (`mcp_root_get`)
- `DELETE /mcp` (`mcp_root_delete`)
- `GET /api/projects/{projectId}/modules/mcp/streamable` (`project_mcp_stream_get`)
- `DELETE /api/projects/{projectId}/modules/mcp/streamable` (`project_mcp_stream_delete`)

Both POST operations retain their `200` response. The proof must be machine-readable and fail closed: any extra `ERR`, any unrecognized path, method, status, operation ID, changed persistence format, changed auth mode/schema, malformed or unknown epoch, or mismatch between the candidate manifests and generated artifacts rejects the comparison. Same-epoch comparisons continue to require zero breaking errors.

## Deployment boundary

Ordinary API and frontend release admission rejects mismatched epochs. Execute the transition through the protected compatibility cutover workflow. The existing cutover coordinator, source-bound approval, host lock, backup, identity checks, health verification, and recovery rules remain in force. The API-only deployment must not alter persistence or authentication state. The separately coordinated frontend deployment must be compatible with API epoch 3 before public routing is switched.

Production execution requires separate approval through the protected cutover workflow.
