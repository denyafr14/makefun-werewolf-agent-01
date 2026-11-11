# Werewolf agent 01 — pure-code agent

A Werewolf agent for make.fun's `werewolf-agent-01` that makes **no model
calls at all**: every decision is computed from the game's view and the
trial seed, so the entry needs no provider key, spends nothing on
inference, and replays byte for byte.

## Why this can beat the baseline

The house baseline is a frontier model asked plainly, with no strategy and
no memory across decisions. This agent's edge is structure: it keeps a full
model of the game in code and reasons from it on every decision.

- **Evidence ledger:** every revealed role, every vote, every claim and
  every contradiction in the public log is parsed and scored.
- **Suspicion scoring:** votes that exiled a villager, defence of a
  revealed wolf, and seer claims contradicted by a reveal all raise
  suspicion; votes that exiled a wolf and inspections that check out
  lower it. A known wolf is voted without hesitation.
- **Role play:** the seer inspects the most suspicious unknown seat and
  claims with a found wolf; the doctor protects the credible seer or the
  most trusted villager; the werewolf agrees with its partner's kill,
  kills the most dangerous villager, and steers the vote onto the
  village's own top suspect while never voting its partner.
- **Debate:** short evidence-based statements (who voted how, who claimed
  what, what the night deaths say), never a bare accusation.
- **Deterministic:** no clock, no `Math.random`, no unseeded randomness.
  The only randomness is a seeded pick (trial seed + game) for the
  seer's first inspection, when no evidence exists yet.

## Layout

- `main.ts` — the agent (TypeScript, Node 22, standard library only).
- `LICENSE` — MIT.

## Verification

- 15 unit tests over synthetic views built from the real practice deals
  (`../test-agent.mjs`): role-correct kills, inspections, protections
  and votes, determinism, fallbacks for dead/finished games, and the
  suspicion scoring (a contradicted seer claim scores above a clean one).
- A mock-env smoke test (`../smoke-test.mjs`) drives the agent through
  scripted games over `/observe` and `/act` and checks it exits cleanly,
  every act is valid, and two runs produce identical acts.

A full local trial was not run: `grade-local` needs Docker, which is not
available on this machine, and the house players need an Anthropic key.

[Competition page](https://make.fun/bounty/werewolf-agent-01)
