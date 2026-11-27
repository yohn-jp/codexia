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
op listPersistenceProjects(@query @minValue(1) @maxValue(200) limit?: int32, @query cursor?: string): ProjectPageResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 503; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects") @post @operationId("persistence_projects_post")
op createPersistenceProject(@body body: PersistenceProjectCreateRequest): { @statusCode _: 201; @body body: ProjectResponse; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/import") @post @operationId("persistence_import_post")
op importPersistenceProject(@body body: WorkArchive, @header("Idempotency-Key") idempotencyKey?: PersistenceIdempotencyKey): { @statusCode _: 201; @body body: WorkImportResult; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 413; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}") @get @operationId("persistence_project_get")
op getPersistenceProject(@path projectId: PersistenceId): ProjectResponse | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}") @patch @operationId("persistence_project_patch")
op updatePersistenceProject(@path projectId: PersistenceId, @body body: PersistenceProjectUpdateRequest): ProjectResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/archive") @get @operationId("persistence_project_archive_get")
op exportPersistenceArchive(@path projectId: PersistenceId): WorkArchiveExport | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/open-export") @get @operationId("persistence_project_open_export_get")
op exportOpenWork(@path projectId: PersistenceId):
    { @statusCode _: 200; @header contentType: "application/zip"; @header("Content-Length") length: uint32; @header("Content-Disposition") disposition: string; @body body: bytes; }
    | { @statusCode _: 400; @body body: ApiError; }
    | PersistenceUnauthorized
    | { @statusCode _: 403; @body body: ApiError; }
    | { @statusCode _: 404; @body body: ApiError; }
    | { @statusCode _: 409; @body body: ApiError; }
    | { @statusCode _: 413; @body body: ApiError; }
    | { @statusCode _: 503; @body body: ApiError; }
    | { @statusCode _: 500; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents") @get @operationId("persistence_documents_get")
op listPersistenceDocuments(
  @path projectId: PersistenceId,
  @query parentId?: PersistenceId | "root",
  @query projectVersion?: PositiveVersion,
  @query @minValue(1) @maxValue(1000) limit?: int32 = 500,
): PersistenceDocumentListResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents") @post @operationId("persistence_documents_post")
op createPersistenceDocument(@path projectId: PersistenceId, @body body: PersistenceDocumentCreateRequest, @header("Idempotency-Key") idempotencyKey: PersistenceIdempotencyKey): { @statusCode _: 201; @body body: SaveDocumentResponse; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}") @get @operationId("persistence_document_get")
op getPersistenceDocument(@path projectId: PersistenceId, @path documentId: PersistenceId, @query revision?: PersistenceId, @query projectVersion?: PositiveVersion): PersistenceDocumentGetResponse | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}") @patch @operationId("persistence_document_patch")
op savePersistenceDocument(
  @path projectId: PersistenceId,
  @path documentId: PersistenceId,
  @body body: SaveDocumentRequest,
  @header("Idempotency-Key") idempotencyKey: PersistenceIdempotencyKey,
  @header("X-Client-Id") clientId?: PersistenceClientId,
): { @statusCode _: 200; @body body: SaveDocumentResponse; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: SaveDocumentConflictResponse; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}") @delete @operationId("persistence_document_delete")
op deletePersistenceDocument(@path projectId: PersistenceId, @path documentId: PersistenceId, @body body: PersistenceDocumentDeleteRequest): PersistenceDocumentEnvelope | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/metadata") @patch @operationId("persistence_document_metadata_patch")
op updatePersistenceDocumentMetadata(@path projectId: PersistenceId, @path documentId: PersistenceId, @body body: PersistenceDocumentMetadataRequest): PersistenceDocumentEnvelope | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/revisions") @get @operationId("persistence_document_revisions_get")
op listPersistenceDocumentRevisions(@path projectId: PersistenceId, @path documentId: PersistenceId, @query @minValue(1) @maxValue(200) limit?: int32, @query before?: PersistenceId): DocumentRevisionPageResponse | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/restore") @post @operationId("persistence_document_restore_post")
op restorePersistenceDocumentRevision(@path projectId: PersistenceId, @path documentId: PersistenceId, @body body: PersistenceDocumentRestoreRequest, @header("Idempotency-Key") idempotencyKey: PersistenceIdempotencyKey): SaveDocumentResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/anchors") @get @operationId("persistence_document_anchors_get")
op listPersistenceDocumentAnchors(@path projectId: PersistenceId, @path documentId: PersistenceId, @query revision?: PersistenceId, @query @minValue(1) @maxValue(500) limit?: int32, @query projectVersion?: PositiveVersion): DocumentEvidenceListBody | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/anchors") @post @operationId("persistence_document_anchors_post")
op createPersistenceAnchor(@path projectId: PersistenceId, @path documentId: PersistenceId, @body body: PersistenceAnchorCreateRequest): { @statusCode _: 201; @body body: PersistenceAnchorCreatedResponse; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/anchors/{anchorId}") @patch @operationId("persistence_document_anchor_patch")
op updatePersistenceAnchor(@path projectId: PersistenceId, @path documentId: PersistenceId, @path anchorId: PersistenceId, @body body: PersistenceAnchorUpdateRequest): PersistenceEvidenceAnchor | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/anchors/{anchorId}/assertions") @post @operationId("persistence_anchor_assertions_post")
op createAnchorAssertion(@path projectId: PersistenceId, @path documentId: PersistenceId, @path anchorId: PersistenceId, @body body: PersistenceAnchorAssertionRequest): { @statusCode _: 201; @body body: PersistenceAssertionEnvelope; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/anchors/{anchorId}/mentions") @post @operationId("persistence_anchor_mentions_post")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-status-observed", 200)
op createAnchorMention(@path projectId: PersistenceId, @path documentId: PersistenceId, @path anchorId: PersistenceId, @body body: PersistenceMentionCreateRequest): PersistenceMentionLink | { @statusCode _: 201; @body body: PersistenceMentionLink; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes") @get @operationId("persistence_nodes_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The public route preserves its legacy unfiltered list response with nodes only, while the browsed response includes nextCursor and projectVersion. Desktop only calls the browsed form and validates the strict generated page projection.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/DesktopPersistenceNodeListBody")
op listPersistenceNodes(@path projectId: PersistenceId, @query @maxLength(128) q?: string, @query @maxLength(64) type?: string, @query status?: "" | "proposed" | "confirmed" | "retired", @query @minValue(1) @maxValue(500) limit?: int32, @query cursor?: string, @query projectVersion?: PositiveVersion): PersistenceNodeListBody | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}") @get @operationId("persistence_node_get")
op getPersistenceNode(@path projectId: PersistenceId, @path nodeId: PersistenceId, @query projectVersion?: PositiveVersion): PersistenceNodeBody | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}") @put @operationId("persistence_node_put")
op updatePersistenceNode(@path projectId: PersistenceId, @path nodeId: PersistenceId, @body body: PersistenceKnowledgeNodeUpdateRequest): PersistenceKnowledgeNodeEnvelope | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}/merge-preview") @post @operationId("persistence_node_merge_preview_post")
op previewPersistenceNodeMerge(@path projectId: PersistenceId, @path nodeId: PersistenceId, @body body: KnowledgeMergePreviewRequest): KnowledgeMergePreviewBody | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}/merge") @post @operationId("persistence_node_merge_post")
op mergePersistenceNode(@path projectId: PersistenceId, @path nodeId: PersistenceId, @body body: KnowledgeMergeRequest): KnowledgeMergeResultBody | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}/aliases") @post @operationId("persistence_node_aliases_post")
op createPersistenceNodeAlias(@path projectId: PersistenceId, @path nodeId: PersistenceId, @body body: PersistenceKnowledgeAliasCreateRequest): { @statusCode _: 201; @body body: PersistenceKnowledgeAliasEnvelope; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}/relations") @post @operationId("persistence_node_relations_post")
op createPersistenceNodeRelation(@path projectId: PersistenceId, @path nodeId: PersistenceId, @body body: PersistenceKnowledgeRelationCreateRequest): { @statusCode _: 201; @body body: PersistenceKnowledgeRelationEnvelope; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}/evidence") @get @operationId("persistence_node_evidence_get")
op listPersistenceNodeEvidence(@path projectId: PersistenceId, @path nodeId: PersistenceId, @query @minValue(1) @maxValue(500) limit?: int32, @query projectVersion?: PositiveVersion): NodeEvidenceListBody | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/assertions/{assertionId}") @get @operationId("persistence_assertion_get")
op getPersistenceAssertion(@path projectId: PersistenceId, @path assertionId: PersistenceId, @query projectVersion?: PositiveVersion): AssertionResponseBody | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/assertions/{assertionId}") @put @operationId("persistence_assertion_put")
op updatePersistenceAssertion(@path projectId: PersistenceId, @path assertionId: PersistenceId, @body body: PersistenceAssertionUpdateRequest): PersistenceAssertionEnvelope | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/assertions/{assertionId}/evidence") @get @operationId("persistence_assertion_evidence_get")
op listPersistenceAssertionEvidence(@path projectId: PersistenceId, @path assertionId: PersistenceId, @query projectVersion?: PositiveVersion): AssertionEvidenceListBody | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/assertions/{assertionId}/evidence") @post @operationId("persistence_assertion_evidence_post")
op createPersistenceAssertionEvidence(@path projectId: PersistenceId, @path assertionId: PersistenceId, @body body: PersistenceAssertionEvidenceCreateRequest): { @statusCode _: 201; @body body: PersistenceEvidenceEnvelope; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets") @get @operationId("persistence_changesets_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The public response keeps the approved compatibility schema; the selected Desktop client validates the strict generated ChangeSet projection until an epoch-compatible public schema update.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/PersistenceChangeSetDesktopListBody")
op listPersistenceChangeSets(@path projectId: PersistenceId, @query @minValue(1) @maxValue(200) limit?: int32): PersistenceChangeSetListBody | { @statusCode _: 400; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets") @post @operationId("persistence_changesets_post")
op proposePersistenceChangeSet(@path projectId: PersistenceId, @body body: ProposeChangeSetRequest, @header("Idempotency-Key") idempotencyKey: PersistenceIdempotencyKey): { @statusCode _: 201; @body body: PersistenceChangeSetResultBody; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets/{changeSetId}") @get @operationId("persistence_changeset_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The public response keeps the approved compatibility schema; the selected Desktop client validates the strict generated ChangeSet projection until an epoch-compatible public schema update.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/PersistenceChangeSetDesktopResponseBody")
op getPersistenceChangeSet(@path projectId: PersistenceId, @path changeSetId: PersistenceId): PersistenceChangeSetResponseBody | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets/{changeSetId}/approve") @post @operationId("persistence_changeset_approve_post")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The public response keeps the approved compatibility schema; the selected Desktop client validates the strict generated ChangeSet projection until an epoch-compatible public schema update.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/PersistenceChangeSetDesktopApprovalBody")
op approvePersistenceChangeSet(@path projectId: PersistenceId, @path changeSetId: PersistenceId, @body body: ChangeSetActionRequest): PersistenceChangeSetApprovalBody | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets/{changeSetId}/reject") @post @operationId("persistence_changeset_reject_post")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The public response keeps the approved compatibility schema; the selected Desktop client validates the strict generated ChangeSet projection until an epoch-compatible public schema update.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/PersistenceChangeSetDesktopApprovalBody")
op rejectPersistenceChangeSet(@path projectId: PersistenceId, @path changeSetId: PersistenceId, @body body: ChangeSetActionRequest): PersistenceChangeSetApprovalBody | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets/{changeSetId}/apply") @post @operationId("persistence_changeset_apply_post")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The public response keeps the approved compatibility schema; the selected Desktop client validates the strict generated ChangeSet projection until an epoch-compatible public schema update.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/PersistenceChangeSetDesktopApplicationBody")
op applyPersistenceChangeSet(@path projectId: PersistenceId, @path changeSetId: PersistenceId, @body body: ChangeSetActionRequest): PersistenceChangeSetApplicationBody | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | PersistenceUnauthorized;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/review-feed") @get @operationId("persistence_review_feed_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The public response keeps the approved compatibility schema; the selected Desktop client validates the strict generated ChangeSet and core-proposal feed projection until an epoch-compatible public schema update.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/DesktopReviewFeedBody")
op getPersistenceReviewFeed(@path projectId: PersistenceId, @query @minValue(1) @maxValue(200) limit?: int32): PersistenceReviewFeedBody | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | PersistenceUnauthorized;
