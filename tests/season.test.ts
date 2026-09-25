import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import * as path from 'node:path';

import {
  parseMaxHeapMb,
  javaMajorOf,
  modSetSimilarity,
  diffModSets,
  classifyBoundary,
  environmentKey,
  groupByEnvironment,
  extractEnvironment,
  type EnvironmentFacts,
  type ModEntry,
  runtimeFlagsOf,
  diffRuntimeFlags,
} from '../src/model/season.ts';
import { decodeSparkProfile } from '../src/decode/sparkprofile.ts';
import { REAL_ARCHIVE } from './fixtures/real-archive.ts';

const BASE: EnvironmentFacts = {
  minecraftVersion: '1.20.1',
  loaderName: 'Fabric',
  loaderVersion: '0.19.3',
  javaVersion: '17.0.20.1',
  javaMajor: '17',
  heapMaxMb: 14336,
  cpuModel: 'Example 8-Core Processor',
  cpuThreads: 8,
  osName: 'Ubuntu 26.04.1 LTS',
  mods: [],
  modCount: 0,
  modSetHash: '',
  modIdSetHash: '',
  runtimeFlags: undefined,
};

function withMods(base: EnvironmentFacts, mods: ModEntry[]): EnvironmentFacts {
  return { ...base, mods, modCount: mods.length };
}

function pack(n: number, bump = ''): ModEntry[] {
  return Array.from({ length: n }, (_, i) => ({ id: `mod${i}`, version: `1.0${bump}` }));
}

describe('parsing', () => {
  test('parseMaxHeapMb handles G/M/K and absence', () => {
    assert.equal(parseMaxHeapMb('-Xms14G -Xmx14G -XX:Foo'), 14336);
    assert.equal(parseMaxHeapMb('-Xmx14336m'), 14336);
    assert.equal(parseMaxHeapMb('-Xmx14680064k'), 14336);
    assert.equal(parseMaxHeapMb('-Xms4G'), undefined);
    assert.equal(parseMaxHeapMb(undefined), undefined);
  });

  test('javaMajorOf handles modern and legacy schemes', () => {
    assert.equal(javaMajorOf('17.0.20.1'), '17');
    assert.equal(javaMajorOf('21.0.7'), '21');
    assert.equal(javaMajorOf('1.8.0_382'), '8');
    assert.equal(javaMajorOf(''), '');
  });
});

describe('mod set comparison', () => {
  test('similarity is 1 for identical id sets regardless of version', () => {
    assert.equal(modSetSimilarity(pack(10), pack(10, '-rc2')), 1);
  });

  test('similarity falls as the sets diverge', () => {
    const a = pack(100);
    const b = pack(100).slice(50).concat(Array.from({ length: 50 }, (_, i) => ({ id: `other${i}`, version: '1' })));
    assert.ok(modSetSimilarity(a, b) < 0.5);
  });

  test('diff separates added, removed and version-changed', () => {
    const before: ModEntry[] = [{ id: 'a', version: '1' }, { id: 'b', version: '1' }];
    const after: ModEntry[] = [{ id: 'a', version: '2' }, { id: 'c', version: '1' }];
    const diff = diffModSets(before, after);
    assert.deepEqual(diff.added.map((m) => m.id), ['c']);
    assert.deepEqual(diff.removed.map((m) => m.id), ['b']);
    assert.deepEqual(diff.changed, [{ id: 'a', from: '1', to: '2' }]);
    assert.equal(diff.identical, false);
  });
});

describe('boundary classification', () => {
  test('identical environment is "same"', () => {
    const env = withMods(BASE, pack(500));
    assert.equal(classifyBoundary(env, env).kind, 'same');
  });

  test('a mod version bump is a revision, not a season', () => {
    const a = withMods(BASE, pack(500));
    const b = withMods(BASE, pack(500, '-rc3'));
    const decision = classifyBoundary(a, b);
    assert.equal(decision.kind, 'revision');
    assert.match(decision.reasons.join(' '), /version-changed/);
  });

  test('a heap change is a revision and is stated, not swallowed', () => {
    const a = withMods(BASE, pack(500));
    const b = withMods({ ...BASE, heapMaxMb: 10240 }, pack(500));
    const decision = classifyBoundary(a, b);
    assert.equal(decision.kind, 'revision');
    assert.match(decision.reasons.join(' '), /heap/);
  });

  test('different hardware is a season, and says why', () => {
    const a = withMods(BASE, pack(500));
    const b = withMods({ ...BASE, cpuThreads: 16, cpuModel: '', osName: 'Windows 11' }, pack(500));
    const decision = classifyBoundary(a, b);
    assert.equal(decision.kind, 'season');
    assert.match(decision.reasons.join(' '), /hardware|OS/);
  });

  test('a Minecraft version change is a season', () => {
    const a = withMods(BASE, pack(500));
    const b = withMods({ ...BASE, minecraftVersion: '1.21.1' }, pack(500));
    assert.equal(classifyBoundary(a, b).kind, 'season');
  });

  test('a wholesale pack swap is a season', () => {
    const a = withMods(BASE, pack(500));
    const b = withMods(BASE, Array.from({ length: 500 }, (_, i) => ({ id: `new${i}`, version: '1' })));
    const decision = classifyBoundary(a, b);
    assert.equal(decision.kind, 'season');
    assert.match(decision.reasons.join(' '), /overlap/);
  });

  test('the first capture is never a season change', () => {
    assert.equal(classifyBoundary(undefined, withMods(BASE, pack(10))).kind, 'first');
  });
});

describe('environment grouping', () => {
  test('two machines are separated rather than sequenced', () => {
    const linux = withMods(BASE, pack(500));
    const windows = withMods({ ...BASE, osName: 'Windows 11', cpuThreads: 16, cpuModel: '' }, pack(500));
    assert.notEqual(environmentKey(linux), environmentKey(windows));

    const groups = groupByEnvironment([linux, windows, linux], (e) => e);
    assert.equal(groups.size, 2);
  });

  test('heap and mod changes do NOT split the environment', () => {
    const a = withMods(BASE, pack(500));
    const b = withMods({ ...BASE, heapMaxMb: 10240 }, pack(400));
    assert.equal(environmentKey(a), environmentKey(b));
  });
});

/**
 * Replays the real archive. This is the test that caught the original design
 * error: treating captures as one timeline produced three bogus season
 * rollovers in four days, because a production server and a local test
 * server interleave by date.
 */
describe('replay of the real archive', () => {
  const ARCHIVE = REAL_ARCHIVE.profiles ?? '';

  test('resolves to two environments with no season churn inside either', (t) => {
    if (ARCHIVE === '' || !existsSync(ARCHIVE)) {
      t.skip('capture archive not available');
      return;
    }

    const files: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 3) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.name.endsWith('.sparkprofile')) files.push(full);
      }
    };
    walk(ARCHIVE, 0);
    assert.ok(files.length >= 20, `expected a substantial archive, found ${files.length}`);

    const captures = files.map((file) => {
      const profile = decodeSparkProfile(readFileSync(file));
      return {
        startTime: profile.metadata.startTime ?? statSync(file).mtimeMs,
        env: extractEnvironment(profile),
      };
    });
    captures.sort((a, b) => a.startTime - b.startTime);

    const groups = groupByEnvironment(captures, (c) => c.env);
    assert.equal(groups.size, REAL_ARCHIVE.machines ?? 2, 'the archive spans the machines it was captured on');

    for (const [key, group] of groups) {
      let previous: EnvironmentFacts | undefined;
      let seasonChanges = 0;
      for (const capture of group) {
        if (classifyBoundary(previous, capture.env).kind === 'season') seasonChanges += 1;
        previous = capture.env;
      }
      assert.equal(
        seasonChanges,
        0,
        `environment ${key} should be one continuous season, saw ${seasonChanges} rollovers`,
      );
    }
  });
});

describe('JVM flags are tracked for comparisons', () => {
  test('only -X flags count, sorted and de-duplicated', () => {
    assert.deepEqual(
      runtimeFlagsOf('-Dlog4j2.formatMsgNoLookups=true -Xmx14G -Xms14G -XX:ReservedCodeCacheSize=512M -Xmx14G'),
      ['-XX:ReservedCodeCacheSize=512M', '-Xms14G', '-Xmx14G'],
    );
  });

  test('missing arguments are unknown, never "no flags"', () => {
    assert.equal(runtimeFlagsOf(undefined), undefined);
    assert.equal(runtimeFlagsOf('   '), undefined);
  });

  test('adding the diagnostic flags reads as two additions', () => {
    const before = runtimeFlagsOf('-Xmx14G -Xms14G -XX:ReservedCodeCacheSize=512M')!;
    const after = runtimeFlagsOf(
      '-Xmx14G -Xms14G -XX:ReservedCodeCacheSize=512M -XX:+UnlockDiagnosticVMOptions -XX:+DebugNonSafepoints',
    )!;
    assert.deepEqual(diffRuntimeFlags(before, after), [
      '+ -XX:+DebugNonSafepoints',
      '+ -XX:+UnlockDiagnosticVMOptions',
    ]);
  });

  test('a system property change alone is not a runtime change', () => {
    assert.deepEqual(
      diffRuntimeFlags(runtimeFlagsOf('-Xmx14G -Dfoo=1')!, runtimeFlagsOf('-Xmx14G -Dfoo=2')!),
      [],
    );
  });
});
