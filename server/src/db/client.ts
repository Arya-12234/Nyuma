import pg from "pg";

export function createClient(databaseUrl: string): pg.Client {
  return new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3000,
  });
}

export async function connectClient(databaseUrl: string): Promise<pg.Client> {
  const client = createClient(databaseUrl);
  await client.connect();
  await client.query("SET statement_timeout = '15s'");
  return client;
}
