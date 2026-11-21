/**
 * Launch VS Code with ForgePilot loaded and run test/vscode/suite.ts inside it.
 * Uses an isolated, throw-away profile; requires a TrueForge server (see
 * test/e2e/README.md). Set VSCODE_PATH to use a specific VS Code binary.
 */
import * as path from "path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { runTests } from "@vscode/test-electron";

const CALC = `def add(a, b):
    return a + b


def sub(a, b):
    return a - b
`;

async function main() {
  const root = path.resolve(__dirname, "../..");
  const ws = mkdtempSync(path.join(tmpdir(), "forgepilot-vscode-ws-"));
  mkdirSync(path.join(ws, "pkg"));
  mkdirSync(path.join(ws, ".vscode"));
  writeFileSync(path.join(ws, "pkg/__init__.py"), "");
  writeFileSync(path.join(ws, "pkg/calc.py"), CALC);
  writeFileSync(
    path.join(ws, ".vscode/settings.json"),
    JSON.stringify(
      {
        "forgepilot.serverUrl": process.env.TRUEFORGE_URL || "http://localhost:8790",
        "forgepilot.retry.baseDelayMs": 50,
        "diffEditor.codeLens": true,
        "security.workspace.trust.enabled": false,
        "git.enabled": false,
      },
      null,
      2,
    ),
  );
  execSync("git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init", { cwd: ws });

  const profile = mkdtempSync(path.join(tmpdir(), "forgepilot-vscode-profile-"));
  const candidates = [
    process.env.VSCODE_PATH,
    "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
    "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
  ].filter(Boolean) as string[];
  const vscodeExecutablePath = candidates.find((p) => existsSync(p));
  await runTests({
    vscodeExecutablePath, // undefined -> @vscode/test-electron downloads a stable build
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, "out/vscode-test/suite.js"),
    launchArgs: [
      ws,
      "--disable-extensions",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-workspace-trust",
      "--user-data-dir",
      path.join(profile, "user"),
      "--extensions-dir",
      path.join(profile, "ext"),
    ],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
