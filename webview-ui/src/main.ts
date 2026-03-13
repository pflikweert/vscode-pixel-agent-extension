import './styles.css';

const vscode = acquireVsCodeApi();

type AgentId = 'scout' | 'builder' | 'reviewer';
type AgentStatus = 'idle' | 'working' | 'completed' | 'error';
type AgentZone = 'lounge' | 'work';

interface AgentViewState {
  id: AgentId;
  label: string;
  task: string;
  status: AgentStatus;
  progress: number;
  lastEventAt: number;
}

interface PixelRuntimeEvent {
  type: string;
  timestamp: number;
  summary: string;
  detail?: string;
  filePath?: string;
  agentId?: AgentId;
  status?: AgentStatus;
  progress?: number;
  git?: GitViewState;
}

interface RuntimeState {
  agents: Record<AgentId, AgentViewState>;
  eventLog: PixelRuntimeEvent[];
  statusLine: string;
  git: GitViewState;
}

interface GitViewState {
  available: boolean;
  branch: string;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  conflicts: number;
  hasChanges: boolean;
  lastCommit: string;
  repositoryRoot: string;
  message: string;
}

interface AgentVisualState extends AgentViewState {
  x: number;
  y: number;
  vx: number;
  frame: number;
  bob: number;
  lane: number;
  zone: AgentZone;
  color: string;
  lastSpeechAt: number;
  speechText: string;
  pauseUntilMs: number;
  nextPauseAtMs: number;
}

type ExtensionMessage =
  | { type: 'pixel.snapshot'; payload: RuntimeState }
  | { type: 'pixel.event'; payload: PixelRuntimeEvent };

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Missing #app container.');
}

const AGENT_INACTIVITY_LIMIT_MS = 10_000;
const SPEECH_VISIBLE_MS = 2_800;
const BUBBLE_MAX_LINES = 2;
const BUBBLE_LINE_MAX_CHARS = 34;
const MAX_VISIBLE_EVENTS = 14;

interface AgentPersonality {
  idleLines: string[];
  workFallback: string;
  icons: string[];
  loungeSpeed: number;
  workSpeed: number;
  driftAmp: number;
  driftFreq: number;
  poseAmp: number;
  poseFreq: number;
}

const AGENT_PERSONALITIES: Record<AgentId, AgentPersonality> = {
  scout: {
    idleLines: [
      'ik scan nog even de context.',
      'waar zit de volgende winst?',
      'commit-plan wordt scherp gezet.',
      'ik spot alvast de risico\'s.',
      'nog een snelle map-check.'
    ],
    workFallback: 'context en impact checken',
    icons: ['🙂', '🧭', '✨'],
    loungeSpeed: 0.95,
    workSpeed: 1.05,
    driftAmp: 0.14,
    driftFreq: 0.0019,
    poseAmp: 0.22,
    poseFreq: 0.0036
  },
  builder: {
    idleLines: [
      'ik zet alvast een patch op.',
      'nog 1 refactor en door.',
      'de build moet strak blijven.',
      'ik warm de compiler op.',
      'ready voor de volgende feature.'
    ],
    workFallback: 'implementatie uitwerken',
    icons: ['😄', '🛠️', '🚀'],
    loungeSpeed: 1.02,
    workSpeed: 1.18,
    driftAmp: 0.09,
    driftFreq: 0.0015,
    poseAmp: 0.16,
    poseFreq: 0.0042
  },
  reviewer: {
    idleLines: [
      'ik hou de checks paraat.',
      'randgevallen eerst, altijd.',
      'ik kijk nog naar regressies.',
      'lint en tests blijven heilig.',
      'klaar voor een snelle review.'
    ],
    workFallback: 'validatie en checks draaien',
    icons: ['😉', '🔎', '✅'],
    loungeSpeed: 0.88,
    workSpeed: 0.97,
    driftAmp: 0.07,
    driftFreq: 0.0013,
    poseAmp: 0.13,
    poseFreq: 0.0029
  }
};

app.innerHTML = `
  <main class="screen">
    <section class="card">
      <header class="title-row">
        <div>
          <p class="kicker">Pixel Agent Lounge</p>
          <h1>Idle Chat + Werkvloer</h1>
        </div>
        <button id="refresh-button" type="button">Refresh Snapshot</button>
      </header>

      <section class="scene-shell">
        <canvas id="scene" width="320" height="180" aria-label="Pixel agent scene"></canvas>
        <div class="scene-caption">
          <span class="pill lounge">Lounge: idle agents praten</span>
          <span class="pill work">Werkvloer: actieve agents werken</span>
        </div>
      </section>

      <section class="status-grid">
        <div class="status-row">
          <span>Runtime</span>
          <strong id="runtime-status">IDLE</strong>
        </div>
        <div class="status-row">
          <span>Webview</span>
          <strong id="hmr-status">Connected</strong>
        </div>
      </section>

      <section class="git-strip">
        <article class="git-cell">
          <span class="git-label">Branch</span>
          <strong id="git-branch">git: laden...</strong>
        </article>
        <article class="git-cell">
          <span class="git-label">Changes</span>
          <strong id="git-counts">staged 0 | unstaged 0 | conflicts 0</strong>
        </article>
        <article class="git-cell">
          <span class="git-label">Status</span>
          <strong id="git-message">Git monitoring wordt geladen.</strong>
        </article>
      </section>

      <section class="data-grid">
        <div class="agent-list" id="agent-list"></div>
        <section class="event-log">
          <h2>Events</h2>
          <ul id="event-log-list"></ul>
        </section>
      </section>
    </section>
  </main>
`;

const status = app.querySelector<HTMLElement>('#hmr-status');
const runtimeStatus = app.querySelector<HTMLElement>('#runtime-status');
const refreshButton = app.querySelector<HTMLButtonElement>('#refresh-button');
const agentList = app.querySelector<HTMLDivElement>('#agent-list');
const eventList = app.querySelector<HTMLUListElement>('#event-log-list');
const gitBranch = app.querySelector<HTMLElement>('#git-branch');
const gitCounts = app.querySelector<HTMLElement>('#git-counts');
const gitMessage = app.querySelector<HTMLElement>('#git-message');
const canvas = app.querySelector<HTMLCanvasElement>('#scene');

if (!canvas) {
  throw new Error('Missing #scene canvas.');
}

const ctx = canvas.getContext('2d');
if (!ctx) {
  throw new Error('Canvas context unavailable.');
}

const loungeLaneYs = [124, 138, 152];
const workLaneYs = [94, 112, 130];
const loungeBounds = { left: 16, right: 132 };
const workBounds = { left: 174, right: canvas.width - 20 };
const splitX = 158;

const agentOrder: AgentId[] = ['scout', 'builder', 'reviewer'];
const agentState: Record<AgentId, AgentVisualState> = {
  scout: createDefaultAgent('scout', 'Scout', '#66e0be', 42, 0, 0.46, 0.3),
  builder: createDefaultAgent('builder', 'Builder', '#ffd27a', 92, 1, -0.41, 1.4),
  reviewer: createDefaultAgent('reviewer', 'Reviewer', '#ff7e9f', 126, 2, 0.52, 2.5)
};

const runtimeEvents: PixelRuntimeEvent[] = [];
let currentGitState = createDefaultGitState();

function createDefaultGitState(): GitViewState {
  return {
    available: false,
    branch: '-',
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    conflicts: 0,
    hasChanges: false,
    lastCommit: '-',
    repositoryRoot: '-',
    message: 'Git status wordt geladen.'
  };
}

function createDefaultAgent(
  id: AgentId,
  label: string,
  color: string,
  x: number,
  lane: number,
  vx: number,
  bob: number
): AgentVisualState {
  const nowMs = performance.now();
  return {
    id,
    label,
    task: 'wacht in lounge',
    status: 'idle',
    progress: 0,
    lastEventAt: Date.now(),
    x,
    y: loungeLaneYs[lane],
    vx,
    frame: 0,
    bob,
    lane,
    zone: 'lounge',
    color,
    lastSpeechAt: 0,
    speechText: '',
    pauseUntilMs: nowMs,
    nextPauseAtMs: nowMs + 1200 + Math.random() * 2200
  };
}

function shorten(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}...`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function isActiveStatus(statusValue: AgentStatus): boolean {
  return statusValue === 'working' || statusValue === 'completed' || statusValue === 'error';
}

function applyZoneFromStatus(agent: AgentVisualState) {
  const active = isActiveStatus(agent.status);
  agent.zone = active ? 'work' : 'lounge';

  const bounds = active ? workBounds : loungeBounds;
  const lanes = active ? workLaneYs : loungeLaneYs;

  agent.lane = clamp(agent.lane, 0, lanes.length - 1);
  agent.x = clamp(agent.x, bounds.left, bounds.right);
  if (!active) {
    agent.progress = 0;
  }
}

function getIdleLine(agent: AgentVisualState, nowMs: number): string {
  const lines = AGENT_PERSONALITIES[agent.id].idleLines;
  const tick = Math.floor(nowMs / 4200);
  const offset = agent.id.length * 3 + agent.lane;
  const index = (tick + offset) % lines.length;
  const icon = pickAgentIcon(agent, nowMs);
  return `${lines[index]} ${icon}`;
}

function getActiveLine(agent: AgentVisualState): string {
  const fallback = AGENT_PERSONALITIES[agent.id].workFallback;
  const core = shorten(agent.task || fallback, 22);
  const icon = pickAgentIcon(agent, Date.now());

  if (agent.status === 'completed') {
    return `klaar: ${core} ${icon}`;
  }
  if (agent.status === 'error') {
    return `let op: ${core} ${icon}`;
  }
  if (agent.id === 'scout') {
    return `scan: ${core} ${icon}`;
  }
  if (agent.id === 'builder') {
    return `bouwt: ${core} ${icon}`;
  }
  return `checkt: ${core} ${icon}`;
}

function pickAgentIcon(agent: AgentVisualState, seed: number): string {
  const icons = AGENT_PERSONALITIES[agent.id].icons;
  const index = Math.abs(Math.floor(seed / 850) + agent.lane + agent.id.length) % icons.length;
  return icons[index];
}

function wrapWords(line: string, maxChars: number): string[] {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }

  const wrapped: string[] = [];
  let current = words[0];
  for (let i = 1; i < words.length; i += 1) {
    const next = `${current} ${words[i]}`;
    if (next.length <= maxChars) {
      current = next;
    } else {
      wrapped.push(current);
      current = words[i];
    }
  }
  wrapped.push(current);
  return wrapped;
}

function wrapBubbleText(text: string, maxChars: number, maxLines: number): string[] {
  const parts = text
    .split('\n')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const lines: string[] = [];
  for (const part of parts) {
    const wrapped = wrapWords(part, maxChars);
    for (const line of wrapped) {
      lines.push(line);
      if (lines.length >= maxLines) {
        break;
      }
    }
    if (lines.length >= maxLines) {
      break;
    }
  }

  if (lines.length === 0) {
    return [];
  }

  const joined = parts.join(' ');
  const rendered = lines.join(' ');
  if (rendered.length < joined.length) {
    const lastIndex = lines.length - 1;
    lines[lastIndex] = shorten(lines[lastIndex], Math.max(4, maxChars - 1));
    if (!lines[lastIndex].endsWith('...')) {
      lines[lastIndex] = `${shorten(lines[lastIndex], Math.max(4, maxChars - 4))}...`;
    }
  }

  return lines;
}

function buildSpeechFromEvent(agent: AgentVisualState, event: PixelRuntimeEvent): string {
  const baseSummary = event.summary ? shorten(event.summary.replace(/\s+/g, ' ').trim(), 74) : getActiveLine(agent);
  const detail = event.detail ? shorten(event.detail.trim(), 90) : '';
  if (detail && detail !== baseSummary) {
    return `${baseSummary}\n${detail}`;
  }
  return baseSummary || getIdleLine(agent, event.timestamp || Date.now());
}

function setAgentSpeech(agent: AgentVisualState, event: PixelRuntimeEvent) {
  agent.speechText = buildSpeechFromEvent(agent, event);
  agent.lastSpeechAt = event.timestamp || Date.now();
}

function renderAgents() {
  if (!agentList) {
    return;
  }

  agentList.innerHTML = agentOrder
    .map((agentId) => {
      const agent = agentState[agentId];
      const location = agent.zone === 'work' ? 'werkplek' : 'lounge';
      return `
        <article class="agent-item">
          <div class="agent-meta">
            <p class="agent-name">${agent.label}</p>
            <p class="agent-task">${escapeHtml(shorten(agent.task, 72))}</p>
            <div class="agent-progress-track">
              <span class="agent-progress-fill" style="width:${agent.progress}%"></span>
            </div>
          </div>
          <p class="agent-state ${agent.status}">${agent.status} ${agent.progress}% ${location}</p>
        </article>
      `;
    })
    .join('');
}

function renderEvents() {
  if (!eventList) {
    return;
  }

  if (runtimeEvents.length === 0) {
    eventList.innerHTML = '<li>Nog geen events ontvangen.</li>';
    return;
  }

  eventList.innerHTML = runtimeEvents
    .slice()
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, MAX_VISIBLE_EVENTS)
    .map((event) => {
      const time = new Date(event.timestamp).toLocaleTimeString();
      const normalizedDetail = event.detail ? event.detail.replace(/\s*\n\s*/g, ' | ') : '';
      const detail = normalizedDetail ? ` - ${escapeHtml(shorten(normalizedDetail, 120))}` : '';
      return `<li>[${time}] ${escapeHtml(event.summary)}${detail}</li>`;
    })
    .join('');
}

function setRuntimeStatus(value: string) {
  if (runtimeStatus) {
    runtimeStatus.textContent = value;
  }
}

function renderGitState(git: GitViewState) {
  currentGitState = git;

  if (gitBranch) {
    gitBranch.textContent = `git: ${git.branch || '-'}`;
  }
  if (gitCounts) {
    gitCounts.textContent = `staged ${git.staged} | unstaged ${git.unstaged} | conflicts ${git.conflicts} | ahead ${git.ahead} | behind ${git.behind}`;
  }
  if (gitMessage) {
    gitMessage.textContent = git.message || 'Git monitoring actief.';
  }
}

function updateRuntimeStatusFromAgents() {
  let working = 0;
  let completed = 0;
  let errors = 0;
  let idle = 0;

  for (const id of agentOrder) {
    const agent = agentState[id];
    if (agent.status === 'working') {
      working += 1;
    } else if (agent.status === 'completed') {
      completed += 1;
    } else if (agent.status === 'error') {
      errors += 1;
    } else {
      idle += 1;
    }
  }

  if (working === 0 && completed === 0 && errors === 0 && idle === agentOrder.length) {
    setRuntimeStatus('IDLE | lounge chat actief');
    return;
  }

  setRuntimeStatus(`${working} actief | ${completed} klaar | ${errors} fout | ${idle} lounge`);
}

function applySnapshot(snapshot: RuntimeState) {
  const now = Date.now();
  for (const agentId of agentOrder) {
    const incoming = snapshot.agents[agentId];
    if (!incoming) {
      continue;
    }
    agentState[agentId] = {
      ...agentState[agentId],
      task: incoming.task,
      status: incoming.status,
      progress: incoming.progress,
      lastEventAt: incoming.lastEventAt
    };

    if (now - incoming.lastEventAt <= SPEECH_VISIBLE_MS) {
      agentState[agentId].speechText = incoming.task ? shorten(incoming.task, 88) : getActiveLine(agentState[agentId]);
      agentState[agentId].lastSpeechAt = incoming.lastEventAt;
    } else {
      agentState[agentId].speechText = '';
      agentState[agentId].lastSpeechAt = 0;
    }

    applyZoneFromStatus(agentState[agentId]);
  }

  runtimeEvents.length = 0;
  runtimeEvents.push(...snapshot.eventLog.slice(0, MAX_VISIBLE_EVENTS));
  renderGitState(snapshot.git || createDefaultGitState());

  setRuntimeStatus(snapshot.statusLine || 'IDLE | lounge chat actief');
  renderAgents();
  renderEvents();
  updateRuntimeStatusFromAgents();
}

function applyEvent(event: PixelRuntimeEvent) {
  if (event.git) {
    renderGitState(event.git);
  }

  if (event.agentId) {
    const agent = agentState[event.agentId];
    if (agent) {
      if (event.status) {
        agent.status = event.status;
      }
      if (typeof event.progress === 'number') {
        agent.progress = Math.max(0, Math.min(100, Math.round(event.progress)));
      }
      if (event.detail) {
        agent.task = event.detail;
      } else if (event.summary) {
        agent.task = event.summary;
      }
      agent.lastEventAt = event.timestamp || Date.now();
      setAgentSpeech(agent, event);
      applyZoneFromStatus(agent);
    }
  }

  runtimeEvents.unshift(event);
  if (runtimeEvents.length > MAX_VISIBLE_EVENTS) {
    runtimeEvents.length = MAX_VISIBLE_EVENTS;
  }

  renderAgents();
  renderEvents();
  updateRuntimeStatusFromAgents();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function drawDesk(x: number, y: number, pulse: number) {
  ctx.fillStyle = '#303a52';
  ctx.fillRect(x, y, 38, 10);
  ctx.fillStyle = '#252d41';
  ctx.fillRect(x + 2, y + 10, 34, 2);

  ctx.fillStyle = '#202534';
  ctx.fillRect(x + 12, y - 9, 14, 8);

  const glow = 95 + Math.floor(35 * Math.sin(pulse));
  ctx.fillStyle = `rgb(${glow}, ${glow + 20}, 180)`;
  ctx.fillRect(x + 13, y - 8, 12, 6);

  ctx.fillStyle = '#171c28';
  ctx.fillRect(x + 6, y + 3, 6, 3);
  ctx.fillRect(x + 26, y + 3, 6, 3);
}

function drawScene(nowMs: number) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#101628';
  ctx.fillRect(0, 0, canvas.width, 74);

  const loungePulse = 0.45 + Math.sin(nowMs * 0.002) * 0.2;
  const workPulse = 0.42 + Math.cos(nowMs * 0.0025) * 0.2;

  ctx.fillStyle = `rgba(102, 224, 190, ${loungePulse.toFixed(2)})`;
  ctx.fillRect(18, 8, 110, 3);
  ctx.fillStyle = `rgba(124, 217, 255, ${workPulse.toFixed(2)})`;
  ctx.fillRect(186, 8, 118, 3);

  ctx.fillStyle = '#1a2a3d';
  ctx.fillRect(8, 74, splitX - 12, 106);
  ctx.fillStyle = '#161f33';
  ctx.fillRect(splitX, 74, canvas.width - splitX, 106);

  ctx.fillStyle = '#2d4f63';
  ctx.fillRect(20, 86, 106, 18);
  ctx.fillStyle = '#40667d';
  ctx.fillRect(24, 90, 98, 5);
  ctx.fillStyle = '#203243';
  ctx.fillRect(40, 104, 66, 7);
  ctx.fillRect(46, 111, 52, 2);

  ctx.fillStyle = '#4a8f69';
  ctx.fillRect(14, 150, 8, 10);
  ctx.fillRect(136, 118, 8, 10);
  ctx.fillStyle = '#2a5f3d';
  ctx.fillRect(15, 160, 6, 2);
  ctx.fillRect(137, 128, 6, 2);

  for (let i = 0; i < 3; i += 1) {
    drawDesk(178, 84 + i * 24, nowMs * 0.004 + i * 5.2);
  }

  ctx.fillStyle = '#304663';
  ctx.fillRect(splitX - 2, 74, 4, 106);

  for (let y = 80; y < canvas.height; y += 14) {
    ctx.strokeStyle = '#2b3b57';
    ctx.beginPath();
    ctx.moveTo(splitX + 2, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  ctx.font = '7px monospace';
  ctx.fillStyle = '#abefdc';
  ctx.fillText('LOUNGE', 18, 70);
  ctx.fillStyle = '#bde9ff';
  ctx.fillText('WERKVLOER', 186, 70);
}

function colorForStatus(agent: AgentVisualState): string {
  if (agent.status === 'error') {
    return '#ff7e9f';
  }
  if (agent.status === 'completed') {
    return '#68d89a';
  }
  if (agent.status === 'idle') {
    return '#7c88a5';
  }
  return agent.color;
}

function limbPalette(agent: AgentVisualState): { arm: string; hand: string; boot: string } {
  if (agent.id === 'scout') {
    return { arm: '#aef0dd', hand: '#79d9c1', boot: '#63bda7' };
  }
  if (agent.id === 'builder') {
    return { arm: '#ffe3aa', hand: '#ffd27a', boot: '#cda24f' };
  }
  return { arm: '#ffd3de', hand: '#ff9eb8', boot: '#c8748f' };
}

function drawAgentBlock(agent: AgentVisualState, nowMs: number) {
  const wobble = Math.sin(nowMs * 0.004 + agent.bob) * 1.5;
  const x = Math.floor(agent.x);
  const y = Math.floor(agent.y + wobble);
  const paused = nowMs < agent.pauseUntilMs;
  const cadence = agent.id === 'builder' ? 14 : agent.id === 'reviewer' ? 18 : 16;
  const step = paused ? 0 : agent.frame % cadence < cadence / 2 ? 0 : 1;
  const palette = limbPalette(agent);

  ctx.fillStyle = '#2f3650';
  ctx.fillRect(x - 1, y - 1, 14, 14);

  ctx.fillStyle = colorForStatus(agent);
  ctx.fillRect(x, y, 12, 12);

  ctx.fillStyle = palette.arm;
  ctx.fillRect(x - 2, y + 5, 2, 3);
  ctx.fillRect(x + 12, y + 5, 2, 3);
  ctx.fillStyle = palette.hand;
  ctx.fillRect(x - 2, y + 8, 2, 1);
  ctx.fillRect(x + 12, y + 8, 2, 1);

  if (agent.status === 'idle' && agent.id === 'scout') {
    ctx.fillRect(x + 12, y + 4, 2, 1);
  }
  if (agent.status === 'idle' && agent.id === 'reviewer') {
    ctx.fillRect(x + 4, y + 9, 4, 1);
  }

  ctx.fillStyle = '#f6f7ff';
  ctx.fillRect(x + 3, y + 3, 2, 2);
  ctx.fillRect(x + 7, y + 3, 2, 2);

  ctx.fillStyle = '#202534';
  ctx.fillRect(x + 4, y + 8, 4, 1);

  ctx.fillStyle = palette.boot;
  ctx.fillRect(x + 2, y + 12 + step, 2, 2);
  ctx.fillRect(x + 8, y + 13 - step, 2, 2);
  ctx.fillStyle = '#ebf4ff';
  ctx.fillRect(x + 2, y + 12 + step, 1, 1);
  ctx.fillRect(x + 8, y + 13 - step, 1, 1);

  if (agent.zone === 'work' && agent.status === 'working') {
    const blink = Math.sin(nowMs * 0.02 + agent.bob) > 0 ? '#9ee7ff' : '#4f6b8f';
    ctx.fillStyle = blink;
    ctx.fillRect(x + 2, y - 3, 8, 1);
  }
}

function drawSpeechCloud(agent: AgentVisualState, nowMs: number) {
  const now = Date.now();
  if (!agent.speechText || now - agent.lastSpeechAt > SPEECH_VISIBLE_MS) {
    return;
  }

  const wobble = Math.sin(nowMs * 0.004 + agent.bob) * 1.5;
  const blockX = Math.floor(agent.x);
  const blockY = Math.floor(agent.y + wobble);

  ctx.font = '8px monospace';
  const lines = wrapBubbleText(`${agent.label}: ${agent.speechText}`, BUBBLE_LINE_MAX_CHARS, BUBBLE_MAX_LINES);
  if (lines.length === 0) {
    return;
  }

  const textWidth = Math.max(...lines.map((line) => Math.ceil(ctx.measureText(line).width)));
  const cloudWidth = Math.max(84, textWidth + 12);
  const cloudHeight = 6 + lines.length * 9;
  const rawX = blockX + 6 - Math.floor(cloudWidth / 2);
  const cloudX = clamp(rawX, 4, canvas.width - cloudWidth - 4);
  const cloudY = blockY - (cloudHeight + 7);

  ctx.fillStyle = '#f6f7ff';
  ctx.fillRect(cloudX, cloudY, cloudWidth, cloudHeight);

  ctx.fillStyle = '#2f3650';
  ctx.fillRect(cloudX, cloudY, cloudWidth, 1);
  ctx.fillRect(cloudX, cloudY + cloudHeight - 1, cloudWidth, 1);
  ctx.fillRect(cloudX, cloudY, 1, cloudHeight);
  ctx.fillRect(cloudX + cloudWidth - 1, cloudY, 1, cloudHeight);
  ctx.fillRect(blockX + 5, cloudY + cloudHeight, 3, 2);
  ctx.fillRect(blockX + 6, cloudY + cloudHeight + 2, 1, 2);

  ctx.fillStyle = '#1f2738';
  for (let index = 0; index < lines.length; index += 1) {
    ctx.fillText(lines[index], cloudX + 5, cloudY + 8 + index * 9);
  }
}

function tickAgent(agent: AgentVisualState, nowMs: number) {
  const inWorkZone = agent.zone === 'work';
  const personality = AGENT_PERSONALITIES[agent.id];
  const lanePool = inWorkZone ? workLaneYs : loungeLaneYs;
  const bounds = inWorkZone ? workBounds : loungeBounds;

  agent.lane = clamp(agent.lane, 0, lanePool.length - 1);

  if (nowMs >= agent.nextPauseAtMs) {
    const busyPause = inWorkZone && agent.status === 'working';
    const pauseDuration = busyPause ? randomRange(900, 2200) : randomRange(350, 1100);
    agent.pauseUntilMs = nowMs + pauseDuration;
    agent.nextPauseAtMs = agent.pauseUntilMs + (busyPause ? randomRange(1300, 3600) : randomRange(2100, 4900));
  }

  const paused = nowMs < agent.pauseUntilMs;

  const speedBase = inWorkZone ? 1.1 : 0.85;
  const speed = speedBase * (inWorkZone ? personality.workSpeed : personality.loungeSpeed);
  if (!paused) {
    agent.x += agent.vx * speed;
  }
  const targetY = lanePool[agent.lane];
  agent.y += (targetY - agent.y) * (inWorkZone ? 0.09 : 0.07);
  if (!paused) {
    agent.frame += 1;
  }

  if (!inWorkZone) {
    agent.x += Math.sin(nowMs * personality.driftFreq + agent.bob) * personality.driftAmp;
    if (agent.status === 'idle') {
      agent.y += Math.sin(nowMs * personality.poseFreq + agent.bob) * personality.poseAmp;
    }
  }

  if (agent.x > bounds.right || agent.x < bounds.left) {
    agent.vx *= -1;
    agent.x = clamp(agent.x, bounds.left, bounds.right);
    agent.lane = Math.floor(Math.random() * lanePool.length);
  }
}

function drawFrame() {
  const nowMs = performance.now();
  drawScene(nowMs);

  for (const id of agentOrder) {
    const agent = agentState[id];
    tickAgent(agent, nowMs);
    drawSpeechCloud(agent, nowMs);
    drawAgentBlock(agent, nowMs);
  }

  requestAnimationFrame(drawFrame);
}

window.addEventListener('message', (rawEvent: MessageEvent<ExtensionMessage>) => {
  const message = rawEvent.data;
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    return;
  }

  if (message.type === 'pixel.snapshot' && message.payload) {
    applySnapshot(message.payload);
    return;
  }

  if (message.type === 'pixel.event' && message.payload) {
    applyEvent(message.payload);
  }
});

refreshButton?.addEventListener('click', () => {
  vscode.postMessage({ type: 'webview-request-snapshot' });
});

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const id of agentOrder) {
    const agent = agentState[id];
    if (agent.status !== 'idle' && now - agent.lastEventAt >= AGENT_INACTIVITY_LIMIT_MS) {
      agent.status = 'idle';
      agent.progress = 0;
      agent.task = 'wacht in lounge';
      applyZoneFromStatus(agent);
      changed = true;
    }
  }

  if (changed) {
    renderAgents();
    updateRuntimeStatusFromAgents();
  }
}, 2000);

renderAgents();
renderEvents();
renderGitState(currentGitState);
setRuntimeStatus('IDLE | lounge chat actief');
drawFrame();

vscode.postMessage({ type: 'webview-ready' });
vscode.postMessage({ type: 'webview-request-snapshot' });

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    if (status) {
      status.textContent = 'HMR updated';
    }
  });
}
