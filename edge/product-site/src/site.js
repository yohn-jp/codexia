const stage = document.querySelector('.stage');
const acts = Array.from(document.querySelectorAll('.act'));
const links = Array.from(document.querySelectorAll('.chapter-nav a'));
const labels = ['I / THE FIRST WORD', 'II / THE GROWING MANUSCRIPT', 'III / THE WORLD WITHIN', "IV / THE AUTHOR'S AUTHORITY", 'V / THE SOVEREIGN LIBRARY'];
const wide = matchMedia('(min-width: 901px)');
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
let active = 1;
function showAct(act, force = false) {
  if (act === active && !force) return;
  active = act;
  const showStage = wide.matches && !reduce.matches;
  stage.dataset.act = showStage ? String(act) : '1';
  document.getElementById('stage-act').textContent = 'ACT ' + labels[showStage ? act - 1 : 0];
  for (const [index, link] of links.entries()) {
    if (index === act - 1) link.setAttribute('aria-current', 'step');
    else link.removeAttribute('aria-current');
  }
}
// Native scroll is authoritative; only act boundaries mutate the stage.
let scheduled = false;
function readScroll() {
  scheduled = false;
  const middle = window.innerHeight * 0.53;
  const rects = acts.map(act => act.getBoundingClientRect());
  const current = rects.findIndex(rect => rect.top <= middle && rect.bottom > middle);
  if (current >= 0) showAct(current + 1);
  else if (rects[0].top > middle) showAct(1);
  else if (rects[rects.length - 1].bottom <= middle) showAct(5);
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(readScroll);
}
function adapt() { showAct(active, true); schedule(); }
window.addEventListener('scroll', schedule, { passive: true });
window.addEventListener('resize', schedule, { passive: true });
wide.addEventListener('change', adapt);
reduce.addEventListener('change', adapt);
schedule();

const atlas = {
  character: ['佐伯律', '「紙の繊維に残る筆圧だけが、書き手の躊躇いを嘘なく記録している。」', '旧書庫の司書補。作品の視点人物。'],
  tower: ['黒曜の時計塔', '「塔の鐘が最後に鳴ったのは、港の霧が白灰に変わった十月の夜だった。」', '停止時刻をめぐる、作品の伏線。'],
  scar: ['古傷の左右', '「佐伯は左手の甲に走る白い筋を撫でながら、書庫の鍵束を受け取った。」', '見本の第三章では右手と記述されています。意図的な違いか、次の幕で判断します。'],
};
const atlasButtons = Array.from(document.querySelectorAll('[data-atlas]'));
for (const button of atlasButtons) {
  button.addEventListener('click', () => {
    const item = atlas[button.dataset.atlas];
    if (!item) return;
    document.getElementById('atlas-title').textContent = item[0];
    document.getElementById('atlas-quote').textContent = item[1];
    document.getElementById('atlas-note').textContent = item[2];
    for (const candidate of atlasButtons) candidate.setAttribute('aria-pressed', String(candidate === button));
  });
}
const decisions = {
  pending: ['右手', '原文', '採否待ち。実際のAIやデータベースには接続していません。', '『灰の書庫』 — 原文（採否未決定）'],
  approved: ['左手', '改稿版', '見本の改稿を採択しました。原稿と最終幕の表示に反映しました。', '『灰の書庫』 — 改稿版（左手）'],
  rejected: ['右手', '原文保持', '見本の原文を保持しました。最終幕にも判断を反映しました。', '『灰の書庫』 — 原文保持（右手）'],
};
for (const button of document.querySelectorAll('.decisions button')) {
  button.addEventListener('click', () => {
    const choice = button.dataset.decision;
    const item = decisions[choice];
    if (!item) return;
    stage.dataset.decision = choice;
    document.getElementById('stage-hand').textContent = item[0];
    document.getElementById('book-edition').textContent = item[1];
    document.getElementById('decision-status').textContent = item[2];
    document.getElementById('edition-result').textContent = item[3];
  });
}
