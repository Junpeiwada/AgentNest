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

function sseResponse(events: object[]) {
  return {
    status: 200 as const,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
    body: sseBody(events),
  };
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

async function typeAndSend(page: Page, message: string) {
  const input = page.getByPlaceholder("Message AgentNest...");
  await input.fill(message);
  // デスクトップの送信は Cmd/Ctrl+Enter（プレーンEnterは改行。IME誤送信防止のため）
  await input.press("Meta+Enter");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Follow-up messages during loading", () => {
  test("input remains enabled while assistant is loading", async ({
    page,
  }) => {
    await mockRepos(page);

    // Never fulfill — fetch hangs, frontend stays in loading state
    await page.route("/api/chat", async () => {
      await new Promise(() => {}); // block forever
    });

    await page.goto("/");
    await selectRepo(page);
    await typeAndSend(page, "Hello");

    // Input should remain enabled during loading (not disabled)
    const input = page.getByPlaceholder("Message AgentNest...");
    await expect(input).toBeEnabled({ timeout: 3000 });

    // User should be able to type during loading
    await input.fill("I can type while loading");
    await expect(input).toHaveValue("I can type while loading");
  });

  test("can send follow-up message while assistant is loading", async ({
    page,
  }) => {
    await mockRepos(page);

    let chatCallCount = 0;
    await page.route("/api/chat", async (route) => {
      chatCallCount++;
      if (chatCallCount === 1) {
        // First request: hang (simulates ongoing assistant work)
        await new Promise(() => {});
        return;
      }
      // Second request (follow-up): respond normally
      return route.fulfill(
        sseResponse([
          { type: "session_id", sessionId: SESSION_ID },
          { type: "text", content: "Response to follow-up!" },
          { type: "done", sessionId: SESSION_ID },
        ])
      );
    });

    await page.goto("/");
    await selectRepo(page);

    // Send first message (will hang)
    await typeAndSend(page, "First message");

    // Input available during loading — send follow-up
    const input = page.getByPlaceholder("Message AgentNest...");
    await expect(input).toBeEnabled({ timeout: 3000 });
    await typeAndSend(page, "Follow-up message");

    // Both user messages should be visible
    await expect(page.getByText("First message")).toBeVisible();
    await expect(page.getByText("Follow-up message")).toBeVisible();

    // Follow-up response should appear
    await expect(page.getByText("Response to follow-up!")).toBeVisible({
      timeout: 5000,
    });

    // Two chat requests were made
    expect(chatCallCount).toBe(2);
  });

  test("preserves session ID across sequential messages", async ({ page }) => {
    await mockRepos(page);

    const capturedRequests: Record<string, unknown>[] = [];

    await page.route("/api/chat", (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      capturedRequests.push(body);

      const isFirst = capturedRequests.length === 1;
      return route.fulfill(
        sseResponse([
          { type: "session_id", sessionId: SESSION_ID },
          {
            type: "text",
            content: isFirst ? "First reply" : "Second reply",
          },
          { type: "done", sessionId: SESSION_ID },
        ])
      );
    });

    await page.goto("/");
    await selectRepo(page);

    // Send first message
    await typeAndSend(page, "Message 1");
    await expect(page.getByText("First reply")).toBeVisible({ timeout: 5000 });

    // Send second message
    await typeAndSend(page, "Message 2");
    await expect(page.getByText("Second reply")).toBeVisible({ timeout: 5000 });

    // First request has no session ID, second includes it
    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[0].sessionId).toBeNull();
    expect(capturedRequests[1].sessionId).toBe(SESSION_ID);
  });

  test("multiple rapid follow-ups resolve to the last response", async ({
    page,
  }) => {
    await mockRepos(page);

    let chatCallCount = 0;
    await page.route("/api/chat", async (route) => {
      chatCallCount++;
      if (chatCallCount < 3) {
        // First two requests: hang
        await new Promise(() => {});
        return;
      }
      // Third request: respond
      return route.fulfill(
        sseResponse([
          { type: "session_id", sessionId: SESSION_ID },
          { type: "text", content: "Final answer" },
          { type: "done", sessionId: SESSION_ID },
        ])
      );
    });

    await page.goto("/");
    await selectRepo(page);

    const input = page.getByPlaceholder("Message AgentNest...");

    // Rapid-fire three messages
    await typeAndSend(page, "First attempt");
    await expect(input).toBeEnabled({ timeout: 3000 });

    await typeAndSend(page, "Second attempt");
    await expect(input).toBeEnabled({ timeout: 3000 });

    await typeAndSend(page, "Third attempt");

    // All user messages visible
    await expect(page.getByText("First attempt")).toBeVisible();
    await expect(page.getByText("Second attempt")).toBeVisible();
    await expect(page.getByText("Third attempt")).toBeVisible();

    // Only the final response appears
    await expect(page.getByText("Final answer")).toBeVisible({ timeout: 5000 });

    expect(chatCallCount).toBe(3);
  });

  test("follow-up during loading shows correct button states", async ({
    page,
  }) => {
    await mockRepos(page);

    await page.route("/api/chat", async () => {
      await new Promise(() => {});
    });

    await page.goto("/");
    await selectRepo(page);
    await typeAndSend(page, "Start");

    const input = page.getByPlaceholder("Message AgentNest...");
    await expect(input).toBeEnabled({ timeout: 3000 });

    // Loading + no text → stop button (square icon) should be visible
    // The input area is the container with the send/stop button
    const inputArea = input.locator("../..");
    await expect(
      inputArea.locator("svg[data-testid='StopRoundedIcon']")
    ).toBeVisible();

    // Type text → send button (arrow icon) should appear
    await input.fill("follow up text");
    await expect(
      inputArea.locator("svg[data-testid='ArrowUpwardRoundedIcon']")
    ).toBeVisible();

    // Clear text → stop button returns
    await input.fill("");
    await expect(
      inputArea.locator("svg[data-testid='StopRoundedIcon']")
    ).toBeVisible();
  });
});
