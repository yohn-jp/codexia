import "@typespec/http";
import "@typespec/openapi";
using TypeSpec.Http;
using TypeSpec.OpenAPI;

namespace Codexia.Http;

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/status") @get @operationId("persistence_status_get")
op getPersistenceStatus(): PersistenceStatusResponse | { @statusCode _: 503; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects") @get @operationId("persistence_projects_get")
op listPersistenceProjects(@query limit?: int32, @query cursor?: string): ProjectPageResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 503; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects") @post @operationId("persistence_projects_post")
op createPersistenceProject(@body body: PersistenceProjectCreateRequest): { @statusCode _: 201; @body body: ProjectResponse; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/import") @post @operationId("persistence_import_post")
op importPersistenceProject(@body body: JsonObject, @header("Idempotency-Key") idempotencyKey: string): { @statusCode _: 201; @body body: JsonObject; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}") @get @operationId("persistence_project_get")
op getPersistenceProject(@path projectId: string): ProjectResponse | { @statusCode _: 404; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}") @patch @operationId("persistence_project_patch")
op updatePersistenceProject(@path projectId: string, @body body: PersistenceProjectUpdateRequest): ProjectResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/archive") @get @operationId("persistence_project_archive_get")
op exportPersistenceArchive(@path projectId: string): JsonResponse | { @statusCode _: 404; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents") @get @operationId("persistence_documents_get")
op listPersistenceDocuments(
  @path projectId: string,
  @query parentId?: string,
  @query projectVersion?: int32,
  @query @minValue(1) @maxValue(1000) limit?: int32 = 500,
): PersistenceDocumentListResponse | { @statusCode _: 400; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents") @post @operationId("persistence_documents_post")
op createPersistenceDocument(@path projectId: string, @body body: JsonObject, @header("Idempotency-Key") idempotencyKey: string): { @statusCode _: 201; @body body: SaveDocumentResponse; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}") @get @operationId("persistence_document_get")
op getPersistenceDocument(@path projectId: string, @path documentId: string, @query revision?: string, @query projectVersion?: int32): PersistenceDocumentGetResponse | { @statusCode _: 404; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}") @patch @operationId("persistence_document_patch")
op savePersistenceDocument(
  @path projectId: string,
  @path documentId: string,
  @body body: SaveDocumentRequest,
  @header("Idempotency-Key") idempotencyKey: string,
  @header("X-Client-Id") clientId?: string,
): { @statusCode _: 200; @body body: SaveDocumentResponse; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: SaveConflictResponse; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}") @delete @operationId("persistence_document_delete")
op deletePersistenceDocument(@path projectId: string, @path documentId: string, @body body: JsonObject): PersistenceDocumentEnvelope | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/metadata") @patch @operationId("persistence_document_metadata_patch")
op updatePersistenceDocumentMetadata(@path projectId: string, @path documentId: string, @body body: JsonObject): PersistenceDocumentEnvelope | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/revisions") @get @operationId("persistence_document_revisions_get")
op listPersistenceDocumentRevisions(@path projectId: string, @path documentId: string, @query limit?: int32, @query before?: string): DocumentRevisionPageResponse | { @statusCode _: 404; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/restore") @post @operationId("persistence_document_restore_post")
op restorePersistenceDocumentRevision(@path projectId: string, @path documentId: string, @body body: JsonObject, @header("Idempotency-Key") idempotencyKey: string): SaveDocumentResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/anchors") @get @operationId("persistence_document_anchors_get")
op listPersistenceDocumentAnchors(@path projectId: string, @path documentId: string, @query revision?: string, @query limit?: int32, @query projectVersion?: int32): JsonResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/anchors") @post @operationId("persistence_document_anchors_post")
op createPersistenceAnchor(@path projectId: string, @path documentId: string, @body body: JsonObject): { @statusCode _: 201; @body body: PersistenceAnchorCreatedResponse; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/anchors/{anchorId}") @patch @operationId("persistence_document_anchor_patch")
op updatePersistenceAnchor(@path projectId: string, @path documentId: string, @path anchorId: string, @body body: JsonObject): PersistenceEvidenceAnchor | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/anchors/{anchorId}/assertions") @post @operationId("persistence_anchor_assertions_post")
op createAnchorAssertion(@path projectId: string, @path documentId: string, @path anchorId: string, @body body: JsonObject): { @statusCode _: 201; @body body: JsonObject; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/documents/{documentId}/anchors/{anchorId}/mentions") @post @operationId("persistence_anchor_mentions_post")
op createAnchorMention(@path projectId: string, @path documentId: string, @path anchorId: string, @body body: JsonObject): { @statusCode _: 201; @body body: JsonObject; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes") @get @operationId("persistence_nodes_get")
op listPersistenceNodes(@path projectId: string, @query q?: string, @query type?: string, @query status?: string, @query limit?: int32, @query cursor?: string, @query projectVersion?: int32): JsonResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}") @get @operationId("persistence_node_get")
op getPersistenceNode(@path projectId: string, @path nodeId: string, @query projectVersion?: int32): JsonResponse | { @statusCode _: 404; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}") @put @operationId("persistence_node_put")
op updatePersistenceNode(@path projectId: string, @path nodeId: string, @body body: JsonObject): JsonResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}/merge-preview") @post @operationId("persistence_node_merge_preview_post")
op previewPersistenceNodeMerge(@path projectId: string, @path nodeId: string, @body body: KnowledgeMergePreviewRequest): JsonResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}/merge") @post @operationId("persistence_node_merge_post")
op mergePersistenceNode(@path projectId: string, @path nodeId: string, @body body: KnowledgeMergeRequest): JsonResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}/aliases") @post @operationId("persistence_node_aliases_post")
op createPersistenceNodeAlias(@path projectId: string, @path nodeId: string, @body body: JsonObject): { @statusCode _: 201; @body body: JsonObject; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}/relations") @post @operationId("persistence_node_relations_post")
op createPersistenceNodeRelation(@path projectId: string, @path nodeId: string, @body body: JsonObject): { @statusCode _: 201; @body body: JsonObject; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/nodes/{nodeId}/evidence") @get @operationId("persistence_node_evidence_get")
op listPersistenceNodeEvidence(@path projectId: string, @path nodeId: string, @query limit?: int32, @query projectVersion?: int32): JsonResponse | { @statusCode _: 404; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/assertions/{assertionId}") @get @operationId("persistence_assertion_get")
op getPersistenceAssertion(@path projectId: string, @path assertionId: string, @query projectVersion?: int32): JsonResponse | { @statusCode _: 404; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/assertions/{assertionId}") @put @operationId("persistence_assertion_put")
op updatePersistenceAssertion(@path projectId: string, @path assertionId: string, @body body: JsonObject): JsonResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/assertions/{assertionId}/evidence") @get @operationId("persistence_assertion_evidence_get")
op listPersistenceAssertionEvidence(@path projectId: string, @path assertionId: string, @query projectVersion?: int32): JsonResponse | { @statusCode _: 404; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/assertions/{assertionId}/evidence") @post @operationId("persistence_assertion_evidence_post")
op createPersistenceAssertionEvidence(@path projectId: string, @path assertionId: string, @body body: JsonObject): { @statusCode _: 201; @body body: JsonObject; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets") @get @operationId("persistence_changesets_get")
op listPersistenceChangeSets(@path projectId: string, @query limit?: int32): JsonResponse | { @statusCode _: 400; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets") @post @operationId("persistence_changesets_post")
op proposePersistenceChangeSet(@path projectId: string, @body body: ProposeChangeSetRequest, @header("Idempotency-Key") idempotencyKey: string): { @statusCode _: 201; @body body: JsonObject; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets/{changeSetId}") @get @operationId("persistence_changeset_get")
op getPersistenceChangeSet(@path projectId: string, @path changeSetId: string): JsonResponse | { @statusCode _: 404; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets/{changeSetId}/approve") @post @operationId("persistence_changeset_approve_post")
op approvePersistenceChangeSet(@path projectId: string, @path changeSetId: string, @body body: ChangeSetActionRequest): JsonResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets/{changeSetId}/reject") @post @operationId("persistence_changeset_reject_post")
op rejectPersistenceChangeSet(@path projectId: string, @path changeSetId: string, @body body: ChangeSetActionRequest): JsonResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/changesets/{changeSetId}/apply") @post @operationId("persistence_changeset_apply_post")
op applyPersistenceChangeSet(@path projectId: string, @path changeSetId: string, @body body: ChangeSetActionRequest): JsonResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 409; @body body: ApiError; };

@tag("persistence") @extension("x-codexia-principal", "OWNER-API")
@route("/api/v1/persistence/projects/{projectId}/review-feed") @get @operationId("persistence_review_feed_get")
op getPersistenceReviewFeed(@path projectId: string, @query limit?: int32): JsonResponse | { @statusCode _: 403; @body body: ApiError; };
