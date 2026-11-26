import "@typespec/http";
import "@typespec/openapi";
using TypeSpec.Http;
using TypeSpec.OpenAPI;

namespace Codexia.Http;

alias PersistenceUnauthorized = { @statusCode _: 401; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/status") @get @operationId("persistence_status_get")
op getPersistenceStatus(): PersistenceStatusResponse | { @statusCode _: 503; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects") @get @operationId("persistence_projects_get")
op listPersistenceProjects(@query limit?: int32, @query cursor?: string): ProjectPageResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 503; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects") @post @operationId("persistence_projects_post")
op createPersistenceProject(@body body: PersistenceProjectCreateRequest): { @statusCode _: 201; @body body: ProjectResponse; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/import") @post @operationId("persistence_import_post")
op importPersistenceProject(@body body: WorkArchive, @header("Idempotency-Key") idempotencyKey?: string): { @statusCode _: 201; @body body: WorkImportResult; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 413; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}") @get @operationId("persistence_project_get")
op getPersistenceProject(@path projectId: string): ProjectResponse | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}") @patch @operationId("persistence_project_patch")
op updatePersistenceProject(@path projectId: string, @body body: PersistenceProjectUpdateRequest): ProjectResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/archive") @get @operationId("persistence_project_archive_get")
op exportPersistenceArchive(@path projectId: string): WorkArchiveExport | { @statusCode _: 404; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents") @get @operationId("persistence_documents_get")
op listPersistenceDocuments(
  @path projectId: string,
  @query parentId?: string,
  @query projectVersion?: int32,
  @query @minValue(1) @maxValue(1000) limit?: int32 = 500,
): PersistenceDocumentListResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents") @post @operationId("persistence_documents_post")
op createPersistenceDocument(@path projectId: string, @body body: PersistenceDocumentCreateRequest, @header("Idempotency-Key") idempotencyKey: string): { @statusCode _: 201; @body body: SaveDocumentResponse; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}") @get @operationId("persistence_document_get")
op getPersistenceDocument(@path projectId: string, @path documentId: string, @query revision?: string, @query projectVersion?: int32): PersistenceDocumentGetResponse | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}") @patch @operationId("persistence_document_patch")
op savePersistenceDocument(
  @path projectId: string,
  @path documentId: string,
  @body body: SaveDocumentRequest,
  @header("Idempotency-Key") idempotencyKey: string,
  @header("X-Client-Id") clientId?: string,
): { @statusCode _: 200; @body body: SaveDocumentResponse; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: SaveDocumentConflictResponse; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}") @delete @operationId("persistence_document_delete")
op deletePersistenceDocument(@path projectId: string, @path documentId: string, @body body: PersistenceDocumentDeleteRequest): PersistenceDocumentEnvelope | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/metadata") @patch @operationId("persistence_document_metadata_patch")
op updatePersistenceDocumentMetadata(@path projectId: string, @path documentId: string, @body body: PersistenceDocumentMetadataRequest): PersistenceDocumentEnvelope | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/revisions") @get @operationId("persistence_document_revisions_get")
op listPersistenceDocumentRevisions(@path projectId: string, @path documentId: string, @query limit?: int32, @query before?: string): DocumentRevisionPageResponse | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/restore") @post @operationId("persistence_document_restore_post")
op restorePersistenceDocumentRevision(@path projectId: string, @path documentId: string, @body body: PersistenceDocumentRestoreRequest, @header("Idempotency-Key") idempotencyKey: string): SaveDocumentResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/anchors") @get @operationId("persistence_document_anchors_get")
op listPersistenceDocumentAnchors(@path projectId: string, @path documentId: string, @query revision?: string, @query limit?: int32, @query projectVersion?: int32): DocumentEvidenceListBody | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/anchors") @post @operationId("persistence_document_anchors_post")
op createPersistenceAnchor(@path projectId: string, @path documentId: string, @body body: PersistenceAnchorCreateRequest): { @statusCode _: 201; @body body: PersistenceAnchorCreatedResponse; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/anchors/{anchorId}") @patch @operationId("persistence_document_anchor_patch")
op updatePersistenceAnchor(@path projectId: string, @path documentId: string, @path anchorId: string, @body body: PersistenceAnchorUpdateRequest): PersistenceEvidenceAnchor | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/anchors/{anchorId}/assertions") @post @operationId("persistence_anchor_assertions_post")
op createAnchorAssertion(@path projectId: string, @path documentId: string, @path anchorId: string, @body body: PersistenceAnchorAssertionRequest): { @statusCode _: 201; @body body: PersistenceAssertionEnvelope; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/anchors/{anchorId}/mentions") @post @operationId("persistence_anchor_mentions_post")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-status-observed", 200)
op createAnchorMention(@path projectId: string, @path documentId: string, @path anchorId: string, @body body: PersistenceMentionCreateRequest): PersistenceMentionLink | { @statusCode _: 201; @body body: PersistenceMentionLink; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes") @get @operationId("persistence_nodes_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The public route preserves its legacy unfiltered list response with nodes only, while the browsed response includes nextCursor and projectVersion. Desktop only calls the browsed form and validates the strict generated page projection.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/DesktopPersistenceNodeListBody")
op listPersistenceNodes(@path projectId: string, @query q?: string, @query type?: string, @query status?: string, @query limit?: int32, @query cursor?: string, @query projectVersion?: int32): PersistenceNodeListBody | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}") @get @operationId("persistence_node_get")
op getPersistenceNode(@path projectId: string, @path nodeId: string, @query projectVersion?: int32): PersistenceNodeBody | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}") @put @operationId("persistence_node_put")
op updatePersistenceNode(@path projectId: string, @path nodeId: string, @body body: PersistenceKnowledgeNodeUpdateRequest): PersistenceKnowledgeNodeEnvelope | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}/merge-preview") @post @operationId("persistence_node_merge_preview_post")
op previewPersistenceNodeMerge(@path projectId: string, @path nodeId: string, @body body: KnowledgeMergePreviewRequest): KnowledgeMergePreviewBody | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}/merge") @post @operationId("persistence_node_merge_post")
op mergePersistenceNode(@path projectId: string, @path nodeId: string, @body body: KnowledgeMergeRequest): KnowledgeMergeResultBody | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}/aliases") @post @operationId("persistence_node_aliases_post")
op createPersistenceNodeAlias(@path projectId: string, @path nodeId: string, @body body: PersistenceKnowledgeAliasCreateRequest): { @statusCode _: 201; @body body: PersistenceKnowledgeAliasEnvelope; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}/relations") @post @operationId("persistence_node_relations_post")
op createPersistenceNodeRelation(@path projectId: string, @path nodeId: string, @body body: PersistenceKnowledgeRelationCreateRequest): { @statusCode _: 201; @body body: PersistenceKnowledgeRelationEnvelope; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}/evidence") @get @operationId("persistence_node_evidence_get")
op listPersistenceNodeEvidence(@path projectId: string, @path nodeId: string, @query limit?: int32, @query projectVersion?: int32): NodeEvidenceListBody | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/assertions/{assertionId}") @get @operationId("persistence_assertion_get")
op getPersistenceAssertion(@path projectId: string, @path assertionId: string, @query projectVersion?: int32): AssertionResponseBody | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/assertions/{assertionId}") @put @operationId("persistence_assertion_put")
op updatePersistenceAssertion(@path projectId: string, @path assertionId: string, @body body: PersistenceAssertionUpdateRequest): PersistenceAssertionEnvelope | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/assertions/{assertionId}/evidence") @get @operationId("persistence_assertion_evidence_get")
op listPersistenceAssertionEvidence(@path projectId: string, @path assertionId: string, @query projectVersion?: int32): AssertionEvidenceListBody | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/assertions/{assertionId}/evidence") @post @operationId("persistence_assertion_evidence_post")
op createPersistenceAssertionEvidence(@path projectId: string, @path assertionId: string, @body body: PersistenceAssertionEvidenceCreateRequest): { @statusCode _: 201; @body body: PersistenceEvidenceEnvelope; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets") @get @operationId("persistence_changesets_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The public response keeps the approved compatibility schema; the selected Desktop client validates the strict generated ChangeSet projection until an epoch-compatible public schema update.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/PersistenceChangeSetDesktopListBody")
op listPersistenceChangeSets(@path projectId: string, @query limit?: int32): PersistenceChangeSetListBody | { @statusCode _: 400; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets") @post @operationId("persistence_changesets_post")
op proposePersistenceChangeSet(@path projectId: string, @body body: ProposeChangeSetRequest, @header("Idempotency-Key") idempotencyKey: string): { @statusCode _: 201; @body body: PersistenceChangeSetResultBody; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets/{changeSetId}") @get @operationId("persistence_changeset_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The public response keeps the approved compatibility schema; the selected Desktop client validates the strict generated ChangeSet projection until an epoch-compatible public schema update.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/PersistenceChangeSetDesktopResponseBody")
op getPersistenceChangeSet(@path projectId: string, @path changeSetId: string): PersistenceChangeSetResponseBody | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets/{changeSetId}/approve") @post @operationId("persistence_changeset_approve_post")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The public response keeps the approved compatibility schema; the selected Desktop client validates the strict generated ChangeSet projection until an epoch-compatible public schema update.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/PersistenceChangeSetDesktopApprovalBody")
op approvePersistenceChangeSet(@path projectId: string, @path changeSetId: string, @body body: ChangeSetActionRequest): PersistenceChangeSetApprovalBody | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets/{changeSetId}/reject") @post @operationId("persistence_changeset_reject_post")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The public response keeps the approved compatibility schema; the selected Desktop client validates the strict generated ChangeSet projection until an epoch-compatible public schema update.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/PersistenceChangeSetDesktopApprovalBody")
op rejectPersistenceChangeSet(@path projectId: string, @path changeSetId: string, @body body: ChangeSetActionRequest): PersistenceChangeSetApprovalBody | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets/{changeSetId}/apply") @post @operationId("persistence_changeset_apply_post")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The public response keeps the approved compatibility schema; the selected Desktop client validates the strict generated ChangeSet projection until an epoch-compatible public schema update.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/PersistenceChangeSetDesktopApplicationBody")
op applyPersistenceChangeSet(@path projectId: string, @path changeSetId: string, @body body: ChangeSetActionRequest): PersistenceChangeSetApplicationBody | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/review-feed") @get @operationId("persistence_review_feed_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The public response keeps the approved compatibility schema; the selected Desktop client validates the strict generated ChangeSet and core-proposal feed projection until an epoch-compatible public schema update.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/DesktopReviewFeedBody")
op getPersistenceReviewFeed(@path projectId: string, @query limit?: int32): PersistenceReviewFeedBody | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | PersistenceUnauthorized;
