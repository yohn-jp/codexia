import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { BackupConsoleExecutor } from "../../packages/api/src/backup-console-executor.js";
import type { BackupPolicy } from "../../packages/api/src/backup-console-routes.js";
import { BackupConsoleStore } from "../../packages/api/src/backup-console-store.js";
import { createServer as createApiServer } from "../../packages/api/src/server.js";
import {
  assertDisposableAuthFixtureDatabaseUrl,
  startBetterAuthFixture,
  type BetterAuthFixture,
} from "../../packages/api/test/fixtures/better-auth-server.js";

const desktop = resolve("app/dist/desktop");
const revision = 7;
const probeId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const now = "2026-11-27T00:00:00.000Z";
const activation = {
  kind: "activate",
  revision,
  probeId,
  requestId: "00000000-0000-4000-8000-000000000004",
  resultId: "00000000-0000-4000-8000-000000000005",
};

test("Backup Console displays fixture-backed evidence and recovers a lost probe response after a reload", async ({ page }, testInfo) => {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const asset = /^\/desktop\/assets\/([A-Za-z0-9_.-]+)$/u.exec(path)?.[1];
    const file = asset ? resolve(desktop, "assets", asset) : resolve(desktop, "index.html");
    const type = !asset ? "text/html" : asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : "application/octet-stream";
    void readFile(file).then(bytes => {
      response.writeHead(200, { "Content-Type": type });
      response.end(bytes);
    }, () => response.writeHead(404).end());
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const config = {
      provider: "aws-s3" as const, endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", bucket: "co…",
      prefix: "testing", credentialConfigured: true, revision,
      draft: {
        provider: "aws-s3", endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", bucket: "co…",
        prefix: "testing", credentialConfigured: true, revision, addressing: "virtual-hosted-style", retentionRequest: { days: 14 },
        credentialMode: "sealed-access-key", offVmPolicy: "required", schedule: "disabled",
      },
      active: null,
    };
    let latestRevision = revision;
    let draftWrites = 0;
    let authSequence = 0;
    const requestedDays = 14;
    await page.addInitScript(() => {
      Object.defineProperty(navigator.credentials, "get", {
        value: async () => {
          // Synthetic assertion for this browser state-machine fixture only.
          const bytes = new Uint8Array([1, 2, 3]).buffer;
          return {
            id: "AQID", rawId: bytes, authenticatorAttachment: "platform", type: "public-key",
            getClientExtensionResults: () => ({}),
            response: { authenticatorData: bytes, clientDataJSON: bytes, signature: bytes },
          };
        },
      });
    });
    let probe: { requestId: string; status: "QUEUED" | "PASSED" } | null = null;
    const postedProbeIds: string[] = [];
    const probeLookupIds: string[] = [];
    let probeAvailable = false;
    const run = {
      runId, requestId: "00000000-0000-4000-8000-000000000003", revision, maintenanceWindowId: "fixture-window", phase: "complete", status: "REMOTE_VERIFIED",
      reasonCode: null, sourceSha: "a".repeat(40), imageDigest: "sha256:" + "b".repeat(64), candidateSourceSha: null, candidateImageDigest: null, manifestSha256: "c".repeat(64),
      offVmConfirmation: { offVmMethod: "s3", receiptSha256: "d".repeat(64), markerSha256: "e".repeat(64) },
      createdAt: now, observedAt: now,
    };
    await page.route(origin + "/api/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      expect(request.headers().authorization).toBeUndefined();
      if (path === "/api/auth/codexia/owner-session") {
        await route.fulfill({ json: { authenticated: true } });
      } else if (path === "/api/auth/get-session") {
        await route.fulfill({ json: authSequence === 0 ? null : { session: { token: "fixture-session-" + authSequence }, user: { id: "fixture" } } });
      } else if (path === "/api/auth/passkey/generate-authenticate-options") {
        await route.fulfill({ json: { challenge: "AQID", rpId: "127.0.0.1", allowCredentials: [] } });
      } else if (path === "/api/auth/passkey/verify-authentication") {
        authSequence += 1;
        await route.fulfill({ json: { session: { token: "fixture-session-" + authSequence }, user: { id: "fixture" } } });
      } else if (path === "/api/console/backups/config") {
        await route.fulfill({ json: { ...config, revision: latestRevision, draft: { ...config.draft, revision: latestRevision } } });
      } else if (path === "/api/console/backups/config/draft" && request.method() === "PUT") {
        expect(request.headers()["x-codexia-csrf"]).toBe("1");
        const body = request.postDataJSON();
        expect(body.bucket).toBe("codexia-fixture");
        if (draftWrites++ === 0) {
          expect(request.headers()["if-match"]).toBe('"7"');
          expect(body.accessKeyId).toBe("fixture-input-id");
          expect(body.secretAccessKey).toBe("fixture-input-key");
          latestRevision += 1;
          await route.fulfill({ status: 412, json: { error: "BACKUP_REVISION_CHANGED", code: "BACKUP_REVISION_CHANGED" } });
        } else {
          expect(request.headers()["if-match"]).toBe('"8"');
          expect(body.secretAccessKey).toBeUndefined();
          await route.fulfill({ status: 403, json: { error: "BACKUP_OWNER_SESSION_REQUIRED", code: "BACKUP_OWNER_SESSION_REQUIRED" } });
        }
      } else if (path === "/api/console/backups/status") {
        const requestId = url.searchParams.get("requestId");
        let operation;
        if (probe && requestId === probe.requestId) {
          probeLookupIds.push(requestId);
          if (!probeAvailable) return route.abort();
          operation = { operationId: probeId, revision, phase: "probe", reasonCode: null, observedAt: now, ...probe };
        } else if (requestId === activation.requestId) {
          operation = {
            operationId: activation.resultId, requestId, revision,
            phase: "activate", status: "APPLIED", reasonCode: null, observedAt: now,
          };
        }
        await route.fulfill({ json: {
          enabled: false, status: "DISABLED", activeRevision: null, degraded: false, appliedAt: null, staging: "unknown",
          lastVerifiedOffVmBackup: "unknown", restoreDrill: "unknown", ...(operation ? { operation } : {}),
        } });
      } else if (path === "/api/console/backups/config/probes" && request.method() === "POST") {
        expect(request.headers()["x-codexia-csrf"]).toBe("1");
        expect(request.postDataJSON()).toEqual({ revision });
        const requestId = request.headers()["idempotency-key"]!;
        postedProbeIds.push(requestId);
        probe = { requestId, status: "QUEUED" };
        // Commit the fixture operation and drop the response before the browser learns the probe ID.
        await route.abort();
      } else if (path === "/api/console/backups/config/probes/" + probeId && probe) {
        if (!probeAvailable) return route.abort();
        await route.fulfill({ json: { probeId, operationId: probeId, revision, phase: "probe", reasonCode: null, evidence: probe.status === "PASSED"
          ? { bucketVersioning: "enabled", objectLock: "enabled", defaultRetentionDays: 30 }
          : null, observedAt: now, ...probe } });
      } else if (path === "/api/console/backups/runs") {
        await route.fulfill({ json: { runs: [run], nextCursor: null } });
      } else if (path === "/api/console/backups/runs/" + runId) {
        await route.fulfill({ json: run });
      } else if (path === "/api/console/backups/recovery") {
        await route.fulfill({ json: {
          status: "unknown", restoreDrill: "unknown", lastVerifiedOffVmBackup: run,
          missingConditions: ["independent_restore_drill_for_latest_backup"],
        } });
      } else {
        await route.fulfill({ status: 404, json: { error: "FIXTURE_UNEXPECTED_REQUEST" } });
      }
    });

    await page.goto(origin + "/console/backups");
    await expect(page.getByRole("heading", { name: "保全状況" })).toBeVisible();
    await expect(page.getByText("手動バックアップには有効な保存先が必要です。")).toBeVisible();
    const nav = page.getByRole("navigation", { name: "バックアップ管理" });
    await nav.getByRole("link", { name: "保存先設定" }).click();
    await expect(page.getByLabel("アクセスキー ID")).toHaveValue("");
    await expect(page.getByLabel("シークレットアクセスキー")).toHaveValue("");
    await expect(page.getByLabel("バケット（必須）")).toHaveValue("");
    await page.screenshot({ path: testInfo.outputPath("destination.png") });
    await nav.getByRole("link", { name: "接続検証" }).click();
    const probeButton = page.getByRole("button", { name: "接続検証を要求" });
    await probeButton.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("受付結果未確認", { exact: true })).toBeVisible();
    await expect(page.getByText("この設定を適用済み", { exact: true })).toHaveCount(0);
    expect(postedProbeIds).toHaveLength(1);

    await page.reload();
    await expect(page.getByRole("alert").getByText("接続または結果を確認できません。通信を確認して状態を再取得してください。")).toBeVisible();
    expect(postedProbeIds).toHaveLength(1);
    probeAvailable = true;
    await page.getByRole("button", { name: "状態を更新" }).click();
    await expect(page.getByText("受付済み", { exact: true })).toBeVisible();
    expect(probeLookupIds).toContain(postedProbeIds[0]);
    if (!probe) throw new Error("Expected a submitted probe");
    (probe as { status: "QUEUED" | "PASSED" }).status = "PASSED";
    await page.getByRole("button", { name: "状態を更新" }).click();
    await expect(page.getByText("接続検証に合格", { exact: true })).toBeVisible();
    expect(postedProbeIds).toHaveLength(1);
    await expect(page.getByText(requestedDays + " 日 / 世代数の指定なし", { exact: true })).toBeVisible();
    await expect(page.getByText("30 日", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("verification.png") });

    // A historical activation receipt must not override the live disabled configuration.
    await page.evaluate(value => sessionStorage.setItem("codexia:backup-console:activate", JSON.stringify(value)), activation);
    await page.reload();
    await expect(page.getByText("設定反映済み", { exact: true })).toBeVisible();
    await expect(page.getByText("現在は未適用", { exact: true })).toBeVisible();
    await expect(page.getByText("この設定を適用済み", { exact: true })).toHaveCount(0);

    await nav.getByRole("link", { name: "保存先設定" }).click();
    await page.getByLabel("バケット（必須）").fill("codexia-fixture");
    await page.getByLabel("アクセスキー ID").fill("fixture-input-id");
    await page.getByLabel("シークレットアクセスキー").fill("fixture-input-key");
    const save = page.getByRole("button", { name: "パスキーで再認証して設定案を保存" });
    await save.click();
    await expect(page.getByRole("alert")).toHaveText("別の操作で設定案が更新されました。最新の設定を確認してください。");
    await expect(page.getByLabel("アクセスキー ID")).toHaveValue("");
    await expect(page.getByLabel("シークレットアクセスキー")).toHaveValue("");
    await expect(page.getByLabel("バケット（必須）")).toHaveValue("codexia-fixture");
    await expect(save).toBeDisabled();
    await page.getByRole("button", { name: "最新のリビジョンを確認" }).click();
    await expect(page.getByText("最新の設定案はリビジョン 8 です。入力内容を保持しています。")).toBeVisible();
    await expect(save).toBeDisabled();
    await page.getByRole("button", { name: "このリビジョンに対して入力を使う" }).click();
    await save.click();
    await expect(page.getByRole("alert")).toHaveText("所有者セッションまたは操作の権限を確認できませんでした。");
    expect(draftWrites).toBe(2);

    await page.goto(origin + "/console/backups/history?run=" + runId);
    await expect(page.getByRole("heading", { name: "実行の詳細" })).toBeVisible();
    await expect(page.getByText("独立した保全証拠の SHA-256")).toBeVisible();
    await nav.getByRole("link", { name: "復旧の証拠" }).click();
    await expect(page.getByText("最新の保全点からの独立した復元試験")).toBeVisible();
    await expect(page.getByRole("button", { name: /本番の復元/u })).toHaveCount(0);
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  }
});


test("Backup Console recovers a dropped probe receipt from real Fastify, Better Auth and PostgreSQL", async ({ page }) => {
  const databaseUrl = process.env.CODEXIA_E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error("The Backup Console browser test requires a disposable PostgreSQL database");
  assertDisposableAuthFixtureDatabaseUrl(databaseUrl);
  const requireApi = createRequire(new URL("../../packages/api/package.json", import.meta.url));
  const { Pool } = requireApi("pg") as {
    Pool: new (options: { connectionString: string; options?: string }) => ConstructorParameters<typeof BackupConsoleStore>[0];
  };
  const admin = new Pool({ connectionString: databaseUrl });
  const apiPool = new Pool({ connectionString: databaseUrl, options: "-c role=codexia_backup_api" });
  const executorPool = new Pool({ connectionString: databaseUrl, options: "-c role=codexia_backup_executor" });
  const destination = {
    provider: "s3-compatible",
    endpoint: "https://backups.fixture.test",
    region: "us-east-1",
    bucket: "codexia-fixture",
    prefix: "install/backup",
  } as const;
  const policy: BackupPolicy = { destinations: [{ ...destination, credentialModes: ["operator-role"] }], maintenanceWindows: [] };
  const executor = new BackupConsoleExecutor({
    pool: executorPool,
    policy,
    privateKeys: new Map(),
    operatorCredential: { origin: destination.endpoint, credential: { accessKeyId: "fixture-key-id", secretAccessKey: "fixture-key" } },
    async probe() { return { state: "PASSED", reason: null }; },
  });
  let fixture: BetterAuthFixture | undefined;
  try {
    await admin.query(await readFile(new URL("../../deploy/backup/operational-schema.sql", import.meta.url), "utf8"));
    await executor.processNext();
    const store = new BackupConsoleStore(apiPool);
    fixture = await startBetterAuthFixture({
      databaseUrl,
      usePostgresPersistence: true,
      staticDirectory: resolve("app/dist"),
      createApiServer: options => createApiServer({ ...options, backupConsole: { store, policy } }),
    });
    const origin = fixture.apiOrigin;
    const scope = "/api/console/backups";
    const verification = origin + "/console/backups/verification";
    // Production serves the Console through its edge rewrite to the Desktop shell.
    await page.route(verification, async route => route.fulfill({ response: await route.fetch({ url: origin + "/desktop/" }) }));
    expect((await page.request.get(origin + scope + "/status")).status()).toBe(401);
    await page.context().addCookies(fixture.ownerSessionCookie().split("; ").map(cookie => {
      const equals = cookie.indexOf("=");
      return { name: cookie.slice(0, equals), value: cookie.slice(equals + 1), url: origin };
    }));
    const draft = await page.request.put(origin + scope + "/config/draft", {
      headers: { Origin: origin, "If-Match": '"0"', "X-Codexia-CSRF": "1" },
      data: { ...destination, credentialMode: "operator-role", offVmPolicy: "secondary" },
    });
    expect(draft.status(), await draft.text()).toBe(200);

    const posted: { requestId: string; probeId: string }[] = [];
    await page.route(origin + scope + "/config/probes", async route => {
      const requestId = route.request().headers()["idempotency-key"];
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(202);
      posted.push({ requestId, probeId: (await response.json()).probeId });
      await route.abort("failed");
    });
    const receiptLookup = (url: URL) => url.origin === origin && url.pathname === scope + "/status" && url.searchParams.has("requestId");
    await page.route(receiptLookup, route => route.abort("failed"));
    await page.goto(verification);
    await page.getByRole("button", { name: "接続検証を要求" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("受付結果未確認", { exact: true })).toBeVisible();
    expect(posted).toHaveLength(1);
    const [receipt] = posted;

    await page.unroute(receiptLookup);
    const lookup = page.waitForResponse(response => receiptLookup(new URL(response.url())));
    await page.reload();
    const recovered = await lookup;
    expect(recovered.status()).toBe(200);
    expect(new URL(recovered.url()).searchParams.get("requestId")).toBe(receipt.requestId);
    expect(await recovered.json()).toMatchObject({ activeRevision: null, operation: {
      operationId: receipt.probeId, requestId: receipt.requestId, phase: "probe", status: "QUEUED",
    } });
    await expect(page.getByText("受付済み", { exact: true })).toBeVisible();
    await expect(page.getByText("現在は未適用", { exact: true })).toBeVisible();
    expect(await executor.processNext()).toBe(true);
    await page.getByRole("button", { name: "状態を更新" }).click();
    await expect(page.getByText("接続検証に合格", { exact: true })).toBeVisible();
    expect(posted).toHaveLength(1);
    const { rows } = await admin.query("SELECT id, request_id, state FROM codexia_backup.operations");
    expect(rows).toEqual([{ id: receipt.probeId, request_id: receipt.requestId, state: "PASSED" }]);
  } finally {
    try { await fixture?.close(); }
    finally {
      try { await Promise.all([apiPool.end(), executorPool.end()]); }
      finally {
        try { await admin.query("DROP SCHEMA IF EXISTS codexia_backup CASCADE"); }
        finally { await admin.end(); }
      }
    }
  }
});
