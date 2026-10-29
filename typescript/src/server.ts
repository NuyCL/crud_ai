// Runs the feature flag service. See config.ts for the environment variables.
import { loadConfig } from "./config.js";
import { buildApp } from "./handler/handler.js";
import { SqliteRepository } from "./repository/sqlite.js";
import { Service } from "./service/service.js";

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const repo = new SqliteRepository(cfg.dbPath);
  const app = buildApp(new Service(repo), { adminKey: cfg.adminKey, clientKey: cfg.clientKey });

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`${new Date().toISOString()} ${signal}: shutting down`);
    try {
      await app.close(); // stops accepting connections and lets in-flight requests finish
      repo.close();
      process.exit(0);
    } catch (error) {
      console.error("error while shutting down:", error);
      process.exit(1);
    }
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  console.log(`${new Date().toISOString()} listening on :${cfg.port} (database ${cfg.dbPath})`);
}

main().catch((error: unknown) => {
  console.error("error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
