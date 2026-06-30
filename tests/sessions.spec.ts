import { test, expect, Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_REPOS = [
  { id: "TestRepo", name: "TestRepo", path: "/tmp/TestRepo" },
];

const TEST_SESSIONS = [
  {
    sessionId: "aaa-111",
    title: "Fix authentication bug",
    firstMessage: "認証のバグを修正して",
    timestamp: "2026-03-26T01:00:00.000Z",
  },
  {
    sessionId: "bbb-222",
    title: "Add dark mode",
    firstMessage: "ダークモードを追加して",
    timestamp: "2026-03-25T12:00:00.000Z",
  },
  {
    sessionId: "ccc-333",
    title: "Refactor API routes",
    firstMessage: "APIルートをリファクタリング",
    timestamp: "2026-03-24T08:00:00.000Z",
  },
];

const TEST_MESSAGES = [
  { role: "user", content: "認証のバグを修正して" },
  { role: "assistant", content: "認証モジュールを確認しました。バグを修正します。" },
  { role: "user", content: "ありがとう、テストも追加して" },
  { role: "assistant", content: "テストを追加しました。" },
];

function sseBody(events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function setupMocks(page: Page) {
  await page.route("/api/repos", (route) =>
    route.fulfill({ json: TEST_REPOS })
  );
  await page.route("/api/sessions/TestRepo", (route) =>
    route.fulfill({ json: TEST_SESSIONS })
  );
  await page.route("/api/sessions/TestRepo/aaa-111/messages", (route) =>
    route.fulfill({ json: TEST_MESSAGES })
  );
}

async function selectRepo(page: Page) {
  await page.getByText("Select repo").click();
  await page.getByText("TestRepo").nth(0).click();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Session history", () => {
  test("shows session list when History button is clicked", async ({
    page,
  }) => {
    await setupMocks(page);
    await page.goto("/");
    await selectRepo(page);

    // Click History button
    await page.getByText("History").click();

    // Sessions should appear
    await expect(page.getByText("Fix authentication bug")).toBeVisible();
    await expect(page.getByText("Add dark mode")).toBeVisible();
    await expect(page.getByText("Refactor API routes")).toBeVisible();
  });

  test("filters sessions by search term", async ({ page }) => {
    await setupMocks(page);
    await page.goto("/");
    await selectRepo(page);

    await page.getByText("History").click();

    // Type in search box
    await page.getByPlaceholder("Search sessions...").fill("dark");

    // Only matching session should be visible
    await expect(page.getByText("Add dark mode")).toBeVisible();
    await expect(page.getByText("Fix authentication bug")).not.toBeVisible();
    await expect(page.getByText("Refactor API routes")).not.toBeVisible();
  });

  test("loads past conversation when selecting a session", async ({
    page,
  }) => {
    await setupMocks(page);

    // Also mock /api/chat for when user sends a new message
    await page.route("/api/chat", (route) => {
      const body = sseBody([
        { type: "session_id", sessionId: "aaa-111" },
        { type: "text", content: "了解しました。" },
        { type: "done", sessionId: "aaa-111" },
      ]);
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body,
      });
    });

    await page.goto("/");
    await selectRepo(page);

    // Open history and select a session
    await page.getByText("History").click();
    await page.getByText("Fix authentication bug").click();

    // Past messages should be loaded
    // Historyプレビューの firstMessage と本文の両方にマッチする。
    // パネルは選択後に折りたたまれるが Collapse のクリップのため要素自体はDOMに残るので、
    // DOM後方（=メッセージ一覧側）の本文を .last() で指定して曖昧さを解消する。
    await expect(
      page.getByText("認証のバグを修正して").last()
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByText("認証モジュールを確認しました。バグを修正します。")
    ).toBeVisible();
    await expect(page.getByText("テストを追加しました。")).toBeVisible();

    // User can send a new message to continue the session
    const input = page.getByPlaceholder("Message AgentNest...");
    await input.fill("もう一つ修正して");
    await input.press("Meta+Enter"); // デスクトップ送信は Cmd/Ctrl+Enter

    await expect(page.getByText("了解しました。")).toBeVisible({
      timeout: 5000,
    });
  });

  test("New resets resumed session and starts a fresh chat route", async ({
    page,
  }) => {
    await setupMocks(page);
    let postedSessionId: string | null | undefined = "unseen";

    await page.route("/api/chat", (route) => {
      const payload = route.request().postDataJSON() as { sessionId?: string | null };
      postedSessionId = payload.sessionId;
      const body = sseBody([
        { type: "session_id", sessionId: "new-session-123" },
        { type: "text", content: "新規会話として開始しました。" },
        { type: "done", sessionId: "new-session-123" },
      ]);
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body,
      });
    });

    await page.goto("/");
    await selectRepo(page);
    await page.getByText("History").click();
    await page.getByText("Fix authentication bug").click();

    // Historyプレビューの firstMessage と本文の両方にマッチする。
    // パネルは選択後に折りたたまれるが Collapse のクリップのため要素自体はDOMに残るので、
    // DOM後方（=メッセージ一覧側）の本文を .last() で指定して曖昧さを解消する。
    await expect(
      page.getByText("認証のバグを修正して").last()
    ).toBeVisible({ timeout: 5000 });
    await expect(page).toHaveURL(/\/TestRepo\/chat\/aaa-111$/);

    await page.getByText("New").click();

    await expect(page).toHaveURL(/\/TestRepo\/chat$/);

    const input = page.getByPlaceholder("Message AgentNest...");
    await input.fill("新しい相談です");
    await input.press("Meta+Enter"); // デスクトップ送信は Cmd/Ctrl+Enter

    await expect.poll(() => postedSessionId).toBe(null);
    await expect(page.getByText("新しい相談です")).toBeVisible();
    await expect(page.getByText("新規会話として開始しました。")).toBeVisible({
      timeout: 5000,
    });
  });

  test("shows empty state when no sessions exist", async ({ page }) => {
    await page.route("/api/repos", (route) =>
      route.fulfill({ json: TEST_REPOS })
    );
    await page.route("/api/sessions/TestRepo", (route) =>
      route.fulfill({ json: [] })
    );

    await page.goto("/");
    await selectRepo(page);

    await page.getByText("History").click();

    await expect(page.getByText("No sessions")).toBeVisible();
  });
});
