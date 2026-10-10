import './style.css';
import { loadDepthEstimator, type DepthEstimator, type DepthMap } from './depth';
import { loadPhoto, type LoadedPhoto } from './image';
import { Viewer, type ViewerParams } from './viewer';
import {
  CATEGORIES, CRITERIA, average, loadRows, saveRows, summarize, toCsv,
  type CriterionKey, type ScoreRow,
} from './scoring';

interface Entry {
  photo: LoadedPhoto;
  depth: DepthMap;
  inferMs: number;
  totalMs: number;
  thumbUrl: string;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const status = $<HTMLParagraphElement>('#status');
const metrics = $<HTMLParagraphElement>('#metrics');

const viewer = new Viewer($('#stage'));
const entries: Entry[] = [];
let currentIndex = -1;
let estimatorPromise: Promise<DepthEstimator> | null = null;
let estimator: DepthEstimator | null = null;
let rows = loadRows();

function setStatus(message: string) {
  status.textContent = message;
}

function getEstimator(): Promise<DepthEstimator> {
  estimatorPromise ??= loadDepthEstimator(setStatus).then((e) => {
    estimator = e;
    return e;
  });
  return estimatorPromise;
}

// --- 写真の追加（終わったものから順に表示する） ---
$<HTMLInputElement>('#file').addEventListener('change', async (ev) => {
  const input = ev.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length) return;

  let est: DepthEstimator;
  try {
    est = await getEstimator();
  } catch (err) {
    estimatorPromise = null;
    setStatus(`モデルを読み込めませんでした: ${(err as Error).message}`);
    return;
  }
  if (est.backend === 'wasm') {
    setStatus('この環境は WebGPU に対応していないため、WASM で処理します（遅くなります）');
  }

  for (const [i, file] of files.entries()) {
    setStatus(`3D化しています（${i + 1} / ${files.length}）: ${file.name}`);
    const t0 = performance.now();
    try {
      const photo = await loadPhoto(file);
      const { depth, inferMs } = await est.estimate(photo.inference);
      const entry: Entry = {
        photo, depth, inferMs,
        totalMs: performance.now() - t0,
        thumbUrl: photo.inference.toDataURL('image/jpeg', 0.6),
      };
      entries.push(entry);
      select(entries.length - 1);
    } catch (err) {
      setStatus((err as Error).message);
      continue;
    }
  }
  setStatus(`${entries.length} 枚を読み込みました。ドラッグ、矢印キー、または傾きで視点を動かせます`);
});

function select(index: number) {
  currentIndex = index;
  const e = entries[index];
  viewer.show(e.photo.display, e.depth);
  renderPhotos();
  const existing = rows.find((r) => r.name === e.photo.name);
  fillScoreForm(existing);
}

function renderPhotos() {
  const list = $<HTMLUListElement>('#photos');
  list.replaceChildren(
    ...entries.map((e, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-current', String(i === currentIndex));
      btn.setAttribute('aria-label', e.photo.name);
      if (rows.some((r) => r.name === e.photo.name)) btn.classList.add('scored');
      const img = document.createElement('img');
      img.src = e.thumbUrl;
      img.alt = '';
      btn.append(img);
      btn.addEventListener('click', () => select(i));
      li.append(btn);
      return li;
    }),
  );
}

// --- 計測値の表示 ---
setInterval(() => {
  const e = entries[currentIndex];
  if (!e || !estimator) return;
  metrics.textContent = [
    `${estimator.backend} / ${estimator.dtype}`,
    `モデル読込 ${(estimator.loadMs / 1000).toFixed(1)}s`,
    `推論 ${Math.round(e.inferMs)}ms`,
    `追加→表示 ${(e.totalMs / 1000).toFixed(2)}s`,
    `${viewer.fps.toFixed(0)}fps @${viewer.currentPixelRatio}x`,
  ].join('\n');
}, 500);

// --- 表示パラメータ ---
for (const key of ['depthScale', 'maxOffset', 'edge'] as (keyof ViewerParams)[]) {
  const input = $<HTMLInputElement>(`#${key}`);
  const out = input.nextElementSibling as HTMLOutputElement;
  input.value = String(viewer.params[key]);
  out.value = input.value;
  input.addEventListener('input', () => {
    viewer.params[key] = Number(input.value);
    out.value = input.value;
  });
}

// --- ジャイロ ---
$<HTMLButtonElement>('#gyro').addEventListener('click', async () => {
  const ok = await viewer.enableGyro();
  setStatus(ok ? '傾きで視点が動きます。「中央に戻す」で基準を取り直せます' : '傾きの許可が得られませんでした。ドラッグで操作してください');
});
$<HTMLButtonElement>('#recenter').addEventListener('click', () => viewer.recenter());

// --- 採点フォーム ---
const categorySelect = $<HTMLSelectElement>('#category');
categorySelect.append(...CATEGORIES.map((c) => new Option(c, c)));

$('#criteria').append(
  ...CRITERIA.map((c) => {
    const div = document.createElement('div');
    div.className = 'criterion';
    const name = document.createElement('div');
    name.textContent = c.label;
    const radios = document.createElement('span');
    const values = c.key === 'face' ? ['-', '1', '2', '3', '4', '5'] : ['1', '2', '3', '4', '5'];
    for (const v of values) {
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = c.key;
      radio.value = v;
      radio.required = true;
      label.append(radio, v === '-' ? '顔なし' : v);
      radios.append(label);
    }
    div.append(name, radios);
    return div;
  }),
);

function fillScoreForm(row?: ScoreRow) {
  const form = $<HTMLFormElement>('#score');
  form.reset();
  if (!row) return;
  categorySelect.value = row.category;
  $<HTMLInputElement>('#note').value = row.note;
  for (const c of CRITERIA) {
    const v = row.scores[c.key];
    const radio = form.querySelector<HTMLInputElement>(`input[name=${c.key}][value="${v ?? '-'}"]`);
    if (radio) radio.checked = true;
  }
}

$<HTMLFormElement>('#score').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const e = entries[currentIndex];
  if (!e || !estimator) {
    setStatus('先に写真を追加してください');
    return;
  }
  const data = new FormData(ev.target as HTMLFormElement);
  const scores = Object.fromEntries(
    CRITERIA.map((c) => {
      const v = data.get(c.key);
      return [c.key, v === '-' || v === null ? null : Number(v)];
    }),
  ) as Record<CriterionKey, number | null>;

  const row: ScoreRow = {
    name: e.photo.name,
    category: categorySelect.value,
    method: 'A',
    backend: estimator.backend,
    dtype: estimator.dtype,
    width: e.photo.display.width,
    height: e.photo.display.height,
    inferMs: e.inferMs,
    totalMs: e.totalMs,
    depthScale: viewer.params.depthScale,
    maxOffset: viewer.params.maxOffset,
    scores,
    note: $<HTMLInputElement>('#note').value,
    userAgent: navigator.userAgent,
    recordedAt: new Date().toISOString(),
  };
  rows = [...rows.filter((r) => r.name !== row.name), row];
  saveRows(rows);
  renderTable();
  renderPhotos();
  setStatus(`${row.name} の採点を記録しました`);
});

function renderTable() {
  const table = $<HTMLTableElement>('#table');
  const head = ['写真', '分類', '推論ms', ...CRITERIA.map((c) => c.label.slice(0, 4)), '平均'];
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>`;
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    const cells: [string, boolean][] = [
      [r.name, false],
      [r.category, false],
      [String(Math.round(r.inferMs)), true],
      ...CRITERIA.map((c): [string, boolean] => [String(r.scores[c.key] ?? '-'), true]),
      [average(r)?.toFixed(2) ?? '-', true],
    ];
    for (const [text, num] of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      if (num) td.className = 'num';
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.replaceChildren(thead, tbody);

  const s = summarize(rows);
  $('#summary').textContent =
    `採点済み ${s.scored} 枚 / 平均3以上 ${s.passed} 枚 → ` +
    (s.scored < 10 ? `あと ${10 - s.scored} 枚` : s.ok ? '合格ライン（仮）を満たしています' : '合格ライン（仮）未達');
}

$<HTMLButtonElement>('#download').addEventListener('click', () => {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `phase0-scores-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$<HTMLButtonElement>('#clear').addEventListener('click', () => {
  if (!confirm('採点表を消去しますか？（CSVを先にダウンロードしてください）')) return;
  rows = [];
  saveRows(rows);
  renderTable();
  renderPhotos();
});

renderTable();
