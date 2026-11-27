import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit Desktop Web operation surface. Better Auth protocol endpoints remain on their owner.
// `auth_consent_context_post` stays with the official Better Auth client: its
// oauth-provider plugin supplies the signed oauth_query continuation value.
const backupConsoleOperationIds = [
  'backup_console_config_activate_post',
  'backup_console_config_disable_post',
  'backup_console_config_draft_put',
  'backup_console_config_get',
  'backup_console_config_probe_get',
  'backup_console_config_probes_post',
  'backup_console_recovery_get',
  'backup_console_run_get',
  'backup_console_runs_get',
  'backup_console_runs_post',
  'backup_console_status_get',
];

export const operationIds = [
  'api_browser_version_get',
  'api_session_get',
  'api_version_get',
  'auth_list_consents_get',
  'auth_methods_get',
  ...backupConsoleOperationIds,
  'inbox_item_read_post',
  'inbox_list_get',
  'inbox_read_all_post',
  'job_events_get',
  'job_get',
  'jobs_list_get',
  'owner_session_confirm_post',
  'owner_setup_authorize_post',
  'owner_setup_complete_post',
  'owner_setup_profile_post',
  'owner_setup_status_get',
  'persistence_anchor_assertions_post',
  'persistence_anchor_mentions_post',
  'persistence_assertion_evidence_get',
  'persistence_assertion_evidence_post',
  'persistence_assertion_get',
  'persistence_assertion_put',
  'persistence_changeset_apply_post',
  'persistence_changeset_approve_post',
  'persistence_changeset_get',
  'persistence_changeset_reject_post',
  'persistence_changesets_get',
  'persistence_document_anchor_patch',
  'persistence_document_anchors_get',
  'persistence_document_anchors_post',
  'persistence_document_delete',
  'persistence_document_get',
  'persistence_document_metadata_patch',
  'persistence_document_patch',
  'persistence_document_restore_post',
  'persistence_document_revisions_get',
  'persistence_documents_get',
  'persistence_documents_post',
  'persistence_import_post',
  'persistence_node_evidence_get',
  'persistence_node_get',
  'persistence_node_merge_post',
  'persistence_node_merge_preview_post',
  'persistence_node_put',
  'persistence_node_relations_post',
  'persistence_node_aliases_post',
  'persistence_nodes_get',
  'persistence_project_archive_get',
  'persistence_project_get',
  'persistence_projects_get',
  'persistence_projects_post',
  'persistence_review_feed_get',
  'persistence_status_get',
  'project_action_post',
  'project_apply_post',
  'project_approvals_post',
  'project_contributions_get',
  'project_modules_get',
  'project_proposals_create_post',
  'project_proposals_list_get',
  'project_recent_activity_get',
  'project_recent_activity_put',
  'project_snapshot_get',
  'public_share_get',
  'public_share_scene_get',
];

// Auth capabilities are generated separately so the OAuth Web entrypoint
// never imports the author API client or its bearer/native transport state.
export const authMethodsOperationIds = ['auth_methods_get'];
export const mainOperationIds = operationIds.filter(id => !authMethodsOperationIds.includes(id));

// These are documented compatibility deviations, used by active Desktop
// paths. Keep target-only operations excluded and review each ID deliberately.
export const provisionalOperationIds = [
  'api_browser_version_get',
  'api_version_get',
  'auth_list_consents_get',
  ...backupConsoleOperationIds,
  'job_get',
  'jobs_list_get',
  'persistence_anchor_mentions_post',
  'persistence_changeset_apply_post',
  'persistence_changeset_approve_post',
  'persistence_changeset_get',
  'persistence_changeset_reject_post',
  'persistence_changesets_get',
  'persistence_nodes_get',
  'persistence_review_feed_get',
  'project_action_post',
  'project_apply_post',
  'project_approvals_post',
  'project_contributions_get',
  'project_modules_get',
  'public_share_get',
  'public_share_scene_get',
];

export function httpClientConfig(input, outputDirectory) {
  return {
    input: {
      target: input,
      filters: { operationIds: mainOperationIds },
      override: {
        transformer: fileURLToPath(new URL('./scripts/orval-desktop-transformer.mjs', import.meta.url)),
      },
    },
    output: {
      client: 'fetch',
      urlEncodeParameters: true,
      target: path.join(outputDirectory, 'client.ts'),
      schemas: { type: 'zod', path: path.join(outputDirectory, 'schemas') },
      operationManifest: { types: false },
      override: {
        mutator: {
          path: fileURLToPath(new URL('./src/generated-http-fetch.ts', import.meta.url)),
          name: 'generatedHttpFetch',
        },
        fetch: { includeHttpResponseReturnType: false, runtimeValidation: true },
        includeSchemaInArguments: true,
        zod: { version: 4 },
      },
    },
  };
}

export function authMethodsClientConfig(input, outputDirectory) {
  return {
    input: {
      target: input,
      filters: { operationIds: authMethodsOperationIds },
    },
    output: {
      client: 'fetch',
      urlEncodeParameters: true,
      target: path.join(outputDirectory, 'client.ts'),
      schemas: { type: 'zod', path: path.join(outputDirectory, 'schemas') },
      operationManifest: { types: false },
      override: {
        mutator: {
          path: fileURLToPath(new URL('./src/generated-auth-methods-fetch.ts', import.meta.url)),
          name: 'generatedAuthMethodsFetch',
        },
        fetch: { includeHttpResponseReturnType: false, runtimeValidation: true },
        includeSchemaInArguments: true,
        zod: { version: 4 },
      },
    },
  };
}
