/**
 * 本机登录来源限制模型（计划 docs/本机登录来源限制模型计划.md）：
 * 配置编辑器里选来源 → 模型下拉只剩来源里的对话模型 → 保存 → 开假 Codex 窗口，启动参数带的是选中的模型。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { e2eTempDir, gotoRoute, type LaunchedApp, launchApp, removeE2eTempDirs } from "./_launch";
import { dismissOverlays } from "./_workbench-ui";

test.afterEach(removeE2eTempDirs);

function seedFakeCodex(dir: string): void {
  const bin = join(dir, "node_modules", "codex", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "codex.js"),
    [
      "const argv = process.argv.slice(2);",
      "process.stdout.write('FAKE_CODEX_ARGV_JSON=' + JSON.stringify(argv) + '\\n');",
      "process.stdout.write('FAKE_CODEX_ENV_END\\n');",
      "process.stdin.resume();",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(dir, "codex.cmd"),
    [
      "@ECHO off",
      "SETLOCAL",
      "CALL :find_dp0",
      `IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )`,
      `endLocal & "%_prog%"  "%dp0%\\node_modules\\codex\\bin\\codex.js" %*`,
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

async function replayOf(page: LaunchedApp["page"], windowId: string): Promise<string> {
  return page.evaluate(async (wid) => {
    const host = document.querySelector(`[data-window-id="${wid}"]`);
    const id = host?.querySelector('[data-testid="terminal-id"]')?.textContent?.trim();
    if (id === undefined || id.length === 0) {
      return "";
    }
    try {
      // biome-ignore lint/suspicious/noExplicitAny: E2E
      const replay = await (window as any).ffpane.invoke("terminal:get-replay", { id });
      return typeof replay?.data === "string" ? replay.data : "";
    } catch {
      return "";
    }
  }, windowId);
}

test("配置里本机登录选来源：模型下拉只剩来源里的，保存后开窗带的是选中的模型", async () => {
  const fakeBin = e2eTempDir("ffpane-e2e-src-bin-");
  const projectDir = e2eTempDir("ffpane-e2e-src-proj-");
  seedFakeCodex(fakeBin);
  const launched = await launchApp({ pathPrepend: fakeBin });
  try {
    const { page } = launched;
    const invoke = async (channel: string, request?: unknown) =>
      page.evaluate(
        async (arg) => {
          // biome-ignore lint/suspicious/noExplicitAny: E2E
          return await (window as any).ffpane.invoke(arg.channel, arg.request);
        },
        { channel, request },
      );

    await invoke("projects:create", { name: "E2E Source", rootPath: projectDir });
    const source = (await invoke("providers:create", {
      draft: {
        name: "限制来源",
        templateId: "local-login",
        models: [
          { id: "m-a", label: "A", kind: "chat" },
          { id: "m-b", label: "B", kind: "chat" },
          { id: "emb-1", label: "E", kind: "embedding" },
        ],
        defaultModelId: "m-b",
        enabled: true,
      },
    })) as { id: string };

    // —— 配置编辑器：新建配置，Codex 这一路选来源
    await gotoRoute(page, "/settings?group=models");
    await page.getByTestId("config-new").click();
    await page.getByTestId("config-name").fill("限制模型");
    await page.getByTestId("config-codex-source").selectOption(source.id);
    const allowed = page.getByTestId("config-codex-model-allowed");
    await expect(allowed).toBeVisible();
    // 下拉 = 「不指定」+ 来源里的两个对话模型；嵌入模型不在里面
    await expect(allowed.locator("option")).toHaveText([/Not specified/, "m-a", "m-b"]);
    await allowed.selectOption("m-a");
    await page.getByTestId("config-save").click();
    await expect(page.getByTestId("config-editor")).toHaveCount(0, { timeout: 15_000 });

    const configs = (await invoke("configs:list")) as Array<{
      id: string;
      name: string;
      codex?: { connectionMode: string; providerId?: string; model?: string };
    }>;
    const created = configs.find((item) => item.name === "限制模型");
    expect(created?.codex).toEqual({
      connectionMode: "local_cli",
      providerId: source.id,
      model: "m-a",
    });
    await invoke("configs:set-default", { id: created?.id });

    // —— 开窗：对话框里写着来源，启动参数带的是 m-a
    await gotoRoute(page, "/projects");
    await page.getByRole("button", { name: /^E2E Source/ }).click();
    await gotoRoute(page, "/workbench");
    await page.getByTestId("workbench-new-tab").click();
    await page.getByTestId("workbench-new-kind-codex").click();
    await expect(page.getByTestId("workbench-new-route")).toContainText("限制来源");
    await expect(page.getByTestId("workbench-new-confirm")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("workbench-new-confirm").click();
    const pane = page.locator('[data-window-kind="codex"]').last();
    await expect(pane.getByTestId("workbench-window-title")).toBeVisible({ timeout: 20_000 });
    const windowId = await page
      .getByTestId("workbench-window")
      .first()
      .getAttribute("data-window-id");
    expect(windowId).toBeTruthy();
    await expect
      .poll(async () => (await replayOf(page, windowId ?? "")).includes("FAKE_CODEX_ARGV_JSON="), {
        timeout: 30_000,
      })
      .toBe(true);
    const replay = await replayOf(page, windowId ?? "");
    const marker = "FAKE_CODEX_ARGV_JSON=";
    const flat = replay.slice(replay.indexOf(marker) + marker.length).replace(/\r?\n/g, "");
    const argv = JSON.parse(flat.slice(0, flat.indexOf("FAKE_CODEX_ENV_END"))) as string[];
    expect(argv[argv.indexOf("-m") + 1]).toBe("m-a");
    await dismissOverlays(page);
  } finally {
    await launched.cleanup();
  }
});
