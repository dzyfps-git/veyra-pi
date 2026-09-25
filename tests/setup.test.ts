/**
 * Surviving a modpack rotation.
 *
 * The scenarios here are the ones that actually happen, and they differ in
 * kind rather than degree:
 *
 *   minor update      a pack's 4.0.4 -> 4.0.5. Same Minecraft, loader
 *                     and Java. spark survives; `config/spark/config.json`
 *                     often does not.
 *
 *   full rotation     a Fabric pack -> a NeoForge one. Minecraft, loader and Java all
 *                     change. The old spark jar is not missing, it is WRONG,
 *                     and the Yarn mappings become actively harmful rather
 *                     than merely absent.
 *
 * The rule being tested throughout: carry the INTENT forward, re-derive the
 * MECHANISM, and never propose overwriting something the new pack shipped.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkSetup,
  mappingsMatchVersion,
  normaliseLoader,
  namingScheme,
  worstSeverity,
  DIAGNOSTIC_FLAGS,
  type DesiredSetup,
  type ObservedForCheck,
} from '../src/runtime/setup.ts';
import { parseSparkFileName, findJvmArgs } from '../src/runtime/serverscan.ts';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const WANT: DesiredSetup = {
  backgroundProfiler: true,
  samplingIntervalMs: 10,
  wantDiagnosticFlags: true,
  mappingsFile: 'D:/mappings/yarn-1.20.1+build.10-tiny.gz',
};

/** A healthy Fabric 1.20.1 server. */
function healthy(): ObservedForCheck {
  return {
    rootReadable: true,
    root: 'S:/',
    sparkJars: [{ fileName: 'spark-1.10.53-fabric.jar', version: '1.10.53', loader: 'fabric' }],
    sparkConfigExists: true,
    sparkConfig: { backgroundProfiler: true },
    sparkConfigPath: 'S:/config/spark/config.json',
    jvmArgs: {
      mechanism: 'variables.txt',
      file: 'S:/variables.txt',
      flags: ['-Xmx14G', ...DIAGNOSTIC_FLAGS],
    },
    modsDirExists: true,
    problems: [],
  };
}

const FABRIC = { minecraftVersion: '1.20.1', loaderName: 'Fabric', javaMajor: '17' };
const NEOFORGE_PACK = { minecraftVersion: '1.21.1', loaderName: 'NeoForge', javaMajor: '21' };

const ids = (findings: ReturnType<typeof checkSetup>): string[] => findings.map((f) => f.id);

describe('a healthy server', () => {
  test('reports nothing wrong', () => {
    assert.deepEqual(checkSetup(healthy(), WANT, FABRIC), []);
    assert.equal(worstSeverity([]), undefined);
  });
});

describe('a minor modpack update', () => {
  test('a wiped spark config is caught', () => {
    // 4.0.4 -> 4.0.5 ships a fresh config folder.
    const observed = { ...healthy(), sparkConfigExists: false, sparkConfig: undefined };
    const findings = checkSetup(observed, WANT, FABRIC);
    assert.ok(ids(findings).includes('spark-config-missing'));
  });

  test('background profiling explicitly turned off is blocking', () => {
    const observed = { ...healthy(), sparkConfig: { backgroundProfiler: false } };
    const findings = checkSetup(observed, WANT, FABRIC);
    const hit = findings.find((f) => f.id === 'background-profiler-off');
    assert.equal(hit?.severity, 'blocking');
    assert.equal(hit?.remedy.kind, 'needs-mc-restart', 'this cannot take effect without a restart');
  });

  test('a reset sampling interval is reported with the right consequence', () => {
    const observed = { ...healthy(), sparkConfig: { backgroundProfiler: true, backgroundProfilerInterval: 100 } };
    const hit = checkSetup(observed, WANT, FABRIC).find((f) => f.id === 'sampling-interval-differs');
    assert.ok(hit);
    assert.match(hit.consequence, /small recurring costs/);
  });

  test('spark itself is untouched by a minor update, so nothing is said about it', () => {
    const findings = checkSetup({ ...healthy(), sparkConfigExists: false }, WANT, FABRIC);
    assert.ok(!ids(findings).some((id) => id.startsWith('spark-missing')));
  });
});

describe('a full modpack rotation', () => {
  test('the old jar is reported as WRONG, not merely present', () => {
    // The fabric jar carried across into a NeoForge pack.
    const findings = checkSetup(healthy(), WANT, NEOFORGE_PACK);
    const hit = findings.find((f) => f.id === 'spark-wrong-loader');
    assert.ok(hit, 'a fabric jar in a neoforge pack must be flagged');
    assert.equal(hit.severity, 'blocking');
    assert.match(hit.remedy.action, /neoforge/i);
  });

  test('a missing spark names the loader the new pack needs', () => {
    const observed = { ...healthy(), sparkJars: [] };
    const hit = checkSetup(observed, WANT, NEOFORGE_PACK).find((f) => f.id === 'spark-missing');
    assert.ok(hit);
    assert.match(hit.remedy.detail ?? '', /neoforge/);
    assert.match(hit.remedy.detail ?? '', /1\.21\.1/);
    assert.equal(hit.remedy.kind, 'manual', 'installing a mod is never automatic');
  });

  test('NeoForge 1.21.1 is NOT told to download Yarn mappings', () => {
    // The first version of this check did exactly that, which would have
    // been confidently wrong advice: NeoForge 1.20.5+ runs with Mojang's
    // official names and needs no mappings at all.
    const findings = checkSetup(healthy(), WANT, NEOFORGE_PACK);
    assert.ok(!ids(findings).includes('mappings-wrong-version'));
    const hit = findings.find((f) => f.id === 'mappings-not-needed');
    assert.equal(hit?.severity, 'info', 'a leftover Yarn file is harmless, not a fault');
  });

  test('a Fabric pack that changes Minecraft version DOES have stale mappings', () => {
    const fabricNewVersion = { minecraftVersion: '1.21.1', loaderName: 'Fabric', javaMajor: '21' };
    const hit = checkSetup(healthy(), WANT, fabricNewVersion).find((f) => f.id === 'mappings-wrong-version');
    assert.ok(hit);
    assert.equal(hit.severity, 'blocking');
    assert.match(hit.consequence, /worse than none/);
  });

  test('Forge is reported as unsupported rather than given wrong advice', () => {
    const forge = { minecraftVersion: '1.20.1', loaderName: 'Forge', javaMajor: '17' };
    const findings = checkSetup(
      { ...healthy(), sparkJars: [{ fileName: 'spark-1.10.53-forge.jar', version: '1.10.53', loader: 'forge' }] },
      WANT,
      forge,
    );
    const hit = findings.find((f) => f.id === 'mappings-srg-unsupported');
    assert.ok(hit);
    assert.match(hit.consequence, /WRONG here, not merely absent/);
    assert.ok(!ids(findings).includes('mappings-wrong-version'));
  });

  test('a rotation produces several findings, not one vague one', () => {
    const findings = checkSetup(healthy(), WANT, NEOFORGE_PACK);
    assert.ok(findings.length >= 2);
    assert.ok(ids(findings).includes('spark-wrong-loader'));
    assert.ok(ids(findings).includes('mappings-not-needed'));
  });
});

describe('never overwriting what the pack shipped', () => {
  test('a remedy that edits a server file says so, so it can be gated', () => {
    const observed = { ...healthy(), sparkConfigExists: false, sparkConfig: undefined };
    const hit = checkSetup(observed, WANT, FABRIC).find((f) => f.id === 'spark-config-missing');
    assert.equal(hit?.remedy.kind, 'server-file');
  });

  test('the JVM remedy never claims it can edit the launcher itself', () => {
    const observed = { ...healthy(), jvmArgs: undefined };
    const hit = checkSetup(observed, WANT, FABRIC).find((f) => f.id === 'jvm-args-unknown');
    assert.equal(hit?.remedy.kind, 'manual');
    assert.match(hit.remedy.action, /Nothing is edited automatically/);
  });
});

describe('spark installation problems', () => {
  test('two spark jars is a problem in itself', () => {
    const observed = {
      ...healthy(),
      sparkJars: [
        { fileName: 'spark-1.10.53-fabric.jar', version: '1.10.53', loader: 'fabric' },
        { fileName: 'spark-1.10.70-fabric.jar', version: '1.10.70', loader: 'fabric' },
      ],
    };
    const hit = checkSetup(observed, WANT, FABRIC).find((f) => f.id === 'spark-duplicate');
    assert.ok(hit);
    assert.match(hit.consequence, /stop the server from starting/);
  });

  test('a newer spark of the right loader is fine', () => {
    const observed = {
      ...healthy(),
      sparkJars: [{ fileName: 'spark-1.11.0-fabric.jar', version: '1.11.0', loader: 'fabric' }],
    };
    assert.deepEqual(checkSetup(observed, WANT, FABRIC), []);
  });

  test('an unparseable jar name is not treated as the wrong loader', () => {
    // Unknown is not wrong. Guessing here would tell someone to replace a
    // jar that is perfectly fine.
    const observed = { ...healthy(), sparkJars: [{ fileName: 'spark.jar' }] };
    assert.deepEqual(ids(checkSetup(observed, WANT, NEOFORGE_PACK)).filter((i) => i.startsWith('spark-')), []);
  });
});

describe('an unreachable server', () => {
  test('reports exactly one finding and stops', () => {
    const findings = checkSetup({ ...healthy(), rootReadable: false }, WANT, FABRIC);
    assert.equal(findings.length, 1, 'cascading every check off one failure is noise');
    assert.equal(findings[0]!.id, 'root-unreachable');
    assert.match(findings[0]!.consequence, /Existing history is untouched/);
  });
});

describe('helpers', () => {
  test('loader aliases collapse to what spark actually ships', () => {
    assert.equal(normaliseLoader('Quilt'), 'fabric');
    assert.equal(normaliseLoader('Paper'), 'bukkit');
    assert.equal(normaliseLoader('NeoForge'), 'neoforge');
    assert.equal(normaliseLoader(undefined), undefined);
  });

  test('spark filenames parse', () => {
    assert.deepEqual(parseSparkFileName('spark-1.10.53-fabric.jar'), { version: '1.10.53', loader: 'fabric' });
    assert.deepEqual(parseSparkFileName('spark-1.10.53-neoforge.jar'), { version: '1.10.53', loader: 'neoforge' });
    assert.deepEqual(parseSparkFileName('not-spark-at-all.jar'), {});
  });

  test('mappings version matching says unknown rather than wrong', () => {
    assert.equal(mappingsMatchVersion('yarn-1.20.1+build.10-tiny.gz', '1.20.1'), true);
    assert.equal(mappingsMatchVersion('yarn-1.20.1+build.10-tiny.gz', '1.21.1'), false);
    assert.equal(mappingsMatchVersion('my-custom-mappings.gz', '1.21.1'), undefined);
    assert.equal(mappingsMatchVersion('', '1.21.1'), undefined);
  });

  test('worst severity picks blocking over degraded', () => {
    const findings = checkSetup({ ...healthy(), sparkJars: [], jvmArgs: undefined }, WANT, NEOFORGE_PACK);
    assert.equal(worstSeverity(findings), 'blocking');
  });
});

describe('finding where JVM flags live', () => {
  function tempServer(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), 'perfint-pack-'));
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(root, name);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    return root;
  }

  test('reads the modpack launcher layout', () => {
    const root = tempServer({
      'variables.txt': 'JAVA_ARGS="-Xmx14G -Xms14G"\nADDITIONAL_ARGS="-Dfoo=bar"\n',
    });
    const found = findJvmArgs(root)!;
    assert.equal(found.mechanism, 'variables.txt');
    assert.deepEqual(found.flags, ['-Xmx14G', '-Xms14G', '-Dfoo=bar']);
  });

  test('reads the Forge/NeoForge layout, which a rotation may switch to', () => {
    const root = tempServer({ 'user_jvm_args.txt': '# comment\n-Xmx16G\n-XX:+UseG1GC\n' });
    const found = findJvmArgs(root)!;
    assert.equal(found.mechanism, 'user_jvm_args.txt');
    assert.deepEqual(found.flags, ['-Xmx16G', '-XX:+UseG1GC']);
  });

  test('falls back to a shell launcher', () => {
    const root = tempServer({ 'start.sh': '#!/bin/sh\nexec java -Xmx8G -jar server.jar nogui\n' });
    const found = findJvmArgs(root)!;
    assert.equal(found.mechanism, 'start.sh');
    assert.ok(found.flags.includes('-Xmx8G'));
  });

  test('an unrecognised pack yields undefined rather than a guessed file', () => {
    assert.equal(findJvmArgs(tempServer({ 'readme.txt': 'hello' })), undefined);
  });
});

describe('naming schemes per loader', () => {
  test('each loader maps to what it actually runs with', () => {
    assert.equal(namingScheme('Fabric', '1.20.1'), 'intermediary');
    assert.equal(namingScheme('Quilt', '1.20.1'), 'intermediary');
    assert.equal(namingScheme('NeoForge', '1.21.1'), 'official');
    assert.equal(namingScheme('NeoForge', '1.20.5'), 'official');
    assert.equal(namingScheme('NeoForge', '1.20.4'), 'srg');
    assert.equal(namingScheme('Forge', '1.20.1'), 'srg');
    assert.equal(namingScheme('Paper', '1.20.1'), 'unknown');
    assert.equal(namingScheme('NeoForge', undefined), 'unknown', 'an unknown version is not guessed');
  });
});

describe('written but not running yet', () => {
  test('flags in the launcher file that the running server lacks are a restart notice, not a fault', () => {
    const f = checkSetup(healthy(), WANT, { ...FABRIC, runningFlags: ['-Xmx14G'] });
    assert.deepEqual(ids(f), ['jvm-flags-not-running']);
    assert.equal(f[0]!.severity, 'info');
    assert.equal(f[0]!.remedy.kind, 'needs-mc-restart');
  });
  test('flags that are running say nothing', () => {
    assert.deepEqual(checkSetup(healthy(), WANT, { ...FABRIC, runningFlags: ['-Xmx14G', ...DIAGNOSTIC_FLAGS] }), []);
  });
  test('a configured interval the newest capture does not use yet is a restart notice', () => {
    const observed = { ...healthy(), sparkConfig: { backgroundProfiler: true, backgroundProfilerInterval: 9 } };
    const f = checkSetup(observed, { ...WANT, samplingIntervalMs: 9 }, { ...FABRIC, runningIntervalMs: 10 });
    assert.deepEqual(ids(f), ['sampling-interval-not-running']);
    assert.deepEqual(checkSetup(observed, { ...WANT, samplingIntervalMs: 9 }, { ...FABRIC, runningIntervalMs: 9 }), []);
  });
});
