/**
 * What, inside a part of the game, the time went to: which entity type,
 * which block entity, which block's random tick, which command a datapack
 * ran, what kind of packet a player sent, what a wait was for.
 *
 * spark records methods, not objects, so a "thing" is recognised from the
 * method the game dispatched to for it:
 *
 *   entities        the first `tick` below ServerWorld.tickEntity is the
 *                   entity's own override, so its class is the type. A type
 *                   with no tick of its own shows as the class it inherits
 *                   from ("mobs with no tick of their own").
 *   block entities  the ticker the chunk calls for each block entity.
 *   random ticks,   the block (or fluid) whose randomTick / scheduledTick ran.
 *   block updates
 *   datapacks       the innermost command class: a function's own name is not
 *                   in a profile, but "/data", "/execute", "/scoreboard" are.
 *   players         the packet handler (movement, clicks, inventory...).
 *   waiting         what was waited for and why (systems.ts explainWait).
 *   world, saving,  the step itself (time of day, weather, a mod's hook...).
 *   mods' hooks
 *   the rest        the first real method below the part's entry point.
 *
 * Time that belongs to a part but not to one thing in it (the loop over all
 * entities, checking whether a block entity may tick) has no subject and is
 * shown as such, never spread across the things.
 */

import { systemStep, type SystemKey } from './systems.ts';
import { isLibraryFrame, parseMixin, readableMethod } from './owner.ts';

export interface PathState {
  inTick: boolean;
  system: SystemKey | undefined;
  /** The key naming the thing, once found: a class for types, a frame otherwise. */
  subject: string | undefined;
  /**
   * The first real step below the entry point, for time that never reaches
   * one thing (despawn checks, a mod's per-entity hook): named after that.
   */
  fallback: string | undefined;
  /** The fallback is only a mixin wrapper, which a later real step replaces. */
  weak: boolean;
  /** Frames since the part of the game was decided. */
  hops: number;
}

/** The key a path's time is filed under: the thing, else the first step ('~' + frame), else ''. */
export function subjectKey(state: PathState): string {
  return state.subject ?? (state.fallback === undefined ? '' : `~${state.fallback}`);
}

/** Any method Mixin generated (owner.ts parseMixin). */
const WRAPPER = { test: (frame: string): boolean => parseMixin(frame) !== undefined };

/** Frames that only pass the call on: crash guards and mixin bridges. */
const PASSTHROUGH = /mixinextras\$bridge|\.neruina\.handler\.TickHandler\./;

/** A frame that is somebody's own code, not a lambda, a library or a mixin wrapper. */
function plain(frame: string): boolean {
  return !WRAPPER.test(frame) && !isLibraryFrame(frame) && !PASSTHROUGH.test(frame);
}

/** "a.b.Outer$Inner.method" -> "Outer$Inner". */
function classSegment(frame: string): string {
  const parts = frame.split('.');
  return parts[parts.length - 2] ?? '';
}

function classOf(frame: string): string {
  const cut = frame.lastIndexOf('.');
  return cut === -1 ? frame : frame.slice(0, cut);
}

/** One key per thing where the game splits it over classes. */
function normalClass(system: SystemKey, cls: string): string {
  // A lambda belongs to the class that wrote it: "ExecuteCommand$$Lambda$12.0x7e2e..." is ExecuteCommand.
  const outer = cls.replace(/\$\$Lambda.*$|\$Lambda\$.*$/, '');
  return system === 'datapacks' ? outer.replace(/EntitySelectorOptions$/, 'EntitySelector') : outer;
}

interface Rule {
  match: (frame: string) => boolean;
  /** The class (a type) or the whole frame (an action) names the thing. */
  key: 'class' | 'frame';
  /** How far below the entry point to look. */
  limit: number;
  /** Keep taking later matches: the innermost one names the thing. */
  innermost?: boolean;
  /** Plumbing classes never taken as the first step (the loop itself). */
  plumbing?: RegExp;
  /** Mod code injected into the loop, run for every one of them: a thing of its own. */
  hooks?: RegExp;
}

const BLOCK_STATE = /AbstractBlock\$AbstractBlockState|\.AbstractBlock\.|\.FluidState\.|\.Fluid\./;

const RULES: Partial<Record<SystemKey, Rule>> = {
  entities: {
    key: 'class',
    limit: 40,
    plumbing: /^(ServerWorld|World|EntityList)$/,
    hooks: /\.(ServerWorld|World)\.handler\$[a-z0-9]+\$/,
    match: (f) => /\.(tick|method_5773)$/.test(f) && !/^(ServerWorld|World)$/.test(classSegment(f)) && plain(f),
  },
  'block-entities': {
    key: 'class',
    limit: 40,
    plumbing: /^(ServerWorld|World|WorldChunk.*|ChunkPos|ChunkTicketManager|ServerChunkManager|ChunkManager)$/,
    hooks: /\.(World|WorldChunk[$A-Za-z]*)\.handler\$[a-z0-9]+\$/,
    match: (f) =>
      /\.(tick|serverTick|method_\d+)$/.test(f) &&
      !/^(WorldChunk.*|BlockEntityType|BlockEntityTicker|World|ServerWorld)$/.test(classSegment(f)) &&
      plain(f),
  },
  'random-ticks': {
    key: 'class',
    limit: 24,
    plumbing: /^(ServerWorld|World|ServerChunkManager|WorldChunk|ChunkSection)$/,
    match: (f) => /\.(randomTick|method_9514|onRandomTick|method_15757)$/.test(f) && !BLOCK_STATE.test(f) && plain(f),
  },
  'block-updates': {
    key: 'class',
    limit: 24,
    plumbing: /^(ServerWorld|World|WorldTickScheduler|ChunkTickScheduler)$/,
    match: (f) =>
      /\.(scheduledTick|method_9588|onScheduledTick|method_15778|onSyncedBlockEvent|method_9592)$/.test(f) &&
      !BLOCK_STATE.test(f) &&
      !/WorldTickScheduler/.test(f) &&
      plain(f),
  },
  players: {
    key: 'frame',
    limit: 30,
    innermost: true,
    plumbing: /^(ServerNetworkIo|ClientConnection)$/,
    match: (f) =>
      /\.ServerPlayNetworkHandler\.on[A-Z]\w*$/.test(f) || /\.(ServerPlayNetworkHandler|ServerPlayerEntity)\.(tick|playerTick)$/.test(f),
  },
  datapacks: {
    key: 'class',
    limit: Number.POSITIVE_INFINITY,
    innermost: true,
    plumbing: /^(CommandFunctionManager|CommandFunction.*|CommandManager)$/,
    match: (f) =>
      (/\.[A-Z][A-Za-z0-9]*Command[.$]/.test(f) || /\.EntitySelector(Options)?[.$]/.test(f)) &&
      !/\.(CommandManager|CommandFunction|CommandFunctionManager|CommandDispatcher|CommandContext|CommandSource|ServerCommandSource)[.$]/.test(f),
  },
};

/** Tick events (Fabric's, Architectury's): the mod listening, not the event, is the thing. */
const EVENT_DISPATCH = /\$fabric-[a-z-]+-v\d+\$|\.architectury\.event\./;
const EVENT_CODE = /^(net\.fabricmc|dev\.architectury)\./;

/** Parts named by the step itself: each entry point is a different job. */
const BY_ENTRY: ReadonlySet<SystemKey> = new Set(['world', 'saving', 'mod-hooks']);
/** Parts named by the first real method below their entry point. */
const BY_CHILD: ReadonlySet<SystemKey> = new Set(['spawning', 'entity-tracking', 'chunk-loading']);

/** One step down a path: the state after `frame`, given its caller's state. */
export function pathStep(frame: string, parent: PathState | undefined): PathState {
  const step = systemStep(frame, parent);
  if (parent === undefined || parent.system === undefined) {
    if (step.system === undefined) {
      return { inTick: step.inTick, system: undefined, subject: undefined, fallback: undefined, weak: false, hops: 0 };
    }
    return {
      inTick: step.inTick,
      system: step.system,
      subject: BY_ENTRY.has(step.system) ? frame : undefined,
      fallback: undefined,
      weak: false,
      hops: 0,
    };
  }
  const system = parent.system;
  const hops = parent.hops + 1;
  let subject = parent.subject;
  let fallback = parent.fallback;
  let weak = parent.weak;
  const rule = RULES[system];
  if (rule !== undefined) {
    if ((subject === undefined || rule.innermost === true) && hops <= rule.limit && rule.match(frame)) {
      subject = rule.key === 'class' ? normalClass(system, classOf(frame)) : frame;
    } else if (subject === undefined && rule.hooks?.test(frame) === true) {
      subject = frame;
    }
    if (subject === undefined && hops <= 12 && (fallback === undefined || weak)) {
      if (fallback === undefined && WRAPPER.test(frame)) {
        fallback = frame;
        weak = true;
      } else if (plain(frame) && !(rule.plumbing?.test(classSegment(frame)) ?? false)) {
        fallback = frame;
        weak = false;
      }
    }
  } else if (BY_CHILD.has(system)) {
    if (subject === undefined && hops <= 6 && plain(frame)) subject = frame;
  } else if (
    system === 'mod-hooks' &&
    subject !== undefined &&
    EVENT_DISPATCH.test(subject) &&
    hops <= 12 &&
    plain(frame) &&
    !EVENT_CODE.test(frame)
  ) {
    subject = frame;
  }
  return { inTick: parent.inTick, system, subject, fallback, weak, hops };
}

/**
 * Walking the call tree below a thing (analysis/inside.ts): could `frame` be
 * where the thing starts, and does it hand the time below it to another?
 */
export function startsThing(system: SystemKey, key: string, frame: string): boolean {
  if (key.startsWith('~')) return frame === key.slice(1);
  if (frame === key) return true;
  const rule = RULES[system];
  return rule?.key === 'class' && rule.match(frame) && normalClass(system, classOf(frame)) === key;
}

export function leavesThing(system: SystemKey, key: string, frame: string): boolean {
  const rule = RULES[system];
  if (rule === undefined) {
    // A tick event hands its time to the mod listening to it.
    return system === 'mod-hooks' && EVENT_DISPATCH.test(key) && plain(frame) && !EVENT_CODE.test(frame);
  }
  const matches = rule.match(frame);
  if (key.startsWith('~')) {
    if (matches || rule.hooks?.test(frame) === true) return true;
    // A wrapper keeps only the plumbing below it; the next real step is its own thing.
    return WRAPPER.test(key.slice(1)) && plain(frame) && !(rule.plumbing?.test(classSegment(frame)) ?? false);
  }
  if (rule.innermost === true && matches) return (rule.key === 'class' ? normalClass(system, classOf(frame)) : frame) !== key;
  return false;
}

/** The part of the game and the thing a path's own time belongs to. `frames` runs root first. */
export function classifyPath(
  frames: readonly string[],
  category: string,
  explainWait: (frames: readonly string[]) => { cause: string },
): { system: SystemKey | undefined; subject: string } {
  if (category === 'idle') return { system: undefined, subject: '' };
  if (category === 'blocked' || category === 'waiting') return { system: 'waiting', subject: explainWait(frames).cause };
  let state: PathState | undefined;
  for (const frame of frames) state = pathStep(frame, state);
  if (state === undefined) return { system: undefined, subject: '' };
  const system = state.system ?? (state.inTick ? 'other' : undefined);
  return { system, subject: state.system === undefined ? '' : subjectKey(state) };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const SHARED: Partial<Record<SystemKey, string>> = {
  entities: 'Not one type: going through all entities',
  'block-entities': 'Not one type: checking which block entities may tick',
  'random-ticks': 'Not one block: chunk upkeep, weather and lightning',
  'block-updates': 'Not one block: running the update queue',
  players: 'Not one action: connection upkeep',
  datapacks: 'Not one command: running functions',
  spawning: 'Deciding where to spawn',
  'entity-tracking': 'Going through tracked entities',
  'chunk-loading': 'Chunk bookkeeping',
};

const TYPE_NAMES: Record<string, string> = {
  ServerPlayerEntity: 'Players',
  PlayerEntity: 'Players',
  ItemEntity: 'Dropped items',
  ExperienceOrbEntity: 'Experience orbs',
  MobEntity: 'Mobs with no tick of their own',
  PathAwareEntity: 'Mobs with no tick of their own',
  LivingEntity: 'Living entities with no tick of their own',
  Entity: 'Entities with no tick of their own',
  FallingBlockEntity: 'Falling blocks',
  TntEntity: 'Primed TNT',
  ArmorStandEntity: 'Armor stands',
  ItemFrameEntity: 'Item frames',
  MobSpawnerBlockEntity: 'Mob spawners',
  AbstractFurnaceBlockEntity: 'Furnaces',
  HopperBlockEntity: 'Hoppers',
  BeehiveBlockEntity: 'Beehives',
  SignBlockEntity: 'Signs',
  SmartBlockEntityTicker: 'Create machines',
  KineticBlockEntity: 'Create machines',
  EntitySelector: 'Entity selectors (@e, @a, @p…)',
  EntitySelectorOptions: 'Entity selectors (@e, @a, @p…)',
};

const THING: Partial<Record<SystemKey, string>> = {
  entities: 'entity',
  'block-entities': 'block entity',
  'random-ticks': 'random tick',
  'block-updates': 'block update',
  datapacks: 'function run',
  players: 'connection',
};

/** First steps with a plain name, by "Class.method". */
const STEP_NAMES: Record<string, string> = {
  'MobEntity.checkDespawn': 'Despawn checks',
  'Entity.checkDespawn': 'Despawn checks',
  'MobEntity.cannotDespawn': 'Despawn checks',
  'SpawnHelper.spawn': 'Natural spawning',
  'SpawnHelper.spawnEntitiesInChunk': 'Natural spawning',
  'ServerChunkManager.ifChunkLoaded': 'Natural spawning, per loaded chunk',
  'PhantomSpawner.spawn': 'Phantoms',
  'PatrolSpawner.spawn': 'Pillager patrols',
  'CatSpawner.spawn': 'Cats in villages',
  'ZombieSiegeManager.spawn': 'Zombie sieges',
  'WanderingTraderManager.spawn': 'Wandering trader',
  'BlockEntityType.supports': 'Checking each block entity still matches its block',
  'ServerWorld.tickIceAndSnow': 'Ice and snow',
  'PalettedContainer.get': 'Picking random blocks to tick',
  'ServerLoginNetworkHandler.tick': 'Players logging in',
  'ServerWorld.tickPrecipitation': 'Ice and snow',
};

const PACKETS: Record<string, string> = {
  onPlayerMove: 'Player movement',
  onVehicleMove: 'Riding and boats',
  onPlayerInteractBlock: 'Using and placing blocks',
  onPlayerInteractItem: 'Using items',
  onPlayerInteractEntity: 'Interacting with entities',
  onPlayerAction: 'Mining, dropping and swapping items',
  onClickSlot: 'Inventory clicks',
  onCreativeInventoryAction: 'Creative inventory',
  onCustomPayload: 'Mod network messages',
  onHandSwing: 'Arm swings',
  onCommandExecution: 'Commands typed by players',
  onChatMessage: 'Chat',
  onUpdateSelectedSlot: 'Hotbar changes',
  onClientStatus: 'Respawns and statistics',
  onKeepAlive: 'Keep-alive',
  onClientCommand: 'Sneaking, sprinting and beds',
  onPlayerInput: 'Steering vehicles',
  tick: 'Connection upkeep',
  playerTick: 'Player upkeep',
};

function words(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .trim();
}

/** "a.b.VillagerEntity" -> "VillagerEntity"; inner and anonymous classes name their outer class. */
function simpleClass(key: string): string {
  const last = key.split('.').pop() ?? key;
  const parts = last.split('$').filter((p) => p !== '' && !/^\d+$/.test(p) && !/^[a-z]/.test(p));
  return parts[parts.length - 1] ?? last;
}

/** A thing's name in words, for the part it belongs to. */
export function subjectName(system: SystemKey, key: string): string {
  if (key === '') return SHARED[system] ?? 'Not one thing in particular';
  if (key.startsWith('~')) {
    const frame = key.slice(1);
    const wrapper = parseMixin(frame);
    if (wrapper !== undefined) return `${wrapper.mod}’s wrapper around each ${THING[system] ?? 'step'}`;
    return STEP_NAMES[frame.split('.').slice(-2).join('.')] ?? readableMethod(frame);
  }
  const hook = parseMixin(key);
  if (hook !== undefined && RULES[system]?.hooks?.test(key) === true) {
    return `Mod hook on every ${THING[system] ?? 'step'} (${words(hook.method.replace(/^[a-z]+[A-Z]*\$/, ''))})`;
  }
  if (system === 'waiting') return key.charAt(0).toUpperCase() + key.slice(1);
  if (system === 'players') {
    const method = key.split('.').pop() ?? key;
    return PACKETS[method] ?? words(method.replace(/^on/, ''));
  }
  if (RULES[system]?.key === 'class') {
    const cls = simpleClass(key);
    const known = TYPE_NAMES[cls];
    if (known !== undefined) return known;
    if (system === 'datapacks') return `/${cls.replace(/Command$/, '').toLowerCase()}`;
    const stripped =
      system === 'entities'
        ? cls.replace(/Entity$/, '')
        : system === 'block-entities'
          ? cls.replace(/(Block)?(Entity|Tile|TileEntity|Ticker)$/, '')
          : cls.replace(/Block$/, '');
    return words(stripped === '' ? cls : stripped);
  }
  return STEP_NAMES[key.split('.').slice(-2).join('.')] ?? readableMethod(key);
}
