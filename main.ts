// werewolf-agent-01 entry: a pure-code Werewolf agent. No model calls at all:
// every decision is computed from the game's view and the trial seed, so the
// entry needs no provider key, spends nothing, and replays byte for byte.
//
// The edge over the house baseline (a frontier model asked plainly, with no
// strategy and no memory across decisions) is structure: this agent keeps a
// full model of the game in code and reasons from it on every decision.
//
//   - Evidence ledger: every revealed role, every vote, every claim and
//     every contradiction in the public log is parsed and scored.
//   - Suspicion scoring: votes that exiled a villager, defence of a
//     revealed wolf, and seer claims contradicted by a reveal all raise
//     suspicion; votes that exiled a wolf and inspections that check out
//     lower it. A known wolf is voted without hesitation.
//   - Role play: the seer inspects the most suspicious unknown seat and
//     claims with a found wolf; the doctor protects the credible seer or
//     the most trusted villager; the werewolf agrees with its partner's
//     kill, kills the most dangerous villager, and steers the vote onto
//     the village's own top suspect while never voting its partner.
//   - Debate: short evidence-based statements (who voted how, who claimed
//     what, what the night deaths say), never a bare accusation.
//   - Deterministic: no clock, no Math.random, no unseeded randomness.
//     The only randomness is a seeded pick (trial seed + game) for the
//     seer's first inspection, when no evidence exists yet.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const CONCURRENCY = 10;
export const MAX_CHARS_DEFAULT = 500;

type Seat = number;
type Role = 'werewolf' | 'seer' | 'doctor' | 'villager';
type DecisionKind = 'speak' | 'vote' | 'kill' | 'protect' | 'inspect';

export interface Player {
  seat: Seat;
  name: string;
  alive: boolean;
  role: string | null;
}

export interface LogEntry {
  seq: number;
  day: number;
  kind: string;
  died?: Seat;
  role?: string;
  order?: Seat[];
  seat?: Seat;
  round?: number;
  text?: string;
  target?: Seat | null;
  tally?: { seat: Seat; votes: number }[];
  winner?: string | null;
  winners?: Seat[];
  [k: string]: unknown;
}

export interface View {
  day: number;
  phase: string;
  you: {
    seat: Seat;
    name: string;
    role: string;
    alive: boolean;
    partner: { seat: Seat; name: string; alive: boolean } | null;
  };
  players: Player[];
  seerResults: { night: number; seat: Seat; werewolf: boolean }[] | null;
  lastProtect: { night: number; seat: Seat } | null;
  wolfVotes: { night: number; seat: Seat; target: Seat | null }[] | null;
  log: LogEntry[];
  outcome: { winner: string | null; reason: string; day: number; winners: Seat[] } | null;
}

export interface Pending {
  game: number;
  decision: DecisionKind;
  options?: Seat[];
  max_chars?: number;
  view: View;
}

interface Observed {
  games: number;
  finished: number;
  done: boolean;
  pending: Pending[];
}

// ---------------------------------------------------------------- utilities

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** A deterministic pick in [0, n): sha256 of the trial seed, the game and a label. */
export function seededPick(seed: string, game: number, label: string, n: number): number {
  if (n <= 0) return 0;
  const h = createHash('sha256').update(`${seed}:${game}:${label}`).digest();
  return h.readUInt32BE(0) % n;
}

/** A statement folded to one line the env's way, cut to max_chars. */
export function foldStatement(text: string, maxChars: number): string {
  const folded = text
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
  if ([...folded].length <= maxChars) return folded;
  return [...folded].slice(0, maxChars).join('').trim();
}

export function nameOf(view: View, seat: Seat): string {
  return view.players.find((p) => p.seat === seat)?.name ?? `seat ${seat}`;
}

export function aliveSeats(view: View): Seat[] {
  return view.players.filter((p) => p.alive).map((p) => p.seat);
}

export function revealedRole(view: View, seat: Seat): string | null {
  return view.players.find((p) => p.seat === seat)?.role ?? null;
}

// ---------------------------------------------------------------- the ledger

interface Claim {
  seat: Seat;
  role: 'seer' | 'doctor';
  inspections: { target: Seat; werewolf: boolean }[];
  protects: Seat[];
}

export interface Ledger {
  knownWolves: Set<Seat>;
  knownInnocents: Set<Seat>;
  claims: Map<Seat, Claim>;
  /** Votes per day: voter -> target (null = abstain). */
  votesByDay: Map<number, Map<Seat, Seat | null>>;
  /** Speeches per seat (today and earlier), in order. */
  speeches: Map<Seat, string[]>;
  /** Passes per seat per day. */
  passesByDay: Map<number, Set<Seat>>;
  /** Seats that died at night, in order, with their revealed roles. */
  nightDeaths: { seat: Seat; role: string | null }[];
}

/** Find a seat by name (case-insensitive) or by "seat N" in a text. */
function findSeat(view: View, text: string): Seat | null {
  const lower = text.toLowerCase();
  for (const p of view.players) {
    if (lower.includes(p.name.toLowerCase())) return p.seat;
  }
  const m = /seat\s+(\d+)/i.exec(text);
  if (m) {
    const seat = Number(m[1]);
    if (view.players.some((p) => p.seat === seat)) return seat;
  }
  return null;
}

function parseClaims(view: View, ledger: Ledger): void {
  for (const entry of view.log) {
    if (entry.kind !== 'speech' || typeof entry.text !== 'string' || entry.seat === undefined) continue;
    const speaker = entry.seat;
    const text = entry.text;
    ledger.speeches.set(speaker, [...(ledger.speeches.get(speaker) ?? []), text]);
    const claim = ledger.claims.get(speaker) ?? { seat: speaker, role: 'seer', inspections: [], protects: [] };
    let touched = false;
    if (/\b(i'?m|i am|me)\b[^.!?]{0,40}\bseer\b/i.test(text) || /\bseer here\b/i.test(text)) {
      claim.role = 'seer';
      touched = true;
    }
    if (/\b(i'?m|i am|me)\b[^.!?]{0,40}\bdoctor\b/i.test(text) || /\bdoctor here\b/i.test(text)) {
      claim.role = 'doctor';
      touched = true;
    }
    const inspectMatch = /(inspected|checked|looked at|investigated|viewed|scryed)\s+(seat\s+\d+|[A-Z][a-z]+)/i.exec(text);
    if (inspectMatch) {
      const target = findSeat(view, inspectMatch[2] ?? '');
      if (target !== null) {
        const wolf = /\b(is a|is|was)\b[^.!?]{0,20}\b(werewolf|wolf)\b/i.test(text) && !/\b(not|isn'?t|no)\b[^.!?]{0,20}\b(werewolf|wolf)\b/i.test(text);
        const innocent = /\b(not a|isn'?t a|is not|no)\b[^.!?]{0,20}\b(werewolf|wolf)\b/i.test(text) || /\b(innocent|clear|villager|not a wolf)\b/i.test(text);
        if (wolf || innocent) {
          claim.role = 'seer';
          claim.inspections.push({ target, werewolf: wolf && !innocent });
          touched = true;
        }
      }
    }
    const protectMatch = /protected\s+(seat\s+\d+|[A-Z][a-z]+)/i.exec(text);
    if (protectMatch) {
      const target = findSeat(view, protectMatch[1] ?? '');
      if (target !== null) {
        claim.role = 'doctor';
        claim.protects.push(target);
        touched = true;
      }
    }
    if (touched) ledger.claims.set(speaker, claim);
  }
}

export function buildLedger(view: View): Ledger {
  const ledger: Ledger = {
    knownWolves: new Set(),
    knownInnocents: new Set(),
    claims: new Map(),
    votesByDay: new Map(),
    speeches: new Map(),
    passesByDay: new Map(),
    nightDeaths: [],
  };
  for (const p of view.players) {
    if (p.role === 'werewolf') ledger.knownWolves.add(p.seat);
    else if (p.role !== null) ledger.knownInnocents.add(p.seat);
  }
  if (view.seerResults) {
    for (const r of view.seerResults) {
      if (r.werewolf) ledger.knownWolves.add(r.seat);
      else ledger.knownInnocents.add(r.seat);
    }
  }
  for (const entry of view.log) {
    if (entry.kind === 'vote' && entry.seat !== undefined) {
      const dayVotes = ledger.votesByDay.get(entry.day) ?? new Map<Seat, Seat | null>();
      dayVotes.set(entry.seat, entry.target ?? null);
      ledger.votesByDay.set(entry.day, dayVotes);
    } else if (entry.kind === 'pass' && entry.seat !== undefined) {
      const dayPasses = ledger.passesByDay.get(entry.day) ?? new Set<Seat>();
      dayPasses.add(entry.seat);
      ledger.passesByDay.set(entry.day, dayPasses);
    } else if (entry.kind === 'dawn' && entry.died !== undefined) {
      ledger.nightDeaths.push({ seat: entry.died, role: entry.role ?? null });
    }
  }
  parseClaims(view, ledger);
  return ledger;
}

// ---------------------------------------------------------------- suspicion

export interface Scores {
  /** suspicion per living seat: higher = more likely a werewolf. */
  score: Map<Seat, number>;
  /** whether a seer claimant's story has been contradicted by a reveal. */
  contradicted: Set<Seat>;
  /** whether a seer claimant has an inspection confirmed by a reveal. */
  confirmed: Set<Seat>;
}

/**
 * Suspicion from the public record, plus private knowledge when usePrivate
 * is true (my own seer results). The werewolf side scores with usePrivate
 * false: that is what the village can see, which is what its votes follow.
 */
export function scoreSuspicion(view: View, ledger: Ledger, usePrivate: boolean): Scores {
  const score = new Map<Seat, number>();
  const contradicted = new Set<Seat>();
  const confirmed = new Set<Seat>();
  const knownWolves = new Set(ledger.knownWolves);
  const knownInnocents = new Set(ledger.knownInnocents);
  if (!usePrivate) {
    // Drop what only my seat knows: my seer results.
    if (view.you.role === 'seer' && view.seerResults) {
      for (const r of view.seerResults) {
        knownWolves.delete(r.seat);
        knownInnocents.delete(r.seat);
      }
    }
  }
  for (const seat of aliveSeats(view)) {
    if (knownWolves.has(seat)) score.set(seat, 100);
    else if (knownInnocents.has(seat)) score.set(seat, -100);
    else score.set(seat, 0);
  }
  const bump = (seat: Seat, n: number): void => {
    if (!score.has(seat)) return;
    const cur = score.get(seat)!;
    if (cur >= 100 || cur <= -100) return;
    score.set(seat, cur + n);
  };
  // Seer claims: check each claimed inspection against the reveals.
  for (const [seat, claim] of ledger.claims) {
    if (claim.role !== 'seer') continue;
    for (const insp of claim.inspections) {
      const role = revealedRole(view, insp.target);
      if (role === null) continue;
      if ((role === 'werewolf') === insp.werewolf) confirmed.add(seat);
      else contradicted.add(seat);
    }
  }
  for (const seat of contradicted) bump(seat, 8);
  for (const seat of confirmed) bump(seat, -6);
  // A claimed inspection moves its target: more when the claimant checks out.
  for (const [seat, claim] of ledger.claims) {
    if (claim.role !== 'seer') continue;
    const weight = contradicted.has(seat) ? 0 : confirmed.has(seat) ? 5 : 2;
    for (const insp of claim.inspections) {
      if (insp.werewolf) bump(insp.target, weight);
      else bump(insp.target, -weight);
    }
  }
  // Votes: exiling a revealed villager is suspicious, exiling a wolf is not.
  for (const [, dayVotes] of ledger.votesByDay) {
    for (const [voter, target] of dayVotes) {
      if (target === null) continue;
      const role = revealedRole(view, target);
      // The target's role is known only if it was exiled and revealed; the
      // exile entry carries it, and players[].role carries it too.
      if (role === 'werewolf') bump(voter, -4);
      else if (role !== null) bump(voter, 4);
    }
  }
  // Speeches: accusing or defending a revealed wolf, judged after the reveal.
  for (const [seat, texts] of ledger.speeches) {
    for (const text of texts) {
      for (const wolf of ledger.knownWolves) {
        if (revealedRole(view, wolf) === null) continue;
        const name = nameOf(view, wolf);
        if (!text.toLowerCase().includes(name.toLowerCase())) continue;
        if (/\b(wolf|werewolf|suspect|vote|guilty)\b/i.test(text)) bump(seat, -3);
        else if (/\b(trust|clear|innocent|defend|not a wolf)\b/i.test(text)) bump(seat, 3);
      }
    }
  }
  // Silence: a seat that never speaks at all while passing day after day
  // is hiding, but only up to +3: quiet villagers exist too.
  {
    const silentDays = new Map<Seat, number>();
    for (const [day, passes] of ledger.passesByDay) {
      if (day >= view.day) continue;
      for (const seat of passes) {
        if ((ledger.speeches.get(seat) ?? []).length === 0) {
          silentDays.set(seat, (silentDays.get(seat) ?? 0) + 1);
        }
      }
    }
    for (const [seat, days] of silentDays) bump(seat, Math.min(days, 3));
  }
  // A seer claimant killed at night was silenced: their claims gain weight.
  for (const death of ledger.nightDeaths) {
    const claim = ledger.claims.get(death.seat);
    if (claim?.role !== 'seer') continue;
    for (const insp of claim.inspections) {
      if (insp.werewolf) bump(insp.target, 3);
    }
  }
  return { score, contradicted, confirmed };
}

/** The village's view of who is most suspicious, best first (ties: low seat). */
export function rankedSuspects(view: View, scores: Scores): Seat[] {
  return aliveSeats(view)
    .filter((s) => s !== view.you.seat)
    .sort((a, b) => (scores.score.get(b) ?? 0) - (scores.score.get(a) ?? 0) || a - b);
}

/** Current day's vote tally from the log. */
export function currentTally(view: View): Map<Seat, number> {
  const tally = new Map<Seat, number>();
  for (const entry of view.log) {
    if (entry.kind === 'vote' && entry.day === view.day && entry.target !== undefined && entry.target !== null) {
      tally.set(entry.target, (tally.get(entry.target) ?? 0) + 1);
    }
  }
  return tally;
}

/** How many speeches I have already made today (which debate round this is). */
export function mySpeechesToday(view: View): number {
  return view.log.filter(
    (e) => e.kind === 'speech' && e.day === view.day && e.seat === view.you.seat,
  ).length;
}

/** Seats that have accused me in today's debate. */
export function myAccusers(view: View): Seat[] {
  const out: Seat[] = [];
  for (const entry of view.log) {
    if (entry.kind !== 'speech' || entry.day !== view.day || entry.seat === undefined || typeof entry.text !== 'string') continue;
    if (entry.seat === view.you.seat) continue;
    const text = entry.text.toLowerCase();
    if (text.includes(view.you.name.toLowerCase()) && /\b(wolf|werewolf|suspect|vote|guilty)\b/i.test(text)) out.push(entry.seat);
  }
  return out;
}

// ---------------------------------------------------------------- decisions

export interface ActBody {
  game: number;
  decision: DecisionKind;
  target?: Seat | null;
  text?: string;
  pass?: boolean;
}

function fallbackFor(p: Pending): ActBody {
  return p.decision === 'speak'
    ? { game: p.game, decision: 'speak', pass: true }
    : { game: p.game, decision: p.decision, target: null };
}

function validTarget(p: Pending, target: Seat | null): Seat | null {
  if (target === null) return null;
  return (p.options ?? []).includes(target) ? target : null;
}

/** The seer's inspection pick: most suspicious unknown, else the quietest. */
export function pickInspect(view: View, ledger: Ledger, scores: Scores, seed: string, game: number): Seat | null {
  const candidates = aliveSeats(view).filter((s) => s !== view.you.seat && !ledger.knownWolves.has(s) && !ledger.knownInnocents.has(s));
  if (candidates.length === 0) return null;
  if (view.day <= 1 && (view.seerResults ?? []).length === 0) {
    return candidates[seededPick(seed, game, 'inspect-night-1', candidates.length)] ?? null;
  }
  const ranked = [...candidates].sort(
    (a, b) => (scores.score.get(b) ?? 0) - (scores.score.get(a) ?? 0) || a - b,
  );
  return ranked[0] ?? null;
}

/** The doctor's protection pick: credible seer first, then most trusted. */
export function pickProtect(view: View, ledger: Ledger, scores: Scores, options: Seat[]): Seat | null {
  if (options.length === 0) return null;
  const alive = new Set(aliveSeats(view));
  const opts = options.filter((s) => alive.has(s) && !ledger.knownWolves.has(s));
  if (opts.length === 0) return null;
  for (const [seat, claim] of ledger.claims) {
    if (claim.role === 'seer' && scores.confirmed.has(seat) && opts.includes(seat)) return seat;
  }
  for (const [seat, claim] of ledger.claims) {
    if (claim.role === 'seer' && !scores.contradicted.has(seat) && opts.includes(seat)) return seat;
  }
  const ranked = [...opts].sort((a, b) => (scores.score.get(a) ?? 0) - (scores.score.get(b) ?? 0) || a - b);
  return ranked[0] ?? null;
}

/**
 * How dangerous a villager is to the werewolves: a seer claimant who named
 * me or my partner, a trusted analyst, a correct accuser. Used for kills.
 */
export function dangerOf(view: View, ledger: Ledger, scores: Scores, seat: Seat): number {
  let danger = -(scores.score.get(seat) ?? 0);
  const claim = ledger.claims.get(seat);
  if (claim?.role === 'seer') {
    danger += 6;
    for (const insp of claim.inspections) {
      if (insp.werewolf && (insp.target === view.you.seat || insp.target === view.you.partner?.seat)) danger += 10;
    }
  }
  const texts = ledger.speeches.get(seat) ?? [];
  for (const text of texts) {
    const lower = text.toLowerCase();
    for (const wolfSeat of [view.you.seat, view.you.partner?.seat]) {
      if (wolfSeat === undefined) continue;
      if (lower.includes(nameOf(view, wolfSeat).toLowerCase()) && /\b(wolf|werewolf|suspect|vote|guilty)\b/i.test(text)) danger += 2;
    }
  }
  return danger;
}

/** The werewolves' kill pick: agree with the partner, else the most dangerous villager. */
export function pickKill(view: View, ledger: Ledger, scores: Scores, options: Seat[]): Seat | null {
  if (options.length === 0) return null;
  const partner = view.you.partner;
  const tonight = (view.wolfVotes ?? []).filter((v) => v.night === view.day);
  if (partner !== null) {
    const partnerVote = tonight.find((v) => v.seat === partner.seat);
    if (partnerVote?.target !== undefined && partnerVote.target !== null && options.includes(partnerVote.target)) {
      return partnerVote.target;
    }
  }
  const ranked = [...options].sort((a, b) => dangerOf(view, ledger, scores, b) - dangerOf(view, ledger, scores, a) || a - b);
  return ranked[0] ?? null;
}

/** The village's vote pick: known wolf first, else suspicion + bandwagon. */
export function pickVoteVillage(view: View, scores: Scores, options: Seat[]): Seat | null {
  const tally = currentTally(view);
  const ranked = [...options].sort((a, b) => {
    const sa = (scores.score.get(a) ?? 0) + 2 * (tally.get(a) ?? 0);
    const sb = (scores.score.get(b) ?? 0) + 2 * (tally.get(b) ?? 0);
    return sb - sa || a - b;
  });
  return ranked[0] ?? null;
}

/** The werewolf's vote pick: the village's top suspect, never the partner. */
export function pickVoteWolf(view: View, scores: Scores, options: Seat[]): Seat | null {
  const partner = view.you.partner?.seat;
  const tally = currentTally(view);
  const ranked = [...options]
    .filter((s) => s !== partner)
    .sort((a, b) => {
      const sa = (scores.score.get(a) ?? 0) + 2 * (tally.get(a) ?? 0);
      const sb = (scores.score.get(b) ?? 0) + 2 * (tally.get(b) ?? 0);
      return sb - sa || a - b;
    });
  return ranked[0] ?? null;
}

function evidenceFor(view: View, ledger: Ledger, scores: Scores, target: Seat): string {
  const bits: string[] = [];
  const claim = ledger.claims.get(target);
  if (claim?.role === 'seer' && scores.contradicted.has(target)) bits.push('claimed seer but the reveal proved them wrong');
  const votes = [...ledger.votesByDay.values()].flatMap((m) => [...m.entries()]);
  const wrongExiles = votes.filter(([voter, t]) => voter === target && t !== null && revealedRole(view, t) !== null && revealedRole(view, t) !== 'werewolf').length;
  if (wrongExiles > 0) bits.push(wrongExiles === 1 ? 'voted to exile a villager once' : `voted to exile a villager ${wrongExiles} times`);
  return bits.join('; ');
}

function speakText(p: Pending, ledger: Ledger, scores: Scores): string | null {
  const view = p.view;
  const me = view.you;
  const max = p.max_chars ?? MAX_CHARS_DEFAULT;
  const round = mySpeechesToday(view) + 1;
  // The werewolf never pushes its own partner: exclude the partner from the
  // suspects it can name, or a no-evidence tie-break could point at them.
  const suspects = rankedSuspects(view, scores).filter((s) => s !== me.partner?.seat);
  const top = suspects[0] ?? null;
  const knownWolf = [...ledger.knownWolves].find((s) => s !== me.seat && aliveSeats(view).includes(s)) ?? null;
  const accusers = myAccusers(view);

  // Round 2: answer an accusation against me first.
  if (round >= 2 && accusers.length > 0) {
    const accuser = accusers[0]!;
    if (me.role === 'werewolf') {
      return foldStatement(`${nameOf(view, accuser)} is guessing: I have voted with the village every day, and the night deaths point away from me. Look at who benefits from this accusation.`, max);
    }
    return foldStatement(`${nameOf(view, accuser)} is wrong about me. I am ${me.role === 'villager' ? 'a villager' : `the ${me.role}`}, and my votes are on the record. The wolf is still at the table: look at ${top !== null ? nameOf(view, top) : 'the quiet ones'}.`, max);
  }

  if (me.role === 'werewolf') {
    const partner = me.partner?.seat;
    if (knownWolf !== null && knownWolf === partner && partner !== undefined && aliveSeats(view).includes(partner)) {
      return foldStatement(`Do not rush ${nameOf(view, partner)}: the case is one claim with no reveal behind it. ${top !== null && top !== partner ? `${nameOf(view, top)} has the worse record, and the night kill points there.` : 'The night kill points elsewhere.'}`, max);
    }
    if (top !== null) {
      const ev = evidenceFor(view, ledger, scores, top);
      return foldStatement(`${nameOf(view, top)} is the one to look at${ev !== '' ? `: ${ev}` : ''}. I will vote there.`, max);
    }
    return foldStatement('No one has shown their hand yet. I will watch the votes: the wolves are the ones steering them.', max);
  }

  if (me.role === 'seer') {
    if (knownWolf !== null) {
      const result = (view.seerResults ?? []).find((r) => r.seat === knownWolf);
      return foldStatement(`I am the seer. I inspected ${nameOf(view, knownWolf)} on night ${result?.night ?? view.day} and they are a werewolf. Vote ${nameOf(view, knownWolf)} today.`, max);
    }
    if (top !== null) {
      return foldStatement(`${nameOf(view, top)} looks worst to me so far. I have cleared ${[...ledger.knownInnocents].filter((s) => s !== me.seat).map((s) => nameOf(view, s)).join(', ') || 'no one yet'}. Keep the pressure on ${nameOf(view, top)}.`, max);
    }
    return foldStatement('Nothing is proven yet. I am watching the votes: whoever steered yesterday\'s exile is worth a look.', max);
  }

  if (knownWolf !== null) {
    return foldStatement(`${nameOf(view, knownWolf)} is a werewolf: the seer's inspection says so. Vote ${nameOf(view, knownWolf)} today, and do not let the wolves change the subject.`, max);
  }
  if (top !== null) {
    const ev = evidenceFor(view, ledger, scores, top);
    return foldStatement(`${nameOf(view, top)} is my strongest suspicion${ev !== '' ? `: ${ev}` : ''}. I will vote there unless someone shows me better evidence.`, max);
  }
  return foldStatement('No strong lead yet. I will watch who pushes the vote and who stays quiet.', max);
}

/** One decision, computed from the view alone. */
export function decide(p: Pending, seed: string): ActBody {
  const view = p.view;
  if (!view.you.alive || view.outcome !== null) return fallbackFor(p);
  const ledger = buildLedger(view);
  const role = view.you.role as Role;
  // The werewolf reads the village's scores (what the table can see); the
  // village side reads its own private knowledge too.
  const scores = scoreSuspicion(view, ledger, role !== 'werewolf');

  switch (p.decision) {
    case 'speak': {
      const text = speakText(p, ledger, scores);
      if (text === null || text === '') return fallbackFor(p);
      return { game: p.game, decision: 'speak', text };
    }
    case 'vote': {
      const options = (p.options ?? []).filter((s) => s !== view.you.seat && aliveSeats(view).includes(s));
      if (options.length === 0) return fallbackFor(p);
      const target = role === 'werewolf' ? pickVoteWolf(view, scores, options) : pickVoteVillage(view, scores, options);
      return { game: p.game, decision: 'vote', target: validTarget(p, target) };
    }
    case 'kill': {
      const options = (p.options ?? []).filter((s) => aliveSeats(view).includes(s));
      const target = pickKill(view, ledger, scores, options);
      return { game: p.game, decision: 'kill', target: validTarget(p, target) };
    }
    case 'protect': {
      const options = (p.options ?? []).filter((s) => aliveSeats(view).includes(s));
      const target = pickProtect(view, ledger, scores, options);
      return { game: p.game, decision: 'protect', target: validTarget(p, target) };
    }
    case 'inspect': {
      const options = (p.options ?? []).filter((s) => s !== view.you.seat && aliveSeats(view).includes(s));
      const target = pickInspect(view, ledger, scores, seed, p.game);
      return { game: p.game, decision: 'inspect', target: validTarget(p, target) };
    }
  }
}

// ---------------------------------------------------------------- the run

interface Reply {
  status: number;
  body: unknown;
}

async function readReply(res: Response): Promise<Reply> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

export interface RunOptions {
  envUrl?: string;
  brief?: string;
  seed?: string;
  log?: (line: string) => void;
}

export interface RunSummary {
  decisions: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function run(o: RunOptions = {}): Promise<RunSummary> {
  const env = process.env;
  const envUrl = (o.envUrl ?? env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') throw new Error('MAKEFUN_ENV_URL is needed');
  const seed = o.seed ?? env.MAKEFUN_TRIAL_SEED ?? 'werewolf-agent-01';
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (o.brief === undefined) {
    const file = env.MAKEFUN_PROMPT_FILE ?? '';
    if (file === '') throw new Error('MAKEFUN_PROMPT_FILE is needed');
    readFileSync(file, 'utf8');
  }
  const summary: RunSummary = { decisions: 0 };

  const envPost = async (path: string, body: unknown): Promise<Reply> =>
    readReply(await fetch(`${envUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

  /** One decision: compute it from the view and post it, falling back on refusal. */
  const decideOne = async (p: Pending): Promise<void> => {
    summary.decisions += 1;
    let act: ActBody;
    try {
      act = decide(p, seed);
    } catch {
      act = fallbackFor(p);
    }
    let posted = await envPost('/act', act);
    if (posted.status === 400 && JSON.stringify(act) !== JSON.stringify(fallbackFor(p))) {
      posted = await envPost('/act', fallbackFor(p));
    }
    if (posted.status !== 200 && posted.status !== 409) throw new Error(`POST /act answered ${posted.status}`);
  };

  // A decision is known by its game, its kind and how far its game's log has
  // come: the same decision is listed again on every /observe until it is
  // answered, and never started twice.
  const keyOf = (p: Pending): string => `${p.game}:${p.decision}:${p.view.log.length}`;
  const inFlight = new Map<string, Promise<void>>();
  const started = new Set<string>();
  const errors: string[] = [];
  for (;;) {
    const r = await envPost('/observe', {});
    if (r.status !== 200 || !isRecord(r.body)) throw new Error(`POST /observe answered ${r.status}`);
    const obs = r.body as unknown as Observed;
    if (obs.done) break;
    for (const p of obs.pending) {
      const key = keyOf(p);
      if (started.has(key) || inFlight.size >= CONCURRENCY) continue;
      started.add(key);
      const task = decideOne(p)
        .catch((err: unknown) => {
          errors.push(`game ${p.game}: ${(err as Error).message}`);
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, task);
    }
    const waiting = obs.pending.some((p) => !started.has(keyOf(p)));
    if (inFlight.size > 0 && (inFlight.size >= CONCURRENCY || !waiting)) await Promise.race(inFlight.values());
    else if (inFlight.size === 0 && obs.pending.length > 0 && !waiting) await sleep(250);
    if (errors.length > 0) break;
  }
  await Promise.all(inFlight.values());
  if (errors.length > 0) throw new Error(`the env failed: ${errors.join('; ')}`);
  log(`werewolf agent: ${summary.decisions} decisions, no model calls`);
  return summary;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    await run();
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(`werewolf agent: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  }
}
