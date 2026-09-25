/**
 * Talking to envx: one interface, so the process client and a stub swap freely.
 *
 * `envx api` reads JSON lines on stdin and writes one JSON line per request,
 * in order, then exits. Each run is a JVM start (about 0.5-1 s), so requests
 * are batched into one run. The process runs at below-normal priority: this
 * PC also runs the Minecraft server.
 *
 * Anything that does not match the contract -- a line that is not JSON, a
 * wrong `api`, an id that does not echo, a missing result -- is reported as a
 * mismatch and that answer is dropped. It is never repaired here.
 */

import { spawn } from 'node:child_process';
import * as os from 'node:os';

import { ENVX_API_VERSION, type EnvxRequest, type EnvxResponse, type EnvxVersion } from './contract.ts';

export interface EnvxBatchResult {
  /** One per request, in order; undefined where the answer was missing or broken. */
  responses: Array<EnvxResponse | undefined>;
  /** Where envx's output did not match the contract. */
  mismatches: string[];
}

export interface EnvxClient {
  version(): Promise<EnvxVersion | undefined>;
  batch(requests: readonly EnvxRequest[]): Promise<EnvxBatchResult>;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `<command> <args...>` for each call: `envx` (or `envx.bat`) normally;
 * tests point it at a stub script. `.bat`/`.cmd` launchers go through cmd.exe,
 * which Node requires for them on Windows.
 */
export class ProcessEnvxClient implements EnvxClient {
  readonly #command: string;
  readonly #prefix: readonly string[];
  readonly #timeoutMs: number;

  constructor(command: string, options: { prefixArgs?: readonly string[]; timeoutMs?: number } = {}) {
    this.#command = command;
    this.#prefix = options.prefixArgs ?? [];
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  async version(): Promise<EnvxVersion | undefined> {
    const run = await this.#run(['api', '--version'], '');
    if (run.code !== 0) return undefined;
    try {
      const parsed = JSON.parse(run.stdout.trim()) as EnvxVersion;
      return typeof parsed.api === 'number' && typeof parsed.envx === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async batch(requests: readonly EnvxRequest[]): Promise<EnvxBatchResult> {
    if (requests.length === 0) return { responses: [], mismatches: [] };
    const run = await this.#run(['api'], requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return readResponses(requests, run.stdout, run.code === 0 ? undefined : `envx api exited with ${run.code}: ${run.stderr.trim().slice(0, 300)}`);
  }

  #run(args: readonly string[], input: string): Promise<RunResult> {
    const all = [...this.#prefix, ...args];
    const viaCmd = process.platform === 'win32' && /\.(bat|cmd)$/i.test(this.#command);
    const child = viaCmd
      ? spawn('cmd.exe', ['/d', '/s', '/c', `""${this.#command}" ${all.join(' ')}"`], { windowsVerbatimArguments: true, windowsHide: true })
      : spawn(this.#command, all, { windowsHide: true });
    try {
      if (child.pid !== undefined) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // Not allowed on this system: it still runs, just at normal priority.
    }
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill(), this.#timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: error.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    });
  }
}

/** Pair each request with its answer line, checking every line against the contract. */
export function readResponses(requests: readonly EnvxRequest[], stdout: string, failure?: string): EnvxBatchResult {
  const mismatches: string[] = failure === undefined ? [] : [failure];
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (failure === undefined && lines.length !== requests.length) {
    mismatches.push(`expected ${requests.length} answer line(s), got ${lines.length}`);
  }
  const responses = requests.map((request, index): EnvxResponse | undefined => {
    const line = lines[index];
    if (line === undefined) return undefined;
    let parsed: EnvxResponse;
    try {
      parsed = JSON.parse(line) as EnvxResponse;
    } catch {
      mismatches.push(`answer ${index + 1} is not JSON: ${line.slice(0, 120)}`);
      return undefined;
    }
    if (parsed.api !== ENVX_API_VERSION) {
      mismatches.push(`answer ${index + 1} has api ${String(parsed.api)}, expected ${ENVX_API_VERSION}`);
      return undefined;
    }
    if (parsed.id !== request.id) {
      mismatches.push(`answer ${index + 1} echoes id ${JSON.stringify(parsed.id)}, expected ${JSON.stringify(request.id)}`);
      return undefined;
    }
    if (parsed.ok === true && (parsed.result === undefined || parsed.result === null)) {
      mismatches.push(`answer ${index + 1} (${request.op}) is ok but has no result`);
      return undefined;
    }
    if (parsed.ok === false && (parsed.error === undefined || typeof parsed.error.code !== 'string')) {
      mismatches.push(`answer ${index + 1} (${request.op}) failed without an error code`);
      return undefined;
    }
    return parsed;
  });
  return { responses, mismatches };
}
