/**
 * T11.8：项目外写入检查——写文件工具、命令里的常见写法、读项目外不拦、heredoc 正文不算。
 * 用例里的路径取自《海上生存日记》现场（10-25 以来写到项目外的那些）。
 */

import { describe, expect, it } from "vitest";
import {
  checkWrite,
  denyHookOutput,
  normalizeWritePath,
  parseWriteRoots,
  shellWriteTargets,
} from "../src/mcp/write-guard";

const PROJECT = "D:\\WorkWork\\gamedesign\\项目2--海上生存";
const HOME = "C:\\Users\\admin";
const TMP = "C:\\Users\\admin\\AppData\\Local\\Temp";
const ROOTS = [PROJECT, TMP, `${HOME}\\.claude\\plans`];

function write(file_path: string): string | undefined {
  return checkWrite(
    { toolName: "Write", toolInput: { file_path }, cwd: PROJECT },
    ROOTS,
    HOME,
    TMP,
  );
}

function shell(command: string, toolName = "Bash"): string | undefined {
  return checkWrite({ toolName, toolInput: { command }, cwd: PROJECT }, ROOTS, HOME, TMP);
}

describe("路径归一", () => {
  it("认 C:\\、C:/、/c/、~、/tmp，大小写不敏感", () => {
    expect(normalizeWritePath("/c/gather/x", PROJECT, HOME, TMP)).toBe("c:/gather/x");
    expect(normalizeWritePath("C:\\Gather\\X\\", PROJECT, HOME, TMP)).toBe("c:/gather/x");
    expect(normalizeWritePath("~/edh/run1.py", PROJECT, HOME, TMP)).toBe(
      "c:/users/admin/edh/run1.py",
    );
    expect(normalizeWritePath("$env:USERPROFILE\\edh", PROJECT, HOME, TMP)).toBe(
      "c:/users/admin/edh",
    );
    expect(normalizeWritePath("/tmp/a.txt", PROJECT, HOME, TMP)).toBe(
      "c:/users/admin/appdata/local/temp/a.txt",
    );
    expect(normalizeWritePath("art/a.png", PROJECT, HOME, TMP)).toBe(
      "d:/workwork/gamedesign/项目2--海上生存/art/a.png",
    );
  });

  it("带没展开的变量或通配符的认不出，返回 undefined", () => {
    expect(normalizeWritePath("$OUT/x", PROJECT, HOME, TMP)).toBeUndefined();
    expect(normalizeWritePath("C:/gather/*.png", PROJECT, HOME, TMP)).toBeUndefined();
  });

  it("环境变量里的允许目录解析失败或为空时不检查", () => {
    expect(parseWriteRoots(undefined)).toEqual([]);
    expect(parseWriteRoots("not json")).toEqual([]);
    expect(parseWriteRoots(JSON.stringify(["D:/a", 3, ""]))).toEqual(["D:/a"]);
    expect(
      checkWrite(
        { toolName: "Write", toolInput: { file_path: "C:/x" }, cwd: PROJECT },
        [],
        HOME,
        TMP,
      ),
    ).toBeUndefined();
  });
});

describe("写文件工具", () => {
  it("项目里、临时目录、计划目录放行", () => {
    expect(write(`${PROJECT}\\code\\a.cs`)).toBeUndefined();
    expect(write("unity/Packages/com.snowpeak.ocean/a.hlsl")).toBeUndefined();
    expect(write(`${TMP}\\x.txt`)).toBeUndefined();
    expect(write(`${HOME}\\.claude\\plans\\p.md`)).toBeUndefined();
  });

  it("项目外拒绝，原因里写出路径和怎么办", () => {
    const reason = write("D:\\WorkWork\\Assist\\snowpeak-ocean\\Shaders\\OceanStylized.hlsl");
    expect(reason).toContain("snowpeak-ocean");
    expect(reason).toContain("ffpane_report");
    expect(write("D:\\WorkWork\\gamedesign\\project_placeholder.txt")).toBeDefined();
    expect(write("../项目2--海上生存-备份/a.txt")).toBeDefined();
    // 前缀相同但不是子目录。
    expect(write(`${PROJECT}-old\\a.txt`)).toBeDefined();
  });

  it("Edit、NotebookEdit 同样检查；别的工具不管", () => {
    const outside = { file_path: "C:/Users/admin/edh/ed.py" };
    expect(
      checkWrite({ toolName: "Edit", toolInput: outside, cwd: PROJECT }, ROOTS, HOME, TMP),
    ).toBeDefined();
    expect(
      checkWrite(
        { toolName: "NotebookEdit", toolInput: { notebook_path: "C:/n.ipynb" }, cwd: PROJECT },
        ROOTS,
        HOME,
        TMP,
      ),
    ).toBeDefined();
    expect(
      checkWrite({ toolName: "Read", toolInput: outside, cwd: PROJECT }, ROOTS, HOME, TMP),
    ).toBeUndefined();
  });
});

describe("命令", () => {
  it("现场那几种写到项目外的写法都拦", () => {
    expect(shell("mkdir -p /c/gather/M_ENV_51_GatherPatch_StoneOre/preview")).toBeDefined();
    expect(shell('cp out.png "/c/M_ITM_01_StoneAxe/preview/old_1.png"')).toBeDefined();
    expect(shell("python gen.py > ~/edh/run2.py")).toBeDefined();
    expect(
      shell("mkdir -p /d/WorkWork/_jobs/shipdeck-1 && cd /d/WorkWork/_jobs/shipdeck-1"),
    ).toBeDefined();
  });

  it("cd 到项目外再用相对路径写，也拦", () => {
    expect(shell("cd /c && mkdir gather")).toBeDefined();
    expect(shell("cd qa && mkdir shots")).toBeUndefined();
  });

  it("只读项目外、写项目里：放行（调用别处的 blender.exe、从外面拷进来）", () => {
    expect(
      shell(
        '"D:/WorkWork/Assist/3D--test--youtube/.local/tools/blender-5.2.0-windows-x64/blender.exe" -b --python lib/bake.py > logs/bake.log 2>&1',
      ),
    ).toBeUndefined();
    expect(shell("cp D:/WorkWork/素材/a.png art/a.png")).toBeUndefined();
    expect(shell("cat C:/Users/admin/.codex/config.toml | grep model")).toBeUndefined();
  });

  it("丢掉输出、2>&1、临时目录都放行", () => {
    expect(shell("python x.py > /dev/null 2>&1")).toBeUndefined();
    expect(shell("dir > NUL", "PowerShell")).toBeUndefined();
    expect(shell("python x.py > /tmp/out.txt")).toBeUndefined();
    expect(shell("python x.py 2>> logs/err.txt")).toBeUndefined();
  });

  it("heredoc 正文不当命令看", () => {
    const command = [
      "cat > tools/gen.py <<'EOF'",
      "import shutil",
      'shutil.copy("a", "b") if a > b else None',
      "rm -rf /c/gather",
      "EOF",
      "python tools/gen.py",
    ].join("\n");
    expect(shell(command)).toBeUndefined();
    expect(shell("cat > /c/x.py <<'EOF'\nprint(1)\nEOF")).toBeDefined();
  });

  it("PowerShell 常见写法", () => {
    expect(shell("Set-Content -Path C:\\gather\\a.txt -Value hi", "PowerShell")).toBeDefined();
    expect(
      shell("New-Item -ItemType Directory -Path D:\\WorkWork\\_jobs", "PowerShell"),
    ).toBeDefined();
    expect(
      shell("Copy-Item art\\a.png -Destination C:\\Users\\admin\\Desktop", "PowerShell"),
    ).toBeDefined();
    expect(shell("Remove-Item -Recurse -Force C:\\gather", "PowerShell")).toBeDefined();
    expect(shell("Set-Content -Path qa\\a.txt -Value 'x > C:\\y'", "PowerShell")).toBeUndefined();
    expect(
      shell("Get-Content C:\\Windows\\win.ini | Out-File qa\\copy.txt", "PowerShell"),
    ).toBeUndefined();
    expect(shell("python x.py | Tee-Object -FilePath C:\\log.txt", "PowerShell")).toBeDefined();
  });

  it("引号里的 > 不是重定向", () => {
    expect(shell("python -c \"print('a > C:/x')\"")).toBeUndefined();
  });

  it("shellWriteTargets 给出原样路径和归一后的路径", () => {
    expect(shellWriteTargets("echo hi > ~/a.txt", PROJECT, HOME, TMP)).toEqual([
      { raw: "~/a.txt", path: "c:/users/admin/a.txt" },
    ]);
  });
});

it("拒绝输出是 Claude PreToolUse 的格式", () => {
  expect(JSON.parse(denyHookOutput("不行"))).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "不行",
    },
  });
});
