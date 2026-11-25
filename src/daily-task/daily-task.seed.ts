export const ANDI_NIK = '00000030';

export const KPI_METHODS = [
  { id: 'gte', name: '≥ Target', hint: 'Isi persentase atau jumlah realisasi. Contoh: 96', formula: 'MIN(100, realisasi ÷ target × 100)' },
  { id: 'lte', name: '≤ Target', hint: 'Isi realisasi dalam persen. Contoh: 95. Angka 0 dihitung 100.', formula: 'MIN(100, target ÷ realisasi × 100)' },
  { id: 'fixed-date', name: 'Tanggal Pasti', hint: 'Isi tanggal selesai. Contoh: 12/11/2026', formula: 'Tepat waktu 100, telat 1 hari kerja 75, 2 hari 50, 3 hari 25, lebih dari itu 0' },
  { id: 'late-days', name: 'Hari Terlambat', hint: 'Isi jumlah hari kerja terlambat. 0 berarti tepat waktu.', formula: '100 − 25 × hari terlambat, minimal 0' },
  { id: 'findings', name: 'Jumlah Temuan', hint: 'Isi jumlah temuan. 0 berarti tidak ada temuan.', formula: '100 − 25 × jumlah temuan, minimal 0' },
  { id: 'zero', name: 'Zero Tolerance', hint: 'Isi jumlah kejadian. 0 berarti tidak ada kejadian.', formula: '0 kejadian = 100, satu atau lebih = 0' },
  { id: 'subordinate', name: 'KPI Bawahan', hint: 'Isi rata-rata nilai akhir KPI bawahan. Contoh: 92,5', formula: 'MIN(100, realisasi ÷ target × 100)' },
] as const;

export const KPI_CATEGORIES = [
  { id: 'cat-90', min: 90, label: 'Sangat Baik' },
  { id: 'cat-80', min: 80, label: 'Baik' },
  { id: 'cat-70', min: 70, label: 'Cukup' },
  { id: 'cat-0', min: 0, label: 'Perlu Perbaikan' },
] as const;

const ESCALATION = [
  'WAJIB LAPOR ke atasan langsung maks. 1 × 24 jam. Bila tidak lapor, tanggung jawab hanya pada PIC.',
  'RINGAN – Pelanggaran administrasi (tidak sesuai SOP). Tanggung jawab: Senior Manager HRGA. Ditangani: CFO (maks. 3 hari kerja). Tindakan: Perbaikan & teguran lisan; nilai KPI PIC berkurang.',
  'SEDANG – Mengakibatkan kerugian perusahaan atau karyawan. Tanggung jawab: Senior Manager HRGA. Ditangani: CFO (maks. 3 hari kerja). Tindakan: Rencana perbaikan tertulis, dipantau mingguan, SP bila perlu; nilai KPI PIC & KPI pengawasan atasan berkurang.',
  'BERAT – Pelanggaran integritas & kerahasiaan data. Tanggung jawab: Senior Manager HRGA. Ditangani: BOD (keputusan akhir) (maks. 1 × 24 jam). Tindakan: Investigasi & sanksi sesuai Peraturan Perusahaan bagi semua yang bertanggung jawab.',
];

type Due = { day: number; month?: number } | null;
type TargetSeed = { text: string; methodId: string; targetValue: number | null; due: Due };

export type KpiSeed = {
  title: string;
  weight: number;
  breakdown: string[];
  targets: TargetSeed[];
};

function lines(text: string): string[] {
  return text.split('\n').map((line) => line.replace(/^•\s*/, '').trim()).filter(Boolean);
}

function kpi(title: string, job: string, weight: number, targets: TargetSeed[]): KpiSeed {
  return { title, weight, breakdown: lines(job), targets };
}

export const ANDI_KPIS: KpiSeed[] = [
  kpi('Pencapaian kinerja Departemen Human Resources dan laporan bulanan kepada CFO', '• Memastikan pencapaian KPI setiap Department Head HR tercapai dan menetapkan tindak lanjut atas KPI yang tidak tercapai\n• Menetapkan sasaran dan target KPI tahunan Departemen HR Service, Recruitment & Training Development, dan Payroll\n• Mereview laporan bulanan Department Head (laporan HR Service, MPP vs realisasi, dan gaji real)\n• Menyusun dan menyampaikan laporan kinerja Human Resources bulanan kepada CFO', 15, [
    { text: 'Rata-rata nilai KPI 3 Department Head ≥ 90', methodId: 'subordinate', targetValue: 90, due: null },
    { text: 'Laporan kinerja HR bulanan diterima CFO', methodId: 'fixed-date', targetValue: null, due: { day: 10 } },
  ]),
  kpi('Biaya Human Resources terkendali sesuai anggaran', '• Menyusun anggaran HR tahunan (biaya tenaga kerja, rekrutmen, pelatihan, dan benefit)\n• Mereview dan menganalisa laporan realisasi vs anggaran HR Departemen\n• Melakukan proses analisa kebutuhan dan dampak adanya penambahan karyawan di luar dari budget tahunan\n• Memastikan penambahan karyawan yang di luar dari budget tahunan memperoleh persetujuan Direksi', 15, [
    { text: 'Realisasi ≤ 100% dari anggaran', methodId: 'lte', targetValue: 100, due: null },
    { text: 'Tidak ada pengeluaran di luar anggaran tahunan tanpa persetujuan Direksi', methodId: 'zero', targetValue: 0, due: null },
  ]),
  kpi('Persetujuan dokumen HR valid dan tepat waktu', '• Finalisasi approval terkait perubahan gaji\n• Finalisasi approval PACA dan SK\n• Finalisasi approval pengajuan pembayaran melalui approval system', 15, [
    { text: '≥ 95% persetujuan selesai ≤ 2 hari kerja sejak dokumen lengkap dan sebelum cut-off Payroll', methodId: 'gte', targetValue: 95, due: null },
  ]),
  kpi('Kepatuhan terhadap peraturan ketenagakerjaan', '• Memastikan kebijakan, kontrak kerja, pengupahan, dan jaminan sosial karyawan sesuai peraturan ketenagakerjaan\n• Memantau perubahan regulasi (UMP/UMK, iuran BPJS, PPh 21, dan ketentuan PKWT) serta menetapkan penerapannya bersama Department Head terkait', 15, [
    { text: 'Tidak ada temuan pelanggaran ketenagakerjaan', methodId: 'findings', targetValue: 0, due: null },
    { text: 'Implementasi atas perubahan regulasi tercapai < 7 hari', methodId: 'late-days', targetValue: 0, due: null },
  ]),
  kpi('Manpower Planning (MPP) tahunan disetujui tepat waktu dan headcount sesuai MPP', '• Mereview dan menyetujui draft MPP serta anggaran headcount yang disusun R&T Dev. Department Head\n• Mengajukan MPP dan anggaran headcount tahun berikutnya kepada Direksi untuk disetujui\n• Mengawasi dan menganalisa pemenuhan kebutuhan karyawan', 10, [
    { text: 'MPP tahunan diajukan ke Direksi', methodId: 'fixed-date', targetValue: null, due: { day: 30, month: 11 } },
    { text: '100% permintaan di luar MPP direkomendasikan ke BOD ≤ 3 hari kerja', methodId: 'gte', targetValue: 100, due: null },
    { text: 'Headcount aktual ≤ 100% MPP', methodId: 'lte', targetValue: 100, due: null },
  ]),
  kpi('Tindak lanjut temuan pemeriksaan diselesaikan tepat waktu', '• Meninjau dan mengevaluasi temuan hasil pemeriksaan internal maupun eksternal\n• Mengoordinasikan dan memastikan tindak lanjut atas temuan pemeriksaan pihak internal dan pihak eksternal\n• Menyelesaikan permasalahan yang membutuhkan keputusan manajemen', 5, [
    { text: '100% temuan ditindaklanjuti sesuai batas waktu rekomendasi', methodId: 'gte', targetValue: 100, due: null },
    { text: 'Tidak ada temuan berulang', methodId: 'findings', targetValue: 0, due: null },
  ]),
  kpi('Implementasi peraturan perusahaan (SOP, IOM dan kebijakan lainnya)', '• Mereview dan mengesahkan SOP serta kebijakan HR yang disusun tim HR Department\n• Memastikan SOP dan kebijakan (IOM) baru disosialisasikan kepada karyawan dan unit terkait', 5, [
    { text: '100% SOP/IOM baru disosialisasikan ≤ 7 hari kerja setelah disahkan', methodId: 'gte', targetValue: 100, due: null },
    { text: 'Seluruh SOP HR ditinjau minimal 1× setahun', methodId: 'gte', targetValue: 100, due: null },
  ]),
  kpi('Program pengembangan karyawan dan kaderisasi berjalan sesuai rencana', '• Menetapkan rencana pengembangan karyawan berdasarkan hasil TNA dari Recruitment & Training Development serta evaluasi kinerja karyawan\n• Mengidentifikasi karyawan potensial dan memastikan pelaksanaan kaderisasi\n• Memantau pelaksanaan program pengembangan dan langkah retensi karyawan', 5, [
    { text: 'Rencana pengembangan & succession plan tahunan disetujui', methodId: 'fixed-date', targetValue: null, due: { day: 31, month: 1 } },
    { text: '≥ 80% posisi strategis memiliki minimal satu kandidat pengganti (kaderisasi)', methodId: 'gte', targetValue: 80, due: null },
  ]),
  kpi('Kesesuaian gaji, benefit, dan struktur organisasi dengan beban kerja serta kebutuhan perusahaan', '• Melakukan survei gaji tahunan dan mengusulkan penyesuaian struktur gaji serta benefit kepada Direksi\n• Mengevaluasi beban kerja, struktur organisasi, dan uraian tugas seluruh departemen bersama Head Department HR', 5, [
    { text: 'Laporan penyesuaian benefit diserahkan', methodId: 'fixed-date', targetValue: null, due: { day: 31, month: 10 } },
    { text: 'Analisa beban kerja & job description diperbarui', methodId: 'fixed-date', targetValue: null, due: { day: 31, month: 10 } },
  ]),
  kpi('Program loan karyawan dan dana pensiun sesuai dengan hak dan kewajiban karyawan', '• Menyetujui pengajuan loan karyawan sesuai ketentuan perusahaan (plafon, masa kerja, dan kemampuan bayar)\n• Memberikan instruksi pengajuan pembayaran loan dan dana pensiun kepada Payroll Team Leader\n• Memantau saldo dan potongan cicilan loan, kepesertaan dan setoran dana pensiun karyawan (khususnya level managerial)\n• Menyelesaikan permasalahan loan dan dana pensiun, termasuk pelunasan saat karyawan resign dan pencairan dana pensiun', 5, [
    { text: '100% pengajuan loan/dana pensiun diputuskan dan diinstruksikan ≤ 2 hari kerja setelah dokumen lengkap', methodId: 'gte', targetValue: 100, due: null },
    { text: 'Tidak terdapat selisih antara nilai potongan loan dengan nilai pengajuannya', methodId: 'findings', targetValue: 0, due: null },
  ]),
  kpi('Kerahasiaan data karyawan & perusahaan terjaga', '• Menjaga kerahasiaan data kandidat, peserta, dan perusahaan', 5, [
    { text: 'Tidak ada kebocoran data', methodId: 'zero', targetValue: 0, due: null },
  ]),
];

export const ANDI_ESCALATION = ESCALATION;
