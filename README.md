# Token Radar — pre-token protocols ranked by implied value

[![make.fun bounty](https://make.fun/badge/token-radar-01.svg)](https://make.fun/competitions/token-radar-01)
[![token radar rank](https://make.fun/badge/token-radar-01/donooyuhuu/makefun-token-radar/rank.svg)](https://make.fun/competitions/token-radar-01)
[![token radar reward](https://make.fun/badge/token-radar-01/donooyuhuu/makefun-token-radar/reward.svg)](https://make.fun/competitions/token-radar-01)

An entry for make.fun's **token-radar-01** bounty: a program that reads a sealed
DefiLlama snapshot of 758 protocols and hands in a web dashboard ranking the ones
with no token yet by what a launch would be worth, each with the steps to farm it.

## What it does

`main.ts` (Node 22, standard library only) reads the snapshot, scores every
pre-token protocol the watchlist's own rule keeps — 40 on the watchlist plus 158
more below the floor, 197 rows in all — and writes `board.json`, the dashboard's
`data.js`, and `dossier.json` (via the vendored `vendor/makefun-board.ts`).

## The model (radar-2)

A flat multiple would value a lending market and a capital allocator the same.
This model calibrates the multiple from the market itself:

- **Comparables:** live-token protocols in the same category, each with a market
  cap and a TVL, whose market-cap / TVL ratio falls in [0.001, 10].
- **Multiple:** the category's median ratio, shrunk toward the market-wide median
  with a prior weight of 10, then clamped to [0.05, 1.50]. A category with many
  comps speaks for itself; a thin one is pulled toward the market as a whole.
- **Growth:** `1 + clamp(change_7d, -60, 120) / 100 × 0.5`.
- **Maturity:** `0.6 + min(age_days, 1095) / 1095 × 0.4` (unknown age: 365 days).
- **Implied value:** `round(TVL × multiple × growth × maturity)`.

Every row carries its working — the category median, how many comps set it, the
global median, both multipliers — so the dashboard can recompute and check it.
Wrapped, staked and bridged products of tokens that already trade, versioned
pools and exchange products are excluded from the board entirely, and live-token
protocols are set aside with their market caps shown, never mixed into the ranking.

Nothing here promises a token or an airdrop. Implied value is an estimate for
ranking, never a price, and never a prediction that a token is issued.

## The dashboard

`dashboard/` is a static page with no network: a sortable, filterable board
(search, category, chain, watchlist-only), a top-ten spotlight, a live-token
view, a detail drawer for every protocol (its model working and its eight-step
farm plan), and a methodology section with the model's limits. It renders from
`data.js`, written beside it by `main.ts`.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path to snapshot.json>
```

Then open `out/dashboard/index.html` in a browser. The run is deterministic:
two runs write byte-identical `board.json` and `dossier.json`.

## Layout

- `main.ts` — the entrypoint: reads the snapshot, writes the board, the data,
  copies `dashboard/` and `screenshots/`, writes the dossier.
- `lib/model.ts` — the comparables model, the board builder, the farm plans.
- `vendor/makefun-board.ts` — make.fun's dossier library, vendored as shipped.
- `dashboard/` — `index.html`, `app.css`, `app.js` (no network, no framework).
- `screenshots/` — the board, a protocol detail view, a filtered view.
- `input/` is not shipped: the grader mounts the sealed snapshot at `/input`.
