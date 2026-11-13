import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import worker from './game-worker.mjs';

const origin = new URL(process.env.PUBLIC_ORIGIN ?? process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:4180').origin;
const pepper = process.env.PIN_PEPPER;
if (!pepper || pepper.length < 32) throw new Error('PIN_PEPPER must be a persistent secret of at least 32 characters');
const path = process.env.DB_PATH ?? './data/game.sqlite';
mkdirSync(dirname(path), { recursive: true });
const sql = new DatabaseSync(path);
sql.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS standalone_migrations (name TEXT PRIMARY KEY)');
const migrations = {"0000_rooms.sql": "CREATE TABLE rooms (\n  id TEXT PRIMARY KEY,\n  version INTEGER NOT NULL,\n  expires INTEGER NOT NULL,\n  state TEXT NOT NULL\n);\nCREATE INDEX rooms_expiration ON rooms(expires);\n", "0001_accounts.sql": "CREATE TABLE accounts (id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL, salt TEXT NOT NULL, pin_hash TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);\n--> statement-breakpoint\nCREATE TABLE sessions (token_hash TEXT PRIMARY KEY, actor TEXT NOT NULL, account_id TEXT, nickname TEXT NOT NULL, expires INTEGER NOT NULL);\n--> statement-breakpoint\nCREATE INDEX session_expiry ON sessions(expires);\n--> statement-breakpoint\nCREATE TABLE auth_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until_time INTEGER NOT NULL);\n--> statement-breakpoint\nCREATE TABLE points (room TEXT NOT NULL, round INTEGER NOT NULL, account_id TEXT NOT NULL, amount INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(room, round, account_id));\n--> statement-breakpoint\nCREATE INDEX points_account ON points(account_id);\n--> statement-breakpoint\nALTER TABLE rooms ADD COLUMN mode TEXT NOT NULL DEFAULT 'duel';\n--> statement-breakpoint\nALTER TABLE rooms ADD COLUMN queue INTEGER NOT NULL DEFAULT 0;\n--> statement-breakpoint\nCREATE INDEX rooms_queue ON rooms(mode,queue,expires);\n--> statement-breakpoint\n"};
function transaction(callback) {
  sql.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    sql.exec('COMMIT');
    return result;
  } catch (error) {
    sql.exec('ROLLBACK');
    throw error;
  }
}
for (const name of Object.keys(migrations)) {
  transaction(() => {
    if (sql.prepare('SELECT 1 FROM standalone_migrations WHERE name=?').get(name)) return;
    sql.exec(migrations[name]);
    sql.prepare('INSERT INTO standalone_migrations VALUES (?)').run(name);
  });
}
function prepare(query, args = []) {
  return {
    bind: (...values) => prepare(query, values),
    first: () => sql.prepare(query).get(...args),
    all: () => ({ results: sql.prepare(query).all(...args) }),
    run: () => ({ meta: { changes: Number(sql.prepare(query).run(...args).changes) } }),
  };
}
const env = {
  DB: { prepare, batch: statements => transaction(() => statements.map(statement => statement.run())) },
  PIN_PEPPER: pepper,
  OWNER_CLAIM_HASH: process.env.OWNER_CLAIM_HASH,
};
createServer(async (req, res) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const headers = new Headers(req.headers);
    // Only enable this when the service is isolated behind a proxy that overwrites X-Real-IP.
    const ip = process.env.TRUST_PROXY === '1' ? headers.get('x-real-ip') : req.socket.remoteAddress;
    headers.set('cf-connecting-ip', ip || 'unknown');
    const url = new URL(origin);
    const target = new URL(req.url, 'http://request.invalid');
    url.pathname = target.pathname;
    url.search = target.search;
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const response = await worker.fetch(new Request(url, { method: req.method, headers, body }), env);
    const outgoing = Object.fromEntries(response.headers);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) outgoing['set-cookie'] = cookies;
    res.writeHead(response.status, outgoing);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error.name);
    res.writeHead(500).end('Server error');
  }
}).listen(Number(process.env.PORT ?? 4180), process.env.HOST ?? '127.0.0.1');
