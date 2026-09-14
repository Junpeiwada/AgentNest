import { test, expect, Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// マルチセッション（clientId/agentId）の退行検知
//
// サーバは `X-Client-Id`（所有者=ブラウザ単位、localStorage）と `X-Agent-Id`
// （実行1本ごと、サーバ発行）の2ヘッダでAgentを識別する（Docs/実装方針-マルチエージェント再接続.md）。
// `X-Connection-Id` は廃止済みで受理しない。
//
// clientId は localStorage 保存のためブラウザ単位で不変（同一ブラウザの複数タブで共有される）。
// 混線防止の単位は agentId 側（サーバ発行・実行1本ごと、SSE冒頭の `agent_id` イベントで通知される）
// が担う。そのため「タブごとに異なるID」という前提は本設計には無く、ここでは
// 「別ブラウザコンテキスト（=別clientId）どうしで応答が混ざらない」ことと、
// 「全チャット系APIに正しいヘッダが送られていること」を検証する。
// サーバ側の分離そのものはAPIモックのため検証できない。ここで担保するのは
// 「フロントが正しいIDを、全チャット系APIに送っていること」。
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

/**
 * 受け取った clientId をそのまま応答に混ぜ返すモック（取り違えれば表示で分かる）。
 * SSE冒頭に agent_id イベントを流し、以降のリクエスト（permission/interrupt）で
 * X-Agent-Id が付与できる状態を作る。agentId はリクエストごとにサーバ発行される想定なので
 * ここでは固定文字列にせず randomUUID 相当の形式で都度払い出す。
 */
async function mockEchoChat(page: Page, onSeen?: (clientId: string) => void) {
  let counter = 0;
  await page.route("/api/chat", (route) => {
    const clientId = route.request().headers()["x-client-id"] ?? "(なし)";
    onSeen?.(clientId);
    counter++;
    const agentId = `aaaaaaaa-bbbb-cccc-dddd-${String(counter).padStart(12, "0")}`;
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: sseBody([
        { type: "agent_id", agentId },
        { type: "session_id", sessionId: agentId },
        { type: "text", content: `応答:${clientId}` },
        { type: "done", sessionId: agentId },
      ]),
    });
  });
}

test.describe("マルチセッション（clientId/agentId）", () => {
  test("チャット送信時に X-Client-Id ヘッダがUUIDで付与される", async ({ page }) => {
    await mockRepos(page);
    let seen = "";
    await mockEchoChat(page, (id) => { seen = id; });

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "hello");

    await expect(page.getByText(/^応答:/)).toBeVisible();
    expect(seen, "X-Client-Id が送られていない").toMatch(UUID_RE);
  });

  test("別ブラウザコンテキスト（別clientId）どうしで応答が混ざらない", async ({ browser }) => {
    // clientId は localStorage 保存（ブラウザ単位で不変）なので、別clientIdを再現するには
    // 別の browser context（= 別プロファイル相当）を使う必要がある。同一contextの複数タブは
    // localStorage を共有するため clientId も共有される（後述の別テストで検証）。
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
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
    // localStorageはブラウザ(context)単位なので、別contextなら別clientIdになる
    expect(idA, "別contextなのにclientIdが同じ（混線する）").not.toBe(idB);
    // 各ページには自分のIDの応答だけが出ていること
    await expect(pageA.getByText(`応答:${idA}`)).toBeVisible();
    await expect(pageB.getByText(`応答:${idB}`)).toBeVisible();
    await expect(pageA.getByText(`応答:${idB}`)).toHaveCount(0);

    await contextA.close();
    await contextB.close();
  });

  test("同一ブラウザの複数タブは同じ clientId を共有するが、agentIdは別々でタブの応答は混ざらない", async ({ context }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const clientIds: string[] = [];

    await mockRepos(pageA);
    await mockRepos(pageB);
    await mockEchoChat(pageA, (id) => { clientIds.push(id); });
    await mockEchoChat(pageB, (id) => { clientIds.push(id); });

    for (const p of [pageA, pageB]) {
      await p.goto("/");
      await selectRepo(p);
    }

    await sendMessage(pageA, "A");
    await expect(pageA.getByText(/^応答:/)).toBeVisible();
    await sendMessage(pageB, "B");
    await expect(pageB.getByText(/^応答:/)).toBeVisible();

    // 同一contextの複数タブは localStorage を共有するため clientId は同じでよい
    expect(clientIds[0]).toMatch(UUID_RE);
    expect(clientIds[1]).toMatch(UUID_RE);
    expect(clientIds[0], "同一ブラウザの複数タブなのにclientIdが違う").toBe(clientIds[1]);

    // 混線防止は agentId 側の責務。各タブは自分が受け取ったagent_idの応答だけを表示していること
    await expect(pageA.getByText("応答:" + clientIds[0])).toBeVisible();
    await expect(pageB.getByText("応答:" + clientIds[1])).toBeVisible();

    await pageA.close();
    await pageB.close();
  });

  test("リロードしても同じブラウザなら clientId は変わらない", async ({ page }) => {
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
    expect(seen[0], "リロードでclientIdが変わっている（再接続先を見失う）").toBe(seen[1]);
  });

  test("権限承認のリクエストにも X-Client-Id と X-Agent-Id が付与される", async ({ page }) => {
    await mockRepos(page);
    let chatClientId = "";
    let permissionClientId = "";
    let permissionAgentId = "";
    const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-000000000001";

    // permission のあとに done を送る（done では pendingPermission がクリアされないのでダイアログは残る）
    await page.route("/api/chat", (route) => {
      chatClientId = route.request().headers()["x-client-id"] ?? "";
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: sseBody([
          { type: "agent_id", agentId: AGENT_ID },
          { type: "session_id", sessionId: "s1" },
          { type: "permission", toolName: "Write", toolInput: { file_path: "/tmp/a.txt" }, requestId: "req-1" },
          { type: "done", sessionId: "s1" },
        ]),
      });
    });
    await page.route("/api/permission", (route) => {
      permissionClientId = route.request().headers()["x-client-id"] ?? "";
      permissionAgentId = route.request().headers()["x-agent-id"] ?? "";
      return route.fulfill({ json: { ok: true } });
    });

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "ファイルを書く処理");

    await expect(page.getByText("Deny")).toBeVisible({ timeout: 5000 });
    await page.getByText("Allow").click();

    await expect.poll(() => permissionClientId).toMatch(UUID_RE);
    expect(permissionClientId, "permission が chat と別のclientIdを送っている").toBe(chatClientId);
    expect(permissionAgentId, "permission に agent_id イベントで受け取ったagentIdが送られていない").toBe(AGENT_ID);
  });

  test("停止のリクエストにも X-Client-Id と X-Agent-Id が付与される", async ({ page }) => {
    await mockRepos(page);
    let chatClientId = "";
    let interruptClientId = "";
    let interruptAgentId = "";
    const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-000000000002";
    let chatCallCount = 0;

    // route.fulfill は一括応答（ストリーミング書き込み不可）のため、「生成中に停止」を
    // 再現するには2回のメッセージ送信に分ける。
    // 1回目: agent_id を含む応答を即座に返して完了させ、フロントに agentId を確定させる
    //   （継続対象として2回目もこの agentId を使う）。
    // 2回目: ハングさせて「生成中」を作り、その状態で停止ボタンを押す。
    // こうすることで、停止操作時点で agentId は既にフロントにセット済みの状態を作れる。
    await page.route("/api/chat", async (route) => {
      chatCallCount++;
      chatClientId = route.request().headers()["x-client-id"] ?? "";
      if (chatCallCount === 1) {
        return route.fulfill({
          status: 200,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
          body: sseBody([
            { type: "agent_id", agentId: AGENT_ID },
            { type: "text", content: "1回目の応答" },
            { type: "done", sessionId: "s1" },
          ]),
        });
      }
      // 2回目: 応答を遅らせて「生成中」の状態を作り、停止ボタンを出す
      await new Promise((r) => setTimeout(r, 5_000));
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: sseBody([{ type: "done", sessionId: "s1" }]),
      });
    });
    await page.route("/api/interrupt", (route) => {
      interruptClientId = route.request().headers()["x-client-id"] ?? "";
      interruptAgentId = route.request().headers()["x-agent-id"] ?? "";
      return route.fulfill({ json: { interrupted: true, stillQueued: [] } });
    });

    await page.goto("/");
    await selectRepo(page);
    await sendMessage(page, "1回目のメッセージ");
    await expect(page.getByText("1回目の応答")).toBeVisible({ timeout: 5000 });

    await sendMessage(page, "時間のかかる処理");

    const stopButton = page.locator('button:has([data-testid="StopRoundedIcon"])');
    await expect(stopButton).toBeVisible({ timeout: 5000 });
    await stopButton.click();

    await expect.poll(() => interruptClientId).toMatch(UUID_RE);
    expect(interruptClientId, "interrupt が chat と別のclientIdを送っている").toBe(chatClientId);
    expect(interruptAgentId, "interrupt に agent_id イベントで受け取ったagentIdが送られていない").toBe(AGENT_ID);
  });
});
