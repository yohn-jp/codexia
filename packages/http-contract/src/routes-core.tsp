import "@typespec/http";
import "@typespec/openapi";
using TypeSpec.Http;
using TypeSpec.OpenAPI;

namespace Codexia.Http;

@tag("health")
@useAuth(NoAuth)
@route("/api/health") @get @operationId("api_health_get")
op getHealth(): HealthResponse | { @statusCode _: 503; @body body: ApiError; };

@tag("health") @useAuth(NoAuth)
@route("/api/health") @head @operationId("api_health_head")
op headHealth(): HeadJsonResponse;

@tag("health") @useAuth(NoAuth)
@route("/api/ready") @get @operationId("api_ready_get")
op getReady(): ReadinessSuccess | ReadinessUnavailable;

@tag("health") @useAuth(NoAuth)
@route("/api/ready") @head @operationId("api_ready_head")
op headReady(): HeadJsonResponse | { @statusCode _: 503; @header contentType: "application/json"; };

@tag("health") @useAuth(NoAuth)
@route("/health/live") @get @operationId("health_live_get")
op getLive(): ReadinessSuccess;

@tag("health") @useAuth(NoAuth)
@route("/health/live") @head @operationId("health_live_head")
op headLive(): HeadJsonResponse;

@tag("health") @useAuth(NoAuth)
@route("/health/ready") @get @operationId("health_ready_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "In setup-only runtime mode, HTTP 200 returns `{ status: \"ready\" }` instead of the approved ReadinessResponse shape; keep this mismatch explicit until an approved compatibility correction.")
op getHealthReady(): ReadinessSuccess | OwnerSetupRateLimited | ReadinessUnavailable | OwnerSetupReadinessUnavailable;

@tag("health") @useAuth(NoAuth)
@route("/health/ready") @head @operationId("health_ready_head")
op headHealthReady(): HeadJsonResponse | { @statusCode _: 503; @header contentType: "application/json"; };

@tag("health") @useAuth(NoAuth)
@route("/health/startup") @get @operationId("health_startup_get")
op getStartup(): ReadinessSuccess | ReadinessUnavailable;

@tag("health") @useAuth(NoAuth)
@route("/health/startup") @head @operationId("health_startup_head")
op headStartup(): HeadJsonResponse | { @statusCode _: 503; @header contentType: "application/json"; };

@tag("health") @useAuth(NoAuth)
@route("/api/version") @get @operationId("api_version_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The runtime and OCI probes use a numeric contractVersion; the API epoch baseline documents a string.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/DesktopVersionResponse")
op getApiVersion(): VersionResponse;

@tag("health") @useAuth(NoAuth)
@route("/api/version") @head @operationId("api_version_head")
op headApiVersion(): HeadJsonResponse;

@tag("health") @useAuth(NoAuth)
@route("/api/browser/version") @get @operationId("api_browser_version_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The runtime and OCI probes use a numeric contractVersion; the API epoch baseline documents a string.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/DesktopVersionResponse")
op getBrowserVersion(): VersionResponse;

@tag("health") @useAuth(NoAuth)
@route("/api/browser/version") @head @operationId("api_browser_version_head")
op headBrowserVersion(): HeadJsonResponse;

@tag("owner") @extension("x-codexia-principal", "OWNER-API")
@route("/api/session") @get @operationId("api_session_get")
op getSession(): ApiSessionBody;

@tag("events") @extension("x-codexia-principal", "OWNER-API")
@route("/api/projects/events") @get @operationId("project_events_get")
op getProjectEvents(): EventStream | { @statusCode _: 503; @body body: ApiError; };

@tag("events") @extension("x-codexia-principal", "OWNER-API")
@route("/api/jobs/events") @get @operationId("job_events_get")
op getJobEvents(): EventStream | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 503; @body body: ApiError; };

@tag("jobs") @extension("x-codexia-principal", "OWNER-API")
@route("/api/jobs") @get @operationId("jobs_list_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "Runtime serializes the public job collection as a top-level array; the approved baseline response body is an object. The wire-shape discrepancy remains tracked pending an approved compatibility correction.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/DesktopJobList")
op listJobs(): JsonResponse | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 503; @body body: ApiError; };

@tag("jobs") @extension("x-codexia-principal", "OWNER-API")
@route("/api/jobs/{jobId}") @get @operationId("job_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "Desktop validates progress between zero and one. The API epoch baseline keeps the nullable progress number schema.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/DesktopPublicJobBody")
op getJob(@path jobId: string): PublicJobBody | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 503; @body body: ApiError; };

@tag("jobs") @extension("x-codexia-principal", "OWNER-API")
@route("/api/inbox") @get @operationId("inbox_list_get")
op listInbox(@query unread?: "1"): InboxListBody | { @statusCode _: 403; @body body: ApiError; };

@tag("jobs") @extension("x-codexia-principal", "OWNER-API")
@route("/api/inbox/read-all") @post @operationId("inbox_read_all_post")
op readAllInbox(): InboxReadAllBody | { @statusCode _: 403; @body body: ApiError; };

@tag("jobs") @extension("x-codexia-principal", "OWNER-API")
@route("/api/inbox/{inboxId}/read") @post @operationId("inbox_item_read_post")
op readInboxItem(@path inboxId: string): InboxReadItemBody | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; };

@tag("projects") @extension("x-codexia-principal", "OWNER-API | MCP-CLIENT(mcp:read)")
@route("/api/projects") @get @operationId("projects_list_get")
op listProjects(@query limit?: int32, @query cursor?: string): ProjectPageResponse | { @statusCode _: 400; @body body: ApiError; };

@tag("projects") @extension("x-codexia-principal", "OWNER-API")
@route("/api/projects") @post @operationId("projects_create_post")
op createProject(@body body: CoreProjectCreateRequest): { @statusCode _: 201; @body body: Project; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; };

@tag("reviews") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/review-queue") @get @operationId("review_queue_get")
op getReviewQueue(): GlobalReviewQueueBody | { @statusCode _: 503; @body body: ApiError; };

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}") @get @operationId("project_get")
op getProject(@path projectId: string): ProjectReadBody | { @statusCode _: 404; @body body: ApiError; };

@tag("projects") @extension("x-codexia-principal", "OWNER-API")
@route("/api/projects/{projectId}/recent-activity") @get @operationId("project_recent_activity_get")
op getRecentActivity(@path projectId: string): RecentActivityBody | { @statusCode _: 403; @body body: ApiError; };

@tag("projects") @extension("x-codexia-principal", "OWNER-API")
@route("/api/projects/{projectId}/recent-activity") @put @operationId("project_recent_activity_put")
op putRecentActivity(@path projectId: string, @body body: JsonObject, @header("X-Codexia-Recent-Activity-Order") order?: string): RecentActivityBody | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; };

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/modules") @get @operationId("project_modules_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "Runtime emits an array of module status objects; the approved baseline response body is an object. The wire-shape discrepancy remains tracked pending an approved compatibility correction.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/DesktopModuleList")
op getProjectModules(@path projectId: string): JsonResponse;

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/contributions") @get @operationId("project_contributions_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "Runtime emits an array of HTTP contribution descriptors; the approved baseline response body is an object. The wire-shape discrepancy remains tracked pending an approved compatibility correction.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/DesktopContributionList")
op getProjectContributions(@path projectId: string): JsonResponse;

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/tree") @get @operationId("project_tree_get")
op getProjectTree(@path projectId: string, @query snapshot?: string, @query projectVersion?: safeint): ProjectTreeResponse;

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/scenes/{sceneId}") @get @operationId("project_scene_get")
op getProjectScene(@path projectId: string, @path sceneId: string, @query snapshot?: string, @query projectVersion?: safeint): ProjectSceneResponse;

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/snapshot") @get @operationId("project_snapshot_get")
op getProjectSnapshot(@path projectId: string, @query snapshot?: string, @query projectVersion?: safeint, @query("projection") editorProjection?: "editor", @query documentId?: string): ProjectSnapshotResponse;

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/history") @get @operationId("project_history_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "Runtime emits an array of commit records; the approved baseline response body is an object. The wire-shape discrepancy remains tracked pending an approved compatibility correction.")
op getProjectHistory(@path projectId: string, @query snapshot?: string, @query projectVersion?: safeint): JsonResponse;

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/status") @get @operationId("project_status_get")
op getProjectStatus(@path projectId: string): ProjectStatusBody;

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/observation") @get @operationId("project_observation_get")
op getProjectObservation(@path projectId: string): ProjectObservationBody;

@tag("proposals") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:propose)")
@route("/api/projects/{projectId}/proposals") @post @operationId("project_proposals_create_post")
op createProposal(@path projectId: string, @body body: JsonObject): { @statusCode _: 201; @body body: CoreChangeProposalBody; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; };

@tag("proposals") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/proposals") @get @operationId("project_proposals_list_get")
op listProposals(@path projectId: string): ProposalListBody;

@tag("proposals") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/proposals/{proposalId}") @get @operationId("project_proposal_get")
op getProposal(@path projectId: string, @path proposalId: string): CoreProposalStatusBody;

@tag("proposals") @extension("x-codexia-principal", "OWNER-API")
@route("/api/projects/{projectId}/approvals") @post @operationId("project_approvals_post")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "Runtime returns HTTP 204 with no body after approval; the approved baseline documents a JSON response. The status and body discrepancy remains tracked pending an approved compatibility correction.")
op approveProposal(@path projectId: string, @body body: JsonObject): JsonResponse | { @statusCode _: 204; } | { @statusCode _: 403; @body body: ApiError; };

@tag("proposals") @extension("x-codexia-principal", "OWNER-API")
@route("/api/projects/{projectId}/apply") @post @operationId("project_apply_post")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "Runtime returns HTTP 201; the approved baseline success response is 200. The baseline 200 remains documented for API-epoch compatibility comparison.")
op applyProposal(@path projectId: string, @body body: JsonObject): ProposalApplyReceiptBody | { @statusCode _: 201; @body body: ProposalApplyReceiptBody; } | { @statusCode _: 403; @body body: ApiError; };

@tag("actions") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/actions") @get @operationId("project_actions_get")
op listProjectActions(@path projectId: string): ProjectActionsBody;

@tag("actions") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:compute|propose)")
@route("/api/projects/{projectId}/actions/{actionId}") @post @operationId("project_action_post")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "Desktop validates the success and failure variants of the synchronous Action result; the API epoch baseline retains the published object schema.")
@extension("x-codexia-desktop-response-schema", "#/components/schemas/DesktopActionResultBody")
op invokeProjectAction(@path projectId: string, @path actionId: string, @body body: JsonObject, @header("Prefer") prefer?: string): ActionResultBody | { @statusCode _: 202; @header("Location") location: string; @header("Preference-Applied") preferenceApplied: "respond-async"; @header("X-Codexia-Job-Id") jobId: string; @body job: PublicJobBody; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; };

@tag("snapshots") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/manuscripts/{manuscriptId}/snapshots") @get @operationId("manuscript_snapshots_get")
op listManuscriptSnapshots(@path projectId: string, @path manuscriptId: string, @query sceneId?: string, @query snapshot?: string, @query projectVersion?: safeint): ManuscriptSnapshotListBody;

@tag("snapshots") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/manuscripts/{manuscriptId}/snapshots/{snapshotId}") @get @operationId("manuscript_snapshot_get")
op getManuscriptSnapshot(@path projectId: string, @path manuscriptId: string, @path snapshotId: string, @query snapshot?: string, @query projectVersion?: safeint): ManuscriptSnapshotReadBody;

@tag("search") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/search") @get @operationId("project_search_get")
op searchProject(@path projectId: string, @query q: string, @query limit?: int32, @query snapshot?: string, @query projectVersion?: safeint): ProjectSearchBody | { @statusCode _: 400; @body body: ApiError; };

@tag("search") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/writing-stats") @get @operationId("project_writing_stats_get")
op getWritingStats(@path projectId: string, @query snapshot?: string, @query projectVersion?: safeint): WritingStatsResponseBody;

@tag("projects") @extension("x-codexia-principal", "OWNER-API")
@route("/api/projects/{projectId}/scratch") @post @operationId("project_scratch_post")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "Runtime returns HTTP 201; the approved baseline success response is 200. The baseline 200 remains documented for API-epoch compatibility comparison.")
op createScratch(@path projectId: string, @body body: JsonObject): ScratchCreateBody | { @statusCode _: 201; @body body: ScratchCreateBody; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 413; @body body: ApiError; };

@tag("reviews") @extension("x-codexia-principal", "OWNER-API")
@route("/api/projects/{projectId}/review-queue") @get @operationId("project_review_queue_get")
op getProjectReviewQueue(@path projectId: string): ProjectReviewQueueBody | { @statusCode _: 503; @body body: ApiError; };

@tag("mcp") @extension("x-codexia-principal", "MCP-CLIENT + project assignment + scope")
@route("/mcp") @get @operationId("mcp_root_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "After admission, the MCP SDK returns HTTP 405 with Allow: POST and JSON-RPC error -32000, id null. The approved API epoch baseline keeps its ApiError response schema pending a compatibility correction.")
op getStandaloneMcp(@query projectId?: string, @header("MCP-Protocol-Version") protocolVersion?: string, @header("Mcp-Method") method?: string, @header("Mcp-Name") name?: string, @header("Accept") accept?: string): McpMethodDenied | McpAdmissionBadRequest | McpAdmissionForbidden | { @statusCode _: 401; @header("WWW-Authenticate") challenge: string; @body body: ApiError; } | McpAdmissionNotFound | McpAdmissionUnavailable;

@tag("mcp") @extension("x-codexia-principal", "MCP-CLIENT + project assignment + scope")
@route("/mcp") @post @operationId("mcp_root_post")
op postStandaloneMcp(@query projectId?: string, @body body: JsonObject | JsonObject[], @header("MCP-Protocol-Version") protocolVersion?: string, @header("Mcp-Method") method?: string, @header("Mcp-Name") name?: string, @header("Accept") accept?: string): McpEventStream | McpJsonResponse | McpAcceptedResponse | { @statusCode _: 400; @body body: ApiError | McpParseError; } | { @statusCode _: 401; @header("WWW-Authenticate") challenge: string; @body body: ApiError; } | McpAdmissionForbidden | { @statusCode _: 413; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | McpAdmissionNotFound | McpAdmissionUnavailable;

@tag("mcp") @extension("x-codexia-principal", "MCP-CLIENT + project assignment + scope")
@route("/mcp") @delete @operationId("mcp_root_delete")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "After admission, the MCP SDK returns HTTP 405 with Allow: POST and JSON-RPC error -32000, id null. The approved API epoch baseline keeps its ApiError response schema pending a compatibility correction.")
op deleteStandaloneMcp(@query projectId?: string, @header("MCP-Protocol-Version") protocolVersion?: string, @header("Mcp-Method") method?: string, @header("Mcp-Name") name?: string): McpMethodDenied | McpAdmissionBadRequest | McpAdmissionForbidden | { @statusCode _: 401; @header("WWW-Authenticate") challenge: string; @body body: ApiError; } | McpAdmissionNotFound | McpAdmissionUnavailable;

@tag("mcp") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT with effect scope")
@route("/api/projects/{projectId}/modules/mcp/streamable") @get @operationId("project_mcp_stream_get")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "After admission, the MCP SDK returns HTTP 405 with Allow: POST and JSON-RPC error -32000, id null. The approved API epoch baseline keeps its ApiError response schema pending a compatibility correction.")
op getProjectMcpStream(@path projectId: string, @header("MCP-Protocol-Version") protocolVersion?: string, @header("Mcp-Method") method?: string, @header("Mcp-Name") name?: string, @header("Accept") accept?: string): McpMethodDenied | McpAdmissionBadRequest | McpAdmissionForbidden | { @statusCode _: 401; @header("WWW-Authenticate") challenge: string; @body body: ApiError; } | McpAdmissionNotFound | McpAdmissionUnavailable;

@tag("mcp") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT with effect scope")
@route("/api/projects/{projectId}/modules/mcp/streamable") @post @operationId("project_mcp_stream_post")
op postProjectMcpStream(@path projectId: string, @body body: JsonObject | JsonObject[], @header("MCP-Protocol-Version") protocolVersion?: string, @header("Mcp-Method") method?: string, @header("Mcp-Name") name?: string, @header("Accept") accept?: string): McpEventStream | McpJsonResponse | McpAcceptedResponse | { @statusCode _: 400; @body body: ApiError | McpParseError; } | { @statusCode _: 401; @header("WWW-Authenticate") challenge: string; @body body: ApiError; } | McpAdmissionForbidden | { @statusCode _: 413; @body body: ApiError; } | { @statusCode _: 415; @body body: ApiError; } | McpAdmissionNotFound | McpAdmissionUnavailable;

@tag("mcp") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT with effect scope")
@route("/api/projects/{projectId}/modules/mcp/streamable") @delete @operationId("project_mcp_stream_delete")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "After admission, the MCP SDK returns HTTP 405 with Allow: POST and JSON-RPC error -32000, id null. The approved API epoch baseline keeps its ApiError response schema pending a compatibility correction.")
op deleteProjectMcpStream(@path projectId: string, @header("MCP-Protocol-Version") protocolVersion?: string, @header("Mcp-Method") method?: string, @header("Mcp-Name") name?: string): McpMethodDenied | McpAdmissionBadRequest | McpAdmissionForbidden | { @statusCode _: 401; @header("WWW-Authenticate") challenge?: string; @body body: ApiError; } | McpAdmissionNotFound | McpAdmissionUnavailable;

@tag("public-reader") @useAuth(NoAuth) @extension("x-codexia-principal", "SHARE-READER capability")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The runtime reader returns only `{ error: \"Share link is unavailable\" }` at 404; the baseline error schema still requires a code field pending an approved compatibility baseline correction.")
@route("/api/public/projects/{projectId}/modules/publishing/share/{token}") @get @operationId("public_share_get")
op getPublicShare(@path projectId: string, @path token: string): PublicShareIndexResponse | { @statusCode _: 404; @body body: ApiError; };

@tag("public-reader") @useAuth(NoAuth) @extension("x-codexia-principal", "SHARE-READER capability")
@extension("x-codexia-contract-status", "incomplete")
@extension("x-codexia-runtime-response-deviation", "The runtime reader returns only `{ error: \"Share link is unavailable\" }` at 404; the baseline error schema still requires a code field pending an approved compatibility baseline correction.")
@route("/api/public/projects/{projectId}/modules/publishing/share/{token}/scenes/{sceneId}") @get @operationId("public_share_scene_get")
op getPublicShareScene(@path projectId: string, @path token: string, @path sceneId: string): PublicShareSceneResponse | { @statusCode _: 404; @body body: ApiError; };
