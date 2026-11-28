// All interaction runs against explicitly fictional, in-memory content.
// The product site never connects to an application API, stores data or claims a save.
const workspace = document.querySelector('.workspace');
const modeButtons = [...document.querySelectorAll('[data-mode].mode')];
const sceneButtons = [...document.querySelectorAll('[data-scene].scene-choice')];
const decisionButtons = [...document.querySelectorAll('[data-decision]')];
const manuscript = document.getElementById('manuscript');
const chapterTitle = document.getElementById('chapter-title');
const chapterIndex = document.getElementById('chapter-index');
const chapterCrumb = document.getElementById('chapter-crumb');
const decisionStatus = document.getElementById('decision-status');
const inspectorCaption = document.getElementById('inspector-caption');

const chapters = {
  '3': {
    index: '03', crumb: '第三章', title: '硝子窓の降灰',
    paragraphs: [
      ['塔の鐘が最後に鳴ったのは、港の霧が白灰に変わった十月の夜だった。'],
      ['旧書庫の司書補である', { anchor: '佐伯律' }, 'は、頁の端に爪を立て、七年前の自分が引いた鉛筆の傍線をなぞった。'],
      ['佐伯は', { hand: true }, 'の古傷を袖口で隠しながら、硝子戸の向こうに積もる灰を見つめた。'],
    ],
  },
  '4': {
    index: '04', crumb: '第四章', title: '閉ざされた書架',
    paragraphs: [
      ['書庫の奥には、七年前から封じられた一列の書架があった。'],
      ['佐伯律は錆びた鍵を手に取り、埃の積もる背表紙をひとつずつ確かめた。'],
      ['誰も読まなかった記録が、今も静かにそこに残されていた。'],
    ],
  },
  '5': {
    index: '05', crumb: '第五章', title: '鐘のない夜',
    paragraphs: [
      ['夜明けの少し前、時計塔の影は港の石畳からゆっくりと消えた。'],
      ['佐伯律は閉じた手帳に指を置き、最後の頁に一行だけ書き足した。'],
      ['終わりにするかどうかを決めるのは、いつも書き手自身だった。'],
    ],
  },
};
const decisions = {
  pending: { hand: '右手', message: '未決定 — 原稿は変更されていません。' },
  approved: { hand: '左手', message: '提案を採用 — 見本の原稿を「左手」に変更しました（保存は行いません）。' },
  rejected: { hand: '右手', message: '原文を保持 — 見本の原稿は「右手」のままです。' },
};
let mode = 'write';
let scene = '3';
let decision = 'pending';

function renderScene() {
  const item = chapters[scene];
  chapterTitle.textContent = item.title;
  chapterIndex.textContent = 'CHAPTER ' + item.index;
  chapterCrumb.textContent = item.crumb;
  const paragraphs = item.paragraphs.map(parts => {
    const p = document.createElement('p');
    for (const part of parts) {
      if (typeof part === 'string') {
        p.append(document.createTextNode(part));
      } else {
        const span = document.createElement('span');
        span.className = 'annotation';
        if (part.hand) {
          span.id = 'hand';
          span.textContent = decisions[decision].hand;
        } else {
          span.textContent = part.anchor;
        }
        p.append(span);
      }
    }
    return p;
  });
  manuscript.replaceChildren(...paragraphs);
  for (const button of sceneButtons) {
    const selected = button.dataset.scene === scene;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}

function setMode(value) {
  if (!['write', 'knowledge', 'review'].includes(value)) return;
  mode = value;
  workspace.dataset.mode = mode;
  for (const button of modeButtons) {
    const selected = button.dataset.mode === mode;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  for (const panel of document.querySelectorAll('[data-panel]')) {
    panel.hidden = panel.dataset.panel !== mode;
  }
  inspectorCaption.textContent = {
    write: '関連する知識',
    knowledge: '根拠と記述',
    review: '変更提案',
  }[mode];
}

function setDecision(value) {
  if (!(value in decisions)) return;
  decision = value;
  decisionStatus.textContent = decisions[value].message;
  for (const button of decisionButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.decision === value));
  }
  // The fictional author decision affects only the in-memory third chapter.
  if (scene === '3') {
    const hand = document.getElementById('hand');
    if (hand) hand.textContent = decisions[value].hand;
  }
}

for (const button of modeButtons) {
  button.disabled = false;
  button.addEventListener('click', () => setMode(button.dataset.mode));
}
for (const button of sceneButtons) {
  button.disabled = false;
  button.addEventListener('click', () => {
    scene = button.dataset.scene;
    renderScene();
  });
}
for (const button of decisionButtons) {
  button.disabled = false;
  button.addEventListener('click', () => setDecision(button.dataset.decision));
}
document.querySelectorAll('.mobile-menu nav a').forEach(link => {
  link.addEventListener('click', () => {
    document.querySelector('.mobile-menu').open = false;
  });
});
renderScene();
setMode('write');
setDecision('pending');
