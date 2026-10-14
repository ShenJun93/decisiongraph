import { FalkorDB } from "falkordb";

export function graphConfig(env = process.env) {
  const host = env.GRAPH_HOST || "127.0.0.1";
  const port = Number(env.GRAPH_PORT || 16379);
  const name = env.GRAPH_NAME || "gh2026_companybrain_owner";
  if (!/^[a-z0-9_]{1,48}$/.test(name)) throw new Error("Invalid graph name");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid graph port");
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error("Local-only graph host required");
  return {host, port, name};
}

export async function openGraph(env = process.env) {
  const config = graphConfig(env);
  const db = await FalkorDB.connect({
    host: config.host, port: config.port,
    socket: {host: config.host, port: config.port, connectTimeout: 3500}
  });
  return {
    graph: db.selectGraph(config.name),
    config,
    async close() { await db.close(); }
  };
}
