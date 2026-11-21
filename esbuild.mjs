import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
});
// VS Code integration test bundles (only with --tests)
if (process.argv.includes("--tests")) {
  await esbuild.build({
    entryPoints: { suite: "test/vscode/suite.ts", runTest: "test/vscode/runTest.ts" },
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outdir: "out/vscode-test",
    external: ["vscode", "@vscode/test-electron"],
    sourcemap: true,
    logLevel: "warning",
  });
}
if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
