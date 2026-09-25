// A stand-in for `envx api` (envx docs/api.md, version 1, as in envx 1.1.0).
// Canned answers shaped exactly like the contract's examples, so the client
// can be built and tested before envx 1.1 exists. Run: node envx-stub.mjs api [--version]
//
// Which canned owner answer a key gets depends on its class name, so tests can
// ask for each certainty: a class containing "Ambig" is ambiguous, "Unknown" is
// none, anything else probable. ENVX_STUB_MATCH=none makes `match` find nothing.
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args[0] !== 'api') {
  process.stderr.write('usage: envx api [--version]\n');
  process.exit(2);
}
if (args.includes('--version')) {
  process.stdout.write(JSON.stringify({ api: 1, envx: process.env.ENVX_STUB_VERSION ?? '1.1.0' }) + '\n');
  process.exit(0);
}

const SNAPSHOTS = [
  { id: 12, fingerprint: 'f'.repeat(64), modset: null, label: '4.1.0', kind: 'sync', taken_at: '2026-09-20T10:00:00Z', checked_at: '2026-09-25T10:00:00Z', current: true },
  { id: 9, fingerprint: 'e'.repeat(64), modset: null, label: '4.1.0', kind: 'sync', taken_at: '2026-09-10T10:00:00Z', checked_at: '2026-09-19T10:00:00Z', current: false },
];

const refOf = (idOrFingerprint) => {
  const s = SNAPSHOTS.find((x) => x.id === idOrFingerprint || x.fingerprint === idOrFingerprint) ?? SNAPSHOTS[0];
  return { id: s.id, env: 'myserver', fingerprint: s.fingerprint, modset: s.modset };
};

const modsetOf = (mods) => createHash('sha256').update(mods.map(([id, v]) => `${id}@${v}`).sort().join('\n')).digest('hex');

const MERGED = /^(handler|redirect|wrapOperation|wrapMethod|inject|localvar|modify[A-Za-z]*)\$[a-z0-9]+\$([A-Za-z0-9_.-]+?)\$(.+)$/;

function owner(key) {
  const cls = key.class.replace(/\$\$Lambda.*$/, '');
  const hidden = cls !== key.class;
  const merged = MERGED.exec(key.method);
  if (/Unknown/.test(cls)) {
    return { status: 'none', candidates: [], class_found: false, member_found: false, yarn: null, mixin: null };
  }
  if (/Ambig/.test(cls)) {
    return {
      status: 'ambiguous',
      candidates: [
        { mod: 'libone', version: '1.0', sha256: 'a'.repeat(64), file: 'mods/libone-1.0.jar', loaded: true, nested_in: [{ mod: 'moda', version: '1', sha256: '1'.repeat(64) }] },
        { mod: 'libone', version: '1.2', sha256: 'b'.repeat(64), file: 'mods/libone-1.2.jar', loaded: true, nested_in: [{ mod: 'modb', version: '1', sha256: '2'.repeat(64) }] },
        { mod: 'libone', version: '0.9', sha256: '9'.repeat(64), file: 'mods/libone-0.9.jar', loaded: false, nested_in: [{ mod: 'modc', version: '1', sha256: '3'.repeat(64) }] },
      ],
      class_found: true,
      member_found: true,
      yarn: null,
      mixin: null,
    };
  }
  const answer = {
    status: 'probable',
    candidates: [{ mod: 'minecraft', version: '1.20.1', sha256: 'c'.repeat(64), file: 'server.jar', loaded: true, nested_in: [] }],
    class_found: true,
    member_found: true,
    yarn: { class: 'net.minecraft.entity.LivingEntity', method: 'tick', desc: '()V' },
    mixin: null,
  };
  if (merged !== null) {
    answer.candidates = [{ mod: merged[2], version: '2.0', sha256: 'd'.repeat(64), file: `mods/${merged[2]}-2.0.jar`, loaded: true, nested_in: [] }];
    answer.yarn = { class: 'net.minecraft.server.world.ServerWorld', method: merged[3], desc: null };
    answer.mixin = {
      mixin_class: `${merged[2]}.mixin.TargetMixin`, config: `${merged[2]}.mixins.json`, kind: 'Inject', handler: merged[3], target: 'method_18765()V',
      at: 'HEAD', priority: 1000, cancellable: false, side: 'common', failed: false, mod: merged[2], version: '2.0', sha256: 'd'.repeat(64),
    };
  }
  if (hidden) answer.hidden_lambda = true;
  return answer;
}

function mixins(target) {
  if (!/^net\.minecraft\./.test(target.class)) return { mixins: [] };
  return {
    mixins: [
      {
        mod: 'overwriter', version: '3.1', sha256: 'e'.repeat(64), nested_in: [], mixin_class: 'overwriter.mixin.LivingEntityMixin', config: 'overwriter.mixins.json',
        kind: 'Overwrite', handler: target.method ?? 'tick', target: `${target.method ?? ''}${target.desc ?? ''}`, at: '', priority: 1000, cancellable: false, side: 'common', failed: false,
      },
    ],
  };
}

function answer(request) {
  switch (request.op) {
    case 'snapshots':
      return { env: 'myserver', snapshots: SNAPSHOTS };
    case 'match': {
      const modset = modsetOf(request.mods);
      return process.env.ENVX_STUB_MATCH === 'none'
        ? { modset, status: 'none', closest: { snapshot: 12, only_in_request_count: 1, only_in_request: [['x', '1.0']], only_in_snapshot_count: 1, only_in_snapshot: [['y', '2.0']] } }
        : { modset, status: 'match', snapshots: [12, 9] };
    }
    case 'owner':
      return { snapshot: refOf(request.snapshot ?? request.fingerprint), results: request.keys.map(owner) };
    case 'mixins':
      return { snapshot: refOf(request.snapshot ?? request.fingerprint), results: request.targets.map(mixins) };
    case 'diff':
      return { from: refOf(request.from), to: refOf(request.to), added: [], removed: [], changed: [] };
    default:
      return undefined;
  }
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.trim() === '') continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ api: 1, id: null, ok: false, error: { code: 'bad_request', message: 'not JSON' } }) + '\n');
    continue;
  }
  const result = answer(request);
  process.stdout.write(
    JSON.stringify(
      result === undefined
        ? { api: 1, id: request.id, ok: false, error: { code: 'unknown_op', message: `unknown op ${request.op}` } }
        : { api: 1, id: request.id, ok: true, result },
    ) + '\n',
  );
}
