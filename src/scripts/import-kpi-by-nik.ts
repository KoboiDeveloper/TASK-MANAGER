import { PrismaClient } from '@prisma/client';
import * as XLSX from '../../../TASKMANAGER-FE/node_modules/xlsx';

const FILE = process.argv[2] || 'c:\\Users\\basko\\Downloads\\Template_KPI_HRD_2026_NIK.xls';
const TEMPLATE_MONTH = 11;

const METHODS: Record<string, string> = {
  '≥ target': 'gte',
  '>= target': 'gte',
  '≤ target': 'lte',
  '<= target': 'lte',
  'tanggal pasti': 'fixed-date',
  'hari terlambat': 'late-days',
  'jumlah temuan': 'findings',
  'zero tolerance': 'zero',
  'kpi bawahan': 'subordinate',
};

type Due = { day: number; month?: number };
type TargetRow = { text: string; methodId: string; targetValue: number | null; due: Due | null };
type KpiRow = { title: string; weight: number; breakdown: string[]; targets: TargetRow[] };
type Person = { nik: string; name: string; escalation: string[]; kpis: KpiRow[] };

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function lines(value: unknown): string[] {
  return text(value)
    .split(/\r?\n/)
    .map((line) => line.replace(/^[•\-\u2022]\s*/, '').trim())
    .filter(Boolean);
}

function nikOf(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  if (/^\d+(\.0+)?$/.test(raw)) return raw.replace(/\.0+$/, '').padStart(8, '0');
  return raw;
}

function weightOf(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const percent = number <= 1 ? number * 100 : number;
  return Math.round(percent * 100) / 100;
}

function targetValue(value: unknown): number | null {
  const raw = text(value);
  if (!raw || raw === '-') return null;
  const number = Number(raw.replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function dueOf(value: unknown): Due | null {
  if (value == null || value === '' || value === '-') return null;
  let year = 0;
  let month = 0;
  let day = 0;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    year = value.getFullYear();
    month = value.getMonth() + 1;
    day = value.getDate();
  } else if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    year = parsed.y;
    month = parsed.m;
    day = parsed.d;
  } else {
    return null;
  }
  if (!year || !month || !day) return null;
  return month === TEMPLATE_MONTH ? { day } : { day, month };
}

function methodId(value: unknown, nik: string, target: string): string {
  const key = text(value).toLowerCase();
  const id = METHODS[key];
  if (!id) throw new Error(`Metode tidak dikenal untuk ${nik}: ${text(value)} (${target})`);
  return id;
}

function parsePeople(rows: unknown[][]): Person[] {
  const people: Person[] = [];
  let current: Person | null = null;
  let kpi: KpiRow | null = null;
  for (const row of rows.slice(4)) {
    const department = text(row[0]);
    if (department.toLowerCase().startsWith('ringkasan')) {
      current = null;
      kpi = null;
      continue;
    }
    const nik = nikOf(row[2]);
    if (/^\d{8}$/.test(nik)) {
      current = { nik, name: text(row[3]), escalation: [], kpis: [] };
      people.push(current);
      kpi = null;
    }
    if (!current) continue;
    const escalation = lines(row[8]);
    if (escalation.length && current.escalation.length === 0) current.escalation = escalation;
    const title = text(row[4]).replace(/^\d+\.\s*/, '');
    const target = text(row[7]);
    const methodName = text(row[10]);
    if (title && !/^(total bobot|bobot kpi|jumlah nilai|nilai akhir|kategori)/i.test(title)) {
      kpi = {
        title,
        weight: weightOf(row[9]) ?? 0,
        breakdown: lines(row[5]),
        targets: [],
      };
      current.kpis.push(kpi);
    }
    if (!target || !kpi || !methodName || /total bobot/i.test(methodName)) continue;
    kpi.targets.push({
      text: target.slice(0, 1000),
      methodId: methodId(methodName, current.nik, target),
      targetValue: targetValue(row[11]),
      due: dueOf(row[6]),
    });
  }
  return people.filter((person) => person.kpis.length > 0);
}

async function main() {
  const book = XLSX.readFile(FILE, { cellDates: false });
  const sheet = book.Sheets['KPI Per Jabatan'];
  if (!sheet) throw new Error('Sheet KPI Per Jabatan tidak ditemukan');
  const people = parsePeople(XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' }));
  if (people.length === 0) throw new Error('Tidak ada KPI yang terbaca');
  for (const person of people) {
    const empty = person.kpis.find((item) => item.targets.length === 0 || !item.title);
    if (empty) throw new Error(`KPI ${person.nik} belum lengkap: ${empty.title || '(tanpa judul)'}`);
  }

  const prisma = new PrismaClient();
  try {
    const niks = people.map((person) => person.nik);
    const summary = await prisma.$transaction(async (tx) => {
      const existing = await tx.dT_KPI.findMany({
        where: { ownerNik: { in: niks } },
        select: { id: true },
      });
      const kpiIds = existing.map((row) => row.id);
      let removedEntries = 0;
      if (kpiIds.length) {
        const targets = await tx.dT_KPI_TARGET.findMany({
          where: { kpiId: { in: kpiIds } },
          select: { id: true },
        });
        const targetIds = targets.map((row) => row.id);
        if (targetIds.length) {
          const entries = await tx.dT_KPI_ENTRY.findMany({
            where: { targetId: { in: targetIds } },
            select: { id: true },
          });
          const entryIds = entries.map((row) => row.id);
          removedEntries = entryIds.length;
          if (entryIds.length) {
            await tx.dT_KPI_ENTRY_FILE.deleteMany({ where: { entryId: { in: entryIds } } });
            await tx.dT_KPI_ENTRY.deleteMany({ where: { id: { in: entryIds } } });
          }
          await tx.dT_KPI_TARGET.deleteMany({ where: { id: { in: targetIds } } });
        }
        await tx.dT_KPI.deleteMany({ where: { id: { in: kpiIds } } });
      }

      for (const person of people) {
        for (const [index, item] of person.kpis.entries()) {
          await tx.dT_KPI.create({
            data: {
              ownerNik: person.nik,
              departmentId: null,
              title: item.title.slice(0, 500),
              weight: item.weight,
              seasonal: false,
              breakdown: JSON.stringify(item.breakdown),
              escalation: JSON.stringify(person.escalation),
              sortOrder: index,
              createdBy: person.nik,
              updatedBy: person.nik,
              targets: {
                create: item.targets.map((target, targetIndex) => ({
                  text: target.text,
                  methodId: target.methodId,
                  targetValue: target.targetValue,
                  dueDate: null,
                  dueDay: target.due?.day ?? null,
                  dueMonth: target.due?.month ?? null,
                  sortOrder: targetIndex,
                })),
              },
            },
          });
        }
      }
      return {
        removedKpis: kpiIds.length,
        removedEntries,
        people: people.map((person) => ({
          nik: person.nik,
          name: person.name,
          kpis: person.kpis.length,
          targets: person.kpis.reduce((sum, item) => sum + item.targets.length, 0),
        })),
      };
    });
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
