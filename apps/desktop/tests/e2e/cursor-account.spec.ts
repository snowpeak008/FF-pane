/**
 * T11.18：设置里管 Cursor 账号。用假的 cursor-agent（放在 PATH 上、旁边带 node.exe 和 index.js），
 * 不碰本机真的 Cursor 登录：登录（认出链接 → 「浏览器里登录完」）→ 选默认模型 → 退出 → 新开窗口看得到账号。
 * 不点「打开浏览器」：那会真的开系统浏览器。
 */

import { copyFileSync, existsSync, linkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { e2eTempDir, gotoRoute, type LaunchedApp, launchApp, removeE2eTempDirs } from "./_launch";

test.afterEach(removeE2eTempDirs);

const FAKE_CURSOR = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const stateFile = path.join(__dirname, "state.json");
const read = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return { signedIn: false };
  }
};
const write = (state) => fs.writeFileSync(stateFile, JSON.stringify(state));
const [cmd] = process.argv.slice(2);
if (cmd === "status") {
  console.log(JSON.stringify(read().signedIn
    ? { status: "authenticated", isAuthenticated: true, userInfo: { email: "fake@example.com", firstName: "Fake", lastName: "User" } }
    : { status: "unauthenticated", isAuthenticated: false }));
} else if (cmd === "about") {
  console.log(JSON.stringify({ cliVersion: "2026.01.01-abc", latestStatus: "up_to_date", subscriptionTier: read().signedIn ? "Free" : undefined }));
} else if (cmd === "models") {
  console.log("Available models\n\nauto - Auto (default)\ngrok-4.7-low - Grok 4.7 Low\n");
} else if (cmd === "logout") {
  write({ signedIn: false });
  console.log("Logged out");
} else if (cmd === "login") {
  if (!process.env.NO_OPEN_BROWSER) {
    console.error("would open a browser");
    process.exit(3);
  }
  console.log("Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=e2e&mode=login");
  const trigger = path.join(__dirname, "login-done");
  const timer = setInterval(() => {
    if (fs.existsSync(trigger)) {
      clearInterval(timer);
      fs.rmSync(trigger);
      write({ signedIn: true });
      console.log("Authentication tokens stored securely.");
      process.exit(0);
    }
  }, 100);
} else {
  console.log("fake cursor-agent");
}
`;

/** 假 cursor-agent：目录里有 cursor-agent.cmd（让 PATH 认出它）、node.exe、index.js。 */
function seedFakeCursor(): string {
  const dir = e2eTempDir("ffpane-e2e-cursor-");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cursor-agent.cmd"), "@echo off\r\n");
  writeFileSync(join(dir, "index.js"), FAKE_CURSOR);
  const node = join(dir, "node.exe");
  try {
    linkSync(process.execPath, node);
  } catch {
    copyFileSync(process.execPath, node);
  }
  return dir;
}

async function createProject(launched: LaunchedApp, dir: string, name: string): Promise<void> {
  const { app, page } = launched;
  await app.evaluate(async ({ dialog }, path) => {
    // biome-ignore lint/suspicious/noExplicitAny: E2E 打桩
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, dir);
  await gotoRoute(page, "/projects");
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("button", { name: /Choose directory/i }).click();
  await expect(page.locator("#create-project-path")).toHaveValue(dir);
  await page.locator("#create-project-name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
}

/** Cursor 账号管理在设置 → 模型 → 新建 Provider →「本机已登录」→ 选 cursor 里。 */
async function openCursorAccountInProviderEditor(page: LaunchedApp["page"]): Promise<void> {
  await gotoRoute(page, "/settings?group=models");
  await page.getByRole("button", { name: "New provider" }).click();
  await page.getByTestId("provider-template-local-login").click();
  await page.locator("#provider-cli-runtime").selectOption("cursor");
}

test("设置里登录 Cursor、选默认模型、退出；新开窗口看得到账号", async () => {
  test.setTimeout(120_000);
  const fakeDir = seedFakeCursor();
  const projectDir = e2eTempDir("ffpane-e2e-cursor-proj-");
  const launched = await launchApp({ pathPrepend: fakeDir });
  try {
    const { page } = launched;
    await openCursorAccountInProviderEditor(page);
    const status = page.getByTestId("cursor-status");
    await expect(status).toHaveAttribute("data-signed-in", "no", { timeout: 20_000 });
    await expect(page.getByTestId("cursor-status-text")).toHaveText("Not signed in to Cursor");

    await page.getByTestId("cursor-login").click();
    await expect(page.getByTestId("cursor-login-copy")).toHaveAttribute(
      "data-url",
      "https://cursor.com/loginDeepControl?challenge=e2e&mode=login",
      { timeout: 20_000 },
    );
    // 「在浏览器里登录完」
    writeFileSync(join(fakeDir, "login-done"), "");
    await expect(page.getByTestId("cursor-login-done")).toContainText("fake@example.com", {
      timeout: 20_000,
    });
    await expect(status).toHaveAttribute("data-signed-in", "yes");
    await expect(page.getByTestId("cursor-status-text")).toHaveText(
      "Signed in as fake@example.com (Free)",
    );

    // 默认模型：初值 auto，选 Grok 后记进设置
    const select = page.getByTestId("cursor-default-model");
    await expect(select).toHaveValue("auto");
    await expect(select.locator("option[value='grok-4.7-low']")).toHaveCount(1, {
      timeout: 20_000,
    });
    await select.selectOption("grok-4.7-low");
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          // biome-ignore lint/suspicious/noExplicitAny: E2E
          const result = await (window as any).ffpane.invoke("config:get");
          return result?.data?.cursorDefaultModel ?? result?.cursorDefaultModel;
        }),
      )
      .toBe("grok-4.7-low");

    // 新开窗口选 Cursor：看得到账号和模型
    await createProject(launched, projectDir, "E2E Cursor Account");
    await page.getByRole("button", { name: /^E2E Cursor Account/ }).click();
    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await page.getByTestId("workbench-new-kind-cursor").click();
    const account = page.getByTestId("workbench-cursor-account");
    await expect(account).toHaveAttribute("data-signed-in", "yes", { timeout: 20_000 });
    await expect(page.getByTestId("workbench-cursor-hint")).toContainText("fake@example.com");
    await expect(page.getByTestId("workbench-cursor-hint")).toContainText("grok-4.7-low");
    await page.keyboard.press("Escape");

    // 退出登录
    await openCursorAccountInProviderEditor(page);
    await expect(status).toHaveAttribute("data-signed-in", "yes", { timeout: 20_000 });
    await page.getByTestId("cursor-logout").click();
    await expect(status).toHaveAttribute("data-signed-in", "no", { timeout: 20_000 });
    expect(existsSync(join(fakeDir, "state.json"))).toBe(true);
  } finally {
    await launched.cleanup();
  }
});
