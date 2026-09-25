/**
 * Minecraft servers, each configured and monitored on its own.
 *
 * The hierarchy the interface uses, from the outside in:
 *
 *   server    One Minecraft server, as a person thinks of it ("Veyra Main",
 *             "Staging"). Its id is frozen; everything else about it --
 *             name, folder, host -- can change without touching history.
 *   machine   The hardware and OS it ran on (`environment`). A server that
 *             moves from a Windows PC to a VM is the same server on a new
 *             machine, and figures are never pooled across machines.
 *   world     Which world was loaded, by seed.
 *   season    One unbroken stretch of one world on one machine with one
 *             modpack. Every figure in the app belongs to exactly one.
 *
 * ## One switch per server
 *
 * `collection` is the only thing that decides whether a server is profiled:
 *
 *   off         Nothing is read or sent. History stays, and stays viewable.
 *   watch       Profiles you save yourself in its spark folder are imported.
 *               No console command is ever sent. Suits a staging server on
 *               this PC that you profile by hand.
 *   automatic   Hourly harvest over SSH + tmux, as for production.
 *
 * It replaced a global "automatic collection" switch rather than joining it:
 * two switches that both have to be on is a bug this project already had
 * once, when turning collection on silently did nothing.
 *
 * `visible` only affects the everyday views. A hidden server keeps its
 * history, keeps being monitored if its mode says so, and comes back with
 * one click.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type CollectionMode = 'off' | 'watch' | 'automatic';
export type ServerKind = 'production' | 'staging' | 'other';

export const COLLECTION_MODES: readonly CollectionMode[] = ['off', 'watch', 'automatic'];
export const SERVER_KINDS: readonly ServerKind[] = ['production', 'staging', 'other'];

export interface ServerConfig {
  id: string;
  slug: string;
  displayName: string;
  kind: ServerKind;
  /** Free text: where it runs, e.g. "Ubuntu VM 192.168.1.20" or "This PC". */
  machine: string;
  /** The server folder as seen from this computer, e.g. S:/ or D:\\staging\\mypack. */
  root: string;
  sparkDir: string;
  collection: CollectionMode;
  sshHost: string;
  tmuxTarget: string;
  mcHost: string;
  mcPort: number;
  visible: boolean;
  createdAt: number;
}

interface Row {
  id: string;
  slug: string;
  display_name: string;
  kind: string | null;
  machine: string | null;
  root: string | null;
  spark_dir: string | null;
  collection: string | null;
  ssh_host: string | null;
  tmux_target: string | null;
  mc_host: string | null;
  mc_port: number | null;
  visible: number | null;
  created_at: number;
}

function fromRow(r: Row): ServerConfig {
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    kind: (SERVER_KINDS as readonly string[]).includes(r.kind ?? '') ? (r.kind as ServerKind) : 'production',
    machine: r.machine ?? '',
    root: r.root ?? '',
    sparkDir: r.spark_dir ?? 'config/spark',
    collection: (COLLECTION_MODES as readonly string[]).includes(r.collection ?? '') ? (r.collection as CollectionMode) : 'off',
    sshHost: r.ssh_host ?? '',
    tmuxTarget: r.tmux_target ?? '',
    mcHost: r.mc_host ?? '',
    mcPort: r.mc_port ?? 25565,
    visible: r.visible !== 0,
    createdAt: r.created_at,
  };
}

export function listServers(db: DatabaseSync, options: { visibleOnly?: boolean } = {}): ServerConfig[] {
  const rows = db
    .prepare(`SELECT * FROM server ${options.visibleOnly === true ? 'WHERE visible != 0' : ''} ORDER BY created_at, id`)
    .all() as unknown as Row[];
  return rows.map(fromRow);
}

export function getServer(db: DatabaseSync, id: string): ServerConfig | undefined {
  const row = db.prepare('SELECT * FROM server WHERE id = ?').get(id) as unknown as Row | undefined;
  return row === undefined ? undefined : fromRow(row);
}

export type ServerPatch = Partial<Omit<ServerConfig, 'id' | 'createdAt' | 'slug'>>;

const SAFE_SSH = /^[A-Za-z0-9_.@-]{1,253}$/;
const SAFE_TMUX = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Everything wrong with a proposed configuration, in plain words. Empty when fine. */
export function validateServer(patch: ServerPatch, current?: ServerConfig): string[] {
  const next = { ...(current ?? {}), ...patch } as Partial<ServerConfig>;
  const errors: string[] = [];
  if (patch.displayName !== undefined && patch.displayName.trim() === '') errors.push('Give the server a name.');
  if (patch.kind !== undefined && !SERVER_KINDS.includes(patch.kind)) errors.push('Unknown server kind.');
  if (patch.collection !== undefined && !COLLECTION_MODES.includes(patch.collection)) errors.push('Unknown collection mode.');
  if (patch.mcPort !== undefined && (!Number.isInteger(patch.mcPort) || patch.mcPort < 1 || patch.mcPort > 65535)) {
    errors.push('The game port must be between 1 and 65535.');
  }
  if (patch.sshHost !== undefined && patch.sshHost !== '' && !SAFE_SSH.test(patch.sshHost)) {
    errors.push('The SSH host may only contain letters, digits, dots, dashes, underscores and @.');
  }
  if (patch.tmuxTarget !== undefined && patch.tmuxTarget !== '' && !SAFE_TMUX.test(patch.tmuxTarget)) {
    errors.push('The tmux session may only contain letters, digits, dots, dashes, underscores and colons.');
  }
  // What each mode needs before it can do anything.
  if (next.collection === 'watch' || next.collection === 'automatic') {
    if ((next.root ?? '').trim() === '') errors.push('Choose the server folder before turning collection on.');
  }
  if (next.collection === 'automatic') {
    if ((next.sshHost ?? '') === '' || (next.tmuxTarget ?? '') === '') {
      errors.push('Automatic collection needs the SSH host and tmux session that run the server console.');
    }
  }
  return errors;
}

function slugify(name: string, db: DatabaseSync): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'server';
  let slug = base;
  for (let n = 2; db.prepare('SELECT 1 FROM server WHERE slug = ?').get(slug) !== undefined; n += 1) slug = `${base}-${n}`;
  return slug;
}

export function createServer(db: DatabaseSync, input: ServerPatch & { displayName: string }): { id?: string; errors: string[] } {
  const errors = validateServer(input);
  if (errors.length > 0) return { errors };
  const id = randomUUID();
  db.prepare(
    `INSERT INTO server (id, slug, display_name, created_at, kind, machine, root, spark_dir, collection,
                         ssh_host, tmux_target, mc_host, mc_port, visible)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    slugify(input.displayName, db),
    input.displayName.trim(),
    Date.now(),
    input.kind ?? 'staging',
    input.machine ?? '',
    input.root ?? '',
    input.sparkDir ?? 'config/spark',
    input.collection ?? 'off',
    input.sshHost ?? '',
    input.tmuxTarget ?? '',
    input.mcHost ?? '',
    input.mcPort ?? 25565,
    input.visible === false ? 0 : 1,
  );
  return { id, errors: [] };
}

const COLUMN: Record<keyof ServerPatch, string> = {
  displayName: 'display_name',
  kind: 'kind',
  machine: 'machine',
  root: 'root',
  sparkDir: 'spark_dir',
  collection: 'collection',
  sshHost: 'ssh_host',
  tmuxTarget: 'tmux_target',
  mcHost: 'mc_host',
  mcPort: 'mc_port',
  visible: 'visible',
};

export function updateServer(db: DatabaseSync, id: string, patch: ServerPatch): { errors: string[] } {
  const current = getServer(db, id);
  if (current === undefined) return { errors: ['No such server.'] };
  const errors = validateServer(patch, current);
  if (errors.length > 0) return { errors };
  for (const [key, value] of Object.entries(patch) as Array<[keyof ServerPatch, unknown]>) {
    const column = COLUMN[key];
    if (column === undefined || value === undefined) continue;
    const stored = typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'string' ? value.trim() : value;
    db.prepare(`UPDATE server SET ${column} = ? WHERE id = ?`).run(stored as string | number, id);
  }
  return { errors: [] };
}

/** Servers whose collection mode asks for anything to happen. */
export function monitoredServers(db: DatabaseSync): ServerConfig[] {
  return listServers(db).filter((s) => s.collection !== 'off');
}

/**
 * The server the everyday views show when none has been chosen: the first
 * visible production server, else the first visible one, else any.
 */
export function defaultServerId(db: DatabaseSync): string | undefined {
  const visible = listServers(db, { visibleOnly: true });
  return (visible.find((s) => s.kind === 'production') ?? visible[0] ?? listServers(db)[0])?.id;
}
