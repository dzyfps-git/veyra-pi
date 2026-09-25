/** Quick check of the work / idle / blocked split for one capture. */
import { readFileSync } from 'node:fs';
import { decodeSparkProfile } from '../decode/sparkprofile.ts';
import { aggregateProfile } from '../decode/aggregate.ts';
import { loadTinyMappings, mapFrame } from '../decode/mappings.ts';

const [file, mappingFile] = process.argv.slice(2);
if (file === undefined || mappingFile === undefined) {
  console.error('usage: node src/cli/active.ts <file.sparkprofile> <mappings.gz>');
  process.exit(2);
}
const mappings = loadTinyMappings(mappingFile);
const profile = decodeSparkProfile(readFileSync(file));
const agg = aggregateProfile(profile, {
  renameFrame: (c, m) => mapFrame(c, m, mappings),
  mappingsAvailable: mappings.available,
});
const ticks = agg.divisorTicks ?? 1;
for (const t of agg.threads) {
  console.log(`thread            ${t.name}`);
  console.log(`  wall            ${(t.totalMs / ticks).toFixed(3)} ms/tick   (${t.totalMs.toFixed(0)} ms)`);
  console.log(`  idle (tick wait)${(t.idleMs / ticks).toFixed(3).padStart(8)} ms/tick`);
  console.log(`  blocked (stall) ${(t.blockedMs / ticks).toFixed(3).padStart(8)} ms/tick`);
  console.log(`  unclassified    ${(t.unclassifiedWaitMs / ticks).toFixed(3).padStart(8)} ms/tick`);
  console.log(`  between ticks   ${t.betweenTickMs === undefined ? '     n/a' : (t.betweenTickMs / ticks).toFixed(3).padStart(8)} ms/tick`);
  console.log(`  non-idle total  ${(t.activeMs / ticks).toFixed(3).padStart(8)} ms/tick`);
  console.log(`  TICK (headline) ${t.tickMs === undefined ? '     n/a' : (t.tickMs / ticks).toFixed(3).padStart(8)} ms/tick`);
}
const blocked = agg.rows.filter((r) => r.category === 'blocked' && r.depth > 0);
blocked.sort((a, b) => b.totalMs - a.totalMs);
if (blocked.length > 0) {
  console.log('\ntop blocked call paths (lost tick time, not idle):');
  for (const r of blocked.slice(0, 5)) {
    console.log(`  ${(r.totalMs / ticks).toFixed(3)} ms/tick  ${r.path.split(' > ').slice(-4).join(' > ')}`);
  }
}
