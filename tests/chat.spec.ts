import { test, expect, Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_REPOS = [
  { id: "TestRepo", name: "TestRepo", path: "/tmp/TestRepo" },
];

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

/** Build an SSE body string from an array of event objects */
function sseBody(events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/** Mock /api/repos to return a fixed repo list */
async function mockRepos(page: Page) {
  await page.route("/api/repos", (route) =>
    route.fulfill({ json: TEST_REPOS })
  );
}

/** Select the test repo from the dropdown */
async function selectRepo(page: Page) {
  // Click the repo selector trigger ("Select repo" text)
  await page.getByText("Select repo").click();
  // Click the repo name in the dropdown
  await page.getByText("TestRepo").nth(0).click();
}

/** Type a message and send it (desktop: Meta+Enter) */
async function sendMessage(page: Page, message: string) {
  const input = page.getByPlaceholder("Message AgentNest...");
  await input.fill(message);
  await input.press("Meta+Enter");
}

// ---------------------------------------------------------------------------
// Tests: Normal Flow
// ---------------------------------------------------------------------------

test.describe("Normal chat flow", () => {
  test("sends a message and receives a streamed response", async ({
    page,
  }) => {
    await mockRepos(page);

    // Mock /api/chat to return a complete SSE response
    await page.route("/api/chat", (route) => {
      const body = sseBody([
        { type: "session_id", sessionId: SESSION_ID },
        { type: "text", content: "Hello " },
        { type: "text", content: "from " },
        { type: "text", content: "Claude!" },
        { type: "done", sessionId: SESSION_ID },
      ]);
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        body,
      });
    });

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "Hello");

    // User message should appear
    await expect(page.getByText("Hello").first()).toBeVisible();

    // Assistant response should appear (streamed text joined)
    await expect(page.getByText("Hello from Claude!")).toBeVisible({
      timeout: 5000,
    });
  });

  test("displays tool results in the response", async ({ page }) => {
    await mockRepos(page);

    const toolPayload = encodeURIComponent(
      JSON.stringify({ toolName: "Read", content: "file contents here" })
    );

    await page.route("/api/chat", (route) => {
      const body = sseBody([
        { type: "session_id", sessionId: SESSION_ID },
        { type: "activity", activity: "Reading file..." },
        { type: "text", content: "I read the file.\n\n" },
        {
          type: "tool_result",
          toolName: "Read",
          content: "file contents here",
        },
        { type: "text", content: "\nDone!" },
        { type: "done", sessionId: SESSION_ID },
      ]);
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body,
      });
    });

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "Read the file");

    // Main text should appear
    await expect(page.getByText("I read the file.")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText("Done!")).toBeVisible();

    // Tool result should be inside a <details> with a "Read" summary
    // （ToolDiffView は Read を「Read」/「Read <パス>」と要約。ファイルパス無しのモックでは「Read」）
    await expect(page.locator("details.tool-result summary")).toHaveText("Read");
  });

  test("shows error from server", async ({ page }) => {
    await mockRepos(page);

    await page.route("/api/chat", (route) => {
      const body = sseBody([
        { type: "session_id", sessionId: SESSION_ID },
        { type: "text", content: "Starting..." },
        { type: "error", error: "Rate limit exceeded" },
      ]);
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body,
      });
    });

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "Do something");

    await expect(page.getByText("Rate limit exceeded")).toBeVisible({
      timeout: 5000,
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Reconnection
// ---------------------------------------------------------------------------

test.describe("Reconnection", () => {
  test("auto-reconnects when connection drops and restores state", async ({
    page,
  }) => {
    await mockRepos(page);

    // First /api/chat call: abort to simulate connection failure
    let chatCallCount = 0;
    await page.route("/api/chat", (route) => {
      chatCallCount++;
      // Simulate a network failure
      return route.abort("connectionreset");
    });

    // /api/reconnect: return state snapshot + done
    await page.route("/api/reconnect", (route) => {
      const body = sseBody([
        {
          type: "reconnect_state",
          sessionId: SESSION_ID,
          responseText:
            "This is the full recovered response after reconnection.",
          pendingPermission: null,
          completed: true,
          error: null,
        },
        { type: "done", sessionId: SESSION_ID },
      ]);
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        body,
      });
    });

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "Reconnect test");

    // The reconnected content should appear
    await expect(
      page.getByText("This is the full recovered response after reconnection.")
    ).toBeVisible({ timeout: 10000 });
  });

  test("shows failure message when all reconnect attempts fail", async ({
    page,
  }) => {
    await mockRepos(page);

    // /api/chat: abort
    await page.route("/api/chat", (route) => route.abort("connectionreset"));

    // /api/reconnect: also fail (404 = no active session)
    await page.route("/api/reconnect", (route) =>
      route.fulfill({ status: 404, json: { error: "No active session" } })
    );

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "Will fail");

    // After all retries fail, the failure message should appear
    await expect(
      page.getByText("サーバーに接続できません。サーバーが起動しているか確認してください。")
    ).toBeVisible({ timeout: 15000 });
  });

  test("reconnects mid-stream and continues receiving events", async ({
    page,
  }) => {
    await mockRepos(page);

    let chatCalls = 0;
    await page.route("/api/chat", (route) => {
      chatCalls++;
      if (chatCalls === 1) {
        // First call: return partial data then abort
        // We send some initial text, but the connection "breaks" after
        // Note: route.fulfill delivers the whole body at once,
        // so the frontend will process these events before the stream ends normally.
        // To simulate a mid-stream break, we abort instead.
        return route.abort("connectionreset");
      }
      // Should not be called again (reconnect goes to /api/reconnect)
      return route.abort();
    });

    // /api/reconnect: return snapshot with partial text + continue streaming
    await page.route("/api/reconnect", (route) => {
      const body = sseBody([
        {
          type: "reconnect_state",
          sessionId: SESSION_ID,
          responseText: "Partial text before disconnect. ",
          pendingPermission: null,
          completed: false,
          error: null,
        },
        // New events after reconnection
        { type: "text", content: "And more text after reconnect!" },
        { type: "done", sessionId: SESSION_ID },
      ]);
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body,
      });
    });

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "Stream test");

    // The restored text + continuation should both be visible
    await expect(
      page.getByText("And more text after reconnect!")
    ).toBeVisible({ timeout: 10000 });
  });

  test("reconnects when stream ends without done event (connection dropped silently)", async ({
    page,
  }) => {
    await mockRepos(page);

    // /api/chat: ストリームがdoneイベントなしで終了（接続が静かに切断されたケース）
    await page.route("/api/chat", (route) => {
      const body = sseBody([
        { type: "session_id", sessionId: SESSION_ID },
        { type: "text", content: "Partial response..." },
        // done イベントなし — 接続が切れた
      ]);
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body,
      });
    });

    // /api/reconnect: 状態を復元して完了
    await page.route("/api/reconnect", (route) => {
      const body = sseBody([
        {
          type: "reconnect_state",
          sessionId: SESSION_ID,
          assistantMessage: {
            role: "assistant",
            content: "Full recovered response after silent disconnect.",
            parts: [{ type: "text", content: "Full recovered response after silent disconnect." }],
            error: null,
          },
          pendingPermission: null,
          completed: true,
        },
        { type: "done", sessionId: SESSION_ID },
      ]);
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body,
      });
    });

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "Silent disconnect test");

    // 再接続後に復元されたレスポンスが表示されるべき
    await expect(
      page.getByText("Full recovered response after silent disconnect.")
    ).toBeVisible({ timeout: 10000 });
  });

  test("does not reconnect when error event is received without done", async ({
    page,
  }) => {
    await mockRepos(page);

    let reconnectCalled = false;

    // /api/chat: errorイベントで終了（doneなし）
    await page.route("/api/chat", (route) => {
      const body = sseBody([
        { type: "session_id", sessionId: SESSION_ID },
        { type: "text", content: "Working..." },
        { type: "error", error: "Something went wrong" },
      ]);
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body,
      });
    });

    // /api/reconnect: 呼ばれないはず
    await page.route("/api/reconnect", (route) => {
      reconnectCalled = true;
      return route.fulfill({
        status: 404,
        json: { error: "No active session" },
      });
    });

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "Error test");

    // エラーメッセージが表示されるべき
    await expect(page.getByText("Something went wrong")).toBeVisible({
      timeout: 5000,
    });

    // 再接続は試みられないべき
    expect(reconnectCalled).toBe(false);
  });

  test("clears stale permission dialog when reconnect snapshot has null pendingPermission", async ({
    page,
  }) => {
    await mockRepos(page);

    await page.route("/api/chat", (route) => {
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody([
          { type: "session_id", sessionId: SESSION_ID },
          {
            type: "permission",
            toolName: "Read",
            toolInput: { file_path: "README.md" },
            requestId: "req-1",
          },
        ]),
      });
    });

    await page.route("/api/reconnect", (route) => {
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody([
          {
            type: "reconnect_state",
            sessionId: SESSION_ID,
            assistantMessage: {
              role: "assistant",
              content: "Recovered after permission resolved",
              parts: [{ type: "text", content: "Recovered after permission resolved" }],
              error: null,
            },
            pendingPermission: null,
            completed: true,
          },
          { type: "done", sessionId: SESSION_ID },
        ]),
      });
    });

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "Permission test");

    await expect(
      page.getByText("Recovered after permission resolved")
    ).toBeVisible({ timeout: 10000 });

    await expect(page.getByText("Permission Request")).not.toBeVisible();
    await expect(page.getByPlaceholder("Message AgentNest...")).toBeEnabled();
  });

  test("retries reconnect when reconnect stream ends without completion", async ({
    page,
  }) => {
    await mockRepos(page);

    await page.route("/api/chat", (route) => route.abort("connectionreset"));

    let reconnectCalls = 0;
    await page.route("/api/reconnect", (route) => {
      reconnectCalls++;
      if (reconnectCalls === 1) {
        return route.fulfill({
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
          body: sseBody([
            {
              type: "reconnect_state",
              sessionId: SESSION_ID,
              assistantMessage: {
                role: "assistant",
                content: "Partial reconnect snapshot",
                parts: [{ type: "text", content: "Partial reconnect snapshot" }],
                error: null,
              },
              pendingPermission: null,
              completed: false,
            },
          ]),
        });
      }

      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody([
          {
            type: "reconnect_state",
            sessionId: SESSION_ID,
            assistantMessage: {
              role: "assistant",
              content: "Recovered after reconnect retry",
              parts: [{ type: "text", content: "Recovered after reconnect retry" }],
              error: null,
            },
            pendingPermission: null,
            completed: true,
          },
          { type: "done", sessionId: SESSION_ID },
        ]),
      });
    });

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "Reconnect retry test");

    await expect(
      page.getByText("Recovered after reconnect retry")
    ).toBeVisible({ timeout: 10000 });
    expect(reconnectCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: Permission Dialog + 実行モード（ModeSelector）変更
// ---------------------------------------------------------------------------

test.describe("Permission dialog with mode selector", () => {
  test("chat is not unmounted when permission mode is changed while permission dialog is shown", async ({
    page,
  }) => {
    await mockRepos(page);

    // /api/chat: permissionイベントを送信後、doneで完了させる
    // （pendingPermissionはdoneでクリアされないので権限ダイアログは残る）
    await page.route("/api/chat", (route) => {
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        body: sseBody([
          { type: "session_id", sessionId: SESSION_ID },
          { type: "text", content: "Before permission" },
          {
            type: "permission",
            toolName: "Write",
            toolInput: { file_path: "/tmp/test.txt", content: "hello" },
            requestId: "perm-auto-1",
          },
          { type: "done", sessionId: SESSION_ID },
        ]),
      });
    });

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "Write a file");

    // 権限ダイアログが表示されるのを待つ（Denyボタンはダイアログ固有）
    await expect(page.getByText("Deny")).toBeVisible({ timeout: 5000 });

    // ユーザーメッセージが表示されていることを確認
    await expect(page.getByText("Write a file")).toBeVisible();

    // 実行モード（ModeSelector）を変更してもチャットがアンマウントされないことを確認。
    // 権限ダイアログのバックドロップ(zIndex:1200)がツールバーを覆うため、dispatchEventで直接クリックして
    // モードポップオーバーを開き、別モード（Ask before edits）を選択する。
    const modeButton = page.getByRole("button", { name: /Edit Automatically/i });
    await modeButton.dispatchEvent("click");
    await page.getByRole("button", { name: /Ask before edits/i }).click();

    // チャットがアンマウントされていないことを確認:
    // 1. ユーザーメッセージがまだ表示されている
    await expect(page.getByText("Write a file")).toBeVisible();

    // 2. 権限ダイアログがまだ表示されている
    await expect(page.getByText("Deny")).toBeVisible();

    // 3. アシスタントのテキストもまだ表示されている
    await expect(page.getByText("Before permission")).toBeVisible();
  });
});
