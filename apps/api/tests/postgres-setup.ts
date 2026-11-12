import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

export default async function setup(project: TestProject) {
  const runId = randomUUID().replaceAll("-", "");
  const projectName = `gethookd-test-${runId}`;
  const composeFile = fileURLToPath(new URL("../../../compose.test.yaml", import.meta.url));
  const env = { ...process.env, GETHOOKD_TEST_RUN_ID: runId };
  const compose = ["compose", "--file", composeFile, "--project-name", projectName];

  function docker(stage: string, args: string[], timeout = 15000): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, {
        env,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let terminated = false;
      const failure = () =>
        new Error(
          `PostgreSQL tests: ${stage} failed for ${projectName}. Docker Engine and Compose are required; check daemon availability and test-owned resources.`,
        );
      function terminateTree() {
        terminated = true;
        if (!child.pid) return;
        if (process.platform === "win32") {
          execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 5000 }, () => child.kill("SIGKILL"));
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
      // Kill the CLI and Compose plugin together, then await pipe/process closure
      // before inspecting ownership or deleting any resources.
      const deadline = setTimeout(terminateTree, timeout);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.length > 1024 * 1024) terminateTree();
      });
      child.stderr.resume(); // Drain diagnostics without printing possible secrets.
      child.once("error", () => {
        clearTimeout(deadline);
        reject(failure());
      });
      child.once("close", (code) => {
        clearTimeout(deadline);
        if (code === 0 && !terminated) resolve(output.trim());
        else reject(failure());
      });
    });
  }

  async function cleanup() {
    // Read ownership evidence before deleting anything; never prune or target a
    // project supplied by the caller, developer environment, or database URL.
    for (const kind of ["container", "volume", "network"]) {
      const names = await docker("cleanup discovery", [
        kind,
        "ls",
        ...(kind === "container" ? ["--all"] : []),
        "--filter",
        `label=com.docker.compose.project=${projectName}`,
        "--format",
        kind === "volume" ? "{{.Name}}" : "{{.ID}}",
      ]);
      if (!names) continue;
      const resources = JSON.parse(
        await docker("cleanup ownership inspection", [kind, "inspect", ...names.split(/\s+/)]),
      );
      for (const resource of resources) {
        const labels = kind === "container" ? resource.Config.Labels : resource.Labels;
        if (labels?.["io.gethookd.test-run"] !== runId || labels?.["com.docker.compose.project"] !== projectName) {
          throw new Error(`PostgreSQL tests: refusing cleanup without ownership evidence for ${projectName}`);
        }
      }
    }
    await docker("cleanup", [...compose, "down", "--volumes", "--timeout", "5"], 30000);
    console.info(`[postgres] cleaned ${projectName}`);
  }

  await docker("prerequisite check", ["info", "--format", "{{.ServerVersion}}"]);
  console.info(`[postgres] provisioning ${projectName}`);
  try {
    await docker(
      "provisioning/readiness (30s health limit)",
      [...compose, "up", "--detach", "--wait", "--wait-timeout", "30"],
      120000,
    );
    const address = await docker("port discovery", [...compose, "port", "db", "5432"]);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(address);
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
      throw new Error("PostgreSQL tests: invalid loopback port mapping");
    }
    project.provide("postgresProject", projectName);
    project.provide(
      "postgresUrl",
      `postgresql://gethookd_test:public-disposable-test-password@127.0.0.1:${match[1]}/gethookd_test`,
    );
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "PostgreSQL test setup and cleanup failed");
    }
    throw error;
  }
  return cleanup;
}
