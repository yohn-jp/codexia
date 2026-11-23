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
op getReady(): ReadinessResponse;

@tag("health") @useAuth(NoAuth)
@route("/api/ready") @head @operationId("api_ready_head")
op headReady(): HeadJsonResponse | { @statusCode _: 503; @header contentType: "application/json"; };

@tag("health") @useAuth(NoAuth)
@route("/health/live") @get @operationId("health_live_get")
op getLive(): ReadinessResponse;

@tag("health") @useAuth(NoAuth)
@route("/health/live") @head @operationId("health_live_head")
op headLive(): HeadJsonResponse;

@tag("health") @useAuth(NoAuth)
@route("/health/ready") @get @operationId("health_ready_get")
op getHealthReady(): ReadinessResponse | OwnerSetupRateLimited;

@tag("health") @useAuth(NoAuth)
@route("/health/ready") @head @operationId("health_ready_head")
op headHealthReady(): HeadJsonResponse | { @statusCode _: 503; @header contentType: "application/json"; };

@tag("health") @useAuth(NoAuth)
@route("/health/startup") @get @operationId("health_startup_get")
op getStartup(): ReadinessResponse;

@tag("health") @useAuth(NoAuth)
@route("/health/startup") @head @operationId("health_startup_head")
op headStartup(): HeadJsonResponse | { @statusCode _: 503; @header contentType: "application/json"; };

@tag("health") @useAuth(NoAuth)
@route("/api/version") @get @operationId("api_version_get")
op getApiVersion(): VersionResponse;

@tag("health") @useAuth(NoAuth)
@route("/api/version") @head @operationId("api_version_head")
op headApiVersion(): HeadJsonResponse;

@tag("health") @useAuth(NoAuth)
@route("/api/browser/version") @get @operationId("api_browser_version_get")
op getBrowserVersion(): VersionResponse;

@tag("health") @useAuth(NoAuth)
@route("/api/browser/version") @head @operationId("api_browser_version_head")
op headBrowserVersion(): HeadJsonResponse;

@tag("owner") @extension("x-codexia-principal", "OWNER-API")
@route("/api/session") @get @operationId("api_session_get")
op getSession(): JsonResponse;

@tag("events") @extension("x-codexia-principal", "OWNER-API")
@route("/api/projects/events") @get @operationId("project_events_get")
op getProjectEvents(): EventStream | { @statusCode _: 503; @body body: ApiError; };

@tag("events") @extension("x-codexia-principal", "OWNER-SESSION")
@route("/api/jobs/events") @get @operationId("job_events_get")
op getJobEvents(): EventStream | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 503; @body body: ApiError; };

@tag("jobs") @extension("x-codexia-principal", "OWNER-SESSION")
@route("/api/jobs") @get @operationId("jobs_list_get")
op listJobs(): JsonResponse | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 503; @body body: ApiError; };

@tag("jobs") @extension("x-codexia-principal", "OWNER-SESSION")
@route("/api/jobs/{jobId}") @get @operationId("job_get")
op getJob(@path jobId: string): JsonResponse | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; } | { @statusCode _: 503; @body body: ApiError; };

@tag("jobs") @extension("x-codexia-principal", "OWNER-SESSION")
@route("/api/inbox") @get @operationId("inbox_list_get")
op listInbox(@query unread?: "1"): JsonResponse | { @statusCode _: 403; @body body: ApiError; };

@tag("jobs") @extension("x-codexia-principal", "OWNER-SESSION")
@route("/api/inbox/read-all") @post @operationId("inbox_read_all_post")
op readAllInbox(): JsonResponse | { @statusCode _: 403; @body body: ApiError; };

@tag("jobs") @extension("x-codexia-principal", "OWNER-SESSION")
@route("/api/inbox/{inboxId}/read") @post @operationId("inbox_item_read_post")
op readInboxItem(@path inboxId: string): JsonResponse | { @statusCode _: 403; @body body: ApiError; } | { @statusCode _: 404; @body body: ApiError; };

@tag("projects") @extension("x-codexia-principal", "OWNER-API | MCP-CLIENT(mcp:read)")
@route("/api/projects") @get @operationId("projects_list_get")
op listProjects(@query limit?: int32, @query cursor?: string): ProjectPageResponse | { @statusCode _: 400; @body body: ApiError; };

@tag("projects") @extension("x-codexia-principal", "OWNER-SESSION")
@route("/api/projects") @post @operationId("projects_create_post")
op createProject(@body body: CoreProjectCreateRequest): { @statusCode _: 201; @body body: Project; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; };

@tag("reviews") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/review-queue") @get @operationId("review_queue_get")
op getReviewQueue(): JsonResponse | { @statusCode _: 503; @body body: ApiError; };

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}") @get @operationId("project_get")
op getProject(@path projectId: string): JsonResponse | { @statusCode _: 404; @body body: ApiError; };

@tag("projects") @extension("x-codexia-principal", "OWNER-SESSION")
@route("/api/projects/{projectId}/recent-activity") @get @operationId("project_recent_activity_get")
op getRecentActivity(@path projectId: string): JsonResponse | { @statusCode _: 403; @body body: ApiError; };

@tag("projects") @extension("x-codexia-principal", "OWNER-SESSION")
@route("/api/projects/{projectId}/recent-activity") @put @operationId("project_recent_activity_put")
op putRecentActivity(@path projectId: string, @body body: JsonObject, @header("X-Codexia-Recent-Activity-Order") order?: string): JsonResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; };

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/modules") @get @operationId("project_modules_get")
op getProjectModules(@path projectId: string): JsonResponse;

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/contributions") @get @operationId("project_contributions_get")
op getProjectContributions(@path projectId: string): JsonResponse;

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/tree") @get @operationId("project_tree_get")
op getProjectTree(@path projectId: string): JsonResponse;

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/scenes/{sceneId}") @get @operationId("project_scene_get")
op getProjectScene(@path projectId: string, @path sceneId: string): JsonResponse;

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/snapshot") @get @operationId("project_snapshot_get")
op getProjectSnapshot(@path projectId: string, @query snapshot?: string): JsonResponse;

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/history") @get @operationId("project_history_get")
op getProjectHistory(@path projectId: string, @query snapshot?: string): JsonResponse;

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/status") @get @operationId("project_status_get")
op getProjectStatus(@path projectId: string): JsonResponse;

@tag("projects") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/observation") @get @operationId("project_observation_get")
op getProjectObservation(@path projectId: string): JsonResponse;

@tag("proposals") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:propose)")
@route("/api/projects/{projectId}/proposals") @post @operationId("project_proposals_create_post")
op createProposal(@path projectId: string, @body body: JsonObject): { @statusCode _: 201; @body body: JsonObject; } | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; };

@tag("proposals") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/proposals") @get @operationId("project_proposals_list_get")
op listProposals(@path projectId: string): JsonResponse;

@tag("proposals") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/proposals/{proposalId}") @get @operationId("project_proposal_get")
op getProposal(@path projectId: string, @path proposalId: string): JsonResponse;

@tag("proposals") @extension("x-codexia-principal", "OWNER-SESSION")
@route("/api/projects/{projectId}/approvals") @post @operationId("project_approvals_post")
op approveProposal(@path projectId: string, @body body: JsonObject): JsonResponse | { @statusCode _: 403; @body body: ApiError; };

@tag("proposals") @extension("x-codexia-principal", "OWNER-SESSION")
@route("/api/projects/{projectId}/apply") @post @operationId("project_apply_post")
op applyProposal(@path projectId: string, @body body: JsonObject): JsonResponse | { @statusCode _: 403; @body body: ApiError; };

@tag("actions") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/actions") @get @operationId("project_actions_get")
op listProjectActions(@path projectId: string): JsonResponse;

@tag("actions") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:compute|propose)")
@route("/api/projects/{projectId}/actions/{actionId}") @post @operationId("project_action_post")
op invokeProjectAction(@path projectId: string, @path actionId: string, @body body: JsonObject): JsonResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; };

@tag("snapshots") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/manuscripts/{manuscriptId}/snapshots") @get @operationId("manuscript_snapshots_get")
op listManuscriptSnapshots(@path projectId: string, @path manuscriptId: string): JsonResponse;

@tag("snapshots") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/manuscripts/{manuscriptId}/snapshots/{snapshotId}") @get @operationId("manuscript_snapshot_get")
op getManuscriptSnapshot(@path projectId: string, @path manuscriptId: string, @path snapshotId: string): JsonResponse;

@tag("search") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/search") @get @operationId("project_search_get")
op searchProject(@path projectId: string, @query q: string, @query limit?: int32, @query snapshot?: string): JsonResponse | { @statusCode _: 400; @body body: ApiError; };

@tag("search") @extension("x-codexia-principal", "OWNER-API | assigned MCP-CLIENT(mcp:read)")
@route("/api/projects/{projectId}/writing-stats") @get @operationId("project_writing_stats_get")
op getWritingStats(@path projectId: string, @query snapshot?: string): JsonResponse;

@tag("projects") @extension("x-codexia-principal", "OWNER-SESSION")
@route("/api/projects/{projectId}/scratch") @post @operationId("project_scratch_post")
op createScratch(@path projectId: string, @body body: JsonObject): JsonResponse | { @statusCode _: 400; @body body: ApiError; } | { @statusCode _: 403; @body body: ApiError; };

@tag("reviews") @extension("x-codexia-principal", "OWNER-SESSION")
@route("/api/projects/{projectId}/review-queue") @get @operationId("project_review_queue_get")
op getProjectReviewQueue(@path projectId: string): JsonResponse | { @statusCode _: 503; @body body: ApiError; };

@tag("mcp") @extension("x-codexia-principal", "MCP-CLIENT + project assignment + scope")
@route("/mcp") @get @operationId("mcp_root_get")
op getStandaloneMcp(): McpEventStream | McpJsonResponse | { @statusCode _: 401; @header("WWW-Authenticate") challenge: string; @body body: ApiError; };

@tag("mcp") @extension("x-codexia-principal", "MCP-CLIENT + project assignment + scope")
@route("/mcp") @post @operationId("mcp_root_post")
op postStandaloneMcp(@body body: JsonObject): McpEventStream | McpJsonResponse | { @statusCode _: 401; @header("WWW-Authenticate") challenge: string; @body body: ApiError; };

@tag("mcp") @extension("x-codexia-principal", "MCP-CLIENT + project assignment + scope")
@route("/mcp") @delete @operationId("mcp_root_delete")
op deleteStandaloneMcp(): McpJsonResponse | { @statusCode _: 401; @body body: ApiError; };

@tag("mcp") @extension("x-codexia-principal", "MCP-CLIENT + project assignment + scope")
@route("/api/projects/{projectId}/modules/mcp/streamable") @get @operationId("project_mcp_stream_get")
op getProjectMcpStream(@path projectId: string): McpEventStream | McpJsonResponse | { @statusCode _: 401; @header("WWW-Authenticate") challenge: string; @body body: ApiError; };

@tag("mcp") @extension("x-codexia-principal", "MCP-CLIENT + project assignment + scope")
@route("/api/projects/{projectId}/modules/mcp/streamable") @post @operationId("project_mcp_stream_post")
op postProjectMcpStream(@path projectId: string, @body body: JsonObject): McpEventStream | McpJsonResponse | { @statusCode _: 401; @header("WWW-Authenticate") challenge: string; @body body: ApiError; };

@tag("mcp") @extension("x-codexia-principal", "MCP-CLIENT + project assignment + scope")
@route("/api/projects/{projectId}/modules/mcp/streamable") @delete @operationId("project_mcp_stream_delete")
op deleteProjectMcpStream(@path projectId: string): McpJsonResponse | { @statusCode _: 401; @body body: ApiError; };

@tag("public-reader") @useAuth(NoAuth) @extension("x-codexia-principal", "SHARE-READER capability")
@route("/api/public/projects/{projectId}/modules/publishing/share/{token}") @get @operationId("public_share_get")
op getPublicShare(@path projectId: string, @path token: string): JsonResponse | { @statusCode _: 404; @body body: ApiError; };

@tag("public-reader") @useAuth(NoAuth) @extension("x-codexia-principal", "SHARE-READER capability")
@route("/api/public/projects/{projectId}/modules/publishing/share/{token}/scenes/{sceneId}") @get @operationId("public_share_scene_get")
op getPublicShareScene(@path projectId: string, @path token: string, @path sceneId: string): JsonResponse | { @statusCode _: 404; @body body: ApiError; };
