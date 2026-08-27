import { test, expect, Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_REPOS = [
  { id: "TestRepo", name: "TestRepo", path: "/tmp/TestRepo" },
];

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

/** iPhone 14 相当の縦画面 */
const MOBILE_VIEWPORT = { width: 390, height: 844 };

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
  await input.press("Meta+Enter");
}

async function mockChatWithContent(page: Page, content: string) {
  await page.route("/api/chat", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: sseBody([
        { type: "session_id", sessionId: SESSION_ID },
        { type: "text", content },
        { type: "done", sessionId: SESSION_ID },
      ]),
    })
  );
}

/**
 * メッセージ一覧のスクロールコンテナに横あふれが無いことを検証する。
 * scrollWidth が clientWidth を超えていれば横スクロールが発生している。
 */
async function expectNoHorizontalOverflow(page: Page) {
  const scroller = page.getByTestId("message-scroller");
  await expect(scroller).toBeVisible();

  const overflow = await scroller.evaluate(
    (el) => el.scrollWidth - el.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

// 折り返せない長い文字列。
// ハイフンやスラッシュはブラウザが改行位置として使えてしまうため、
// 改行機会を一切持たない連続文字で「折り返せない最悪ケース」を作る。
const LONG_URL = `https://example.com/${"a".repeat(250)}`;
const LONG_PATH = `/Users/test/Documents/Project/${"b".repeat(250)}.ts`;
const LONG_COMMAND = `npm run build -- --config ${"x".repeat(300)}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("モバイル幅での横あふれ", () => {
  test.use({ viewport: MOBILE_VIEWPORT });

  test("空白を含まない長いURL・パスでも横スクロールしない", async ({ page }) => {
    await mockRepos(page);
    await mockChatWithContent(page, `参照: ${LONG_URL}\n\n対象ファイル: ${LONG_PATH}`);

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "Long URL");

    await expect(page.getByText("参照:")).toBeVisible({ timeout: 5000 });
    await expectNoHorizontalOverflow(page);
  });

  test("長いコマンドを含むコードブロックが折り返される", async ({ page }) => {
    await mockRepos(page);
    await mockChatWithContent(page, `実行します:\n\n\`\`\`bash\n${LONG_COMMAND}\n\`\`\``);

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "Long command");

    const code = page.locator("pre code");
    await expect(code).toBeVisible({ timeout: 5000 });

    // モバイル幅では pre-wrap で折り返るため、pre 自体に横スクロールが出ない
    const preOverflow = await page
      .locator("pre")
      .first()
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(preOverflow).toBeLessThanOrEqual(1);

    await expectNoHorizontalOverflow(page);
  });

  test("列数の多いテーブルはテーブル内でスクロールし、画面全体を押し広げない", async ({
    page,
  }) => {
    // 列数を増やすほどテーブルの min-content 幅が広がり、
    // 折り返しだけでは画面幅に収まらない状態を確実に作れる
    const headers = Array.from({ length: 20 }, (_, i) => `Column ${i + 1}`);
    const cells = Array.from({ length: 20 }, (_, i) => `value-${i + 1}`);
    const table = [
      `| ${headers.join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
      `| ${cells.join(" | ")} |`,
    ].join("\n");

    await mockRepos(page);
    await mockChatWithContent(page, `結果:\n\n${table}`);

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "Wide table");

    await expect(page.getByText("Column 1", { exact: true })).toBeVisible({
      timeout: 5000,
    });
    await expectNoHorizontalOverflow(page);
  });

  test("ツール結果の長い出力でも横スクロールしない", async ({ page }) => {
    await page.route("/api/chat", (route) =>
      route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody([
          { type: "session_id", sessionId: SESSION_ID },
          {
            type: "tool_result",
            toolName: "Bash",
            toolInput: { command: LONG_COMMAND },
            content: `${LONG_PATH}\n${LONG_URL}`,
          },
          { type: "done", sessionId: SESSION_ID },
        ]),
      })
    );

    await mockRepos(page);
    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "Run command");

    const summary = page.locator(".tool-result summary");
    await expect(summary).toBeVisible({ timeout: 5000 });
    await summary.click();

    await expectNoHorizontalOverflow(page);
  });
});
