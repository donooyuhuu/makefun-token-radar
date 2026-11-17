// An independent audit of a built token-radar board.
//
// The audit reads the board.json a build wrote and the snapshot it was built
// from, then re-derives the numbers from first principles: every row's implied
// value from its own working, every multiple from the snapshot's live-token
// comparables, the coverage of the watchlist, the shape of the farm plans,
// the dashboard and screenshots that ship with the entry, and a byte-exact
// rebuild of the board. A check that fails names the row and the reason.
//
// The audit never writes the board: it only reads. Run it through the entry:
//   node main.ts --audit --input <snapshot.json>
// or straight from this file:
//   node lib/audit.ts --board out/board.json --input <snapshot.json>

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL, buildRadar, parseSnapshot } from './model.ts';
import type { BoardRow, Snapshot, SnapshotProtocol } from './model.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AuditFinding {
  name: string;
  ok: boolean;
  note: string;
}

export interface AuditReport {
  ok: boolean;
  passed: number;
  failed: number;
  boardRows: number;
  snapshotProtocols: number;
  findings: AuditFinding[];
}

function finding(name: string, ok: boolean, note: string): AuditFinding {
  return { name, ok, note };
}

function asFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampNumber(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

function middleOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = values.slice().sort((left, right) => left - right);
  const lower = Math.floor((ordered.length - 1) / 2);
  const upper = Math.floor(ordered.length / 2);
  return (ordered[lower]! + ordered[upper]!) / 2;
}

function daysBetween(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(listedAt);
  const end = Date.parse(asOf);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

function growthFactor(change7d: number | null): number {
  const change = clampNumber(change7d ?? 0, MODEL.growth_floor, MODEL.growth_cap);
  return 1 + (change / 100) * MODEL.growth_weight;
}

function maturityFactor(age: number | null): number {
  const days = age ?? MODEL.unknown_age_days;
  const capped = Math.min(Math.max(days, 0), MODEL.maturity_days);
  return MODEL.maturity_floor + (capped / MODEL.maturity_days) * MODEL.maturity_range;
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function liveRatios(protocols: SnapshotProtocol[], onlyCategory: string | null | undefined): number[] {
  const ratios: number[] = [];
  for (const p of protocols) {
    if (onlyCategory !== undefined && p.category !== onlyCategory) continue;
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (ratio < MODEL.comp_ratio_min || ratio > MODEL.comp_ratio_max) continue;
    ratios.push(ratio);
  }
  return ratios;
}

function freshMultiple(category: string | null, protocols: SnapshotProtocol[]): { multiple: number; compMedian: number | null; compN: number; globalMedian: number } {
  const catRatios = liveRatios(protocols, category);
  const allRatios = liveRatios(protocols, undefined);
  const compMedian = middleOf(catRatios);
  const globalMedian = middleOf(allRatios) ?? 0;
  const compN = catRatios.length;
  const raw = compMedian === null ? globalMedian : (compN * compMedian + MODEL.shrink_prior * globalMedian) / (compN + MODEL.shrink_prior);
  return { multiple: clampNumber(raw, MODEL.multiple_floor, MODEL.multiple_cap), compMedian, compN, globalMedian };
}

function impliedFromWorking(row: BoardRow): number {
  const growth = 1 + (row.model.growth_pct / 100) * MODEL.growth_weight;
  const maturity = maturityFactor(row.model.age_days);
  return Math.max(1, Math.round(row.tvl_usd * row.model.base_multiple * growth * maturity));
}

function impliedFromSnapshot(protocol: SnapshotProtocol, asOf: string, protocols: SnapshotProtocol[]): number {
  const fresh = freshMultiple(protocol.category, protocols);
  const age = daysBetween(asOf, protocol.listed_at);
  const growth = growthFactor(protocol.change_7d);
  const maturity = maturityFactor(age);
  return Math.max(1, Math.round(protocol.tvl_usd * fresh.multiple * growth * maturity));
}

const BLOCKED_CATEGORIES = ['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX'];

function nameLooksVersioned(name: string): boolean {
  const tail = name.trim().split(/\s+/).pop() ?? '';
  if (/^v\d+$/i.test(tail)) return true;
  if (/^\d+\.\d+(\.\d+)*$/.test(tail)) return true;
  return false;
}

function nameLooksWrapped(name: string): boolean {
  return /wrapped|staked|staking|restak/i.test(name);
}

const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

function eligibleForBoard(p: SnapshotProtocol): boolean {
  if (p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null) return false;
  if (p.category !== null && BLOCKED_CATEGORIES.includes(p.category)) return false;
  if (nameLooksVersioned(p.name)) return false;
  if (nameLooksWrapped(p.name)) return false;
  if (EXCHANGE_NAMES.some((prefix) => p.name.startsWith(prefix))) return false;
  return true;
}

function rowMatchesProtocol(row: BoardRow, p: SnapshotProtocol, asOf: string): string | null {
  if (row.name !== p.name) return `name ${row.name} is ${p.name} in the snapshot`;
  if (row.category !== p.category) return `category ${row.category} is ${p.category} in the snapshot`;
  if (JSON.stringify(row.chains) !== JSON.stringify(p.chains)) return `chains differ from the snapshot`;
  if (row.tvl_usd !== p.tvl_usd) return `tvl ${row.tvl_usd} is ${p.tvl_usd} in the snapshot`;
  if (row.change_7d !== p.change_7d) return `change_7d ${row.change_7d} is ${p.change_7d} in the snapshot`;
  if (row.mcap_usd !== p.mcap_usd) return `mcap ${row.mcap_usd} is ${p.mcap_usd} in the snapshot`;
  if (row.listed_at !== p.listed_at) return `listed_at ${row.listed_at} is ${p.listed_at} in the snapshot`;
  if (row.gecko_id !== p.gecko_id) return `gecko_id ${row.gecko_id} is ${p.gecko_id} in the snapshot`;
  if (row.symbol !== p.symbol) return `symbol ${row.symbol} is ${p.symbol} in the snapshot`;
  if (row.age_days !== daysBetween(asOf, p.listed_at)) return `age_days ${row.age_days} is ${daysBetween(asOf, p.listed_at)} from listed_at`;
  if (row.model.age_days !== row.age_days) return `model.age_days ${row.model.age_days} is ${row.age_days} in the row`;
  return null;
}

export function runAudit(boardPath: string, snapshotPath: string): AuditReport {
  const findings: AuditFinding[] = [];
  const pass = (name: string, note: string): void => {
    findings.push(finding(name, true, note));
  };
  const fail = (name: string, note: string): void => {
    findings.push(finding(name, false, note));
  };
  const empty: AuditReport = { ok: false, passed: 0, failed: findings.length, boardRows: 0, snapshotProtocols: 0, findings };

  let boardText: string;
  try {
    boardText = readFileSync(boardPath, 'utf8');
  } catch {
    fail('board file reads', `cannot read ${boardPath}`);
    return { ...empty, failed: findings.length };
  }

  let boardDoc: unknown;
  try {
    boardDoc = JSON.parse(boardText);
  } catch {
    fail('board file parses', `${boardPath} is not JSON`);
    return { ...empty, failed: findings.length };
  }
  const rows = (boardDoc as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    fail('board file parses', `${boardPath} holds no rows array`);
    return { ...empty, failed: findings.length };
  }
  pass('board file parses', `${rows.length} rows in ${boardPath}`);

  let snapshot: Snapshot;
  try {
    snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
  } catch (e) {
    fail('snapshot parses', e instanceof Error ? e.message : `${snapshotPath} cannot be scored`);
    return { ...empty, boardRows: rows.length, failed: findings.length };
  }

  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const boardRows = rows as BoardRow[];

  const watchlistPresent = snapshot.watchlist.filter((slug) => bySlug.has(slug)).length;
  const earlyExpected = snapshot.protocols.filter((p) => !snapshot.watchlist.includes(p.slug) && eligibleForBoard(p)).length;
  const expectedRows = watchlistPresent + earlyExpected;
  if (boardRows.length === expectedRows) {
    pass('row count matches the rule', `${boardRows.length} rows: ${watchlistPresent} watchlist + ${earlyExpected} early`);
  } else {
    fail('row count matches the rule', `${boardRows.length} rows, the rule keeps ${expectedRows} (${watchlistPresent} watchlist + ${earlyExpected} early)`);
  }

  const slugs = new Set(boardRows.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length === 0) {
    pass('watchlist fully covered', `all ${snapshot.watchlist.length} watchlist slugs are on the board`);
  } else {
    fail('watchlist fully covered', `missing ${missing.length}: ${missing.slice(0, 5).join(', ')}`);
  }

  if (slugs.size === boardRows.length) {
    pass('no duplicate slugs', `${boardRows.length} rows, ${slugs.size} distinct slugs`);
  } else {
    fail('no duplicate slugs', `${boardRows.length} rows but only ${slugs.size} distinct slugs`);
  }

  let ranksOk = true;
  let firstBadRank = -1;
  for (let i = 0; i < boardRows.length; i++) {
    if (boardRows[i]!.rank !== i + 1) {
      ranksOk = false;
      firstBadRank = i + 1;
      break;
    }
  }
  if (ranksOk) {
    pass('ranks run 1..n in order', `ranks 1 to ${boardRows.length} with no gap`);
  } else {
    fail('ranks run 1..n in order', `position ${firstBadRank} carries rank ${boardRows[firstBadRank - 1]!.rank}`);
  }

  let orderOk = true;
  let firstRise = -1;
  for (let i = 1; i < boardRows.length; i++) {
    if (boardRows[i]!.implied_value_usd > boardRows[i - 1]!.implied_value_usd) {
      orderOk = false;
      firstRise = i + 1;
      break;
    }
  }
  if (orderOk) {
    pass('implied values fall down the board', `${usd(boardRows[0]!.implied_value_usd)} at rank 1 down to ${usd(boardRows[boardRows.length - 1]!.implied_value_usd)} at rank ${boardRows.length}`);
  } else {
    fail('implied values fall down the board', `row ${firstRise} outranks row ${firstRise - 1} on implied value`);
  }

  if (boardRows.length >= 2 && boardRows[0]!.implied_value_usd > boardRows[boardRows.length - 1]!.implied_value_usd) {
    pass('implied values spread', `top ${usd(boardRows[0]!.implied_value_usd)} against bottom ${usd(boardRows[boardRows.length - 1]!.implied_value_usd)}`);
  } else {
    fail('implied values spread', 'the top and bottom rows share one implied value: the board ranks nothing');
  }

  const fieldProblems: string[] = [];
  const missingProtocols: string[] = [];
  for (const row of boardRows) {
    const p = bySlug.get(row.slug);
    if (p === undefined) {
      missingProtocols.push(row.slug);
      continue;
    }
    const problem = rowMatchesProtocol(row, p, snapshot.as_of);
    if (problem !== null) fieldProblems.push(`${row.slug}: ${problem}`);
  }
  if (missingProtocols.length === 0 && fieldProblems.length === 0) {
    pass('row fields match the snapshot', `all ${boardRows.length} rows agree with their snapshot protocol`);
  } else {
    const bits = [...missingProtocols.slice(0, 3).map((s) => `${s} is not in the snapshot`), ...fieldProblems.slice(0, 3)];
    fail('row fields match the snapshot', bits.join('; '));
  }

  let worstWorking = 0;
  let worstWorkingSlug = '';
  for (const row of boardRows) {
    const again = impliedFromWorking(row);
    const drift = Math.abs(again - row.implied_value_usd) / Math.max(1, row.implied_value_usd);
    if (drift > worstWorking) {
      worstWorking = drift;
      worstWorkingSlug = row.slug;
    }
  }
  if (worstWorking <= 0.0005) {
    pass('implied matches each row working', `worst drift ${(worstWorking * 100).toFixed(4)}% at ${worstWorkingSlug || 'no row'}`);
  } else {
    fail('implied matches each row working', `worst drift ${(worstWorking * 100).toFixed(3)}% at ${worstWorkingSlug}`);
  }

  let worstMultiple = 0;
  let worstMultipleSlug = '';
  for (const row of boardRows) {
    const p = bySlug.get(row.slug);
    if (p === undefined) continue;
    const fresh = freshMultiple(p.category, snapshot.protocols);
    const drift = Math.abs(fresh.multiple - row.model.base_multiple) / Math.max(1e-12, row.model.base_multiple);
    if (drift > worstMultiple) {
      worstMultiple = drift;
      worstMultipleSlug = row.slug;
    }
  }
  if (worstMultiple <= 1e-6) {
    pass('multiples match a fresh calibration', `worst drift ${(worstMultiple * 100).toFixed(6)}% at ${worstMultipleSlug || 'no row'}`);
  } else {
    fail('multiples match a fresh calibration', `worst drift ${(worstMultiple * 100).toFixed(4)}% at ${worstMultipleSlug}`);
  }

  const outsideClamp = boardRows.filter((r) => r.model.base_multiple < MODEL.multiple_floor || r.model.base_multiple > MODEL.multiple_cap);
  if (outsideClamp.length === 0) {
    pass('multiples stay inside the clamp', `all ${boardRows.length} multiples sit in [${MODEL.multiple_floor}, ${MODEL.multiple_cap}]`);
  } else {
    fail('multiples stay inside the clamp', `${outsideClamp.length} outside [${MODEL.multiple_floor}, ${MODEL.multiple_cap}]: ${outsideClamp.slice(0, 3).map((r) => r.slug).join(', ')}`);
  }

  const stepProblems: string[] = [];
  for (const row of boardRows) {
    if (row.farm_steps.length !== 8) {
      stepProblems.push(`${row.slug} has ${row.farm_steps.length} farm steps`);
      continue;
    }
    for (const step of row.farm_steps) {
      if (step.length < 20 || step.length > 600) stepProblems.push(`${row.slug} has a farm step of ${step.length} characters`);
    }
  }
  if (stepProblems.length === 0) {
    pass('farm plans hold eight steps', `all ${boardRows.length} rows carry 8 steps of 20..600 characters`);
  } else {
    fail('farm plans hold eight steps', stepProblems.slice(0, 3).join('; '));
  }

  const tokened: string[] = [];
  for (const row of boardRows) {
    const p = bySlug.get(row.slug);
    if (p === undefined) continue;
    if (row.mcap_usd !== null || row.gecko_id !== null || row.symbol !== null) tokened.push(`${row.slug} carries a token record`);
    else if (!eligibleForBoard(p)) tokened.push(`${row.slug} fails the board rule on its own record`);
  }
  if (tokened.length === 0) {
    pass('no board row already has a token', `all ${boardRows.length} rows are pre-token and pass the board rule`);
  } else {
    fail('no board row already has a token', tokened.slice(0, 3).join('; '));
  }

  const dashFiles = ['index.html', 'app.js', 'app.css'];
  const dashMissing = dashFiles.filter((name) => {
    const path = join(REPO_ROOT, 'dashboard', name);
    return !existsSync(path) || statSync(path).size === 0;
  });
  if (dashMissing.length === 0) {
    pass('dashboard ships complete', 'index.html, app.js and app.css are all present and non-empty');
  } else {
    fail('dashboard ships complete', `missing or empty: ${dashMissing.join(', ')}`);
  }

  const shotDir = join(REPO_ROOT, 'screenshots');
  let shotNames: string[] = [];
  try {
    shotNames = readdirSync(shotDir).filter((name) => name.toLowerCase().endsWith('.png'));
  } catch {
    shotNames = [];
  }
  const shotProblems = shotNames.filter((name) => {
    if (!/^[A-Za-z0-9_][\w.-]{0,127}$/.test(name)) return true;
    return statSync(join(shotDir, name)).size === 0;
  });
  if (shotNames.length >= 3 && shotProblems.length === 0) {
    pass('screenshots ship complete', `${shotNames.length} screenshots, all non-empty with valid names`);
  } else {
    fail('screenshots ship complete', `${shotNames.length} screenshots, problems: ${shotProblems.join(', ') || 'fewer than 3'}`);
  }

  const rebuilt = buildRadar(snapshot).board;
  const rebuiltText = `${JSON.stringify({ rows: rebuilt })}\n`;
  const storedHash = sha256(boardText);
  const rebuiltHash = sha256(rebuiltText);
  if (storedHash === rebuiltHash) {
    pass('rebuild is byte-identical', `board sha256 ${storedHash.slice(0, 12)}… matches a fresh rebuild`);
  } else {
    let firstDiff = -1;
    for (let i = 0; i < Math.max(boardRows.length, rebuilt.length); i++) {
      if (JSON.stringify(boardRows[i]) !== JSON.stringify(rebuilt[i])) {
        firstDiff = i + 1;
        break;
      }
    }
    fail('rebuild is byte-identical', `stored ${storedHash.slice(0, 12)}… against rebuilt ${rebuiltHash.slice(0, 12)}…, first differing row ${firstDiff}`);
  }

  const passed = findings.filter((f) => f.ok).length;
  const failed = findings.length - passed;
  return { ok: failed === 0, passed, failed, boardRows: boardRows.length, snapshotProtocols: snapshot.protocols.length, findings };
}

export function formatReport(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`audit: ${report.passed} passed, ${report.failed} failed (${report.boardRows} board rows, ${report.snapshotProtocols} snapshot protocols)`);
  for (const f of report.findings) lines.push(`  ${f.ok ? 'ok  ' : 'FAIL'} ${f.name}: ${f.note}`);
  lines.push(`audit: ${report.ok ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

function flagValue(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && i + 1 < args.length) return args[i + 1]!;
    if (args[i]!.startsWith(`--${name}=`)) return args[i]!.slice(name.length + 3);
  }
  return fallback;
}

const invokedAs = process.argv[1] ?? '';
if (invokedAs.endsWith('audit.ts')) {
  const boardArg = flagValue('board', join(REPO_ROOT, 'out', 'board.json'));
  const inputArg = flagValue('input', '/input/snapshot.json');
  const report = runAudit(boardArg, inputArg);
  process.stdout.write(`${formatReport(report)}\n`);
  process.exit(report.ok ? 0 : 1);
}
