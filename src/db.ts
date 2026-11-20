import pg from "pg";

export type ServerRow = {
  name: string;
  type: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url?: string | null;
  oauth?: OAuthState | null;
  enabled: boolean;
  pid?: number | null;
  pid_start?: string | null;
};

/** Persisted OAuth client/token state for a "http" server, so a restart doesn't force re-login. */
export type OAuthState = {
  clientInformation?: unknown;
  tokens?: unknown;
  codeVerifier?: string;
};

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://mcp:mcp@127.0.0.1:5440/mcp",
});

export const init = async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS servers(
    name text PRIMARY KEY, command text NOT NULL,
    args jsonb NOT NULL DEFAULT '[]', env jsonb NOT NULL DEFAULT '{}',
    enabled boolean NOT NULL DEFAULT true)`);
  // pid/pid_start record the live process group so a restarted app can kill what it left behind.
  await pool.query("ALTER TABLE servers ADD COLUMN IF NOT EXISTS pid int, ADD COLUMN IF NOT EXISTS pid_start text");
  // "http" servers (remote, OAuth) have no process: url is their endpoint, oauth persists login across restarts.
  await pool.query(
    "ALTER TABLE servers ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'stdio', ADD COLUMN IF NOT EXISTS url text, ADD COLUMN IF NOT EXISTS oauth jsonb",
  );
};

export const setPid = (name: string, pid: number | null, start: string | null) =>
  pool.query("UPDATE servers SET pid=$2, pid_start=$3 WHERE name=$1", [name, pid, start]);

export const setOAuth = (name: string, oauth: OAuthState) =>
  pool.query("UPDATE servers SET oauth=$2 WHERE name=$1", [name, JSON.stringify(oauth)]);

export const list = async (): Promise<ServerRow[]> =>
  (await pool.query("SELECT * FROM servers ORDER BY name")).rows;

export const get = async (name: string): Promise<ServerRow | undefined> =>
  (await pool.query("SELECT * FROM servers WHERE name=$1", [name])).rows[0];

export const upsert = (s: ServerRow) =>
  pool.query(
    `INSERT INTO servers(name,type,command,args,env,url,enabled) VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(name) DO UPDATE SET type=$2,command=$3,args=$4,env=$5,url=$6,enabled=$7`,
    [s.name, s.type, s.command, JSON.stringify(s.args), JSON.stringify(s.env), s.url ?? null, s.enabled],
  );

export const remove = (name: string) => pool.query("DELETE FROM servers WHERE name=$1", [name]);
