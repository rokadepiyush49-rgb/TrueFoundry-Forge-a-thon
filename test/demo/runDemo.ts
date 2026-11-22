/**
 * Record the demo: launches VS Code (isolated profile) on a pristine Flask
 * checkout with ForgePilot loaded and runs test/demo/demoSuite.ts.
 *
 *   FLASK_DIR=../flask-3.1.3 DEMO_VENV=../venv-flask \
 *   DEMO_MODELS_A=groq/gpt-oss-120b DEMO_MODELS_B=anthropic/claude-haiku-5-5 \
 *   DEMO_MODELS_C=broken/unreachable,groq/gpt-oss-120b \
 *   node out/demo/runDemo.js
 */
import * as path from "path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { runTests } from "@vscode/test-electron";

async function main() {
  const root = path.resolve(__dirname, "../..");
  const flask = path.resolve(process.env.FLASK_DIR || path.join(root, "../flask-3.1.3"));
  const venv = path.resolve(process.env.DEMO_VENV || path.join(root, "../venv-flask"));
  const profile = mkdtempSync(path.join(tmpdir(), "forgepilot-demo-profile-"));
  mkdirSync(path.join(profile, "user/User"), { recursive: true });
  writeFileSync(
    path.join(profile, "user/User/settings.json"),
    JSON.stringify(
      {
        "workbench.colorTheme": "Default Dark Modern",
        "window.zoomLevel": 1,
        "editor.fontSize": 14,
        "terminal.integrated.fontSize": 13,
        "editor.minimap.enabled": false,
        "workbench.startupEditor": "none",
        "workbench.tips.enabled": false,
        "window.nativeFullScreen": true,
        "window.restoreWindows": "none",
        "security.workspace.trust.enabled": false,
        "diffEditor.codeLens": true,
        "diffEditor.renderSideBySide": true,
        "chat.disableAIFeatures": true,
        "workbench.secondarySideBar.defaultVisibility": "hidden",
        "git.enabled": false,
        "telemetry.telemetryLevel": "off",
        "update.mode": "none",
        "extensions.ignoreRecommendations": true,
        "forgepilot.serverUrl": process.env.TRUEFORGE_URL || "http://localhost:8790",
      },
      null,
      2,
    ),
  );
  const sampleDir = mkdtempSync(path.join(tmpdir(), "flask-config-demo-"));
  const sampleApp = path.join(sampleDir, "app.py");
  writeFileSync(
    sampleApp,
    'from flask import Flask\n\napp = Flask(__name__)\napp.config.update(\n    SECRET_KEY="dev-secret",\n    DATABASE_PASSWORD="hunter2",\n    API_TOKEN="abc123",\n    STRIPE_KEY="sk_test_42",\n    GREETING="hello",\n)\n',
  );
  const vscodeExecutablePath = [process.env.VSCODE_PATH, "/Applications/Visual Studio Code.app/Contents/MacOS/Code"].find((p) => p && existsSync(p));
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, "out/demo/demoSuite.js"),
    extensionTestsEnv: {
      DEMO_VENV: venv,
      DEMO_SAMPLE_APP: sampleApp,
      DEMO_VIDEO: process.env.DEMO_VIDEO || path.join(root, "../forgepilot-demo.mp4"),
      DEMO_MODELS_A: process.env.DEMO_MODELS_A || "",
      DEMO_MODELS_B: process.env.DEMO_MODELS_B || "",
      DEMO_MODELS_C: process.env.DEMO_MODELS_C || "",
      DEMO_RECORD: process.env.DEMO_RECORD || "1",
      DEMO_TASK_B_TIMEOUT_S: process.env.DEMO_TASK_B_TIMEOUT_S || "600",
    },
    launchArgs: [flask, "--disable-extensions", "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust", "--user-data-dir", path.join(profile, "user"), "--extensions-dir", path.join(profile, "ext")],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
