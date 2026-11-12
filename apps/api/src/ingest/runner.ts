import { setTimeout as delay } from "node:timers/promises";

type IngestResource = {
  tick: () => Promise<void>;
  close: () => Promise<void>;
};

type Signals = Pick<NodeJS.Process, "on" | "off">;

export async function runIngest({
  open,
  signals = process,
  wait = (ms, signal) => delay(ms, undefined, { signal }),
  reportError = (message) => console.error(message),
}: {
  open: () => IngestResource;
  signals?: Signals;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  reportError?: (message: string) => void;
}): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();

  signals.on("SIGINT", stop);
  signals.on("SIGTERM", stop);

  let resource: IngestResource | undefined;
  let exitCode = 0;

  try {
    resource = open();

    while (!controller.signal.aborted) {
      try {
        await wait(1000, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      }

      if (controller.signal.aborted) {
        break;
      }

      // A tick settles (including rollback) before another wait or pool cleanup.
      await resource.tick();
    }
  } catch {
    reportError("Ingest failed.");
    exitCode = 1;
  } finally {
    try {
      await resource?.close();
    } catch {
      reportError("Ingest database shutdown failed.");
      exitCode = 1;
    } finally {
      signals.off("SIGINT", stop);
      signals.off("SIGTERM", stop);
    }
  }

  return exitCode;
}
