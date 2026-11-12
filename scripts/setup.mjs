import { execFile, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export function runCommand(command, args, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      detached: process.platform !== "win32",
      stdio: "ignore", // Child diagnostics can contain SQL parameters or credentials.
    });

    let terminated = false;

    function terminate() {
      terminated = true;

      if (!child.pid) {
        return;
      }

      if (process.platform === "win32") {
        execFile(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          {
            timeout: 5000,
          },
          () => child.kill("SIGKILL"),
        );
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }

    const deadline = setTimeout(terminate, timeout);

    process.once("SIGINT", terminate);
    process.once("SIGTERM", terminate);

    function finish(code) {
      clearTimeout(deadline);

      process.removeListener("SIGINT", terminate);
      process.removeListener("SIGTERM", terminate);

      if (code === 0 && !terminated) {
        resolve();
      } else {
        reject(new Error("Command failed or timed out."));
      }
    }

    child.once("error", () => finish(null));
    child.once("close", finish);
  });
}

export async function runSetup(run = runCommand) {
  let stage = "database readiness";

  try {
    await run("docker", ["compose", "up", "--detach", "--wait", "--wait-timeout", "30", "--no-deps", "db"], 120000);

    stage = "database initialization";

    await run(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("../apps/api/src/db/initialize.ts", import.meta.url))],
      60000,
    );
  } catch {
    throw new Error(`Setup failed during ${stage}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.info("Waiting for PostgreSQL, then applying committed migrations and seed...");

    await runSetup();

    console.info("Setup completed. Run npm run dev to start API and web.");
  } catch (error) {
    console.error(error.message);
    console.error(
      "Check Docker availability, database configuration and committed migrations. Existing data is preserved.",
    );
    process.exitCode = 1;
  }
}
