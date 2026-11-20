import pg from "pg";

export type ServerRow = {
  name: string;
  type: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url?: string | null;
  oauth?: OAuthState | null;
  // what this server is for ("Internal GitLab — MRs, pipelines, issues"), since the name alone
  // (e.g. "mcp123") tells a calling model nothing — shown in the gateway's session "instructions".
  description?: string | null;
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
  await pool.query("ALTER TABLE servers ADD COLUMN IF NOT EXISTS description text");
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
    `INSERT INTO servers(name,type,command,args,env,url,enabled,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(name) DO UPDATE SET type=$2,command=$3,args=$4,env=$5,url=$6,enabled=$7,description=$8`,
    [s.name, s.type, s.command, JSON.stringify(s.args), JSON.stringify(s.env), s.url ?? null, s.enabled, s.description ?? null],
  );

export const remove = (name: string) => pool.query("DELETE FROM servers WHERE name=$1", [name]);

/**
 * Ranks items against a query using Postgres full-text search (no table: the candidate list is
 * passed in and ranked ad-hoc). Terms are OR'd and ranked by match quality, instead of the old
 * AND-substring match that returned nothing when a query term didn't appear verbatim.
 * Returns matching names in rank order (unlimited) — the caller decides how many to keep.
 */
export const rankTools = async (query: string, items: { name: string; text: string }[]): Promise<string[]> => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean).map((t) => t.replace(/'/g, "''"));
  if (!terms.length) return items.map((i) => i.name);
  const tsq = terms.join(" | ");
  const { rows } = await pool.query(
    // "hits" (how many distinct query terms matched) ranks an all-terms match above a document that
    // just repeats one term a lot (plain ts_rank alone did that: OR'd terms rank by frequency, so a
    // doc mentioning "issue" five times outranked one that actually matches "gitlab" + "issue" once each).
    `WITH terms AS (SELECT unnest($2::text[]) AS term)
     SELECT t.name,
       (SELECT count(*) FROM terms WHERE to_tsvector('english', t.text) @@ to_tsquery('english', terms.term)) AS hits,
       ts_rank(to_tsvector('english', t.text), to_tsquery('english', $3)) AS rank
     FROM jsonb_to_recordset($1::jsonb) AS t(name text, text text)
     WHERE to_tsvector('english', t.text) @@ to_tsquery('english', $3)
     ORDER BY hits DESC, rank DESC`,
    [JSON.stringify(items), terms, tsq],
  );
  return rows.map((r) => r.name);
};
