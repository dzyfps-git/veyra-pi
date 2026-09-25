/**
 * Which part of the game a call path belongs to, in words a server owner
 * uses: entities, block entities, chunks, players, datapacks...
 *
 * A path is assigned by the OUTERMOST frame that names a specific part of
 * the tick, so "entities -> ... -> a chunk lookup" counts as entities: it is
 * the entity that caused the work. Waiting (the thread parked on another
 * thread) is its own part whatever caused it, because a wait costs tick time
 * differently from work, and "Stalls" explains the cause separately.
 *
 * Names are yarn (1.20.1), which is what captures are stored in once the
 * mappings are available. On other versions the rules still match wherever
 * the method names are unchanged; anything unmatched is "Other game work",
 * never guessed.
 */

import { parseMixin, type MixinFrame } from './owner.ts';

export type SystemKey =
  | 'entities'
  | 'block-entities'
  | 'random-ticks'
  | 'spawning'
  | 'entity-tracking'
  | 'chunk-loading'
  | 'datapacks'
  | 'players'
  | 'block-updates'
  | 'world'
  | 'mod-hooks'
  | 'saving'
  | 'gc'
  | 'waiting'
  | 'other';

export interface SystemInfo {
  key: SystemKey;
  name: string;
  /** One sentence for someone who does not read Java. */
  about: string;
}

export const SYSTEMS: Record<SystemKey, SystemInfo> = {
  entities: { key: 'entities', name: 'Entities', about: 'Mobs, animals, items, projectiles and players moving, thinking and colliding.' },
  'block-entities': {
    key: 'block-entities',
    name: 'Block entities',
    about: 'Blocks that do something every tick: furnaces, hoppers, machines, spawners, modded storage.',
  },
  'random-ticks': { key: 'random-ticks', name: 'Random ticks', about: 'Crops growing, leaves decaying, ice melting, fire spreading: random updates in loaded chunks.' },
  spawning: { key: 'spawning', name: 'Mob spawning', about: 'Deciding where and whether new mobs spawn around players.' },
  'entity-tracking': { key: 'entity-tracking', name: 'Entity tracking', about: 'Telling each player where nearby entities are and what changed.' },
  'chunk-loading': { key: 'chunk-loading', name: 'Chunk loading', about: 'Keeping the right chunks loaded around players, and unloading the rest.' },
  datapacks: {
    key: 'datapacks',
    name: 'Datapack functions',
    about: 'Functions and commands run every tick by datapacks (and mods that use them).',
  },
  players: { key: 'players', name: 'Players & network', about: 'Handling what each player’s client sends: movement, clicks, chat, inventory.' },
  'block-updates': { key: 'block-updates', name: 'Block & fluid updates', about: 'Scheduled updates: redstone, water and lava flow, falling blocks.' },
  world: { key: 'world', name: 'World upkeep', about: 'Time of day, weather, raids, sleeping.' },
  'mod-hooks': { key: 'mod-hooks', name: 'Mods’ own tick work', about: 'Work mods add to every server or world tick.' },
  saving: { key: 'saving', name: 'Saving', about: 'Writing the world to disk (autosave and save-all).' },
  gc: { key: 'gc', name: 'Garbage collection', about: 'Java freeing memory. Only the part seen on the server thread is counted here.' },
  waiting: {
    key: 'waiting',
    name: 'Waiting',
    about: 'The server thread stopped and waited for something else, usually a chunk being loaded or generated.',
  },
  other: { key: 'other', name: 'Other game work', about: 'Tick work not matched to one of the parts above.' },
};

/** Outermost-first rules: the first frame (from the root down) that matches decides. */
const RULES: ReadonlyArray<[RegExp, SystemKey]> = [
  [/\.MinecraftServer\.save(All)?$|ServerWorld\.save$|ServerChunkManager\.save$/, 'saving'],
  [/\.CommandFunctionManager\.tick$/, 'datapacks'],
  [/\.ServerNetworkIo\.tick$/, 'players'],
  [/\.World\.tickBlockEntities$/, 'block-entities'],
  [/\.EntityList\.forEach$|ServerWorld\.tickEntity$|ServerWorld\.tickPassenger$/, 'entities'],
  [/\.ServerWorld\.tickChunk$/, 'random-ticks'],
  [/\.SpawnHelper\.|[sS]pawn[A-Za-z]*$|\.ServerChunkManager\.redirect\$.*[Ss]pawn/, 'spawning'],
  [/\.ThreadedAnvilChunkStorage\.tickEntityMovement$|EntityTracker/, 'entity-tracking'],
  [/\.ChunkTicketManager\.|\.ThreadedAnvilChunkStorage\.tick$|\.ThreadedAnvilChunkStorage\.updateHolderMap$/, 'chunk-loading'],
  [/\.WorldTickScheduler\.tick$|\.ServerWorld\.processSyncedBlockEvents$/, 'block-updates'],
  [/\.ServerWorld\.(tickTime|tickWeather|wakeSleepingPlayers)$|\.RaidManager\.tick$|\.ServerWorld\.tickSpawners$/, 'world'],
];

/** Mod code added to the server or world tick itself (owner.ts parses the frame). */
const HOOKED_CLASS = /\.(?:MinecraftServer|MinecraftDedicatedServer|ServerWorld)$/;
const HOOK_KINDS: ReadonlySet<string> = new Set(['handler', 'redirect', 'wrapOperation']);
function hookOf(frame: string): MixinFrame | undefined {
  const m = parseMixin(frame);
  return m !== undefined && HOOKED_CLASS.test(m.cls) && (HOOK_KINDS.has(m.kind) || m.kind.startsWith('modify')) ? m : undefined;
}

const TICK_ANCHOR = /\.MinecraftServer\.tick$/;

export function modOfHook(frame: string): string | undefined {
  return hookOf(frame)?.mod;
}

/**
 * One step down a path: the state after `frame`, given the state of its
 * caller. The outermost specific frame decides, so once a part is known it
 * stays. Shared by per-file and per-database classification.
 */
export function systemStep(
  frame: string,
  parent: { inTick: boolean; system: SystemKey | undefined } | undefined,
): { inTick: boolean; system: SystemKey | undefined } {
  if (parent === undefined) {
    if (frame === 'native.GC_active') return { inTick: false, system: 'gc' };
    return { inTick: TICK_ANCHOR.test(frame), system: undefined };
  }
  if (parent.system !== undefined) return parent;
  if (!parent.inTick) return { inTick: TICK_ANCHOR.test(frame), system: undefined };
  if (hookOf(frame) !== undefined) return { inTick: true, system: 'mod-hooks' };
  for (const [pattern, key] of RULES) if (pattern.test(frame)) return { inTick: true, system: key };
  return parent;
}

/**
 * The part of the game a path belongs to. `frames` runs root first.
 * Returns undefined for time that is not tick work (idle between ticks).
 */
export function systemOf(frames: readonly string[], category: string): SystemKey | undefined {
  if (category === 'idle') return undefined;
  if (category === 'blocked' || category === 'waiting') return 'waiting';
  let state: { inTick: boolean; system: SystemKey | undefined } | undefined;
  for (const frame of frames) state = systemStep(frame, state);
  if (state === undefined) return undefined;
  return state.system ?? (state.inTick ? 'other' : undefined);
}

/** In plain words, what a wait was for and what caused it. `frames` runs root first. */
export function explainWait(frames: readonly string[]): { what: string; cause: string } {
  const joined = frames.join(' > ');
  const chunk = frames.findIndex((f) => /getChunkBlocking$|ServerChunkManager\.getChunk$/.test(f));
  const what = chunk >= 0 ? 'waited for a chunk to load or generate' : /save/i.test(joined) ? 'waited while the world saved' : 'waited on another thread';
  const before = chunk >= 0 ? frames.slice(0, chunk) : frames;
  const has = (re: RegExp): boolean => before.some((f) => re.test(f));
  let cause: string;
  if (has(/getLandingPos|applyMovementEffects|\.Entity\.move$|ServerPlayNetworkHandler\.onPlayerMove/)) cause = 'a player or mob moving into terrain that was not loaded yet';
  else if (has(/FilledMapItem/)) cause = 'a held map updating its picture over unloaded chunks';
  else if (has(/PortalForcer/)) cause = 'a Nether portal being created or searched for';
  else if (has(/teleport/i)) cause = 'a teleport';
  else if (has(/SpawnHelper|[sS]pawn/)) cause = 'mob spawning';
  else if (has(/StructureLocator|locateStructure|\.locate/)) cause = 'a structure search (for example a map, compass or /locate)';
  else {
    const culprit = [...before].reverse().find((f) => !/^(java|jdk|sun|native|net\.minecraft|com\.mojang|it\.unimi)\./.test(f));
    cause = culprit === undefined ? 'game code (no single trigger identified)' : `code in ${culprit.split('.').slice(0, -1).join('.')}`;
  }
  return { what, cause };
}
