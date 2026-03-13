import characterSheetUrl from "./assets/agent-characters.jpg";
import "./styles.css";

const vscode = acquireVsCodeApi();

type AgentId = "scout" | "builder" | "reviewer";
type AgentStatus = "idle" | "working" | "completed" | "error";
type AgentPhase =
  | "waiting-input"
  | "analyzing"
  | "responding"
  | "executing"
  | "done"
  | "error";
type AgentZone = "lounge" | "work";
type AgentRoutine = "normal" | "pause" | "dance" | "sleep";

interface AgentViewState {
  id: AgentId;
  label: string;
  task: string;
  status: AgentStatus;
  phase?: AgentPhase;
  phaseUpdatedAt?: number;
  lastEventType?: string;
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
  source?: "local" | "copilot-export";
  traceId?: string;
  spanId?: string;
  model?: string;
  latencyMs?: number;
  tokenUsage?: {
    prompt?: number;
    completion?: number;
    total?: number;
  };
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
  phase: AgentPhase;
  phaseUpdatedAt: number;
  lastEventType: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  locationLabel: string;
  workstationId?: string;
  vx: number;
  frame: number;
  bob: number;
  lane: number;
  zone: AgentZone;
  color: string;
  lastSpeechAt: number;
  speechVisibleUntil: number;
  speechText: string;
  pauseUntilMs: number;
  nextPauseAtMs: number;
  routine: AgentRoutine;
  routineUntilMs: number;
  nextRoutineAtMs: number;
  characterId: string;
  characterLabel: string;
  spriteRect?: SpriteRect;
}

interface SpriteRect {
  x: number;
  y: number;
  width: number;
  height: number;
  pixelCount: number;
}

interface AgentSpriteVariant {
  id: string;
  label: string;
  rect: SpriteRect;
}

interface Spot {
  x: number;
  y: number;
}

type WorkstationRole = "research" | "engineering" | "qa";

interface WorkstationSpot extends Spot {
  id: string;
  label: string;
  role: WorkstationRole;
  deskX: number;
  deskY: number;
}

interface WorkstationActivity {
  occupied: number;
  working: number;
  completed: number;
  error: number;
}

interface BubbleBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BubbleLayout {
  agent: AgentVisualState;
  lines: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  anchorX: number;
}

type ExtensionMessage =
  | { type: "pixel.snapshot"; payload: RuntimeState }
  | { type: "pixel.event"; payload: PixelRuntimeEvent };

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app container.");
}

const AGENT_INACTIVITY_LIMIT_MS = 10_000;
const SPEECH_BASE_VISIBLE_MS = 3_600;
const SPEECH_PER_CHAR_MS = 24;
const SPEECH_MAX_VISIBLE_MS = 6_200;
const BUBBLE_MAX_LINES = 2;
const BUBBLE_LINE_MAX_CHARS = 34;
const BUBBLE_MIN_GAP_PX = 3;
const BUBBLE_EDGE_MARGIN_PX = 4;
const MAX_VISIBLE_EVENTS = 14;
const IDLE_CHAT_MIN_GAP_MS = 1_500;
const IDLE_CHAT_MAX_GAP_MS = 4_800;
const IDLE_REPLY_MIN_DELAY_MS = 450;
const IDLE_REPLY_MAX_DELAY_MS = 1_050;
const COMPLETION_TO_WAITING_MS = 6_500;
const MIN_SPRITE_COMPONENT_PIXELS = 1_800;
const MIN_SPRITE_WIDTH = 46;
const MIN_SPRITE_HEIGHT = 72;
const DEFAULT_SPRITE_COLUMNS = 3;
const DEFAULT_SPRITE_ROWS = 4;

interface IdleJoke {
  setup: string;
  reply: string;
}

const IDLE_JOKES: IdleJoke[] = [
  {
    setup: "Waarom breekt de build altijd vrijdag?",
    reply: "Omdat bugs weekendplannen hebben.",
  },
  {
    setup: "Ik had een race condition opgelost.",
    reply: "Top, was je op tijd voor jezelf?",
  },
  {
    setup: "Deze feature was vijf minuten werk.",
    reply: "Ja, plus 2 uur naming-discussie.",
  },
  {
    setup: "Mijn test is flaky, maar alleen bij maanlicht.",
    reply: "Dan noemen we het een astrologische dependency.",
  },
  {
    setup: "Ik heb 1 semicolon gefixt.",
    reply: "Perfect, nu durft lint weer te ademen.",
  },
  {
    setup: "Code review zei: kleine wijziging.",
    reply: "Klein, als je 19 files negeert.",
  },
  {
    setup: "Waarom praat jij tegen de compiler?",
    reply: "Omdat docs soms stiller zijn dan errors.",
  },
  {
    setup: "Ik heb de bug niet kunnen reproduceren.",
    reply: "Mooi, dan reproduceert hij jou straks.",
  },
];

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
      "ik scan nog even de context.",
      "waar zit de volgende winst?",
      "commit-plan wordt scherp gezet.",
      "ik spot alvast de risico's.",
      "nog een snelle map-check.",
    ],
    workFallback: "context en impact checken",
    icons: ["🙂", "🧭", "✨"],
    loungeSpeed: 0.95,
    workSpeed: 1.05,
    driftAmp: 0.14,
    driftFreq: 0.0019,
    poseAmp: 0.22,
    poseFreq: 0.0036,
  },
  builder: {
    idleLines: [
      "ik zet alvast een patch op.",
      "nog 1 refactor en door.",
      "de build moet strak blijven.",
      "ik warm de compiler op.",
      "ready voor de volgende feature.",
    ],
    workFallback: "implementatie uitwerken",
    icons: ["😄", "🛠️", "🚀"],
    loungeSpeed: 1.02,
    workSpeed: 1.18,
    driftAmp: 0.09,
    driftFreq: 0.0015,
    poseAmp: 0.16,
    poseFreq: 0.0042,
  },
  reviewer: {
    idleLines: [
      "ik hou de checks paraat.",
      "randgevallen eerst, altijd.",
      "ik kijk nog naar regressies.",
      "lint en tests blijven heilig.",
      "klaar voor een snelle review.",
    ],
    workFallback: "validatie en checks draaien",
    icons: ["😉", "🔎", "✅"],
    loungeSpeed: 0.88,
    workSpeed: 0.97,
    driftAmp: 0.07,
    driftFreq: 0.0013,
    poseAmp: 0.13,
    poseFreq: 0.0029,
  },
};

interface AgentMangaPalette {
  outline: string;
  coat: string;
  coatShade: string;
  accent: string;
  hair: string;
  hairShade: string;
  skin: string;
  visor: string;
  effect: string;
  badge: string;
}

const AGENT_MANGA_PALETTES: Record<AgentId, AgentMangaPalette> = {
  scout: {
    outline: "#2a3042",
    coat: "#252c3f",
    coatShade: "#dce8f4",
    accent: "#ff73b5",
    hair: "#ff99ca",
    hairShade: "#d45f9f",
    skin: "#f7d5c7",
    visor: "#82e9ff",
    effect: "#effbff",
    badge: "SC",
  },
  builder: {
    outline: "#272e40",
    coat: "#2a2945",
    coatShade: "#d6e4f4",
    accent: "#ff7fbc",
    hair: "#ff87c0",
    hairShade: "#c75699",
    skin: "#f4ccbf",
    visor: "#89ecff",
    effect: "#edf8ff",
    badge: "BL",
  },
  reviewer: {
    outline: "#2b2f45",
    coat: "#25243f",
    coatShade: "#e3edf8",
    accent: "#ff6fb2",
    hair: "#ff92c8",
    hairShade: "#bc4c92",
    skin: "#f6d2c4",
    visor: "#8ef0ff",
    effect: "#f3fbff",
    badge: "RV",
  },
};

app.innerHTML = `
  <main class="screen">
    <section class="card">
      <header class="title-row">
        <div>
          <p class="kicker">Endfield Command Grid</p>
          <h1>Anime-Tech Pixel Agent Ops</h1>
          <p class="subtitle">Lichtere Endfield variant met wit-metaal basis en roze anime-tech agents.</p>
        </div>
        <div class="title-actions">
          <span class="mode-chip">END-FIELD LITE</span>
          <button id="refresh-button" type="button">Sync Snapshot</button>
        </div>
      </header>

      <section class="scene-shell">
        <canvas id="scene" width="320" height="180" aria-label="Pixel agent scene"></canvas>
        <div class="scene-caption">
          <span class="pill lounge">Middenplein: idle kletsen</span>
          <span class="pill work">Research = analyse, Engineering = build, QA = review/error</span>
          <span class="pill">Rustbed: max 1 agent tegelijk</span>
        </div>
      </section>

      <section class="status-grid">
        <div class="status-row">
          <span>Runtime vector</span>
          <strong id="runtime-status">IDLE</strong>
        </div>
        <div class="status-row">
          <span>Webview link</span>
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

const status = app.querySelector<HTMLElement>("#hmr-status");
const runtimeStatus = app.querySelector<HTMLElement>("#runtime-status");
const refreshButton = app.querySelector<HTMLButtonElement>("#refresh-button");
const agentList = app.querySelector<HTMLDivElement>("#agent-list");
const eventList = app.querySelector<HTMLUListElement>("#event-log-list");
const gitBranch = app.querySelector<HTMLElement>("#git-branch");
const gitCounts = app.querySelector<HTMLElement>("#git-counts");
const gitMessage = app.querySelector<HTMLElement>("#git-message");
const canvas = app.querySelector<HTMLCanvasElement>("#scene");

if (!canvas) {
  throw new Error("Missing #scene canvas.");
}

const ctx = canvas.getContext("2d");
if (!ctx) {
  throw new Error("Canvas context unavailable.");
}

const FLOOR_BOUNDS = {
  left: 20,
  right: canvas.width - 20,
  top: 42,
  bottom: canvas.height - 20,
};
const CHAT_SPOTS: readonly Spot[] = [
  { x: 150, y: 106 },
  { x: 168, y: 118 },
  { x: 148, y: 132 },
];
const BED_SPOT: Spot = { x: 90, y: 146 };
const WORKSTATIONS: readonly WorkstationSpot[] = [
  {
    id: "ws-1",
    label: "Research 1",
    role: "research",
    x: 84,
    y: 66,
    deskX: 56,
    deskY: 36,
  },
  {
    id: "ws-2",
    label: "Research 2",
    role: "research",
    x: 236,
    y: 66,
    deskX: 206,
    deskY: 36,
  },
  {
    id: "ws-3",
    label: "Engineering 1",
    role: "engineering",
    x: 268,
    y: 108,
    deskX: 240,
    deskY: 84,
  },
  {
    id: "ws-4",
    label: "Engineering 2",
    role: "engineering",
    x: 220,
    y: 146,
    deskX: 190,
    deskY: 124,
  },
  {
    id: "ws-5",
    label: "QA 1",
    role: "qa",
    x: 56,
    y: 108,
    deskX: 28,
    deskY: 84,
  },
];
const ROLE_TO_STATIONS: Record<WorkstationRole, readonly string[]> = {
  research: ["ws-1", "ws-2"],
  engineering: ["ws-3", "ws-4"],
  qa: ["ws-5"],
};
const AGENT_ROLE_STATION_SLOT: Record<
  AgentId,
  Record<WorkstationRole, number>
> = {
  scout: { research: 0, engineering: 0, qa: 0 },
  builder: { research: 1, engineering: 1, qa: 0 },
  reviewer: { research: 1, engineering: 0, qa: 0 },
};

const agentOrder: AgentId[] = ["scout", "builder", "reviewer"];
const agentState: Record<AgentId, AgentVisualState> = {
  scout: createDefaultAgent(
    "scout",
    "Scout",
    "#ff94c8",
    CHAT_SPOTS[0].x,
    0,
    0.46,
    0.3,
  ),
  builder: createDefaultAgent(
    "builder",
    "Builder",
    "#ff7dbb",
    CHAT_SPOTS[1].x,
    1,
    -0.41,
    1.4,
  ),
  reviewer: createDefaultAgent(
    "reviewer",
    "Reviewer",
    "#ff9fd2",
    CHAT_SPOTS[2].x,
    2,
    0.52,
    2.5,
  ),
};

const runtimeEvents: PixelRuntimeEvent[] = [];
let currentGitState = createDefaultGitState();
let nextIdleChatAt =
  Date.now() +
  Math.round(randomRange(IDLE_CHAT_MIN_GAP_MS, IDLE_CHAT_MAX_GAP_MS));
let spriteSheetImage: HTMLImageElement | undefined;
let spriteVariants: AgentSpriteVariant[] = [];

function createDefaultGitState(): GitViewState {
  return {
    available: false,
    branch: "-",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    conflicts: 0,
    hasChanges: false,
    lastCommit: "-",
    repositoryRoot: "-",
    message: "Git status wordt geladen.",
  };
}

function createDefaultAgent(
  id: AgentId,
  label: string,
  color: string,
  x: number,
  lane: number,
  vx: number,
  bob: number,
): AgentVisualState {
  const nowMs = performance.now();
  const startSpot = CHAT_SPOTS[lane % CHAT_SPOTS.length] || CHAT_SPOTS[0];
  return {
    id,
    label,
    task: "wacht in lounge",
    status: "idle",
    phase: "waiting-input",
    phaseUpdatedAt: Date.now(),
    lastEventType: "init",
    progress: 0,
    lastEventAt: Date.now(),
    x,
    y: startSpot.y,
    targetX: startSpot.x,
    targetY: startSpot.y,
    locationLabel: "middenplein",
    workstationId: undefined,
    vx,
    frame: 0,
    bob,
    lane,
    zone: "lounge",
    color,
    lastSpeechAt: 0,
    speechVisibleUntil: 0,
    speechText: "",
    pauseUntilMs: nowMs,
    nextPauseAtMs: nowMs + 1200 + Math.random() * 2200,
    routine: "normal",
    routineUntilMs: nowMs + randomRange(1800, 3600),
    nextRoutineAtMs: nowMs + randomRange(1100, 2600),
    characterId: `${id}-default`,
    characterLabel: "Character ?",
    spriteRect: undefined,
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
  return (
    statusValue === "working" ||
    statusValue === "completed" ||
    statusValue === "error"
  );
}

function isBedOccupied(exceptAgentId?: AgentId): boolean {
  return agentOrder
    .map((id) => agentState[id])
    .some(
      (agent) =>
        agent.id !== exceptAgentId &&
        agent.status === "idle" &&
        agent.routine === "sleep" &&
        agent.locationLabel === "rustbed",
    );
}

function getWorkstationById(id: string): WorkstationSpot | undefined {
  return WORKSTATIONS.find((station) => station.id === id);
}

function resolveWorkRole(agent: AgentVisualState): WorkstationRole {
  if (agent.status === "error" || agent.phase === "error") {
    return "qa";
  }
  if (agent.phase === "done" || agent.status === "completed") {
    return "qa";
  }

  const text = `${agent.task} ${agent.lastEventType}`.toLowerCase();
  if (/lint|test|check|audit|validate|review|diagnos|qa/.test(text)) {
    return "qa";
  }

  if (
    agent.phase === "executing" ||
    /build|compile|bundle|vite|npm|tsc|write|patch|implement|refactor|execute|run/.test(
      text,
    )
  ) {
    return "engineering";
  }

  if (
    agent.phase === "analyzing" ||
    agent.phase === "responding" ||
    /analy|scan|context|plan|read|diff|status|prompt|respond|stream|answer|chat/.test(
      text,
    )
  ) {
    return "research";
  }

  return "engineering";
}

function resolveWorkstation(agent: AgentVisualState): WorkstationSpot {
  const role = resolveWorkRole(agent);
  const preferredIds = ROLE_TO_STATIONS[role];
  const preferredSlot =
    AGENT_ROLE_STATION_SLOT[agent.id][role] % preferredIds.length;
  const rotatedIds = [
    ...preferredIds.slice(preferredSlot),
    ...preferredIds.slice(0, preferredSlot),
  ];

  let bestStation = getWorkstationById(preferredIds[0]) || WORKSTATIONS[0];
  let bestScore = Number.POSITIVE_INFINITY;

  for (let i = 0; i < rotatedIds.length; i += 1) {
    const stationId = rotatedIds[i];
    const station = getWorkstationById(stationId);
    if (!station) {
      continue;
    }

    const occupancy = agentOrder
      .map((id) => agentState[id])
      .filter(
        (other) =>
          other.id !== agent.id &&
          isActiveStatus(other.status) &&
          other.workstationId === station.id,
      ).length;

    const score = occupancy * 10 + i;
    if (score < bestScore) {
      bestScore = score;
      bestStation = station;
    }
  }

  return bestStation;
}

function resolveChatSpot(agent: AgentVisualState): Spot {
  const index = Math.max(0, agentOrder.indexOf(agent.id)) % CHAT_SPOTS.length;
  return CHAT_SPOTS[index];
}

function applyZoneFromStatus(agent: AgentVisualState) {
  const active = isActiveStatus(agent.status);
  agent.zone = active ? "work" : "lounge";

  if (active) {
    const station = resolveWorkstation(agent);
    agent.targetX = station.x;
    agent.targetY = station.y;
    agent.locationLabel = station.label;
    agent.workstationId = station.id;
    agent.lane = WORKSTATIONS.findIndex((value) => value.id === station.id);
  } else {
    agent.workstationId = undefined;
    if (agent.routine === "sleep" && !isBedOccupied(agent.id)) {
      agent.targetX = BED_SPOT.x;
      agent.targetY = BED_SPOT.y;
      agent.locationLabel = "rustbed";
      agent.lane = 0;
    } else {
      if (agent.routine === "sleep" && isBedOccupied(agent.id)) {
        agent.routine = "pause";
      }

      const chatSpot = resolveChatSpot(agent);
      agent.targetX = chatSpot.x;
      agent.targetY = chatSpot.y;
      agent.locationLabel = "middenplein";
      agent.lane = Math.max(0, agentOrder.indexOf(agent.id));
    }
  }

  agent.x = clamp(agent.x, FLOOR_BOUNDS.left, FLOOR_BOUNDS.right);
  agent.y = clamp(agent.y, FLOOR_BOUNDS.top, FLOOR_BOUNDS.bottom);
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

  if (agent.status === "completed") {
    return `klaar: ${core} ${icon}`;
  }
  if (agent.status === "error") {
    return `let op: ${core} ${icon}`;
  }
  if (agent.id === "scout") {
    return `scan: ${core} ${icon}`;
  }
  if (agent.id === "builder") {
    return `bouwt: ${core} ${icon}`;
  }
  return `checkt: ${core} ${icon}`;
}

function pickAgentIcon(agent: AgentVisualState, seed: number): string {
  const icons = AGENT_PERSONALITIES[agent.id].icons;
  const index =
    Math.abs(Math.floor(seed / 850) + agent.lane + agent.id.length) %
    icons.length;
  return icons[index];
}

function pickRandom<T>(items: readonly T[]): T {
  const index = Math.floor(Math.random() * items.length);
  return items[index];
}

function shuffledCopy<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pickUniqueRandom<T>(items: readonly T[], count: number): T[] {
  return shuffledCopy(items).slice(
    0,
    Math.max(0, Math.min(count, items.length)),
  );
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Kan image niet laden: ${src}`));
    image.src = src;
  });
}

function isForegroundPixel(data: Uint8ClampedArray, index: number): boolean {
  const alpha = data[index + 3];
  if (alpha < 20) {
    return false;
  }

  const r = data[index];
  const g = data[index + 1];
  const b = data[index + 2];
  const lightness = (r + g + b) / 3;
  const saturation = Math.max(r, g, b) - Math.min(r, g, b);
  return lightness < 247 || saturation > 14;
}

function detectSpriteRects(image: HTMLImageElement): SpriteRect[] {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (width <= 0 || height <= 0) {
    return [];
  }

  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;
  const offCtx = offscreen.getContext("2d", { willReadFrequently: true });
  if (!offCtx) {
    return [];
  }

  offCtx.drawImage(image, 0, 0, width, height);
  const { data } = offCtx.getImageData(0, 0, width, height);
  const size = width * height;
  const mask = new Uint8Array(size);
  const visited = new Uint8Array(size);
  const queue = new Int32Array(size);

  for (let i = 0; i < size; i += 1) {
    const dataIndex = i * 4;
    if (isForegroundPixel(data, dataIndex)) {
      mask[i] = 1;
    }
  }

  const found: SpriteRect[] = [];

  for (let index = 0; index < size; index += 1) {
    if (mask[index] === 0 || visited[index] === 1) {
      continue;
    }

    let head = 0;
    let tail = 0;
    queue[tail] = index;
    tail += 1;
    visited[index] = 1;

    let minX = index % width;
    let maxX = minX;
    let minY = Math.floor(index / width);
    let maxY = minY;
    let pixels = 0;

    while (head < tail) {
      const current = queue[head];
      head += 1;
      pixels += 1;

      const x = current % width;
      const y = Math.floor(current / width);

      if (x < minX) {
        minX = x;
      }
      if (x > maxX) {
        maxX = x;
      }
      if (y < minY) {
        minY = y;
      }
      if (y > maxY) {
        maxY = y;
      }

      const left = x > 0 ? current - 1 : -1;
      const right = x < width - 1 ? current + 1 : -1;
      const up = y > 0 ? current - width : -1;
      const down = y < height - 1 ? current + width : -1;

      if (left >= 0 && mask[left] === 1 && visited[left] === 0) {
        visited[left] = 1;
        queue[tail] = left;
        tail += 1;
      }
      if (right >= 0 && mask[right] === 1 && visited[right] === 0) {
        visited[right] = 1;
        queue[tail] = right;
        tail += 1;
      }
      if (up >= 0 && mask[up] === 1 && visited[up] === 0) {
        visited[up] = 1;
        queue[tail] = up;
        tail += 1;
      }
      if (down >= 0 && mask[down] === 1 && visited[down] === 0) {
        visited[down] = 1;
        queue[tail] = down;
        tail += 1;
      }
    }

    const rectWidth = maxX - minX + 1;
    const rectHeight = maxY - minY + 1;
    if (
      pixels < MIN_SPRITE_COMPONENT_PIXELS ||
      rectWidth < MIN_SPRITE_WIDTH ||
      rectHeight < MIN_SPRITE_HEIGHT
    ) {
      continue;
    }

    const padding = 3;
    const paddedX = clamp(minX - padding, 0, width - 1);
    const paddedY = clamp(minY - padding, 0, height - 1);
    found.push({
      x: paddedX,
      y: paddedY,
      width: clamp(rectWidth + padding * 2, 1, width - paddedX),
      height: clamp(rectHeight + padding * 2, 1, height - paddedY),
      pixelCount: pixels,
    });
  }

  found.sort((left, right) => {
    const rowBand = Math.max(left.height, right.height) * 0.44;
    if (Math.abs(left.y - right.y) > rowBand) {
      return left.y - right.y;
    }
    return left.x - right.x;
  });

  return found;
}

function buildGridFallbackRects(image: HTMLImageElement): SpriteRect[] {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const cellWidth = Math.floor(width / DEFAULT_SPRITE_COLUMNS);
  const cellHeight = Math.floor(height / DEFAULT_SPRITE_ROWS);
  const rects: SpriteRect[] = [];

  for (let row = 0; row < DEFAULT_SPRITE_ROWS; row += 1) {
    for (let col = 0; col < DEFAULT_SPRITE_COLUMNS; col += 1) {
      const x = col * cellWidth;
      const y = row * cellHeight;
      const w = col === DEFAULT_SPRITE_COLUMNS - 1 ? width - x : cellWidth;
      const h = row === DEFAULT_SPRITE_ROWS - 1 ? height - y : cellHeight;
      rects.push({
        x,
        y,
        width: w,
        height: h,
        pixelCount: w * h,
      });
    }
  }

  return rects;
}

function toSpriteVariants(rects: SpriteRect[]): AgentSpriteVariant[] {
  return rects.map((rect, index) => {
    const number = String(index + 1).padStart(2, "0");
    return {
      id: `char-${number}`,
      label: `Character ${number}`,
      rect,
    };
  });
}

function assignRandomCharactersToAgents() {
  if (spriteVariants.length < agentOrder.length) {
    return;
  }

  const picks = pickUniqueRandom(spriteVariants, agentOrder.length);
  for (let i = 0; i < agentOrder.length; i += 1) {
    const agentId = agentOrder[i];
    const variant = picks[i];
    if (!variant) {
      continue;
    }
    agentState[agentId].characterId = variant.id;
    agentState[agentId].characterLabel = variant.label;
    agentState[agentId].spriteRect = variant.rect;
  }
}

async function initializeCharacterSprites() {
  try {
    const image = await loadImage(characterSheetUrl);
    const detectedRects = detectSpriteRects(image);
    const usableRects =
      detectedRects.length >= agentOrder.length
        ? detectedRects
        : buildGridFallbackRects(image);

    spriteSheetImage = image;
    spriteVariants = toSpriteVariants(usableRects);
    assignRandomCharactersToAgents();
    renderAgents();

    if (status) {
      status.textContent = `Connected | chars ${spriteVariants.length}`;
    }
  } catch {
    spriteSheetImage = undefined;
    spriteVariants = [];
    if (status) {
      status.textContent = "Connected | default sprites";
    }
  }
}

function setAgentSpeechText(
  agent: AgentVisualState,
  text: string,
  timestamp: number = Date.now(),
) {
  const normalized = shorten(text.replace(/\s+/g, " ").trim(), 96);
  const visibleDuration = clamp(
    SPEECH_BASE_VISIBLE_MS + normalized.length * SPEECH_PER_CHAR_MS,
    SPEECH_BASE_VISIBLE_MS,
    SPEECH_MAX_VISIBLE_MS,
  );
  agent.speechText = normalized;
  agent.lastSpeechAt = timestamp;
  agent.speechVisibleUntil = timestamp + visibleDuration;
}

function isSpeechVisible(agent: AgentVisualState, nowMs: number): boolean {
  return Boolean(agent.speechText) && nowMs <= agent.speechVisibleUntil;
}

function chooseNextIdleRoutine(agent: AgentVisualState, nowMs: number) {
  const roll = Math.random();
  let routine: AgentRoutine = "normal";
  if (roll >= 0.56 && roll < 0.74) {
    routine = "pause";
  } else if (roll >= 0.74 && roll < 0.9) {
    routine = "dance";
  } else if (roll >= 0.9) {
    routine = "sleep";
  }

  if (routine === "sleep" && isBedOccupied(agent.id)) {
    routine = "pause";
  }

  agent.routine = routine;

  if (routine === "pause") {
    agent.routineUntilMs = nowMs + randomRange(1300, 2600);
  } else if (routine === "dance") {
    agent.routineUntilMs = nowMs + randomRange(1800, 3600);
  } else if (routine === "sleep") {
    agent.routineUntilMs = nowMs + randomRange(2000, 3900);
  } else {
    agent.routineUntilMs = nowMs + randomRange(1700, 3200);
  }

  agent.nextRoutineAtMs = agent.routineUntilMs + randomRange(900, 2400);
}

function maybeRunIdleChatter() {
  const now = Date.now();
  if (now < nextIdleChatAt) {
    return;
  }

  const idleAgents = agentOrder
    .map((id) => agentState[id])
    .filter((agent) => agent.status === "idle" && agent.routine !== "sleep");

  if (idleAgents.length < 2) {
    nextIdleChatAt = now + Math.round(randomRange(900, 2200));
    return;
  }

  if (Math.random() < 0.34) {
    nextIdleChatAt = now + Math.round(randomRange(1200, 2800));
    return;
  }

  const joke = pickRandom(IDLE_JOKES);
  const speaker = pickRandom(idleAgents);
  const responses = idleAgents.filter((agent) => agent.id !== speaker.id);
  const responder = pickRandom(responses);

  setAgentSpeechText(
    speaker,
    `${joke.setup} ${pickAgentIcon(speaker, now)}`,
    now,
  );

  const delay = Math.round(
    randomRange(IDLE_REPLY_MIN_DELAY_MS, IDLE_REPLY_MAX_DELAY_MS),
  );
  setTimeout(() => {
    if (responder.status !== "idle" || responder.routine === "sleep") {
      return;
    }
    setAgentSpeechText(
      responder,
      `${joke.reply} ${pickAgentIcon(responder, Date.now())}`,
    );
  }, delay);

  nextIdleChatAt =
    now + Math.round(randomRange(IDLE_CHAT_MIN_GAP_MS, IDLE_CHAT_MAX_GAP_MS));
}

function wrapWords(line: string, maxChars: number): string[] {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }

  const expanded: string[] = [];
  for (const word of words) {
    if (word.length <= maxChars) {
      expanded.push(word);
      continue;
    }

    for (let index = 0; index < word.length; index += maxChars) {
      expanded.push(word.slice(index, index + maxChars));
    }
  }

  const wrapped: string[] = [];
  let current = expanded[0];
  for (let i = 1; i < expanded.length; i += 1) {
    const next = `${current} ${expanded[i]}`;
    if (next.length <= maxChars) {
      current = next;
    } else {
      wrapped.push(current);
      current = expanded[i];
    }
  }
  wrapped.push(current);
  return wrapped;
}

function wrapBubbleText(
  text: string,
  maxChars: number,
  maxLines: number,
): string[] {
  const parts = text
    .split("\n")
    .map((part) => part.replace(/\s+/g, " ").trim())
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

  const joined = parts.join(" ");
  const rendered = lines.join(" ");
  if (rendered.length < joined.length) {
    const lastIndex = lines.length - 1;
    lines[lastIndex] = shorten(lines[lastIndex], Math.max(4, maxChars - 1));
    if (!lines[lastIndex].endsWith("...")) {
      lines[lastIndex] =
        `${shorten(lines[lastIndex], Math.max(4, maxChars - 4))}...`;
    }
  }

  return lines;
}

function buildSpeechFromEvent(
  agent: AgentVisualState,
  event: PixelRuntimeEvent,
): string {
  const baseSummary = event.summary
    ? shorten(event.summary.replace(/\s+/g, " ").trim(), 74)
    : getActiveLine(agent);
  const detail = event.detail ? shorten(event.detail.trim(), 90) : "";
  if (detail && detail !== baseSummary) {
    return `${baseSummary}\n${detail}`;
  }
  return baseSummary || getIdleLine(agent, event.timestamp || Date.now());
}

function setAgentSpeech(agent: AgentVisualState, event: PixelRuntimeEvent) {
  setAgentSpeechText(
    agent,
    buildSpeechFromEvent(agent, event),
    event.timestamp || Date.now(),
  );
}

function renderAgents() {
  if (!agentList) {
    return;
  }

  agentList.innerHTML = agentOrder
    .map((agentId) => {
      const agent = agentState[agentId];
      const location = agent.locationLabel;
      const palette = AGENT_MANGA_PALETTES[agentId];
      const characterLabel = escapeHtml(agent.characterLabel);
      return `
        <article class="agent-item">
          <div class="agent-avatar ${agentId} ${agent.status}">
            <span>${palette.badge}</span>
          </div>
          <div class="agent-meta">
            <p class="agent-name">${agent.label}</p>
            <p class="agent-character">${characterLabel}</p>
            <p class="agent-task">${escapeHtml(shorten(agent.task, 72))}</p>
            <div class="agent-progress-track">
              <span class="agent-progress-fill" style="width:${agent.progress}%"></span>
            </div>
          </div>
          <p class="agent-state ${agent.status}">${phaseToLabel(agent.phase)} | ${agent.progress}% | ${location}</p>
        </article>
      `;
    })
    .join("");
}

function renderEvents() {
  if (!eventList) {
    return;
  }

  if (runtimeEvents.length === 0) {
    eventList.innerHTML = "<li>Nog geen events ontvangen.</li>";
    return;
  }

  eventList.innerHTML = runtimeEvents
    .slice()
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, MAX_VISIBLE_EVENTS)
    .map((event) => {
      const time = new Date(event.timestamp).toLocaleTimeString();
      const normalizedDetail = event.detail
        ? event.detail.replace(/\s*\n\s*/g, " | ")
        : "";
      const detail = normalizedDetail
        ? ` - ${escapeHtml(shorten(normalizedDetail, 120))}`
        : "";

      const sourceTag = event.source ? ` [${event.source}]` : "";
      const traceTag = event.traceId
        ? ` trace=${escapeHtml(shorten(event.traceId, 16))}`
        : "";
      const modelTag = event.model
        ? ` model=${escapeHtml(shorten(event.model, 28))}`
        : "";

      let tokenTag = "";
      if (event.tokenUsage) {
        const prompt =
          typeof event.tokenUsage.prompt === "number"
            ? `p:${Math.round(event.tokenUsage.prompt)}`
            : "";
        const completion =
          typeof event.tokenUsage.completion === "number"
            ? `c:${Math.round(event.tokenUsage.completion)}`
            : "";
        const total =
          typeof event.tokenUsage.total === "number"
            ? `t:${Math.round(event.tokenUsage.total)}`
            : "";
        const bits = [prompt, completion, total].filter(Boolean).join("/");
        if (bits) {
          tokenTag = ` tokens(${bits})`;
        }
      }

      const latencyTag =
        typeof event.latencyMs === "number"
          ? ` ${Math.round(event.latencyMs)}ms`
          : "";
      return `<li>[${time}] ${escapeHtml(event.summary)}${sourceTag}${detail}${traceTag}${modelTag}${tokenTag}${latencyTag}</li>`;
    })
    .join("");
}

function setRuntimeStatus(value: string) {
  if (runtimeStatus) {
    runtimeStatus.textContent = value;
  }
}

function phaseToLabel(phase: AgentPhase): string {
  if (phase === "waiting-input") {
    return "wacht op input";
  }
  if (phase === "analyzing") {
    return "analyseert";
  }
  if (phase === "responding") {
    return "antwoordt";
  }
  if (phase === "executing") {
    return "bezig";
  }
  if (phase === "done") {
    return "afgerond";
  }
  return "fout";
}

function resolveWorkingPhaseFromText(text: string): AgentPhase {
  if (
    /analy|analyse|scan|diagnos|context|plan|read|diff|status|review/.test(text)
  ) {
    return "analyzing";
  }
  if (/stream|antwoord|response|reply/.test(text)) {
    return "responding";
  }
  return "executing";
}

function derivePhaseFromSnapshot(
  agent: AgentViewState,
  now: number,
): AgentPhase {
  if (agent.status === "error") {
    return "error";
  }
  if (agent.status === "idle") {
    return "waiting-input";
  }
  if (agent.status === "completed") {
    return now - agent.lastEventAt > COMPLETION_TO_WAITING_MS
      ? "waiting-input"
      : "done";
  }

  return resolveWorkingPhaseFromText((agent.task || "").toLowerCase());
}

function derivePhaseFromEvent(
  event: PixelRuntimeEvent,
  previous: AgentVisualState,
): AgentPhase {
  if (event.status === "error") {
    return "error";
  }
  if (event.status === "idle") {
    return "waiting-input";
  }

  const type = (event.type || "").toLowerCase();
  const text = `${event.summary || ""} ${event.detail || ""}`.toLowerCase();
  const combined = `${type} ${text}`;

  if (/chat\.received/.test(type)) {
    return "analyzing";
  }
  if (/chat\.streaming/.test(type)) {
    return "responding";
  }
  if (/chat\.completed/.test(type)) {
    return "done";
  }
  if (
    /idletimeout|wacht|waiting|geen nieuwe events|no new events/.test(combined)
  ) {
    return "waiting-input";
  }
  if (
    /analy|analyse|scan|diagnos|context|plan|read|diff|status|review/.test(
      combined,
    )
  ) {
    return "analyzing";
  }

  if (event.status === "working") {
    return resolveWorkingPhaseFromText(combined);
  }
  if (event.status === "completed") {
    return "done";
  }

  return previous.phase;
}

function getLatestEventForAgent(
  agentId: AgentId,
): PixelRuntimeEvent | undefined {
  return runtimeEvents.find((event) => event.agentId === agentId);
}

function formatRuntimeStatus(
  working: number,
  completed: number,
  errors: number,
  idle: number,
): string {
  const now = Date.now();
  const phases = agentOrder
    .map((id) => agentState[id])
    .filter((agent) => agent.status === "working")
    .map((agent) => agent.phase);

  if (errors > 0) {
    return `${working} actief | ${completed} klaar | ${errors} fout | ${idle} lounge`;
  }

  if (working > 0) {
    if (phases.includes("analyzing")) {
      return `${working} actief | analyseert prompt/context`;
    }
    if (phases.includes("responding")) {
      return `${working} actief | antwoord aan het opbouwen`;
    }
    return `${working} actief | bezig met uitvoeren`;
  }

  const recentCompletion = runtimeEvents.find(
    (event) =>
      event.type.startsWith("chat.completed") ||
      (event.status === "completed" &&
        now - event.timestamp <= COMPLETION_TO_WAITING_MS),
  );
  if (
    recentCompletion &&
    now - recentCompletion.timestamp <= COMPLETION_TO_WAITING_MS
  ) {
    return "Wacht op input | laatste antwoord klaar";
  }

  return "Wacht op input | lounge chat actief";
}

function renderGitState(git: GitViewState) {
  currentGitState = git;

  if (gitBranch) {
    gitBranch.textContent = `git: ${git.branch || "-"}`;
  }
  if (gitCounts) {
    gitCounts.textContent = `staged ${git.staged} | unstaged ${git.unstaged} | conflicts ${git.conflicts} | ahead ${git.ahead} | behind ${git.behind}`;
  }
  if (gitMessage) {
    gitMessage.textContent = git.message || "Git monitoring actief.";
  }
}

function updateRuntimeStatusFromAgents() {
  let working = 0;
  let completed = 0;
  let errors = 0;
  let idle = 0;
  const now = Date.now();

  for (const id of agentOrder) {
    const agent = agentState[id];
    if (agent.status === "working") {
      const latest = getLatestEventForAgent(id);
      if (latest) {
        agent.phase = derivePhaseFromEvent(latest, agent);
        agent.phaseUpdatedAt = latest.timestamp;
        agent.lastEventType = latest.type;
      }
    } else if (agent.status === "idle") {
      agent.phase = "waiting-input";
    } else if (
      agent.status === "completed" &&
      now - agent.lastEventAt > COMPLETION_TO_WAITING_MS
    ) {
      agent.phase = "waiting-input";
    }

    if (agent.status === "working") {
      working += 1;
    } else if (agent.status === "completed") {
      completed += 1;
    } else if (agent.status === "error") {
      errors += 1;
    } else {
      idle += 1;
    }
  }

  setRuntimeStatus(formatRuntimeStatus(working, completed, errors, idle));
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
      phase: incoming.phase || derivePhaseFromSnapshot(incoming, now),
      phaseUpdatedAt: incoming.phaseUpdatedAt || incoming.lastEventAt,
      lastEventType:
        incoming.lastEventType || agentState[agentId].lastEventType,
      progress: incoming.progress,
      lastEventAt: incoming.lastEventAt,
    };

    if (now - incoming.lastEventAt <= SPEECH_MAX_VISIBLE_MS) {
      const speech = incoming.task
        ? shorten(incoming.task, 88)
        : getActiveLine(agentState[agentId]);
      setAgentSpeechText(agentState[agentId], speech, incoming.lastEventAt);
    } else {
      agentState[agentId].speechText = "";
      agentState[agentId].lastSpeechAt = 0;
      agentState[agentId].speechVisibleUntil = 0;
    }

    applyZoneFromStatus(agentState[agentId]);
  }

  runtimeEvents.length = 0;
  runtimeEvents.push(...snapshot.eventLog.slice(0, MAX_VISIBLE_EVENTS));
  renderGitState(snapshot.git || createDefaultGitState());

  setRuntimeStatus(
    snapshot.statusLine || "Wacht op input | lounge chat actief",
  );
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
      agent.phase = derivePhaseFromEvent(event, agent);
      agent.phaseUpdatedAt = event.timestamp || Date.now();
      agent.lastEventType = event.type || "unknown";
      if (typeof event.progress === "number") {
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
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function stationRoleCode(role: WorkstationRole): string {
  if (role === "research") {
    return "R";
  }
  if (role === "engineering") {
    return "E";
  }
  return "Q";
}

function stationRoleDeskColor(role: WorkstationRole): string {
  if (role === "research") {
    return "#d9e6f3";
  }
  if (role === "engineering") {
    return "#e8dfd3";
  }
  return "#ead8e7";
}

function stationRoleMonitorColor(role: WorkstationRole, glow: number): string {
  if (role === "research") {
    return `rgb(${glow}, ${Math.min(255, glow + 18)}, 255)`;
  }
  if (role === "engineering") {
    return `rgb(255, ${Math.min(255, glow + 16)}, ${Math.max(170, glow - 22)})`;
  }
  return `rgb(255, ${Math.max(160, glow - 35)}, ${Math.min(255, glow + 20)})`;
}

function collectWorkstationActivity(): Map<string, WorkstationActivity> {
  const map = new Map<string, WorkstationActivity>();
  for (const station of WORKSTATIONS) {
    map.set(station.id, { occupied: 0, working: 0, completed: 0, error: 0 });
  }

  for (const id of agentOrder) {
    const agent = agentState[id];
    if (!isActiveStatus(agent.status) || !agent.workstationId) {
      continue;
    }

    const activity = map.get(agent.workstationId);
    if (!activity) {
      continue;
    }

    activity.occupied += 1;
    if (agent.status === "working") {
      activity.working += 1;
    } else if (agent.status === "completed") {
      activity.completed += 1;
    } else if (agent.status === "error") {
      activity.error += 1;
    }
  }

  return map;
}

function drawWorkstation(
  station: WorkstationSpot,
  pulse: number,
  activity?: WorkstationActivity,
) {
  const x = station.deskX;
  const y = station.deskY;
  const occupied = Boolean(activity && activity.occupied > 0);

  if (occupied) {
    const hasError = Boolean(activity && activity.error > 0);
    const hasWorking = Boolean(activity && activity.working > 0);
    const hasCompleted = Boolean(activity && activity.completed > 0);

    const glowColor = hasError
      ? "rgba(255, 110, 160, 0.35)"
      : hasWorking
        ? "rgba(110, 240, 255, 0.3)"
        : hasCompleted
          ? "rgba(120, 255, 190, 0.3)"
          : "rgba(210, 230, 255, 0.22)";

    const glowSize = 46 + Math.floor(5 * Math.sin(pulse));
    ctx.fillStyle = glowColor;
    ctx.fillRect(x - 2, y - 14, glowSize, 18);
  }

  ctx.fillStyle = stationRoleDeskColor(station.role);
  ctx.fillRect(x, y, 42, 11);
  ctx.fillStyle = "#9fb3c8";
  ctx.fillRect(x + 2, y + 11, 38, 2);

  ctx.fillStyle = "#f1f8ff";
  ctx.fillRect(x + 14, y - 11, 14, 9);

  const glow = 205 + Math.floor(30 * Math.sin(pulse));
  ctx.fillStyle = stationRoleMonitorColor(station.role, glow);
  ctx.fillRect(x + 15, y - 10, 12, 7);

  if (occupied) {
    const ringColor =
      activity && activity.error > 0
        ? "#ff86be"
        : activity && activity.working > 0
          ? "#8cf6ff"
          : "#b7ffc9";
    ctx.strokeStyle = ringColor;
    ctx.strokeRect(x + 13, y - 12, 16, 11);
  }

  ctx.fillStyle = "#7f93ab";
  ctx.fillRect(x + 6, y + 3, 7, 3);
  ctx.fillRect(x + 28, y + 3, 7, 3);

  ctx.fillStyle = "#2f3b4f";
  ctx.fillRect(station.x - 3, station.y + 7, 6, 4);
  ctx.fillStyle = "#55667f";
  ctx.fillRect(station.x - 2, station.y + 6, 4, 1);

  ctx.font = "6px monospace";
  ctx.fillStyle = occupied ? "#dff8ff" : "#9fb2c7";
  ctx.fillText(
    `${stationRoleCode(station.role)}${station.id.slice(-1)}`,
    x + 15,
    y + 20,
  );
}

function drawScene(nowMs: number) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const activityByStation = collectWorkstationActivity();

  // Outer void
  ctx.fillStyle = "#05080f";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Octagonal room shell inspired by the provided pixel room
  const roomPoly: ReadonlyArray<Spot> = [
    { x: 34, y: 8 },
    { x: 286, y: 8 },
    { x: 312, y: 34 },
    { x: 312, y: 146 },
    { x: 286, y: 172 },
    { x: 34, y: 172 },
    { x: 8, y: 146 },
    { x: 8, y: 34 },
  ];

  ctx.beginPath();
  ctx.moveTo(roomPoly[0].x, roomPoly[0].y);
  for (let i = 1; i < roomPoly.length; i += 1) {
    ctx.lineTo(roomPoly[i].x, roomPoly[i].y);
  }
  ctx.closePath();
  const shellGradient = ctx.createLinearGradient(
    0,
    0,
    canvas.width,
    canvas.height,
  );
  shellGradient.addColorStop(0, "#aebfd1");
  shellGradient.addColorStop(1, "#8296ac");
  ctx.fillStyle = shellGradient;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(40, 20);
  ctx.lineTo(280, 20);
  ctx.lineTo(300, 40);
  ctx.lineTo(300, 140);
  ctx.lineTo(280, 160);
  ctx.lineTo(40, 160);
  ctx.lineTo(20, 140);
  ctx.lineTo(20, 40);
  ctx.closePath();
  ctx.fillStyle = "#254363";
  ctx.fill();

  // Central walkway
  ctx.fillStyle = "#d9e4ee";
  ctx.fillRect(146, 40, 28, 118);
  ctx.fillStyle = "#9fb0c2";
  ctx.fillRect(150, 40, 20, 118);

  // Floor tiles
  ctx.fillStyle = "#315372";
  ctx.fillRect(34, 40, 252, 118);
  for (let x = 34; x <= 286; x += 18) {
    ctx.strokeStyle = "rgba(173, 202, 227, 0.45)";
    ctx.beginPath();
    ctx.moveTo(x, 40);
    ctx.lineTo(x, 158);
    ctx.stroke();
  }
  for (let y = 40; y <= 158; y += 18) {
    ctx.strokeStyle = "rgba(173, 202, 227, 0.45)";
    ctx.beginPath();
    ctx.moveTo(34, y);
    ctx.lineTo(286, y);
    ctx.stroke();
  }

  const pulseA = 0.48 + Math.sin(nowMs * 0.0021) * 0.24;
  const pulseB = 0.44 + Math.cos(nowMs * 0.0023) * 0.24;

  // Neon wall strips
  ctx.fillStyle = `rgba(102, 232, 255, ${pulseA.toFixed(2)})`;
  ctx.fillRect(48, 24, 96, 3);
  ctx.fillRect(176, 24, 96, 3);
  ctx.fillStyle = `rgba(102, 232, 255, ${pulseB.toFixed(2)})`;
  ctx.fillRect(48, 154, 96, 3);
  ctx.fillRect(176, 154, 96, 3);

  // Bed area
  ctx.fillStyle = "#dce6ef";
  ctx.fillRect(58, 132, 56, 20);
  ctx.fillStyle = "#f7fbff";
  ctx.fillRect(62, 136, 48, 8);
  ctx.fillStyle = "#95a8bb";
  ctx.fillRect(60, 145, 52, 3);

  // Workstations
  WORKSTATIONS.forEach((station, index) => {
    drawWorkstation(
      station,
      nowMs * 0.004 + index * 1.7,
      activityByStation.get(station.id),
    );
  });

  // Room labels
  ctx.font = "bold 8px monospace";
  ctx.fillStyle = "#9fefff";
  ctx.fillText("RESEARCH", 70, 34);
  ctx.fillStyle = "#ffe7af";
  ctx.fillText("ENGINEERING", 198, 34);
  ctx.fillStyle = "#f8b5de";
  ctx.fillText("QA", 44, 79);
  ctx.fillStyle = "#c8f2ff";
  ctx.fillText("MIDDEN", 142, 95);
  ctx.fillStyle = "#f0d7e8";
  ctx.fillText("RUSTBED", 62, 129);
}

function resolveAgentBodyColor(
  agent: AgentVisualState,
  palette: AgentMangaPalette,
): string {
  if (agent.status === "error") {
    return "#854167";
  }
  if (agent.status === "completed") {
    return "#c9f0df";
  }
  if (agent.status === "idle") {
    return palette.coat;
  }
  return palette.coatShade;
}

function drawPixelRect(
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.floor(x), Math.floor(y), width, height);
}

function drawMangaBadge(agent: AgentVisualState, x: number, y: number) {
  const palette = AGENT_MANGA_PALETTES[agent.id];
  let text = palette.badge;
  if (agent.status === "idle" && agent.routine === "sleep") {
    text = "ZZ";
  } else if (agent.status === "idle" && agent.routine === "dance") {
    text = "!!";
  } else if (agent.status === "idle" && agent.routine === "pause") {
    text = "..";
  }

  drawPixelRect(x - 3, y - 9, 14, 7, "rgba(237, 244, 255, 0.86)");
  drawPixelRect(x - 2, y - 8, 12, 5, "#f7fbff");
  ctx.fillStyle = palette.accent;
  ctx.font = "6px monospace";
  ctx.fillText(text, x, y - 4);
}

function drawSpriteCharacter(
  agent: AgentVisualState,
  x: number,
  y: number,
  step: number,
  nowMs: number,
  routineDance: boolean,
  routineSleep: boolean,
) {
  if (!spriteSheetImage || !agent.spriteRect) {
    return;
  }

  const source = agent.spriteRect;
  const palette = AGENT_MANGA_PALETTES[agent.id];
  const targetHeight = 34;
  const targetWidth = Math.max(
    16,
    Math.round((source.width / source.height) * targetHeight),
  );
  const centerX = x + 8;
  const danceShift = routineDance ? Math.sin(nowMs * 0.03 + agent.bob) * 2 : 0;
  const drawX = Math.floor(centerX - targetWidth / 2 + step * 0.5);
  const drawY = Math.floor(y - 3 + danceShift);

  drawPixelRect(
    drawX + Math.floor(targetWidth * 0.2),
    y + 29,
    Math.max(8, Math.floor(targetWidth * 0.62)),
    2,
    "rgba(86, 102, 129, 0.32)",
  );

  const previousSmoothing = ctx.imageSmoothingEnabled;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (routineSleep) {
    ctx.globalAlpha = 0.9;
  }
  ctx.drawImage(
    spriteSheetImage,
    source.x,
    source.y,
    source.width,
    source.height,
    drawX,
    drawY,
    targetWidth,
    targetHeight,
  );
  ctx.restore();
  ctx.imageSmoothingEnabled = previousSmoothing;

  if (agent.zone === "work" && agent.status === "working") {
    const pulse =
      Math.sin(nowMs * 0.018 + agent.bob) > 0 ? palette.effect : palette.accent;
    drawPixelRect(drawX - 1, drawY - 1, targetWidth + 2, 1, pulse);
    drawPixelRect(drawX - 1, drawY + targetHeight, targetWidth + 2, 1, pulse);
  }
  if (agent.status === "completed") {
    drawPixelRect(drawX + targetWidth - 5, drawY + 2, 3, 2, "#e9fff1");
    drawPixelRect(drawX + targetWidth - 6, drawY + 4, 2, 1, "#e9fff1");
  }
  if (agent.status === "error") {
    drawPixelRect(drawX - 2, drawY + 11, 2, 1, "#ff7eb7");
    drawPixelRect(drawX + targetWidth, drawY + 7, 2, 1, "#ff7eb7");
  }

  drawMangaBadge(agent, drawX + Math.floor(targetWidth / 2) - 3, drawY + 1);
}

function drawAgentBlock(agent: AgentVisualState, nowMs: number) {
  const routineDance = agent.status === "idle" && agent.routine === "dance";
  const routineSleep = agent.status === "idle" && agent.routine === "sleep";
  const routinePause = agent.status === "idle" && agent.routine === "pause";

  const danceBoost = routineDance
    ? Math.sin(nowMs * 0.02 + agent.bob) * 1.8
    : 0;
  const wobble = Math.sin(nowMs * 0.004 + agent.bob) * 1.5 + danceBoost;
  const x = Math.floor(agent.x);
  const y = Math.floor(agent.y + wobble - 16);
  const paused = nowMs < agent.pauseUntilMs || routinePause || routineSleep;
  const cadence =
    agent.id === "builder" ? 14 : agent.id === "reviewer" ? 18 : 16;
  let step = paused ? 0 : agent.frame % cadence < cadence / 2 ? 0 : 1;
  if (routineDance) {
    step = Math.sin(nowMs * 0.03 + agent.bob) > 0 ? 1 : -1;
  }

  if (spriteSheetImage && agent.spriteRect) {
    drawSpriteCharacter(agent, x, y, step, nowMs, routineDance, routineSleep);
    return;
  }

  const palette = AGENT_MANGA_PALETTES[agent.id];
  const bodyColor = resolveAgentBodyColor(agent, palette);
  const accentPulse =
    Math.sin(nowMs * 0.019 + agent.bob) > 0 ? palette.effect : palette.accent;

  const legSwing = step;
  const shinSwing = step === 0 ? 0 : step > 0 ? 1 : -1;

  drawPixelRect(x + 2, y + 29, 12, 2, "rgba(100, 114, 138, 0.3)");

  if (agent.id === "scout") {
    drawPixelRect(x + 11, y + 10, 4, 2, palette.coatShade);
    drawPixelRect(x + 13 + legSwing, y + 12, 2, 2, palette.accent);
  } else if (agent.id === "builder") {
    drawPixelRect(x + 1, y + 9, 2, 5, palette.coatShade);
    drawPixelRect(x + 13, y + 9, 2, 5, palette.coatShade);
  } else {
    drawPixelRect(x + 2, y + 10, 2, 8, palette.hairShade);
    drawPixelRect(x + 12, y + 10, 2, 8, palette.hairShade);
  }

  drawPixelRect(x + 3, y + 10 + legSwing, 2, 8, palette.outline);
  drawPixelRect(x + 12, y + 10 - legSwing, 2, 8, palette.outline);
  drawPixelRect(x + 4, y + 11 + legSwing, 1, 6, palette.coat);
  drawPixelRect(x + 12, y + 11 - legSwing, 1, 6, palette.coat);

  drawPixelRect(x + 6, y + 8, 2, 1, palette.skin);

  drawPixelRect(x + 3, y + 8, 10, 10, palette.outline);
  drawPixelRect(x + 4, y + 9, 8, 8, bodyColor);
  drawPixelRect(x + 4, y + 13, 8, 4, palette.coat);
  drawPixelRect(x + 5, y + 11, 6, 1, palette.coatShade);
  drawPixelRect(x + 6, y + 14, 4, 1, palette.accent);
  drawPixelRect(x + 3, y + 11, 1, 5, palette.accent);
  drawPixelRect(x + 12, y + 11, 1, 5, palette.accent);

  drawPixelRect(x + 5, y + 18 + legSwing, 2, 6, palette.outline);
  drawPixelRect(x + 9, y + 18 - legSwing, 2, 6, palette.outline);
  drawPixelRect(x + 5, y + 19 + legSwing, 2, 5, palette.coat);
  drawPixelRect(x + 9, y + 19 - legSwing, 2, 5, palette.coat);
  drawPixelRect(x + 5, y + 21 + legSwing, 2, 2, palette.accent);
  drawPixelRect(x + 9, y + 21 - legSwing, 2, 2, palette.accent);

  drawPixelRect(x + 5, y + 24 + legSwing + shinSwing, 2, 4, palette.outline);
  drawPixelRect(x + 9, y + 24 - legSwing - shinSwing, 2, 4, palette.outline);
  drawPixelRect(x + 5, y + 25 + legSwing + shinSwing, 2, 3, palette.coat);
  drawPixelRect(x + 9, y + 25 - legSwing - shinSwing, 2, 3, palette.coat);

  drawPixelRect(x + 4, y + 28 + legSwing + shinSwing, 3, 2, palette.outline);
  drawPixelRect(x + 9, y + 28 - legSwing - shinSwing, 3, 2, palette.outline);
  drawPixelRect(x + 5, y + 28 + legSwing + shinSwing, 2, 1, palette.accent);
  drawPixelRect(x + 10, y + 28 - legSwing - shinSwing, 2, 1, palette.accent);

  drawPixelRect(x + 4, y + 0, 8, 9, palette.outline);
  drawPixelRect(x + 5, y + 1, 6, 7, palette.skin);
  drawPixelRect(x + 3, y - 1, 10, 3, palette.hair);
  drawPixelRect(x + 4, y + 1, 8, 2, palette.hairShade);
  drawPixelRect(x + 6, y + 0, 4, 1, "#ffdff0");

  if (agent.id === "scout") {
    drawPixelRect(x + 3, y + 1, 2, 4, palette.hair);
    drawPixelRect(x + 10, y + 2, 2, 4, palette.hairShade);
    drawPixelRect(x + 2, y + 0, 1, 1, palette.hair);
  } else if (agent.id === "builder") {
    drawPixelRect(x + 4, y + 1, 5, 2, palette.hair);
    drawPixelRect(x + 9, y + 1, 3, 5, palette.hairShade);
    drawPixelRect(x + 10, y + 6, 1, 1, palette.hair);
  } else {
    drawPixelRect(x + 4, y + 2, 1, 4, palette.hair);
    drawPixelRect(x + 11, y + 2, 1, 4, palette.hair);
    drawPixelRect(x + 4, y + 6, 1, 4, palette.hairShade);
    drawPixelRect(x + 11, y + 6, 1, 4, palette.hairShade);
  }

  if (routineSleep) {
    drawPixelRect(x + 6, y + 4, 1, 1, palette.outline);
    drawPixelRect(x + 9, y + 4, 1, 1, palette.outline);
  } else {
    drawPixelRect(x + 6, y + 4, 1, 1, palette.visor);
    drawPixelRect(x + 9, y + 4, 1, 1, palette.visor);
    drawPixelRect(x + 6, y + 3, 1, 1, "#f7fcff");
    drawPixelRect(x + 9, y + 3, 1, 1, "#f7fcff");
  }

  drawPixelRect(x + 6, y + 5, 1, 1, palette.outline);
  drawPixelRect(x + 9, y + 5, 1, 1, palette.outline);
  drawPixelRect(x + 7, y + 6, 1, 1, "#e8b1ba");
  drawPixelRect(x + 8, y + 6, 1, 1, "#e8b1ba");
  drawPixelRect(x + 7, y + 7, 2, 1, palette.outline);

  if (agent.id === "scout") {
    drawPixelRect(x + 5, y + 3, 1, 1, "#f2bfd1");
  } else if (agent.id === "builder") {
    drawPixelRect(x + 10, y + 4, 1, 1, "#f2bfd1");
  } else {
    drawPixelRect(x + 5, y + 4, 1, 1, "#f2bfd1");
    drawPixelRect(x + 10, y + 4, 1, 1, "#f2bfd1");
  }

  if (agent.zone === "work" && agent.status === "working") {
    drawPixelRect(x + 3, y + 1, 10, 1, accentPulse);
    drawPixelRect(x + 2, y + 2, 1, 8, "rgba(133, 226, 255, 0.26)");
    drawPixelRect(x + 13, y + 2, 1, 8, "rgba(255, 140, 198, 0.2)");
  }
  if (agent.status === "completed") {
    drawPixelRect(x + 2, y + 0, 2, 1, "#e7fff1");
    drawPixelRect(x + 12, y + 0, 2, 1, "#e7fff1");
  }
  if (agent.status === "error") {
    drawPixelRect(x + 1, y + 12, 2, 1, "#ff86be");
    drawPixelRect(x + 13, y + 7, 2, 1, "#ff86be");
  }

  drawMangaBadge(agent, x, y);
}

function buildSpeechLayout(
  agent: AgentVisualState,
  nowMs: number,
): BubbleLayout | undefined {
  const wobble = Math.sin(nowMs * 0.004 + agent.bob) * 1.5;
  const blockX = Math.floor(agent.x);
  const blockY = Math.floor(agent.y + wobble - 16);

  ctx.font = "8px monospace";
  const lines = wrapBubbleText(
    `${agent.label}: ${agent.speechText}`,
    BUBBLE_LINE_MAX_CHARS,
    BUBBLE_MAX_LINES,
  );
  if (lines.length === 0) {
    return undefined;
  }

  const textWidth = Math.max(
    ...lines.map((line) => Math.ceil(ctx.measureText(line).width)),
  );
  const cloudWidth = Math.max(84, textWidth + 12);
  const cloudHeight = 6 + lines.length * 9;
  const preferredX = clamp(
    blockX + 7 - Math.floor(cloudWidth / 2),
    BUBBLE_EDGE_MARGIN_PX,
    canvas.width - cloudWidth - BUBBLE_EDGE_MARGIN_PX,
  );
  const preferredY = Math.max(
    BUBBLE_EDGE_MARGIN_PX,
    blockY - (cloudHeight + 7),
  );

  return {
    agent,
    lines,
    x: preferredX,
    y: preferredY,
    width: cloudWidth,
    height: cloudHeight,
    anchorX: blockX + 7,
  };
}

function bubblesOverlap(left: BubbleBox, right: BubbleBox): boolean {
  return !(
    left.x + left.width + BUBBLE_MIN_GAP_PX <= right.x ||
    right.x + right.width + BUBBLE_MIN_GAP_PX <= left.x ||
    left.y + left.height + BUBBLE_MIN_GAP_PX <= right.y ||
    right.y + right.height + BUBBLE_MIN_GAP_PX <= left.y
  );
}

function resolveSpeechLayouts(
  nowMs: number,
  nowEpochMs: number,
): BubbleLayout[] {
  const candidates = agentOrder
    .map((id) => agentState[id])
    .filter((agent) => isSpeechVisible(agent, nowEpochMs))
    .map((agent) => buildSpeechLayout(agent, nowMs))
    .filter((layout): layout is BubbleLayout => Boolean(layout))
    .sort((left, right) => right.agent.lastSpeechAt - left.agent.lastSpeechAt);

  const placed: BubbleLayout[] = [];
  const offsets: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [0, -10],
    [-14, -6],
    [14, -6],
    [-24, -10],
    [24, -10],
    [-34, -4],
    [34, -4],
    [0, -18],
  ];

  for (const candidate of candidates) {
    let placedCandidate: BubbleLayout | undefined;

    for (const [dx, dy] of offsets) {
      const attemptX = clamp(
        candidate.x + dx,
        BUBBLE_EDGE_MARGIN_PX,
        canvas.width - candidate.width - BUBBLE_EDGE_MARGIN_PX,
      );
      const attemptY = clamp(
        candidate.y + dy,
        BUBBLE_EDGE_MARGIN_PX,
        canvas.height - candidate.height - BUBBLE_EDGE_MARGIN_PX,
      );

      const attemptBox: BubbleBox = {
        x: attemptX,
        y: attemptY,
        width: candidate.width,
        height: candidate.height,
      };

      const collides = placed.some((existing) =>
        bubblesOverlap(attemptBox, existing),
      );
      if (!collides) {
        placedCandidate = {
          ...candidate,
          x: attemptX,
          y: attemptY,
        };
        break;
      }
    }

    if (!placedCandidate) {
      const fallbackY = clamp(
        BUBBLE_EDGE_MARGIN_PX +
          placed.length * (candidate.height + BUBBLE_MIN_GAP_PX),
        BUBBLE_EDGE_MARGIN_PX,
        canvas.height - candidate.height - BUBBLE_EDGE_MARGIN_PX,
      );
      placedCandidate = {
        ...candidate,
        y: fallbackY,
      };
    }

    placed.push(placedCandidate);
  }

  return placed;
}

function drawSpeechCloud(layout: BubbleLayout) {
  const tailX = clamp(
    layout.anchorX,
    layout.x + 2,
    layout.x + layout.width - 3,
  );
  const tailTop = layout.y + layout.height;

  ctx.fillStyle = "#f6f7ff";
  ctx.fillRect(layout.x, layout.y, layout.width, layout.height);

  ctx.fillStyle = "#2f3650";
  ctx.fillRect(layout.x, layout.y, layout.width, 1);
  ctx.fillRect(layout.x, layout.y + layout.height - 1, layout.width, 1);
  ctx.fillRect(layout.x, layout.y, 1, layout.height);
  ctx.fillRect(layout.x + layout.width - 1, layout.y, 1, layout.height);
  ctx.fillRect(tailX - 1, tailTop, 3, 2);
  ctx.fillRect(tailX, tailTop + 2, 1, 2);

  ctx.fillStyle = "#1f2738";
  for (let index = 0; index < layout.lines.length; index += 1) {
    ctx.fillText(layout.lines[index], layout.x + 5, layout.y + 8 + index * 9);
  }
}

function tickAgent(agent: AgentVisualState, nowMs: number) {
  const inWorkZone = agent.zone === "work";
  const personality = AGENT_PERSONALITIES[agent.id];

  if (agent.status === "idle") {
    if (nowMs >= agent.nextRoutineAtMs) {
      chooseNextIdleRoutine(agent, nowMs);
      applyZoneFromStatus(agent);
    }
  } else {
    agent.routine = "normal";
    agent.routineUntilMs = nowMs;
    agent.nextRoutineAtMs = nowMs + randomRange(1200, 2800);
  }

  if (nowMs >= agent.nextPauseAtMs) {
    const busyPause = inWorkZone && agent.status === "working";
    const pauseDuration = busyPause
      ? randomRange(900, 2200)
      : randomRange(350, 1100);
    agent.pauseUntilMs = nowMs + pauseDuration;
    agent.nextPauseAtMs =
      agent.pauseUntilMs +
      (busyPause ? randomRange(1300, 3600) : randomRange(2100, 4900));
  }

  const routinePause =
    agent.status === "idle" &&
    (agent.routine === "pause" || agent.routine === "sleep");
  const paused = nowMs < agent.pauseUntilMs || routinePause;

  const speedBase = inWorkZone ? 1.12 : 0.82;
  const speed =
    speedBase * (inWorkZone ? personality.workSpeed : personality.loungeSpeed);

  const dx = agent.targetX - agent.x;
  const dy = agent.targetY - agent.y;
  const distance = Math.hypot(dx, dy);

  if (!paused && distance > 0.4) {
    const step = Math.min(distance, speed);
    agent.x += (dx / Math.max(0.0001, distance)) * step;
    agent.y += (dy / Math.max(0.0001, distance)) * step;

    if (Math.abs(dx) > 0.08) {
      const absV = Math.max(0.2, Math.abs(agent.vx));
      agent.vx = dx >= 0 ? absV : -absV;
    }
  }

  if (!paused || (agent.status === "idle" && agent.routine === "dance")) {
    agent.frame += 1;
  }

  if (!inWorkZone && distance < 2.2) {
    agent.x +=
      Math.sin(nowMs * personality.driftFreq + agent.bob) *
      personality.driftAmp;
    if (agent.status === "idle") {
      agent.y +=
        Math.sin(nowMs * personality.poseFreq + agent.bob) *
        personality.poseAmp;
      if (agent.routine === "dance") {
        agent.x += Math.sin(nowMs * 0.016 + agent.bob) * 0.45;
        agent.y += Math.cos(nowMs * 0.023 + agent.bob) * 0.4;
      }
    }
  }

  agent.x = clamp(agent.x, FLOOR_BOUNDS.left, FLOOR_BOUNDS.right);
  agent.y = clamp(agent.y, FLOOR_BOUNDS.top, FLOOR_BOUNDS.bottom);
}

function drawFrame() {
  const nowMs = performance.now();
  const nowEpochMs = Date.now();
  drawScene(nowMs);
  maybeRunIdleChatter();

  for (const id of agentOrder) {
    const agent = agentState[id];
    tickAgent(agent, nowMs);
    drawAgentBlock(agent, nowMs);
  }

  const bubbleLayouts = resolveSpeechLayouts(nowMs, nowEpochMs);
  for (const layout of bubbleLayouts) {
    drawSpeechCloud(layout);
  }

  requestAnimationFrame(drawFrame);
}

window.addEventListener(
  "message",
  (rawEvent: MessageEvent<ExtensionMessage>) => {
    const message = rawEvent.data;
    if (
      !message ||
      typeof message !== "object" ||
      typeof message.type !== "string"
    ) {
      return;
    }

    if (message.type === "pixel.snapshot" && message.payload) {
      applySnapshot(message.payload);
      return;
    }

    if (message.type === "pixel.event" && message.payload) {
      applyEvent(message.payload);
    }
  },
);

refreshButton?.addEventListener("click", () => {
  vscode.postMessage({ type: "webview-request-snapshot" });
});

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const id of agentOrder) {
    const agent = agentState[id];
    if (
      agent.status !== "idle" &&
      now - agent.lastEventAt >= AGENT_INACTIVITY_LIMIT_MS
    ) {
      agent.status = "idle";
      agent.phase = "waiting-input";
      agent.phaseUpdatedAt = now;
      agent.lastEventType = "inactivity-timeout";
      agent.progress = 0;
      agent.task = "wacht in lounge";
      agent.routine = "normal";
      agent.routineUntilMs = performance.now() + randomRange(1400, 2600);
      agent.nextRoutineAtMs = performance.now() + randomRange(800, 2000);
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
setRuntimeStatus("Wacht op input | lounge chat actief");
void initializeCharacterSprites();
drawFrame();

vscode.postMessage({ type: "webview-ready" });
vscode.postMessage({ type: "webview-request-snapshot" });

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    if (status) {
      status.textContent = "HMR updated";
    }
  });
}
