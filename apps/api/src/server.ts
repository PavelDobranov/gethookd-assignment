import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
const app = createApp({ db: database.db, jwtSecret: config.jwtSecret });

const server = app.listen(3000, "0.0.0.0", () => {
  console.log("API listening on port 3000");
});

function shutdown() {
  server.close(() => {
    database.close().catch(() => {
      console.error("Database shutdown failed.");
      process.exitCode = 1;
    });
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
