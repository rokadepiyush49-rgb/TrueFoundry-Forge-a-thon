import { promises as fsp } from "fs";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { FilePort } from "./diff/journal";
import { CommandResult } from "../mcp/tools";

/** Plain Node file access (used by tests and as the fallback outside VS Code). */
export class NodeFilePort implements FilePort {
  async read(p: string): Promise<string | null> {
    try {
      return await fsp.readFile(p, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async write(p: string, content: string): Promise<void> {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    // write to a temp file and rename: a crash mid-write cannot leave a half-written file
    const tmp = `${p}.forgepilot-${process.pid}-${Date.now()}.tmp`;
    await fsp.writeFile(tmp, content, "utf8");
    await fsp.rename(tmp, p);
  }
  async remove(p: string): Promise<void> {
    await fsp.rm(p, { force: true });
  }
}

/**
 * Runs terminal commands for the agent and kills them (with their whole
 * process group) on cancellation, because TrueForge waits for running MCP
 * tool calls to finish before a cancel completes.
 */
export class CommandRunner {
  private running = new Set<ChildProcess>();

  constructor(private cwd: string) {}

  run(command: string, timeoutMs: number): Promise<CommandResult> {
    const t0 = Date.now();
    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd: this.cwd,
        shell: process.env.SHELL || true,
        detached: process.platform !== "win32",
        env: { ...process.env, PYTHONUNBUFFERED: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      });
      this.running.add(child);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let killed = false;
      child.stdout?.on("data", (d) => (stdout += d));
      child.stderr?.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => {
        timedOut = true;
        this.kill(child);
      }, timeoutMs);
      (child as ChildProcess & { __markKilled?: () => void }).__markKilled = () => (killed = true);
      child.on("close", (code) => {
        clearTimeout(timer);
        this.running.delete(child);
        resolve({ code, stdout, stderr, timedOut, killed, ms: Date.now() - t0 });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        this.running.delete(child);
        resolve({ code: null, stdout, stderr: stderr + String(e), timedOut, killed, ms: Date.now() - t0 });
      });
    });
  }

  private kill(child: ChildProcess): void {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }

  killAll(): number {
    const n = this.running.size;
    for (const c of this.running) {
      (c as ChildProcess & { __markKilled?: () => void }).__markKilled?.();
      this.kill(c);
    }
    return n;
  }
}
