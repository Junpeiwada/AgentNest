import { test, expect, Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// マルチエージェント再接続（agentId/clientId分離対応）の退行検知
//
// Docs/実装方針-マルチエージェント再接続.md フェーズ6 P6-5。
// 「タブを閉じた／リロードしても、実行中Agentに復帰できる」という今回の改修の核心を
// 検証する。対象はフロントの挙動（useChat.ts のマウント時自動復帰effect、AgentList）。
// サーバー側の実際の分離・所有権チェックはAPIモックのため検証できない
// （サーバー側の担保は tests/agent-reconnect.spec.ts ではなく実サーバでの手動確認や
// server/claude/executor.ts のロジックそのものに委ねる）。
// ---------------------------------------------------------------------------

const TEST_REPOS = [
  { id: "TestRepo", name: "TestRepo", path: "/tmp/TestRepo" },
  { id: "OtherRepo", name: "OtherRepo", path: "/tmp/OtherRepo" },
];

const AGENT_ID = "aaaaaaaa-1111-2222-3333-444444444444";

function sseBody(events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function mockRepos(page: Page) {
  await page.route("/api/repos", (route) => route.fulfill({ json: TEST_REPOS }));
}

async function selectRepo(page: Page, name = "TestRepo") {
  await page.getByText("Select repo").click();
  await page.getByText(name).nth(0).click();
}

/**
 * `GET /api/agents` をモックする。マウント時自動復帰effect（useChat.ts）だけでなく
 * useAgents（Headerのバッジ・ポップオーバー）も同じエンドポイントをポーリングするため、
 * 両方がこのモックを共有する。
 */
async function mockAgentsList(
  page: Page,
  agents: Array<{
    agentId: string;
    repoId: string;
    sessionId: string | null;
    completed: boolean;
    createdAt: number;
    lastActiveAt: number;
    hasPendingPermission: boolean;
    hasPendingQuestion: boolean;
  }>
) {
  await page.route("/api/agents", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { agents } });
    }
    return route.continue();
  });
}

function makeAgent(overrides: Partial<{
  agentId: string;
  repoId: string;
  sessionId: string | null;
  completed: boolean;
  createdAt: number;
  lastActiveAt: number;
  hasPendingPermission: boolean;
  hasPendingQuestion: boolean;
}> = {}) {
  return {
    agentId: AGENT_ID,
    repoId: "TestRepo",
    sessionId: "sess-1",
    completed: false,
    createdAt: Date.now() - 60_000,
    lastActiveAt: Date.now() - 1_000,
    hasPendingPermission: false,
    hasPendingQuestion: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. リロード後の自動復帰
// ---------------------------------------------------------------------------

test.describe("マウント時の自動復帰", () => {
  test("実行中Agentがあれば GET /api/agents 経由で見つけて自動的に /api/reconnect し、状態が復元される", async ({ page }) => {
    await mockRepos(page);
    await mockAgentsList(page, [makeAgent()]);

    let reconnectRequested = false;
    let seenAgentIdHeader = "";
    await page.route("/api/reconnect", (route) => {
      reconnectRequested = true;
      seenAgentIdHeader = route.request().headers()["x-agent-id"] ?? "";
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody([
          {
            type: "reconnect_state",
            repoId: "TestRepo",
            sessionId: "sess-1",
            assistantMessage: {
              role: "assistant",
              content: "自動復帰で復元されたレスポンス",
              parts: [{ type: "text", content: "自動復帰で復元されたレスポンス" }],
              error: null,
            },
            lastUserMessage: null,
            pendingPermission: null,
            pendingQuestion: null,
            completed: true,
          },
          { type: "done", sessionId: "sess-1" },
        ]),
      });
    });

    // /api/chat は呼ばれないはず（自動復帰のみで完結する）
    let chatCalled = false;
    await page.route("/api/chat", (route) => {
      chatCalled = true;
      return route.abort();
    });

    await page.goto("/");
    await selectRepo(page);

    // 何も送信していないのに、自動復帰によって過去の応答が復元される
    await expect(page.getByText("自動復帰で復元されたレスポンス")).toBeVisible({ timeout: 10000 });

    expect(reconnectRequested, "GET /api/agents で見つけたAgentへ /api/reconnect していない").toBe(true);
    expect(seenAgentIdHeader, "/api/reconnect に正しい X-Agent-Id が付与されていない").toBe(AGENT_ID);
    expect(chatCalled, "自動復帰のはずが /api/chat が呼ばれている").toBe(false);
  });

  test("実行中Agentが無ければ何も復元されず、新規チャット画面のまま", async ({ page }) => {
    await mockRepos(page);
    await mockAgentsList(page, []); // 実行中Agentなし

    let reconnectRequested = false;
    await page.route("/api/reconnect", (route) => {
      reconnectRequested = true;
      return route.fulfill({ status: 404, json: { error: "No active session" } });
    });

    await page.goto("/");
    await selectRepo(page);

    // 復帰対象が無いので何も表示されない（新規チャット画面のまま）ことを、
    // メッセージ入力欄が空のまま操作可能であることで確認する
    const input = page.getByPlaceholder("Message AgentNest...");
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();
    await expect(page.getByText(/自動復帰|復元/)).toHaveCount(0);

    expect(reconnectRequested, "候補が無いのに /api/reconnect が呼ばれている").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. lastUserMessage の復元
// ---------------------------------------------------------------------------

test.describe("自動復帰時の lastUserMessage 復元", () => {
  test("reconnect_state の lastUserMessage がユーザーメッセージとして画面に表示される", async ({ page }) => {
    await mockRepos(page);
    await mockAgentsList(page, [makeAgent()]);

    await page.route("/api/reconnect", (route) => {
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody([
          {
            type: "reconnect_state",
            repoId: "TestRepo",
            sessionId: "sess-1",
            assistantMessage: {
              role: "assistant",
              content: "続きの応答です",
              parts: [{ type: "text", content: "続きの応答です" }],
              error: null,
            },
            lastUserMessage: "実行中に送ったユーザーメッセージ",
            pendingPermission: null,
            pendingQuestion: null,
            completed: true,
          },
          { type: "done", sessionId: "sess-1" },
        ]),
      });
    });

    await page.goto("/");
    await selectRepo(page);

    // assistant応答だけが唐突に出るのではなく、対応するユーザーメッセージも表示される
    await expect(page.getByText("実行中に送ったユーザーメッセージ")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("続きの応答です")).toBeVisible();

    // 「実行中だった会話を再開しました」のフォールバック注記は、lastUserMessageが
    // 取得できた場合には不要になる（取得できなかった場合のみのフォールバック）
    await expect(page.getByText("実行中だった会話を再開しました")).toHaveCount(0);
  });

  test("lastUserMessage が取得できない場合はフォールバック注記が表示される", async ({ page }) => {
    await mockRepos(page);
    await mockAgentsList(page, [makeAgent()]);

    await page.route("/api/reconnect", (route) => {
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody([
          {
            type: "reconnect_state",
            repoId: "TestRepo",
            sessionId: "sess-1",
            assistantMessage: {
              role: "assistant",
              content: "続きの応答です（注記あり想定）",
              parts: [{ type: "text", content: "続きの応答です（注記あり想定）" }],
              error: null,
            },
            lastUserMessage: null,
            pendingPermission: null,
            pendingQuestion: null,
            completed: true,
          },
          { type: "done", sessionId: "sess-1" },
        ]),
      });
    });

    await page.goto("/");
    await selectRepo(page);

    await expect(page.getByText(/実行中だった会話を再開しました/)).toBeVisible({ timeout: 10000 });
  });
});

// ---------------------------------------------------------------------------
// 3. repoId 不一致での復帰中止
// ---------------------------------------------------------------------------

test.describe("repoId 不一致での復帰中止", () => {
  test("reconnect_state の repoId が現在のリポジトリと違う場合、復帰せず混線しない", async ({ page }) => {
    await mockRepos(page);
    // GET /api/agents は TestRepo 向けの実行中Agentがあると返す（候補には入る）が、
    // /api/reconnect のレスポンス側で異なる repoId を返すことで、
    // 「候補選定後にサーバ側スナップショットのrepoIdが食い違う」ケースを再現する。
    await mockAgentsList(page, [makeAgent({ repoId: "TestRepo" })]);

    await page.route("/api/reconnect", (route) => {
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody([
          {
            type: "reconnect_state",
            // 現在表示中のリポジトリ（TestRepo）と異なるrepoIdを返す
            repoId: "OtherRepo",
            sessionId: "sess-1",
            assistantMessage: {
              role: "assistant",
              content: "別リポジトリのAgentの出力（表示されてはいけない）",
              parts: [{ type: "text", content: "別リポジトリのAgentの出力（表示されてはいけない）" }],
              error: null,
            },
            lastUserMessage: "別リポジトリでの発言（表示されてはいけない）",
            pendingPermission: null,
            pendingQuestion: null,
            completed: true,
          },
          { type: "done", sessionId: "sess-1" },
        ]),
      });
    });

    await page.goto("/");
    await selectRepo(page, "TestRepo");

    // repoId不一致のため、静かに諦めて何も画面に反映されないはず。
    // 「反映されないこと」を有限時間内に確認するため、無関係な操作（入力欄操作）を
    // 挟んでから未表示を確認する。
    const input = page.getByPlaceholder("Message AgentNest...");
    await expect(input).toBeEnabled({ timeout: 10000 });
    await page.waitForTimeout(500); // 復帰処理が非同期で走りきる猶予

    await expect(page.getByText("別リポジトリのAgentの出力（表示されてはいけない）")).toHaveCount(0);
    await expect(page.getByText("別リポジトリでの発言（表示されてはいけない）")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Agent一覧UI（Header バッジ・ポップオーバー・破棄）
// ---------------------------------------------------------------------------

test.describe("Agent一覧UI", () => {
  test("Headerのバッジに実行中Agent数が表示される", async ({ page }) => {
    await mockRepos(page);
    await mockAgentsList(page, [
      makeAgent({ agentId: "aaaaaaaa-0000-0000-0000-000000000001", repoId: "TestRepo", completed: false }),
      makeAgent({ agentId: "aaaaaaaa-0000-0000-0000-000000000002", repoId: "OtherRepo", completed: false }),
      makeAgent({ agentId: "aaaaaaaa-0000-0000-0000-000000000003", repoId: "TestRepo", completed: true }),
    ]);
    // 自動復帰effectが/api/reconnectを叩いても実害はないように応答しておく
    await page.route("/api/reconnect", (route) =>
      route.fulfill({ status: 404, json: { error: "No active session" } })
    );

    await page.goto("/");
    await selectRepo(page);

    // 実行中(completed=false)は2件 → バッジに"2"が出る
    const badge = page.locator(".MuiBadge-badge");
    await expect(badge).toHaveText("2", { timeout: 10000 });
  });

  test("ポップオーバーから一覧が見え、選択で復帰する", async ({ page }) => {
    // このテストは「選択したAgentと同じリポジトリを表示中」のケース。
    // 「現在と別のリポジトリのAgentを選んで復帰する」ケースは下の
    // 「別リポジトリのAgentを一覧から選んで復帰する」テストで検証する
    // （かつて後者は既知のバグ（後述）により復帰が握りつぶされていたため、
    // このテストでは意図的に同一リポジトリのケースのみを検証していた）。
    //
    // 修正済みのバグ: MinimalLayout.handleResumeAgent は resumeAgentのセットと
    // navigate(chatPath(repoId)) を同一イベント内で呼ぶが、RootLayout の repoId は
    // useParams()（React Routerのルート一致、navigate後1レンダー遅れる）から取れる一方、
    // resumeAgentId は useOutletContext（MinimalLayoutのstate、同期的に反映）から
    // 取れるため、両者の反映タイミングがずれていた。その結果、Chatが新しいkey
    // （resumeAgentId基準）で先にマウントされる瞬間の repoId がまだ遷移前の値のままで、
    // useChat.ts の自動復帰effectが古いrepoIdをexpectedRepoIdとして /api/reconnect を
    // 呼んでしまい、サーバが返す reconnect_state.repoId（新リポジトリ側）と一致しないため
    // 「repoId不一致」とみなされ、復帰が静かに失敗していた
    // （P4-5のrepoId不一致ガード自体は意図通り機能しており、問題はマウントの
    // タイミング側にあった）。
    // 対策: MinimalLayoutはresumeAgentIdの代わりに{repoId, agentId}のペア（resumeAgent）
    // を渡すようにし、RootLayout側でresumeAgent.repoIdが自分のrepoId（useParams由来、
    // navigate後に追いつく値）と一致するまでresumeAgentIdをnullのまま保つよう変更した。
    // これによりrepoIdが追いつく前にChatが古いrepoIdのままマウントされることがなくなり、
    // 「別リポジトリのAgentへの一覧からの復帰」もrepoId不一致ガードに誤って
    // 引っかからなくなった（退行検知は下のテストで行う）。
    await mockRepos(page);
    await mockAgentsList(page, [
      makeAgent({ agentId: AGENT_ID, repoId: "TestRepo", completed: false }),
    ]);
    await page.route("/api/reconnect", (route) => {
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody([
          {
            type: "reconnect_state",
            repoId: "TestRepo",
            sessionId: "sess-2",
            assistantMessage: {
              role: "assistant",
              content: "一覧選択からの復帰",
              parts: [{ type: "text", content: "一覧選択からの復帰" }],
              error: null,
            },
            lastUserMessage: null,
            pendingPermission: null,
            pendingQuestion: null,
            completed: true,
          },
          { type: "done", sessionId: "sess-2" },
        ]),
      });
    });

    await page.goto("/");
    await selectRepo(page, "TestRepo");

    // Headerのバッジ（実行中Agentアイコン）を開く。
    // ポップオーバー内に絞って検索する（RepoSelectorのドロップダウンにも同名のリポジトリ名が
    // 表示されうるため、page全体で getByText すると strict mode violation になる）。
    await page.getByLabel("実行中のAgent").click();
    const popover = page.locator(".MuiPopover-paper");
    await expect(popover.getByText("TestRepo")).toBeVisible();
    await expect(popover.getByText("実行中")).toBeVisible();

    // 一覧から選択 → 復帰した応答が表示される
    await popover.getByText("TestRepo").click();
    await expect(page.getByText("一覧選択からの復帰")).toBeVisible({ timeout: 10000 });
  });

  test("別リポジトリのAgentを一覧から選んで復帰する（退行検知）", async ({ page }) => {
    // 上のテストのコメントで説明した、かつて存在したバグの退行検知テスト。
    // TestRepoを表示中に、一覧から現在と別のOtherRepoのAgentを選んで復帰できることを検証する。
    // 修正前は、Chatが（navigate未反映の）TestRepoのままresumeAgentId基準で再マウントされ、
    // useChat.tsの自動復帰effectがexpectedRepoId="TestRepo"で/api/reconnectを呼んでしまい、
    // サーバが返すreconnect_state.repoId="OtherRepo"と食い違って「repoId不一致」とみなされ、
    // 復帰が静かに失敗していた（この場合、以下のassistantMessageは画面に表示されなかった）。
    await mockRepos(page);
    await mockAgentsList(page, [
      makeAgent({ agentId: AGENT_ID, repoId: "OtherRepo", completed: false }),
    ]);

    let seenRepoIdHeader: string | null = null;
    await page.route("/api/reconnect", (route) => {
      seenRepoIdHeader = route.request().headers()["x-agent-id"] ?? null;
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: sseBody([
          {
            type: "reconnect_state",
            // 選択したAgentが属する別リポジトリ側のrepoIdをサーバが返す
            repoId: "OtherRepo",
            sessionId: "sess-3",
            assistantMessage: {
              role: "assistant",
              content: "別リポジトリからの復帰",
              parts: [{ type: "text", content: "別リポジトリからの復帰" }],
              error: null,
            },
            lastUserMessage: null,
            pendingPermission: null,
            pendingQuestion: null,
            completed: true,
          },
          { type: "done", sessionId: "sess-3" },
        ]),
      });
    });

    await page.goto("/");
    await selectRepo(page, "TestRepo");

    // Headerのバッジ一覧を開き、OtherRepoのAgentを選択する
    await page.getByLabel("実行中のAgent").click();
    const popover = page.locator(".MuiPopover-paper");
    await expect(popover.getByText("OtherRepo")).toBeVisible();
    await popover.getByText("OtherRepo").click();

    // URLがOtherRepo側に遷移し、選択したAgentの復帰内容が画面に表示される
    await expect(page).toHaveURL(/\/OtherRepo\/chat/, { timeout: 10000 });
    await expect(page.getByText("別リポジトリからの復帰")).toBeVisible({ timeout: 10000 });
    expect(seenRepoIdHeader, "/api/reconnect に正しい X-Agent-Id が付与されていない").toBe(AGENT_ID);
  });

  test("破棄は確認ダイアログ経由で行われ、キャンセルすれば破棄されない", async ({ page }) => {
    await mockRepos(page);
    let deleteCalled = false;
    await page.route("/api/agents/*", (route) => {
      if (route.request().method() === "DELETE") {
        deleteCalled = true;
        return route.fulfill({ json: { deleted: true } });
      }
      return route.continue();
    });
    await mockAgentsList(page, [makeAgent({ repoId: "TestRepo", completed: false })]);
    await page.route("/api/reconnect", (route) =>
      route.fulfill({ status: 404, json: { error: "No active session" } })
    );

    await page.goto("/");
    await selectRepo(page);

    await page.getByLabel("実行中のAgent").click();
    await page.getByLabel("このAgentを破棄").click();

    // 確認ダイアログが出る
    await expect(page.getByText("Agentを破棄しますか？")).toBeVisible();

    // キャンセル → DELETEは呼ばれない
    await page.getByText("キャンセル").click();
    await expect(page.getByText("Agentを破棄しますか？")).not.toBeVisible();
    expect(deleteCalled, "キャンセルしたのにDELETEが呼ばれている").toBe(false);

    // 再度開いて今度は確定 → DELETEが呼ばれる
    await page.getByLabel("実行中のAgent").click();
    await page.getByLabel("このAgentを破棄").click();
    await expect(page.getByText("Agentを破棄しますか？")).toBeVisible();
    await page.getByText("破棄する").click();

    await expect.poll(() => deleteCalled, { timeout: 5000 }).toBe(true);
  });
});
