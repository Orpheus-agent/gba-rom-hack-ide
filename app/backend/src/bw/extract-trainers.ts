/* BW demake - extract trainers from the Lillipup xlsx into staging JSON.
 * Read-only on the xlsx; writes only to <editor>/.bw-extract/trainers.json.
 * Run: tsx app/backend/src/bw/extract-trainers.ts */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readXlsxSheet } from './xlsx.js';

const XLSX = 'C:/path/to/Pokémon Black Trainer info (Lillipup).xlsx';
const OUT = 'C:/path/to/gba-rom-hack-ide/.bw-extract/trainers.json';

interface BwMon {
  species: string;
  gender: string | null;
  level: number | null;
  nature: string | null;
  ability: string | null;
  item: string | null;
  moves: string[];
  ivs: string | null;
}
interface BwTrainer {
  battle: string;
  trainer: string;
  location: string;
  battleType: string;
  party: BwMon[];
}

function clean(v: string | undefined): string {
  return (v ?? '').trim();
}
function nz(v: string | undefined): string | null {
  const s = clean(v);
  return s && !/^(none|-+|n\/a| - |–)$/i.test(s) ? s : null;
}

async function main(): Promise<void> {
  const bytes = await fs.readFile(XLSX);
  const sheet = readXlsxSheet(bytes);
  console.log('headers:', JSON.stringify(sheet.headers));
  console.log('data rows:', sheet.rows.length);
  console.log('first 3 rows:', JSON.stringify(sheet.rows.slice(0, 3), null, 1));

  // Forward-fill the battle-level columns (continuation rows leave them blank),
  // then group consecutive rows by Battle (fallback Trainer).
  const fillCols = ['Battle', 'Trainer', 'Battle Type', 'Location'];
  const filled: Array<Record<string, string>> = [];
  const last: Record<string, string> = {};
  for (const row of sheet.rows) {
    const r = { ...row };
    for (const c of fillCols) {
      const cur = clean(r[c]);
      const prev = last[c];
      if (cur) last[c] = cur;
      else if (prev) r[c] = prev;
    }
    filled.push(r);
  }

  const trainers: BwTrainer[] = [];
  let cur: BwTrainer | null = null;
  let curKey = '';
  for (const r of filled) {
    if (!nz(r['Pokemon'])) continue; // skip rows without a mon
    const key = `${clean(r['Battle'])}|${clean(r['Trainer'])}|${clean(r['Location'])}`;
    if (key !== curKey) {
      cur = {
        battle: clean(r['Battle']),
        trainer: clean(r['Trainer']),
        location: clean(r['Location']),
        battleType: clean(r['Battle Type']),
        party: [],
      };
      trainers.push(cur);
      curKey = key;
    }
    const levelNum = Number.parseInt(clean(r['Level']), 10);
    cur!.party.push({
      species: clean(r['Pokemon']),
      gender: nz(r['Gender']),
      level: Number.isFinite(levelNum) ? levelNum : null,
      nature: nz(r['Nature']),
      ability: nz(r['Ability']),
      item: nz(r['Item']),
      moves: ['Move 1', 'Move 2', 'Move 3', 'Move 4'].map((c) => nz(r[c])).filter((m): m is string => !!m),
      ivs: nz(r['IVs']),
    });
  }

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(trainers, null, 2) + '\n', 'utf8');

  console.log(`\n=> ${String(trainers.length)} trainers, ${String(trainers.reduce((n, t) => n + t.party.length, 0))} mons → ${OUT}`);
  console.log('first 2 trainers:', JSON.stringify(trainers.slice(0, 2), null, 1));
  const names = [...new Set(trainers.map((t) => t.trainer))];
  console.log(`distinct trainer names: ${String(names.length)}; sample:`, names.slice(0, 12));
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
