export const CATEGORIES = ['人物', '風景', '室内', '逆光', '夜景', '集合写真', 'その他'] as const;

export const CRITERIA = [
  { key: 'edge', label: '輪郭の引き伸ばし' },
  { key: 'hole', label: '背後の穴' },
  { key: 'face', label: '顔の歪み' },
  { key: 'depth', label: '奥行きの自然さ' },
] as const;

export type CriterionKey = (typeof CRITERIA)[number]['key'];

export interface ScoreRow {
  name: string;
  category: string;
  method: 'A';
  backend: string;
  dtype: string;
  width: number;
  height: number;
  inferMs: number;
  /** ファイル選択から 3D 表示まで（モデルの初回ダウンロードを除く） */
  totalMs: number;
  depthScale: number;
  maxOffset: number;
  /** 1〜5（5 = 気にならない）。顔がない写真は null */
  scores: Record<CriterionKey, number | null>;
  note: string;
  userAgent: string;
  recordedAt: string;
}

const STORAGE_KEY = 'phase0-scores-v1';

// localStorage は使えない環境があるため、失敗しても動くようにする
export function loadRows(): ScoreRow[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ScoreRow[]) : [];
  } catch {
    return [];
  }
}

export function saveRows(rows: ScoreRow[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    /* 保存できなくても採点表のダウンロードはできる */
  }
}

export function average(row: ScoreRow): number | null {
  const values = Object.values(row.scores).filter((v): v is number => v !== null);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** 合格ライン（仮）: 平均 3 以上の写真が 7 枚以上 */
export function summarize(rows: ScoreRow[]) {
  const scored = rows.filter((r) => average(r) !== null);
  const passed = scored.filter((r) => (average(r) ?? 0) >= 3).length;
  return { scored: scored.length, passed, ok: passed >= 7 };
}

export function toCsv(rows: ScoreRow[]): string {
  const header = [
    'name', 'category', 'method', 'backend', 'dtype', 'width', 'height',
    'infer_ms', 'total_ms', 'depth_scale', 'max_offset',
    ...CRITERIA.map((c) => c.label), 'average', 'note', 'user_agent', 'recorded_at',
  ];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [
      r.name, r.category, r.method, r.backend, r.dtype, r.width, r.height,
      Math.round(r.inferMs), Math.round(r.totalMs), r.depthScale, r.maxOffset,
      ...CRITERIA.map((c) => r.scores[c.key]), average(r)?.toFixed(2), r.note, r.userAgent, r.recordedAt,
    ].map(esc).join(','),
  );
  // Excel で文字化けしないよう BOM を付ける
  return '﻿' + [header.join(','), ...lines].join('\n');
}
