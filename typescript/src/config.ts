// Configuration comes from the environment only:
//   PORT        listen port (default 8080)
//   DB_PATH     SQLite file (default ./flags.db)
//   ADMIN_KEY   key for the admin API (required)
//   CLIENT_KEY  key for evaluate and events (required)

export interface Config {
  port: number;
  dbPath: string;
  adminKey: string;
  clientKey: string;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const port = env["PORT"] === undefined || env["PORT"] === "" ? 8080 : Number(env["PORT"]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT must be an integer from 1 to 65535, got ${JSON.stringify(env["PORT"])}`);
  const adminKey = env["ADMIN_KEY"] ?? "";
  const clientKey = env["CLIENT_KEY"] ?? "";
  if (adminKey === "" || clientKey === "") throw new Error("ADMIN_KEY and CLIENT_KEY must both be set");
  const dbPath = env["DB_PATH"] === undefined || env["DB_PATH"] === "" ? "./flags.db" : env["DB_PATH"];
  return { port, dbPath, adminKey, clientKey };
}
