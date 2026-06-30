import { test, expect, Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_REPOS = [
  { id: "TestRepo", name: "TestRepo", path: "/tmp/TestRepo" },
];

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

function sseBody(events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function mockRepos(page: Page) {
  await page.route("/api/repos", (route) =>
    route.fulfill({ json: TEST_REPOS })
  );
}

async function selectRepo(page: Page) {
  await page.getByText("Select repo").click();
  await page.getByText("TestRepo").nth(0).click();
}

async function sendMessage(page: Page, message: string) {
  const input = page.getByPlaceholder("Message AgentNest...");
  await input.fill(message);
  // デスクトップの送信は Cmd/Ctrl+Enter（プレーンEnterは改行。IME誤送信防止のため）
  await input.press("Meta+Enter");
}

/** inputArea内のstopボタン（StopRoundedIcon）が非表示であることを確認 */
async function expectNotLoading(page: Page) {
  const inputArea = page
    .getByPlaceholder("Message AgentNest...")
    .locator("../..");
  await expect(
    inputArea.locator("svg[data-testid='StopRoundedIcon']")
  ).not.toBeVisible({ timeout: 5000 });
  await expect(
    inputArea.locator("svg[data-testid='ArrowUpwardRoundedIcon']")
  ).toBeVisible();
}

// ---------------------------------------------------------------------------
// Bug 1: isLoading stuck after reconnection
//
// Root cause (useChat.ts):
//   doReconnect() sets abortRef.current = reconnectController (line 308),
//   but the finally block (line 380) only checks
//     abortRef.current === controller || abortRef.current === null
//   Since abortRef is now reconnectController, the condition is false
//   and setIsLoading(false) is never called.
// ---------------------------------------------------------------------------

test.describe("Bug: isLoading not cleared after reconnection", () => {
  test("stop button disappears after successful reconnection", async ({
    page,
  }) => {
    await mockRepos(page);

    // /api/chat: abort → triggers reconnection path
    await page.route("/api/chat", (route) => route.abort("connectionreset"));

    // /api/reconnect: return completed state
    await page.route("/api/reconnect", (route) => {
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        body: sseBody([
          {
            type: "reconnect_state",
            sessionId: SESSION_ID,
            assistantMessage: {
              role: "assistant",
              content: "Recovered after reconnection",
              parts: [
                { type: "text", content: "Recovered after reconnection" },
              ],
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
    await sendMessage(page, "Reconnect test");

    // 再接続後のレスポンスが表示される
    await expect(
      page.getByText("Recovered after reconnection")
    ).toBeVisible({ timeout: 10000 });

    // Bug再現: isLoadingがfalseに戻るべき → stopボタンは消えてsendボタンが表示される
    await expectNotLoading(page);
  });

  test("stop button disappears after all reconnect attempts fail", async ({
    page,
  }) => {
    await mockRepos(page);

    await page.route("/api/chat", (route) => route.abort("connectionreset"));
    await page.route("/api/reconnect", (route) =>
      route.fulfill({ status: 404, json: { error: "No active session" } })
    );

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "Will fail");

    await expect(
      page.getByText(
        "サーバーに接続できません。サーバーが起動しているか確認してください。"
      )
    ).toBeVisible({ timeout: 15000 });

    // Bug再現: 全リトライ失敗後もisLoadingがfalseに戻るべき
    await expectNotLoading(page);
  });

  test("can send new message after reconnection completes", async ({
    page,
  }) => {
    await mockRepos(page);

    let chatCallCount = 0;
    await page.route("/api/chat", (route) => {
      chatCallCount++;
      if (chatCallCount === 1) {
        return route.abort("connectionreset");
      }
      // 2回目以降: 正常レスポンス
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody([
          { type: "session_id", sessionId: SESSION_ID },
          { type: "text", content: "Second message response!" },
          { type: "done", sessionId: SESSION_ID },
        ]),
      });
    });

    await page.route("/api/reconnect", (route) => {
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        body: sseBody([
          {
            type: "reconnect_state",
            sessionId: SESSION_ID,
            assistantMessage: {
              role: "assistant",
              content: "First recovered",
              parts: [{ type: "text", content: "First recovered" }],
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
    await sendMessage(page, "First message");

    await expect(page.getByText("First recovered")).toBeVisible({
      timeout: 10000,
    });

    // Bug再現: isLoadingがtrueのまま残ると、後続のメッセージ送信後もUIが壊れる
    await sendMessage(page, "Second message");
    await expect(page.getByText("Second message response!")).toBeVisible({
      timeout: 5000,
    });

    // 2回目の完了後もisLoadingがクリアされているべき
    await expectNotLoading(page);
  });

  test("stop button disappears after silent disconnect + reconnection", async ({
    page,
  }) => {
    await mockRepos(page);

    // doneイベントなしでストリーム終了（silent disconnect）
    await page.route("/api/chat", (route) => {
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody([
          { type: "session_id", sessionId: SESSION_ID },
          { type: "text", content: "Partial..." },
          // done/error なし → 再接続トリガー
        ]),
      });
    });

    await page.route("/api/reconnect", (route) => {
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        body: sseBody([
          {
            type: "reconnect_state",
            sessionId: SESSION_ID,
            assistantMessage: {
              role: "assistant",
              content: "Full response after silent reconnect",
              parts: [
                {
                  type: "text",
                  content: "Full response after silent reconnect",
                },
              ],
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
    await sendMessage(page, "Silent disconnect");

    await expect(
      page.getByText("Full response after silent reconnect")
    ).toBeVisible({ timeout: 10000 });

    // Bug再現: silent disconnect→再接続後もisLoadingがクリアされるべき
    await expectNotLoading(page);
  });
});
