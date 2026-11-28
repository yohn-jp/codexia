const stage = document.querySelector('.stage');
const acts = Array.from(document.querySelectorAll('.act'));
const links = Array.from(document.querySelectorAll('.chapter-nav a'));
const labels = ['I / THE FIRST WORD', 'II / THE GROWING MANUSCRIPT', 'III / THE WORLD WITHIN', "IV / THE AUTHOR'S AUTHORITY", 'V / THE SOVEREIGN LIBRARY'];
const wide = matchMedia('(min-width: 901px)');
const root = document.documentElement;
const stageLabel = document.getElementById('stage-act');
const stageGeometry = { top:0, height:0, bottom:0 };
let ranges = [];
let scrollTop = 0;
let rotation = 0;
let lastFrame = '';
const clamp = value => Math.max(0, Math.min(1, value));
const lerp = (a,b,t) => a + (b-a)*t;
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
let active = 1;
function showAct(act, force = false) {
  if (act === active && !force) return;
  active = act;
  stage.dataset.act = reduce.matches ? '1' : String(act);
  stageLabel.textContent = 'ACT ' + labels[reduce.matches ? 0 : act - 1];
  for (const [index, link] of links.entries()) {
    if (index === act - 1) link.setAttribute('aria-current', 'step');
    else link.removeAttribute('aria-current');
  }
}
// Geometry is read together, only after size/content changes. Scroll work
// updates compositor-friendly values and never queries layout per glyph.
function measure() {
  const y = window.scrollY;
  const r = stage.getBoundingClientRect();
  stageGeometry.height = r.height;
  stageGeometry.top = document.querySelector('.masthead').getBoundingClientRect().height;
  stageGeometry.bottom = document.querySelector('.experience').getBoundingClientRect().bottom + y;
  ranges = acts.map(act => {
    const rect = act.getBoundingClientRect();
    return {top:rect.top+y,bottom:rect.bottom+y};
  });
}
let scheduled = false;
let needsMeasure = true;
function render() {
  scheduled = false;
  if (needsMeasure) { needsMeasure = false; measure(); }
  scrollTop = window.scrollY;
  if (!ranges.length) return;
  const header = stageGeometry.top;
  const top = !wide.matches && !reduce.matches ? header + stageGeometry.height : header;
  const center = scrollTop + top + Math.max(0,window.innerHeight-top)*.5;
  let index = ranges.findIndex(r => r.top <= center && r.bottom > center);
  if (index < 0) index = center < ranges[0].top ? 0 : ranges.length-1;
  const range = ranges[index];
  const local = clamp((center-range.top)/Math.max(1,range.bottom-range.top));
  const moment = index + local;
  showAct(index+1);
  const motion = !reduce.matches;
  // Scrub over narrow transition bands, retaining the visual for each act.
  const growth = motion ? clamp((moment-.82)/.4) : 0;
  const atlas = motion ? Math.min(clamp((moment-1.82)/.4),1-clamp((moment-2.78)/.42)) : 0;
  const binding = motion ? clamp((moment-3.82)/.42) : 0;
  const opening = motion ? lerp(.52,1,clamp(local/.5)) : 1;
  const frame = [growth,atlas,binding,index===0?opening:1].map(v=>v.toFixed(3)).join('|');
  if(frame !== lastFrame) {
    lastFrame = frame;
    stage.style.setProperty('--growth',growth.toFixed(3));
    stage.style.setProperty('--atlas',atlas.toFixed(3));
    stage.style.setProperty('--binding',binding.toFixed(3));
    stage.style.setProperty('--opening',index===0?opening.toFixed(3):'1');
  }
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(render);
}
function invalidate() { needsMeasure=true; schedule(); }
function adapt() { showAct(active,true); invalidate(); }
stage.dataset.enhanced = 'true';
window.addEventListener('scroll',schedule,{passive:true});
window.addEventListener('resize',invalidate,{passive:true});
wide.addEventListener('change',adapt);
reduce.addEventListener('change',adapt);
if ('ResizeObserver' in window) {
  const observer = new ResizeObserver(invalidate);
  observer.observe(stage);
  for (const act of acts) observer.observe(act);
}
document.fonts.ready.then(invalidate);
schedule();

const lightToggle = document.getElementById('light-toggle');
lightToggle.disabled = false;
lightToggle.addEventListener('click',()=>{
  const daylight = root.dataset.room !== 'daylight';
  root.dataset.room = daylight ? 'daylight' : 'chiaroscuro';
  lightToggle.setAttribute('aria-pressed',String(daylight));
  lightToggle.setAttribute('aria-label',daylight?'夜想の書斎に切り替える':'昼光の書斎に切り替える');
  lightToggle.querySelector('.light-label').textContent = daylight?'夜想':'昼光';
});
function setRotation(angle) {
  rotation = Math.max(-34,Math.min(38,angle));
  stage.style.setProperty('--rotation',rotation+'deg');
}
for (const [id,change] of [['rotate-left',-12],['rotate-right',12],['rotate-reset',0]]) {
  const button = document.getElementById(id);
  button.disabled = false;
  button.addEventListener('click',()=>setRotation(change===0?0:rotation+change));
}
const book = stage.querySelector('.book');
let drag = null;
book.addEventListener('pointerdown',event=>{
  if(active!==5 || reduce.matches || event.pointerType==='touch')return;
  drag = {id:event.pointerId,x:event.clientX,rotation};
  book.setPointerCapture(event.pointerId);
});
book.addEventListener('pointermove',event=>{
  if(drag?.id===event.pointerId) setRotation(drag.rotation+(event.clientX-drag.x)*.18);
});
for(const event of ['pointerup','pointercancel','lostpointercapture'])book.addEventListener(event,()=>{drag=null;});

const atlas = {
  character: ['佐伯律', '「紙の繊維に残る筆圧だけが、書き手の躊躇いを嘘なく記録している。」', '旧書庫の司書補。作品の視点人物。'],
  tower: ['黒曜の時計塔', '「塔の鐘が最後に鳴ったのは、港の霧が白灰に変わった十月の夜だった。」', '停止時刻をめぐる、作品の伏線。'],
  scar: ['古傷の左右', '「佐伯は左手の甲に走る白い筋を撫でながら、書庫の鍵束を受け取った。」', '見本の第三章では右手と記述されています。意図的な違いか、次の幕で判断します。'],
};
const atlasButtons = Array.from(document.querySelectorAll('[data-atlas]'));
for (const button of atlasButtons) {
  button.disabled = false;
  button.addEventListener('click', () => {
    const item = atlas[button.dataset.atlas];
    if (!item) return;
    stage.dataset.atlasSelection = button.dataset.atlas;
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
  button.disabled = false;
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
