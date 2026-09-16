import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider, ProviderId, RuntimeId } from "@ff-pane/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECTION_MODE_RESET_ID,
  ensureLocalCliProvider,
  LOCAL_CLI_PROVIDER_NAME,
  materializeProfileDraft,
  type ProfileDraft,
  resetLegacyAgentConfigIfNeeded,
} from "../src/main/connection-mode";

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "provider-relay" as ProviderId,
    name: "Hub",
    type: "openai_compatible",
    models: [],
    enabled: true,
    ...overrides,
  };
}

describe("resetLegacyAgentConfigIfNeeded", () => {
  let root = "";

  afterEach(async () => {
    if (root !== "") {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("首次清掉四份旧档并写下标记；再次调用跳过", async () => {
    root = await mkdtemp(join(tmpdir(), "ffpane-reset-"));
    const providersFile = join(root, "providers.json");
    const profilesFile = join(root, "profiles.json");
    const rolesFile = join(root, "roles.json");
    const secretsFile = join(root, "secrets.json");
    await Promise.all([
      writeFile(providersFile, "{}", "utf8"),
      writeFile(profilesFile, "{}", "utf8"),
      writeFile(rolesFile, "{}", "utf8"),
      writeFile(secretsFile, "{}", "utf8"),
    ]);

    await expect(
      resetLegacyAgentConfigIfNeeded({
        rootDir: root,
        providersFile,
        profilesFile,
        rolesFile,
        secretsFile,
      }),
    ).resolves.toBe(true);

    const marker = join(root, `.reset-${CONNECTION_MODE_RESET_ID}`);
    await access(marker);
    await expect(access(providersFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(profilesFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(rolesFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(secretsFile)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(providersFile, "{\"kept\":true}", "utf8");
    await expect(
      resetLegacyAgentConfigIfNeeded({
        rootDir: root,
        providersFile,
        profilesFile,
        rolesFile,
        secretsFile,
      }),
    ).resolves.toBe(false);
    await expect(access(providersFile)).resolves.toBeUndefined();
  });
});

describe("ensureLocalCliProvider / materializeProfileDraft", () => {
  it("没有 cli_login 就建一条「本地 CLI」", async () => {
    const created: Provider[] = [];
    const store = {
      listProviders: async () => created,
      createProvider: async (draft: {
        readonly name: string;
        readonly type: "cli_login";
        readonly models: readonly [];
        readonly enabled: true;
      }) => {
        const next: Provider = { id: "provider-local" as ProviderId, ...draft };
        created.push(next);
        return next;
      },
    };
    const local = await ensureLocalCliProvider(store);
    expect(local.name).toBe(LOCAL_CLI_PROVIDER_NAME);
    expect(local.type).toBe("cli_login");
    expect(await ensureLocalCliProvider(store)).toBe(local);
  });

  it("本地 CLI 档案覆盖成刚找到/建好的本机登录来源；中转原样返回", async () => {
    const local = provider({
      id: "provider-cli" as ProviderId,
      name: "本地 CLI",
      type: "cli_login",
    });
    const store = {
      listProviders: async () => [local],
      createProvider: async () => {
        throw new Error("不应再建");
      },
    };
    const localDraft = await materializeProfileDraft(
      {
        name: "Claude",
        runtime: "claude-code" as RuntimeId,
        providerId: "provider-relay" as ProviderId,
        defaultRole: "worker",
        permissionPreset: {
          readPaths: ["**"],
          writePaths: [],
          shell: "forbidden",
          network: false,
          dangerousOpsRequireApproval: true,
        },
        connectionMode: "local_cli",
      },
      store,
    );
    expect(localDraft.providerId).toBe("provider-cli");

    const relayDraft: ProfileDraft = {
      name: "Relay",
      runtime: "claude-code" as RuntimeId,
      providerId: "provider-relay" as ProviderId,
      defaultRole: "worker",
      permissionPreset: localDraft.permissionPreset,
      connectionMode: "relay",
    };
    await expect(materializeProfileDraft(relayDraft, store)).resolves.toBe(relayDraft);
  });
});
