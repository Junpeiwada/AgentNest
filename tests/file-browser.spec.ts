import { test, expect, Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_REPOS = [
  { id: "TestRepo", name: "TestRepo", path: "/tmp/TestRepo" },
];

const ROOT_FILES = [
  { name: "src", path: "src", type: "directory" },
  { name: "docs", path: "docs", type: "directory" },
  { name: "README.md", path: "README.md", type: "file", size: 1234, extension: ".md" },
  { name: "index.ts", path: "index.ts", type: "file", size: 567, extension: ".ts" },
  { name: "logo.png", path: "logo.png", type: "file", size: 20480, extension: ".png" },
];

const SRC_FILES = [
  { name: "components", path: "src/components", type: "directory" },
  { name: "App.tsx", path: "src/App.tsx", type: "file", size: 890, extension: ".tsx" },
  { name: "main.ts", path: "src/main.ts", type: "file", size: 120, extension: ".ts" },
];

const COMPONENTS_FILES = [
  { name: "Header.tsx", path: "src/components/Header.tsx", type: "file", size: 450, extension: ".tsx" },
];

const SPECIAL_FILES = [
  { name: "foo #1.ts", path: "docs/foo #1.ts", type: "file", size: 321, extension: ".ts" },
];

const CODE_CONTENT = {
  type: "code",
  content: 'export default function App() {\n  return <div>Hello</div>;\n}',
  language: "tsx",
};

const MARKDOWN_CONTENT = {
  type: "markdown",
  content: "# Project Title\n\nThis is a **sample** project.\n\n## Features\n\n- Feature 1\n- Feature 2\n",
  language: "markdown",
};

const IMAGE_CONTENT = {
  type: "image",
  // 1x1 red pixel PNG in base64
  content: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
};

const BINARY_CONTENT = {
  type: "binary",
  content: null,
  message: "ファイルが大きすぎます",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mockRepos(page: Page) {
  await page.route("/api/repos", (route) =>
    route.fulfill({ json: TEST_REPOS })
  );
}

/** Known directory paths — anything else with a file extension is treated as "Not a directory" */
const KNOWN_DIRS: Record<string, object[]> = {
  "": ROOT_FILES,
  "src": SRC_FILES,
  "src/components": COMPONENTS_FILES,
  "docs": SPECIAL_FILES,
};

/** Mock file listing API — dispatches by ?dir= parameter */
async function mockFileList(page: Page) {
  await page.route("**/api/repos/TestRepo/files**", (route) => {
    const url = new URL(route.request().url());
    const dir = url.searchParams.get("dir") || "";

    if (dir in KNOWN_DIRS) {
      return route.fulfill({ json: KNOWN_DIRS[dir] });
    }
    // File path → 400 "Not a directory" (same as real server)
    return route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "Not a directory" }),
    });
  });
}

/** Mock individual file content API */
async function mockFileContent(page: Page) {
  await page.route("/api/repos/TestRepo/file/**", (route) => {
    const url = route.request().url();

    if (url.includes("App.tsx")) {
      return route.fulfill({ json: CODE_CONTENT });
    }
    if (url.includes("README.md")) {
      return route.fulfill({ json: MARKDOWN_CONTENT });
    }
    if (url.includes("logo.png")) {
      return route.fulfill({ json: IMAGE_CONTENT });
    }
    // default: code
    return route.fulfill({ json: CODE_CONTENT });
  });
}

async function selectRepo(page: Page) {
  await page.getByText("Select repo").click();
  await page.getByText("TestRepo").nth(0).click();
}

async function switchToFilesTab(page: Page) {
  await page.getByText("ファイル").click();
}

async function switchToChatTab(page: Page) {
  await page.getByText("チャット").click();
}

async function setupAll(page: Page) {
  await mockRepos(page);
  await mockFileList(page);
  await mockFileContent(page);
}

// ---------------------------------------------------------------------------
// Tests: Tab switching
// ---------------------------------------------------------------------------

test.describe("Tab switching", () => {
  test("chat tab is active by default", async ({ page }) => {
    await setupAll(page);
    await page.goto("/");
    await selectRepo(page);

    // Chat input should be visible (after selecting repo, placeholder becomes "Message AgentNest...")
    await expect(page.getByPlaceholder("Message AgentNest...")).toBeVisible();
  });

  test("switching to files tab shows file explorer", async ({ page }) => {
    await setupAll(page);
    await page.goto("/");
    await selectRepo(page);
    await switchToFilesTab(page);

    // Root files should be listed
    await expect(page.getByText("README.md")).toBeVisible();
    await expect(page.getByText("index.ts")).toBeVisible();
    await expect(page.getByText("src")).toBeVisible();
  });

  test("switching back to chat tab restores chat view", async ({ page }) => {
    await setupAll(page);
    await page.goto("/");
    await selectRepo(page);

    await switchToFilesTab(page);
    await expect(page.getByText("README.md")).toBeVisible();

    await switchToChatTab(page);
    await expect(page.getByPlaceholder("Message AgentNest...")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Tests: File explorer (directory navigation)
// ---------------------------------------------------------------------------

test.describe("File explorer", () => {
  test("shows file list after selecting a repo", async ({ page }) => {
    await setupAll(page);
    await page.goto("/");
    await selectRepo(page);
    await switchToFilesTab(page);

    // Directories
    await expect(page.getByText("src")).toBeVisible();
    await expect(page.getByText("docs")).toBeVisible();
    // Files
    await expect(page.getByText("README.md")).toBeVisible();
    await expect(page.getByText("index.ts")).toBeVisible();
    await expect(page.getByText("logo.png")).toBeVisible();
    // File size should be displayed
    await expect(page.getByText("1.2 KB")).toBeVisible(); // README.md = 1234 bytes
  });

  test("clicking a directory navigates into it", async ({ page }) => {
    await setupAll(page);
    await page.goto("/");
    await selectRepo(page);
    await switchToFilesTab(page);

    await page.getByText("src").click();

    // Should show src contents
    await expect(page.getByText("components")).toBeVisible();
    await expect(page.getByText("App.tsx")).toBeVisible();
    await expect(page.getByText("main.ts")).toBeVisible();

    // Root items should be gone
    await expect(page.getByText("README.md")).not.toBeVisible();
  });

  test("breadcrumb navigates back to root", async ({ page }) => {
    await setupAll(page);
    await page.goto("/");
    await selectRepo(page);
    await switchToFilesTab(page);

    // Navigate into src
    await page.getByText("src").click();
    await expect(page.getByText("App.tsx")).toBeVisible();

    // Click repo name in breadcrumb to go back to root
    // MUI Link component="button" renders as <button>, not <a>
    await page.getByRole("button", { name: "TestRepo" }).click();

    // Root items should be back
    await expect(page.getByText("README.md")).toBeVisible();
    await expect(page.getByText("src")).toBeVisible();
  });

  test("breadcrumb shows intermediate paths for deep navigation", async ({
    page,
  }) => {
    await setupAll(page);
    await page.goto("/");
    await selectRepo(page);
    await switchToFilesTab(page);

    // Navigate: root → src → components
    await page.getByText("src").click();
    await page.getByText("components").click();
    await expect(page.getByText("Header.tsx")).toBeVisible();

    // Breadcrumb should show: TestRepo > src > components
    // MUI Breadcrumbs with Link component="button" renders as <button>
    const breadcrumbNav = page.locator("nav");
    await expect(breadcrumbNav.getByText("TestRepo")).toBeVisible();
    await expect(breadcrumbNav.getByText("src")).toBeVisible();
    await expect(breadcrumbNav.getByText("components")).toBeVisible();

    // Click "src" in breadcrumb should go back to src/
    await breadcrumbNav.getByText("src").click();
    await expect(page.getByText("App.tsx")).toBeVisible();
    await expect(page.getByText("Header.tsx")).not.toBeVisible();
  });

  test("shows placeholder when no repo is selected", async ({ page }) => {
    await setupAll(page);
    await page.goto("/");

    // リポジトリ未選択時はRepoRedirect画面が表示される
    await expect(
      page.getByText("リポジトリを選択してください")
    ).toBeVisible();
  });

  test("shows empty message for empty directory", async ({ page }) => {
    await mockRepos(page);
    await mockFileContent(page);
    await page.route("**/api/repos/TestRepo/files**", (route) => {
      const url = new URL(route.request().url());
      const dir = url.searchParams.get("dir") || "";

      if (dir === "docs") {
        return route.fulfill({ json: [] });
      }
      if (dir === "src/components") {
        return route.fulfill({ json: COMPONENTS_FILES });
      }
      if (dir === "src") {
        return route.fulfill({ json: SRC_FILES });
      }
      return route.fulfill({ json: ROOT_FILES });
    });
    await page.goto("/");
    await selectRepo(page);
    await switchToFilesTab(page);

    await page.getByText("docs").click();
    await expect(page.getByText("空のディレクトリです")).toBeVisible();
  });

  test("encodes special characters in file URLs", async ({ page }) => {
    await setupAll(page);
    await page.goto("/");
    await selectRepo(page);
    await switchToFilesTab(page);

    await page.getByText("docs").click();
    await page.getByText("foo #1.ts").click();

    await expect(page).toHaveURL(/\/TestRepo\/files\/docs\/foo%20%231\.ts$/);
  });

  test("shows error for missing file path instead of file viewer", async ({ page }) => {
    await mockRepos(page);
    await mockFileContent(page);
    await page.route("**/api/repos/TestRepo/files**", (route) => {
      const url = new URL(route.request().url());
      const dir = url.searchParams.get("dir") || "";

      if (dir === "missing/path") {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Directory not found" }),
        });
      }
      return route.fulfill({ json: ROOT_FILES });
    });

    await page.goto("/TestRepo/files/missing/path");

    await expect(page.getByText("サーバーに接続できません")).toBeVisible();
    await expect(page.locator("[data-testid='ArrowBackRoundedIcon']")).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Tests: File viewer
// ---------------------------------------------------------------------------

test.describe("File viewer", () => {
  test("displays code file content", async ({ page }) => {
    await setupAll(page);
    await page.goto("/");
    await selectRepo(page);
    await switchToFilesTab(page);

    await page.getByText("src").click();
    await page.getByText("App.tsx").click();

    // File name should appear in header
    await expect(page.getByText("App.tsx").first()).toBeVisible();
    // Code content should be rendered
    await expect(page.getByText("export default function App()")).toBeVisible();
  });

  test("renders markdown file as formatted HTML", async ({ page }) => {
    await setupAll(page);
    await page.goto("/");
    await selectRepo(page);
    await switchToFilesTab(page);

    await page.getByText("README.md").click();

    // Heading should be rendered as an h1
    const heading = page.locator("h1", { hasText: "Project Title" });
    await expect(heading).toBeVisible();
    // Bold text should be rendered
    await expect(page.locator("strong", { hasText: "sample" })).toBeVisible();
    // List items
    await expect(page.getByText("Feature 1")).toBeVisible();
    await expect(page.getByText("Feature 2")).toBeVisible();
  });

  test("displays image file as img element", async ({ page }) => {
    await setupAll(page);
    await page.goto("/");
    await selectRepo(page);
    await switchToFilesTab(page);

    await page.getByText("logo.png").click();

    // Image should be rendered
    const img = page.locator("img[alt='logo.png']");
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute("src", /^data:image\/png;base64,/);
  });

  test("back button returns to file list", async ({ page }) => {
    await setupAll(page);
    await page.goto("/");
    await selectRepo(page);
    await switchToFilesTab(page);

    await page.getByText("src").click();
    await page.getByText("App.tsx").click();
    await expect(page.getByText("export default function App()")).toBeVisible();

    // Click back button (the first IconButton with ArrowBack icon in the viewer header)
    await page.locator("[data-testid='ArrowBackRoundedIcon']").click();

    // Should be back in src/ directory
    await expect(page.getByText("App.tsx")).toBeVisible();
    await expect(page.getByText("main.ts")).toBeVisible();
  });

  test("shows error when file content fetch fails", async ({ page }) => {
    await mockRepos(page);
    await mockFileList(page);
    // Override file content to return a network error
    await page.route("/api/repos/TestRepo/file/**", (route) =>
      route.abort("connectionrefused")
    );

    await page.goto("/");
    await selectRepo(page);
    await switchToFilesTab(page);

    await page.getByText("index.ts").click();

    await expect(page.getByText("サーバーに接続できません")).toBeVisible();
  });

  test("shows message for binary/oversized file", async ({ page }) => {
    await mockRepos(page);
    await mockFileList(page);
    await page.route("/api/repos/TestRepo/file/**", (route) =>
      route.fulfill({ json: BINARY_CONTENT })
    );

    await page.goto("/");
    await selectRepo(page);
    await switchToFilesTab(page);

    await page.getByText("logo.png").click();

    await expect(page.getByText("ファイルが大きすぎます")).toBeVisible();
  });

  test("switches from file viewer back to chat via tab bar", async ({ page }) => {
    await setupAll(page);
    await page.goto("/");
    await selectRepo(page);
    await switchToFilesTab(page);

    await page.getByText("README.md").click();
    await expect(page.locator("h1", { hasText: "Project Title" })).toBeVisible();

    // ファイル閲覧中にタブバーの「チャット」でチャットへ戻れること（旧チャットFABの代替）
    await switchToChatTab(page);

    // Should switch to chat tab
    await expect(page.getByPlaceholder("Message AgentNest...")).toBeVisible();
  });
});
