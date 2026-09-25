/**
 * The console transport: the one piece of code that sends anything to the
 * live Minecraft server.
 *
 * Everything else in the harvest path is a pure decision, a parser, or a
 * file copy. This is where a command actually lands in the server console,
 * so it is deliberately small and deliberately narrow:
 *
 *   - It sends only `AllowedCommand` values. The type system enforces that
 *     at compile time and `isAllowedCommand` enforces it again at runtime,
 *     because a transport that trusts its caller is one refactor away from
 *     sending anything.
 *   - Every value that reaches the remote shell -- the tmux target, the
 *     server directory, a filename -- is checked against a strict pattern
 *     first. Nothing is escaped into safety; unsafe input is refused.
 *   - Scripts go to the remote shell on STDIN (`sh -s`), never as a
 *     command-line argument. Windows argument quoting is a well-known source
 *     of mangled commands, and stdin sidesteps it entirely.
 *   - No local shell is ever involved: `ssh` is spawned directly.
 *
 * ## How a command's output is read
 *
 * spark's replies go to the server log. The script notes the log's length,
 * types the command into the tmux pane, waits, and prints only the lines
 * added since. Reading over SSH rather than through the SMB share matters:
 * the share caches file attributes and was observed returning a stale log for
 * several seconds, which would make a successful command look like it had
 * produced nothing.
 *
 * If the log rotated in between (midnight), it is shorter than before, and
 * the whole new file is read instead of an empty tail.
 *
 * ## Sharing the console
 *
 * The console is also used by people and by other automation (the hourly
 * backup types save-off / save-all / save-on into the same pane). Typing
 * blindly could append our command to something half-typed -- "kick Steve "
 * plus our command is a kick -- or split someone else's command in two. So
 * in the same remote step, immediately before typing, the script checks and
 * holds off (reporting why) when:
 *   - world saving is off according to the log, i.e. a backup is mid-way
 *     (held off for at most 20 minutes, in case it was switched off by hand);
 *   - the pane is scrolled back (tmux copy mode would swallow the keys);
 *   - there is unsent text on the input line -- it is left untouched, never
 *     cleared;
 *   - someone attached typed in the last 30 seconds.
 * The command and its Enter then go in ONE tmux invocation, so nothing else
 * can land between them.
 */

import { spawn } from 'node:child_process';

import { isAllowedCommand, type AllowedCommand } from './harvest.ts';

export interface ConsoleResult {
  ok: boolean;
  /** Nothing was sent because the console was in use; says by what. */
  busy?: string;
  /** Log lines produced after the command was sent. */
  lines: string[];
  /** Why it failed, when it did. */
  error?: string;
}

export interface RemoteFileState {
  exists: boolean;
  size?: number;
  mtime?: number;
  sha256?: string;
}

/**
 * Anything that can run an allowlisted command and inspect a server file.
 *
 * An interface rather than a class so the harvest flow can be exercised end
 * to end in tests without a server -- which matters, because the failure
 * paths (a stale log, a file still being written, a hash mismatch) are
 * exactly the ones that cannot safely be produced on production.
 */
export interface ConsoleTransport {
  run(command: AllowedCommand, settleMs: number): Promise<ConsoleResult>;
  /** Size, mtime and hash of a file in the server's spark directory. */
  inspectSparkFile(fileName: string, stabilityWaitMs: number): Promise<{ first: RemoteFileState; second: RemoteFileState }>;
  /** The server directory on the remote side, detected from the running pane. */
  serverDir(): Promise<string | undefined>;
}

/** Strict shapes for anything that reaches the remote shell. */
const SAFE_HOST = /^[A-Za-z0-9_.@-]{1,253}$/;
const SAFE_TMUX = /^[A-Za-z0-9_.:-]{1,64}$/;
const SAFE_DIR = /^\/[A-Za-z0-9_./-]{1,512}$/;
const SAFE_FILE = /^profile-\d{4}-\d{2}-\d{2}_\d{2}\.\d{2}\.\d{2}\.sparkprofile$/;

export class ConsoleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleInputError';
  }
}

export function assertSafe(kind: 'host' | 'tmux' | 'dir' | 'file', value: string): void {
  const pattern = { host: SAFE_HOST, tmux: SAFE_TMUX, dir: SAFE_DIR, file: SAFE_FILE }[kind];
  if (!pattern.test(value) || value.includes('..')) {
    throw new ConsoleInputError(`refusing unsafe ${kind} value ${JSON.stringify(value)}`);
  }
}

/** Build the remote script that sends one command and prints its output. */
export function commandScript(command: AllowedCommand, tmuxTarget: string, serverDir: string, settleMs: number): string {
  if (!isAllowedCommand(command)) throw new ConsoleInputError(`not an allowed command: ${command}`);
  assertSafe('tmux', tmuxTarget);
  assertSafe('dir', serverDir);
  const seconds = Math.max(1, Math.min(30, Math.round(settleMs / 1000)));

  return [
    'set -u',
    `LOG='${serverDir}/logs/latest.log'`,
    'if [ ! -f "$LOG" ]; then echo "__PERFINT_NO_LOG__"; exit 3; fi',
    ...consoleFreeCheck(tmuxTarget),
    'BEFORE=$(wc -l < "$LOG")',
    // One tmux invocation for text and Enter: nothing can land in between.
    `tmux send-keys -t '${tmuxTarget}' -l '${command}' \\; send-keys -t '${tmuxTarget}' Enter || { echo "__PERFINT_TMUX_FAILED__"; exit 4; }`,
    `sleep ${seconds}`,
    'AFTER=$(wc -l < "$LOG")',
    // Rotated during the wait: the new file is shorter, so read all of it.
    'if [ "$AFTER" -lt "$BEFORE" ]; then BEFORE=0; fi',
    'echo "__PERFINT_BEGIN__"',
    'tail -n +$((BEFORE + 1)) "$LOG"',
    'echo "__PERFINT_END__"',
  ].join('\n');
}

/**
 * Shell lines that stop the script with `__PERFINT_BUSY__ <why>` when the
 * console is in use (see "Sharing the console" above). Expects $LOG.
 */
export function consoleFreeCheck(tmuxTarget: string): string[] {
  assertSafe('tmux', tmuxTarget);
  const t = `'${tmuxTarget}'`;
  return [
    'busy() { echo "__PERFINT_BUSY__ $1"; exit 5; }',
    // World saving switched off and not yet back on: a backup is mid-way.
    `SAVE=$(grep -a -E 'Automatic saving is now (disabled|enabled)' "$LOG" | tail -n 1)`,
    // How long ago, from the line's [HH:MM:SS] (latest.log is one day). awk,
    // not shell arithmetic: the remote `sh` is dash, and "08" is not octal-safe.
    'case "$SAVE" in *disabled*)',
    `  AGE=$(printf '%s\\n' "$SAVE" | awk -v now="$(date +%H:%M:%S)" '/^\\[[0-9][0-9]:[0-9][0-9]:[0-9][0-9]\\]/ { split(substr($0, 2, 8), a, ":"); split(now, b, ":"); d = (b[1] * 3600 + b[2] * 60 + b[3]) - (a[1] * 3600 + a[2] * 60 + a[3]); if (d < 0) d += 86400; print d }')`,
    '  if [ -n "$AGE" ] && [ "$AGE" -lt 1200 ]; then busy "world saving is switched off, so a backup is probably running"; fi;;',
    'esac',
    `PANE=$(tmux display-message -p -t ${t} '#{pane_in_mode} #{cursor_x} #{cursor_y}') || { echo "__PERFINT_TMUX_FAILED__"; exit 4; }`,
    'set -- $PANE',
    'if [ "$1" != "0" ]; then busy "the console is scrolled back (tmux copy mode)"; fi',
    'if [ "$2" -gt 0 ]; then',
    `  TYPED=$(tmux capture-pane -p -t ${t} -S "$3" -E "$3" | cut -c1-"$2" | tr -d '[:space:]')`,
    '  if [ -n "$TYPED" ]; then busy "there is unsent text on the console input line"; fi',
    'fi',
    `LAST=$(tmux list-clients -t ${t} -F '#{client_activity}' 2>/dev/null | sort -n | tail -n 1)`,
    'if [ -n "$LAST" ] && [ $(( $(date +%s) - LAST )) -lt 30 ]; then busy "someone typed in the console in the last 30 seconds"; fi',
  ];
}

/** Build the remote script that checks a file twice and hashes it. */
export function inspectScript(fileName: string, serverDir: string, stabilityWaitMs: number): string {
  assertSafe('file', fileName);
  assertSafe('dir', serverDir);
  const seconds = Math.max(5, Math.min(60, Math.round(stabilityWaitMs / 1000)));
  const file = `${serverDir}/config/spark/${fileName}`;
  return [
    `F='${file}'`,
    'if [ ! -f "$F" ]; then echo "MISSING"; exit 0; fi',
    'echo "A $(stat -c \'%s %Y\' "$F")"',
    `sleep ${seconds}`,
    'echo "B $(stat -c \'%s %Y\' "$F") $(sha256sum "$F" | cut -d\' \' -f1)"',
  ].join('\n');
}

/** Pull the lines between the markers, dropping the markers themselves. */
export function extractOutput(stdout: string): string[] | undefined {
  const lines = stdout.split(/\r?\n/);
  const begin = lines.indexOf('__PERFINT_BEGIN__');
  const end = lines.indexOf('__PERFINT_END__');
  if (begin === -1 || end === -1 || end < begin) return undefined;
  return lines.slice(begin + 1, end).filter((l) => l !== '');
}

export function parseInspect(stdout: string): { first: RemoteFileState; second: RemoteFileState } {
  if (stdout.trim().startsWith('MISSING')) {
    return { first: { exists: false }, second: { exists: false } };
  }
  const a = /^A (\d+) (\d+)$/m.exec(stdout);
  const b = /^B (\d+) (\d+) ([0-9a-f]{64})$/m.exec(stdout);
  const first: RemoteFileState = a === null ? { exists: false } : { exists: true, size: Number(a[1]), mtime: Number(a[2]) };
  const second: RemoteFileState =
    b === null
      ? { exists: false }
      : { exists: true, size: Number(b[1]), mtime: Number(b[2]), sha256: b[3]! };
  return { first, second };
}

export interface SshTmuxOptions {
  sshHost: string;
  tmuxTarget: string;
  /** Explicit server directory; when empty it is read from the tmux pane. */
  serverDir?: string;
  /** Absolute path to ssh; defaults to whatever is on PATH. */
  sshBinary?: string;
  timeoutMs?: number;
}

export class SshTmuxConsole implements ConsoleTransport {
  readonly #options: SshTmuxOptions;
  #detectedDir: string | undefined;

  constructor(options: SshTmuxOptions) {
    assertSafe('host', options.sshHost);
    assertSafe('tmux', options.tmuxTarget);
    if (options.serverDir !== undefined && options.serverDir !== '') assertSafe('dir', options.serverDir);
    this.#options = options;
  }

  /** Run a script on the server via `sh -s`, fed on stdin. */
  #ssh(script: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const timeoutMs = this.#options.timeoutMs ?? 60_000;
    return new Promise((resolve) => {
      const child = spawn(
        this.#options.sshBinary ?? 'ssh',
        ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', this.#options.sshHost, 'sh -s'],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: stderr + error.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.end(script + '\n');
    });
  }

  async serverDir(): Promise<string | undefined> {
    const configured = this.#options.serverDir;
    if (configured !== undefined && configured !== '') return configured;
    if (this.#detectedDir !== undefined) return this.#detectedDir;

    // The pane runs `cd <server dir> && exec ./start.sh`, so its current
    // path IS the server directory. Read it rather than assume it, so a
    // server that moves between rotations is followed automatically.
    const result = await this.#ssh(
      `tmux display-message -p -t '${this.#options.tmuxTarget}' '#{pane_current_path}'`,
    );
    const dir = result.stdout.trim().split(/\r?\n/)[0] ?? '';
    if (result.code !== 0 || !SAFE_DIR.test(dir)) return undefined;

    // Only trust it if it actually looks like a Minecraft server.
    const check = await this.#ssh(`[ -f '${dir}/logs/latest.log' ] && [ -d '${dir}/config' ] && echo OK`);
    if (!check.stdout.includes('OK')) return undefined;

    this.#detectedDir = dir;
    return dir;
  }

  async run(command: AllowedCommand, settleMs: number): Promise<ConsoleResult> {
    const dir = await this.serverDir();
    if (dir === undefined) {
      return { ok: false, lines: [], error: 'could not determine the server directory from the tmux pane' };
    }
    const result = await this.#ssh(commandScript(command, this.#options.tmuxTarget, dir, settleMs));
    if (result.stdout.includes('__PERFINT_NO_LOG__')) {
      return { ok: false, lines: [], error: `no latest.log under ${dir}/logs` };
    }
    const busy = /__PERFINT_BUSY__ (.*)/.exec(result.stdout);
    if (busy !== null) return { ok: false, busy: busy[1]!.trim(), lines: [], error: `console in use: ${busy[1]!.trim()}` };
    if (result.stdout.includes('__PERFINT_TMUX_FAILED__')) {
      return { ok: false, lines: [], error: `tmux could not reach session "${this.#options.tmuxTarget}"` };
    }
    const lines = extractOutput(result.stdout);
    if (lines === undefined) {
      return {
        ok: false,
        lines: [],
        error: `ssh returned ${result.code}: ${result.stderr.trim().slice(0, 300) || 'no output'}`,
      };
    }
    return { ok: true, lines };
  }

  async inspectSparkFile(fileName: string, stabilityWaitMs: number) {
    const dir = await this.serverDir();
    if (dir === undefined) return { first: { exists: false }, second: { exists: false } };
    const result = await this.#ssh(inspectScript(fileName, dir, stabilityWaitMs));
    return parseInspect(result.stdout);
  }
}
