/**
 * What is worth doing about a cost: its MSPT, and its fix outlook.
 *
 * These used to be folded into a star rating. Stars hid the two things a
 * person actually weighs -- how big is it, and could anyone realistically
 * fix it -- behind one opaque number, so a 0.5 MSPT cost in the game's own
 * code and a 0.5 MSPT cost in your own mod looked alike. Now both are shown
 * as themselves:
 *
 *   MSPT      measured; the default order.
 *   outlook   a plain label with its reason, from facts only:
 *
 *     known-fix       fixed here before, fixed upstream, or avoidable by a
 *                     setting (your own earlier investigations say so)
 *     own-mod         in one of your own mods: you can change it directly
 *     pattern         matches a pattern that has been fixable before (a
 *                     detector, or an open investigation of the same thing)
 *     mod             mod code nobody has checked yet: could be easy
 *     mod-driven      the game's code, but reached through a mod, which is
 *                     where a fix would go
 *     game            the game's own work with no mod anywhere in the call
 *                     path: usually needs a performance mod or a setting
 *     checked-needed  investigated before and found necessary
 *
 * The rule that matters most: the app never decides on its own that
 * something is hard. "Game's own work" is a statement about who owns the
 * code, which the profile shows; "checked: needed" only ever comes from a
 * conclusion someone actually reached. A mod anywhere in the path means the
 * mod is named as the place to look, so an easy patch in mod code is never
 * written off as "vanilla".
 *
 * "Best chance to win MSPT back" orders by cost x how likely the outlook is
 * to pay off x how solid the evidence is. It is an order, not a verdict:
 * every finding stays listed, and the inputs are always shown.
 */

import type { Feasibility } from './detectors.ts';

export type Risk = 'unknown' | 'low' | 'medium' | 'high';

/** Who, if anyone, could act on this (the profile's own evidence). */
export type Actionability =
  /** Owned by a mod: there is somewhere to send a patch. */
  | 'mod'
  /** The game's or Java's code, but a mod appears in the call path and is the real subject. */
  | 'mod-driven'
  /** The game's or Java's code with no mod anywhere in the path. */
  | 'engine';

export type Outlook = 'known-fix' | 'own-mod' | 'pattern' | 'mod' | 'mod-driven' | 'game' | 'checked-needed';

export type KnowledgeVerdict = 'fixed-here' | 'no-benefit-here' | 'fixed-upstream' | 'config-switch' | 'necessary' | 'open';

export const OUTLOOKS: Record<Outlook, { label: string; tone: 'good' | 'maybe' | 'hard' | 'done'; weight: number }> = {
  'known-fix': { label: 'Known fix', tone: 'good', weight: 1 },
  'own-mod': { label: 'Your own mod', tone: 'good', weight: 1 },
  pattern: { label: 'Matches a fixable pattern', tone: 'good', weight: 0.9 },
  mod: { label: 'Mod code, not checked yet', tone: 'maybe', weight: 0.7 },
  'mod-driven': { label: 'Game code driven by a mod', tone: 'maybe', weight: 0.5 },
  game: { label: 'Game’s own work', tone: 'hard', weight: 0.25 },
  'checked-needed': { label: 'Checked: needed', tone: 'done', weight: 0.02 },
};

/** The order outlooks are listed in, most promising first. */
export const OUTLOOK_ORDER: readonly Outlook[] = ['known-fix', 'own-mod', 'pattern', 'mod', 'mod-driven', 'game', 'checked-needed'];

export interface PriorityInput {
  /** Measured: own time in ms per tick. */
  msPerTick: number;
  /** Measured: fraction of observed windows in which the path appeared, 0..1. */
  persistence: number;
  /** Measured: approximate sample count behind the figure. */
  samples: number;
  /** Measured: ratio of worst window to typical window. */
  volatility?: number;
  /** Measured: how many distinct days the path has been observed. */
  daysObserved?: number;
  /** From detectors and earlier investigations; `unknown` unless one says otherwise. */
  feasibility?: Feasibility;
  /** Not measurable from a profile. */
  risk?: Risk;
  /** Who could act on this. Defaults to 'mod'. */
  actionability?: Actionability;
  /** The mod the time is attributed to (owner, or the mod it is reached through). */
  mod?: string | null;
  /** Whether that mod is one of yours. */
  ownMod?: boolean;
  /** Conclusions of earlier investigations of this exact thing. */
  verdicts?: readonly KnowledgeVerdict[];
}

export interface PriorityBreakdown {
  outlook: Outlook;
  /** One sentence: why this outlook. */
  outlookWhy: string;
  /** MSPT x the outlook's chance x evidence: the "best chance to win MSPT back" order. */
  winBack: number;
  /** Worth a look now: a real chance at a real cost, on solid evidence. */
  top: boolean;
  /** Server-thread seconds per day at 20 TPS. */
  secondsPerDay: number;
  confidence: 'thin' | 'moderate' | 'strong';
  /** Plain-language reasons, shown with the outlook. */
  rationale: string[];
}

const EVIDENCE: Record<PriorityBreakdown['confidence'], number> = { thin: 0.5, moderate: 0.85, strong: 1 };

export function outlookOf(input: PriorityInput): { outlook: Outlook; why: string } {
  const verdicts = input.verdicts ?? [];
  const mod = input.mod ?? undefined;
  if (verdicts.includes('necessary')) {
    return { outlook: 'checked-needed', why: 'An earlier investigation of this found the work necessary.' };
  }
  if (verdicts.includes('fixed-here') || verdicts.includes('fixed-upstream') || verdicts.includes('config-switch')) {
    const how = verdicts.includes('config-switch') ? 'a setting avoids it' : verdicts.includes('fixed-upstream') ? 'it was fixed upstream' : 'it was fixed here before';
    return { outlook: 'known-fix', why: `Earlier work says ${how}; check it applies to this version.` };
  }
  if (input.ownMod === true && mod !== undefined) {
    return { outlook: 'own-mod', why: `${mod} is one of your own mods, so the code can be changed directly.` };
  }
  if (input.feasibility === 'likely' || input.feasibility === 'proven' || verdicts.includes('open')) {
    return { outlook: 'pattern', why: 'It matches a pattern that has been fixable before; confirm it in the source.' };
  }
  switch (input.actionability ?? 'mod') {
    case 'mod':
      return {
        outlook: 'mod',
        why: `${mod ?? 'A mod'}’s own code, and nobody has looked at it yet: it may well be easy, and reading the source is the way to find out.`,
      };
    case 'mod-driven':
      return {
        outlook: 'mod-driven',
        why: `The game’s code, but ${mod ?? 'a mod'} is what calls it this much, so a fix would go in ${mod ?? 'that mod'}.`,
      };
    default:
      return {
        outlook: 'game',
        why: 'The game’s own work, with no mod anywhere in the call path: usually needs a performance mod or a setting rather than a patch.',
      };
  }
}

export function prioritise(input: PriorityInput): PriorityBreakdown {
  const { outlook, why } = outlookOf(input);
  const confidence: PriorityBreakdown['confidence'] =
    input.samples < 30 ? 'thin' : input.samples < 1000 ? 'moderate' : 'strong';
  const riskFactor = input.risk === 'high' ? 0.6 : input.risk === 'medium' ? 0.9 : 1;
  const winBack = Math.max(0, input.msPerTick) * OUTLOOKS[outlook].weight * EVIDENCE[confidence] * riskFactor;
  const secondsPerDay = (input.msPerTick * 20 * 86400) / 1000;

  const rationale: string[] = [
    input.msPerTick >= 0.1
      ? `Costs ${input.msPerTick.toFixed(2)} MSPT, ${secondsPerDay.toFixed(0)} s of tick time a day.`
      : `Small per tick (${input.msPerTick.toFixed(3)} MSPT) but ${secondsPerDay.toFixed(0)} s of tick time a day.`,
    why,
  ];
  const persistence = Math.max(0, Math.min(1, input.persistence));
  if (persistence >= 0.9) rationale.push('Present in almost every minute.');
  else if (persistence <= 0.25) rationale.push('Only in some minutes.');
  if ((input.daysObserved ?? 0) >= 7) rationale.push(`Seen across ${input.daysObserved} days.`);
  if ((input.volatility ?? 1) >= 4) rationale.push('Spiky: its worst minutes are far above its typical ones.');
  if (confidence === 'thin') rationale.push(`Only ~${input.samples} samples, so treat the figure as provisional.`);
  if (input.risk === 'high') rationale.push('Marked as risky to change for gameplay.');

  return {
    outlook,
    outlookWhy: why,
    winBack,
    top: winBack >= 0.1 && confidence !== 'thin' && outlook !== 'checked-needed',
    secondsPerDay,
    confidence,
    rationale,
  };
}

/** Mod ids that are yours, from the setting ("mymod, myprefix"). */
/** The "Your own mods" setting as a list of id prefixes. */
export function ownModPrefixes(setting: string): string[] {
  return setting
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== '');
}

export function ownModMatcher(setting: string): (mod: string | null | undefined) => boolean {
  const prefixes = ownModPrefixes(setting);
  return (mod) => mod !== null && mod !== undefined && prefixes.some((p) => mod.toLowerCase().startsWith(p));
}
