import { test, expect, Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// マルチセッション（connectionId）の退行検知
//
// サーバは `X-Connection-Id` ヘッダごとにセッションを分離する（Docs/実装方針-マルチセッション対応.md）。
// フロントがヘッダを付け忘れたり、タブ間でIDが共有されたりすると複数端末・複数タブで
// チャットが混線するため、ここで検知する。
// サーバ側の分離そのものはAPIモックのため検証できない。ここで担保するのは
// 「フロントが正しいIDを、全チャット系APIに、タブ単位で送っていること」。
// ---------------------------------------------------------------------------

const TEST_REPOS = [{ id: "TestRepo", name: "TestRepo", path: "/tmp/TestRepo" }];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sseBody(events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function mockRepos(page: Page) {
  await page.route("/api/repos", (route) => route.fulfill({ json: TEST_REPOS }));
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

/** 受け取った connectionId をそのまま応答に混ぜ返すモック（取り違えれば表示で分かる） */
async function mockEchoChat(page: Page, onSeen?: (id: string) => void) {
  await page.route("/api/chat", (route) => {
    const id = route.request().headers()["x-connection-id"] ?? "(なし)";
    onSeen?.(id);
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: sseBody([
        { type: "session_id", sessionId: id },
        { type: "text", content: `応答:${id}` },
        { type: "done", sessionId: id },
      ]),
    });
  });
}

test.describe("マルチセッション（connectionId）", () => {
  test("チャット送信時に X-Connection-Id ヘッダがUUIDで付与される", async ({ page }) => {
    await mockRepos(page);
    let seen = "";
    await mockEchoChat(page, (id) => { seen = id; });

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "hello");

    await expect(page.getByText(/^応答:/)).toBeVisible();
    expect(seen, "X-Connection-Id が送られていない").toMatch(UUID_RE);
  });

  test("タブごとに異なる connectionId が発行され、応答が混ざらない", async ({ context }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    let idA = "";
    let idB = "";

    await mockRepos(pageA);
    await mockRepos(pageB);
    await mockEchoChat(pageA, (id) => { idA = id; });
    await mockEchoChat(pageB, (id) => { idB = id; });

    for (const p of [pageA, pageB]) {
      await p.goto("/");
      await selectRepo(p);
    }

    await sendMessage(pageA, "A");
    await expect(pageA.getByText(/^応答:/)).toBeVisible();
    await sendMessage(pageB, "B");
    await expect(pageB.getByText(/^応答:/)).toBeVisible();

    expect(idA).toMatch(UUID_RE);
    expect(idB).toMatch(UUID_RE);
    // sessionStorageはタブ単位なので、別タブなら別IDになる
    expect(idA, "タブ間でconnectionIdが共有されている（混線する）").not.toBe(idB);
    // 各タブには自分のIDの応答だけが出ていること
    await expect(pageA.getByText(`応答:${idA}`)).toBeVisible();
    await expect(pageB.getByText(`応答:${idB}`)).toBeVisible();
    await expect(pageA.getByText(`応答:${idB}`)).toHaveCount(0);

    await pageA.close();
    await pageB.close();
  });

  test("リロードしても同じタブなら connectionId は変わらない", async ({ page }) => {
    await mockRepos(page);
    const seen: string[] = [];
    await mockEchoChat(page, (id) => { seen.push(id); });

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "1回目");
    await expect(page.getByText(/^応答:/)).toBeVisible();

    await page.reload();
    // リロード後はURLにリポジトリが残るため再選択は不要
    await sendMessage(page, "2回目");
    await expect(page.getByText(/^応答:/)).toBeVisible();

    expect(seen.length).toBe(2);
    expect(seen[0], "リロードでconnectionIdが変わっている（再接続先を見失う）").toBe(seen[1]);
  });

  test("権限承認のリクエストにも X-Connection-Id が付与される", async ({ page }) => {
    await mockRepos(page);
    let chatId = "";
    let permissionId = "";

    // permission のあとに done を送る（done では pendingPermission がクリアされないのでダイアログは残る）
    await page.route("/api/chat", (route) => {
      chatId = route.request().headers()["x-connection-id"] ?? "";
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: sseBody([
          { type: "session_id", sessionId: "s1" },
          { type: "permission", toolName: "Write", toolInput: { file_path: "/tmp/a.txt" }, requestId: "req-1" },
          { type: "done", sessionId: "s1" },
        ]),
      });
    });
    await page.route("/api/permission", (route) => {
      permissionId = route.request().headers()["x-connection-id"] ?? "";
      return route.fulfill({ json: { ok: true } });
    });

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "ファイルを書く処理");

    await expect(page.getByText("Deny")).toBeVisible({ timeout: 5000 });
    await page.getByText("Allow").click();

    await expect.poll(() => permissionId).toMatch(UUID_RE);
    expect(permissionId, "permission が chat と別のIDを送っている").toBe(chatId);
  });

  test("停止のリクエストにも X-Connection-Id が付与される", async ({ page }) => {
    await mockRepos(page);
    let chatId = "";
    let interruptId = "";

    // 応答を遅らせて「生成中」の状態を作り、停止ボタンを出す
    await page.route("/api/chat", async (route) => {
      chatId = route.request().headers()["x-connection-id"] ?? "";
      await new Promise((r) => setTimeout(r, 5_000));
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: sseBody([{ type: "done", sessionId: "s1" }]),
      });
    });
    await page.route("/api/interrupt", (route) => {
      interruptId = route.request().headers()["x-connection-id"] ?? "";
      return route.fulfill({ json: { interrupted: true, stillQueued: [] } });
    });

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "時間のかかる処理");

    const stopButton = page.locator('button:has([data-testid="StopRoundedIcon"])');
    await expect(stopButton).toBeVisible({ timeout: 5000 });
    await stopButton.click();

    await expect.poll(() => interruptId).toMatch(UUID_RE);
    expect(interruptId, "interrupt が chat と別のIDを送っている").toBe(chatId);
  });
});
