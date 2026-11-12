import { loadConfig } from "../config.js";
import { createDatabase } from "../db/client.js";
import { runIngest } from "./runner.js";
import { runIngestTick } from "./tick.js";

process.exitCode = await runIngest({
  open: () => {
    const database = createDatabase(loadConfig().databaseUrl);
    return {
      tick: () => runIngestTick(database.db),
      close: database.close,
    };
  },
});
