import characterSheetUrl from "./assets/agent-characters.jpg";
import roomBackgroundUrl from "./assets/agent-room-bg.jpg";
import "./styles.css";

const vscode = acquireVsCodeApi();
const ANSI_SGR_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  "g",
);

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
type AgentIdleRoutine = AgentRoutine | "phone" | "wave" | "water-plant";

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
  source?: "local" | "copilot-export" | "codex";
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
  idleSpotId?: string;
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
  nextIdleActionAtMs: number;
  idlePreviousSpotId?: string;
  idleHoldUntilMs: number;
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

interface IdleSpot extends Spot {
  id: string;
  label: string;
  jitterX: number;
  jitterY: number;
  neighbors?: readonly string[];
}

type WorkstationRole = "research" | "engineering" | "qa";

interface WorkstationSpot extends Spot {
  id: string;
  label: string;
  role: WorkstationRole;
  deskX: number;
  deskY: number;
  facing: "north" | "east" | "west";
  screenX: number;
  screenY: number;
  screenWidth: number;
  screenHeight: number;
  bgScreenX?: number;
  bgScreenY?: number;
  bgScreenWidth?: number;
  bgScreenHeight?: number;
}

interface WorkstationActivity {
  occupied: number;
  working: number;
  completed: number;
  error: number;
}

type WorkstationScreenMode = "off" | "working" | "completed" | "error";
type WorkAnimationMode = "thinking" | "typing" | "reviewing" | "completed" | "error";

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

interface BossMonitorState {
  speechText: string;
  speechVisibleUntil: number;
  lastEventAt: number;
  mode: "idle" | "receiving" | "dispatching";
  targetAgentId?: AgentId;
}

type OfficeCatMode =
  | "offstage"
  | "entering"
  | "wandering"
  | "lounging"
  | "leaving";
type OfficeCatAction = "walk" | "sit" | "loaf" | "groom" | "zoom" | "nap";
type OfficeCatPersonalityId =
  | "default"
  | "chaos-goblin"
  | "senior-office-cat"
  | "boss-cat";

interface OfficeCatSpot extends Spot {
  id: string;
  label: string;
}

interface OfficeCatPersonality {
  id: OfficeCatPersonalityId;
  name: string;
  bossLabel: string;
  personalityLabel: string;
  fur: string;
  furShade: string;
  outline: string;
  ear: string;
  eye: string;
  nose: string;
  shadow: string;
  speedMin: number;
  speedMax: number;
  zoomChance: number;
  immediateBossChance: number;
  stayMultiplier: number;
  preferredSpotIds: readonly string[];
  meows: readonly string[];
  actionWeights: ReadonlyArray<readonly [OfficeCatAction, number]>;
}

interface OfficeCatState {
  active: boolean;
  personalityId: OfficeCatPersonalityId;
  mode: OfficeCatMode;
  action: OfficeCatAction;
  facing: 1 | -1;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  speed: number;
  frame: number;
  bob: number;
  enteredAtMs: number;
  departureAtMs: number;
  actionUntilMs: number;
  nextDecisionAtMs: number;
  nextSpawnAtMs: number;
  exitSide: "left" | "right";
  meowText: string;
  meowVisibleUntilMs: number;
}

type ExtensionMessage =
  | { type: "pixel.snapshot"; payload: RuntimeState }
  | { type: "pixel.event"; payload: PixelRuntimeEvent };

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app container.");
}

const DEFAULT_AGENT_INACTIVITY_LIMIT_MS = 12_000;
const ANALYZING_AGENT_INACTIVITY_LIMIT_MS = 35_000;
const SPEECH_BASE_VISIBLE_MS = 4_600;
const SPEECH_PER_CHAR_MS = 34;
const SPEECH_MAX_VISIBLE_MS = 9_200;
const MESSAGE_SPEECH_BASE_VISIBLE_MS = 5_800;
const MESSAGE_SPEECH_PER_CHAR_MS = 42;
const MESSAGE_SPEECH_MAX_VISIBLE_MS = 11_500;
const BUBBLE_MAX_LINES = 2;
const BUBBLE_LINE_MAX_CHARS = 34;
const BUBBLE_MIN_GAP_PX = 3;
const BUBBLE_EDGE_MARGIN_PX = 4;
const MAX_VISIBLE_EVENTS = 14;
const IDLE_CHAT_MIN_GAP_MS = 9_000;
const IDLE_CHAT_MAX_GAP_MS = 24_000;
const IDLE_REPLY_MIN_DELAY_MS = 900;
const IDLE_REPLY_MAX_DELAY_MS = 1_850;
const IDLE_CHAT_RECENT_SPEECH_BLOCK_MS = 11_000;
const IDLE_CHAT_SKIP_CHANCE = 0.72;
const COMPLETION_TO_WAITING_MS = 6_500;
const MIN_SPRITE_COMPONENT_PIXELS = 1_800;
const MIN_SPRITE_WIDTH = 46;
const MIN_SPRITE_HEIGHT = 72;
const DEFAULT_SPRITE_COLUMNS = 3;
const DEFAULT_SPRITE_ROWS = 4;
const GRID_TRIM_DISTANCE = 24;
const GRID_TRIM_MIN_PIXELS = 340;
const GRID_TRIM_PADDING = 4;
const OFFICE_CAT_MIN_SPAWN_MS = 18_000;
const OFFICE_CAT_MAX_SPAWN_MS = 46_000;
const OFFICE_CAT_MIN_STAY_MS = 8_500;
const OFFICE_CAT_MAX_STAY_MS = 21_000;
const OFFICE_CAT_MEOW_BASE_MS = 1_400;
const OFFICE_CAT_MEOW_MAX_MS = 4_800;

interface IdleJoke {
  setup: string;
  reply: string;
}

const OPS_AI_IDLE_LINES = [
  "bzzt... lounge vector stabiel. snacks-protocol standby.",
  "krrt... ik hoor 3 commits en 1 naderende refactor.",
  "whirr... sector builder warm, scout-signaal nominaal.",
  "tik-tik... idle grid danst. chaosniveau: charmant.",
  "vrm... patchweer gedetecteerd in kwadrant engineering.",
  "bz-bzzt... alle pixels paraat. koffie-subroutine ontbreekt.",
];

const OPS_AI_DIRTY_GIT_IDLE_LINES = [
  "war room bulletin: {changes} op {branch}. diff-loopgraven bemand.",
  "krrt... {changes} gezien op {branch}. wie noemde dit een kleine patch?",
  "frontbericht: {changes}. eerst formatteren, dan de veldslag.",
  "stil in de lounge, rumoer in git: {changes}. klassieke hinderlaag.",
  "ik ruik {changes} op {branch}. de commit-linie lacht nerveus.",
];

const OPS_AI_DIRTY_GIT_ALL_IDLE_LINES = [
  "alle agents idle, maar {changes} liggen nog in de loopgraven.",
  "de vloer is rustig, het front niet: {changes} op {branch}.",
  "iedereen loungt terwijl {changes} guerrilla speelt in git.",
  "war room update: alle squads rusten, maar {changes} wachten nog.",
  "grap van de dag: 'kleine wijziging'. realiteit: {changes}.",
];

const OPS_AI_CAT_IDLE_LINES = [
  "sensor ping: {catName} draait in {catAction}. morale-build groen.",
  "mrr-module actief. {catName} runt nu {catAction} in {catSpot}.",
  "ops update: {catName} voert een stealth-audit uit bij {catSpot}.",
  "ik zie snorharen op de bus: {catName} in {catAction}. waarschijnlijk feature-complete.",
  "war room notitie: {catName} heeft opnieuw ownership gepakt over {catSpot}.",
  "nerd alert: {catPersona}. purrformance stabiel in {catAction}.",
  "{catName} test de latency van het tapijt. benchmark: volledig subjectief.",
  "feline kernel notice: {catName} claimt {catSpot} als write-access zone.",
];

const OPS_AI_BOSS_CAT_IDLE_LINES = [
  "executive override: {catName} heeft de sprint review zonder uitnodiging geopend.",
  "{catName} inspecteert {catSpot}. iedereen gedraagt zich alsof dit gepland was.",
  "board update: {catName} draait in {catAction}. roadmap nu 14% hariger.",
  "{catName} heeft ownership geclaimd over de lounge. approvals verlopen via pootafdruk.",
  "priority alert: executive feline op de vloer. alle squads doen alsof zij geen toetsenbord delen.",
];

const OFFICE_CAT_MEOWS = [
  "mrrp",
  "prrt",
  "miauw",
  "*staar*",
  "*zoom*",
  "*snif*",
  "*plof*",
];

const OFFICE_CAT_PERSONALITIES: Record<
  OfficeCatPersonalityId,
  OfficeCatPersonality
> = {
  default: {
    id: "default",
    name: "Monitor Minoes",
    bossLabel: "Monitor Minoes",
    personalityLabel: "huisdier daemon",
    fur: "#d9dde9",
    furShade: "#b3bbd0",
    outline: "#2d3347",
    ear: "#f4b7cf",
    eye: "#fbfcff",
    nose: "#f29ebe",
    shadow: "rgba(70, 85, 110, 0.25)",
    speedMin: 1.04,
    speedMax: 1.26,
    zoomChance: 0.18,
    immediateBossChance: 0.38,
    stayMultiplier: 1,
    preferredSpotIds: ["ops-monitor", "center-lane", "lounge-rug"],
    meows: ["mrrp", "prrt", "*snif*", "*staar*"],
    actionWeights: [
      ["sit", 26],
      ["loaf", 25],
      ["groom", 25],
      ["nap", 24],
    ],
  },
  "chaos-goblin": {
    id: "chaos-goblin",
    name: "Stacktrace",
    bossLabel: "Stacktrace",
    personalityLabel: "chaos goblin met root access",
    fur: "#f1a764",
    furShade: "#cd6e3a",
    outline: "#40251d",
    ear: "#ffd2c0",
    eye: "#fff8d8",
    nose: "#ffb38f",
    shadow: "rgba(120, 70, 40, 0.3)",
    speedMin: 1.22,
    speedMax: 1.58,
    zoomChance: 0.46,
    immediateBossChance: 0.54,
    stayMultiplier: 0.92,
    preferredSpotIds: ["eng-corner", "qa-door", "ops-monitor"],
    meows: ["*skrrt*", "nyoom", "mrrROW", "*chaos*", "*toetsenbord?*"],
    actionWeights: [
      ["zoom", 34],
      ["groom", 18],
      ["sit", 16],
      ["loaf", 12],
      ["nap", 20],
    ],
  },
  "senior-office-cat": {
    id: "senior-office-cat",
    name: "Oom Buffer",
    bossLabel: "Oom Buffer",
    personalityLabel: "senior office cat met legacy privileges",
    fur: "#c9ceda",
    furShade: "#8f9aad",
    outline: "#334056",
    ear: "#efc9d7",
    eye: "#fefefe",
    nose: "#e5a5bd",
    shadow: "rgba(60, 74, 102, 0.28)",
    speedMin: 0.78,
    speedMax: 0.96,
    zoomChance: 0.05,
    immediateBossChance: 0.31,
    stayMultiplier: 1.42,
    preferredSpotIds: ["lounge-rug", "plant-corner", "center-lane"],
    meows: ["mrrf", "*plof*", "*zucht als een architect*", "prr...", "*dutje*"],
    actionWeights: [
      ["nap", 38],
      ["loaf", 31],
      ["sit", 15],
      ["groom", 12],
      ["zoom", 4],
    ],
  },
  "boss-cat": {
    id: "boss-cat",
    name: "Director Whiskers",
    bossLabel: "Director Whiskers",
    personalityLabel: "executive feline met production access",
    fur: "#f2e1a8",
    furShade: "#c6a65a",
    outline: "#4a3720",
    ear: "#f6cdb6",
    eye: "#fff7cf",
    nose: "#e7a47b",
    shadow: "rgba(120, 92, 40, 0.34)",
    speedMin: 0.9,
    speedMax: 1.12,
    zoomChance: 0.08,
    immediateBossChance: 0.82,
    stayMultiplier: 1.18,
    preferredSpotIds: ["ops-monitor", "center-lane", "plant-corner"],
    meows: ["mrrrow", "*board meeting*", "*keurend knikje*", "prrrt"],
    actionWeights: [
      ["sit", 28],
      ["loaf", 24],
      ["groom", 16],
      ["nap", 28],
      ["zoom", 4],
    ],
  },
};

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

const AGENT_MANGA_TITLES: Record<AgentId, string> = {
  scout: "Akari // Recon Runner",
  builder: "Rin // Forge Coder",
  reviewer: "Sora // Edge Auditor",
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
        <canvas id="scene" width="320" height="320" aria-label="Pixel agent scene"></canvas>
        <div class="scene-caption">
          <span class="pill lounge">Idle-zone: brede lounge-lus + rustbed + plantzorg</span>
          <span class="pill work">Werkstations volgen de kamerlayout: Research, Engineering en QA</span>
          <span class="pill">Rustzone bank: max 1 slapende agent</span>
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

const ROOM_LAYOUT_X_OFFSET = -2;
const ROOM_LAYOUT_Y_OFFSET = 58;
const ROOM_SCREEN_X_OFFSET = -1;
const ROOM_SCREEN_Y_OFFSET = -2;
const ROOM_BACKGROUND_ALPHA = 1;
const ROOM_BACKGROUND_OVERLAY_BASE_ALPHA = 0;
const ROOM_BITMAP_SOURCE_WIDTH = 736;
const ROOM_BITMAP_SOURCE_HEIGHT = 736;

function roomX(value: number): number {
  return Math.round(value + ROOM_LAYOUT_X_OFFSET);
}

function roomY(value: number): number {
  return Math.round(value + ROOM_LAYOUT_Y_OFFSET);
}

function roomScreenX(value: number): number {
  return roomX(value + ROOM_SCREEN_X_OFFSET);
}

function roomScreenY(value: number): number {
  return roomY(value + ROOM_SCREEN_Y_OFFSET);
}

function bitmapRoomX(value: number): number {
  return Math.round((value / ROOM_BITMAP_SOURCE_WIDTH) * canvas.width);
}

function bitmapRoomY(value: number): number {
  return Math.round((value / ROOM_BITMAP_SOURCE_HEIGHT) * canvas.height);
}

function bitmapRoomWidth(value: number): number {
  return Math.max(1, Math.round((value / ROOM_BITMAP_SOURCE_WIDTH) * canvas.width));
}

function bitmapRoomHeight(value: number): number {
  return Math.max(1, Math.round((value / ROOM_BITMAP_SOURCE_HEIGHT) * canvas.height));
}

const FLOOR_BOUNDS = {
  left: roomX(34),
  right: roomX(canvas.width - 34),
  top: roomY(44),
  bottom: roomY(160),
};
const BED_SPOT: IdleSpot = {
  id: "bed",
  label: "rustbed",
  x: roomX(99),
  y: roomY(145),
  jitterX: 5,
  jitterY: 4,
};
const IDLE_SPOTS: readonly IdleSpot[] = [
  {
    id: "center-north",
    label: "midden boven",
    x: roomX(160),
    y: roomY(92),
    jitterX: 8,
    jitterY: 7,
    neighbors: ["left-north", "right-north", "center-mid"],
  },
  {
    id: "center-mid",
    label: "midden corridor",
    x: roomX(160),
    y: roomY(116),
    jitterX: 10,
    jitterY: 8,
    neighbors: ["center-north", "left-mid", "right-mid", "center-south"],
  },
  {
    id: "center-south",
    label: "zuid corridor",
    x: roomX(160),
    y: roomY(142),
    jitterX: 10,
    jitterY: 7,
    neighbors: ["center-mid", "left-lower", "south-turn"],
  },
  {
    id: "south-turn",
    label: "zuid turn",
    x: roomX(160),
    y: roomY(154),
    jitterX: 8,
    jitterY: 5,
    neighbors: ["center-south"],
  },
  {
    id: "left-north",
    label: "linker lus boven",
    x: roomX(100),
    y: roomY(95),
    jitterX: 8,
    jitterY: 8,
    neighbors: ["center-north", "left-mid"],
  },
  {
    id: "left-mid",
    label: "linker lus midden",
    x: roomX(108),
    y: roomY(116),
    jitterX: 10,
    jitterY: 8,
    neighbors: ["left-north", "center-mid", "left-lower"],
  },
  {
    id: "left-lower",
    label: "linker lounge",
    x: roomX(115),
    y: roomY(136),
    jitterX: 8,
    jitterY: 6,
    neighbors: ["left-mid", "center-south"],
  },
  {
    id: "right-north",
    label: "rechter lus boven",
    x: roomX(216),
    y: roomY(96),
    jitterX: 7,
    jitterY: 7,
    neighbors: ["center-north", "right-mid"],
  },
  {
    id: "right-mid",
    label: "rechter lus midden",
    x: roomX(202),
    y: roomY(116),
    jitterX: 8,
    jitterY: 7,
    neighbors: ["right-north", "center-mid"],
  },
];
const IDLE_SPOT_BY_ID = new Map(IDLE_SPOTS.map((spot) => [spot.id, spot] as const));
const AGENT_IDLE_HOME_SPOTS: Record<AgentId, readonly string[]> = {
  scout: ["left-north", "left-mid", "center-north"],
  builder: ["right-north", "right-mid", "center-north"],
  reviewer: ["center-mid", "center-south", "south-turn"],
};
const CHAT_SPOTS: readonly Spot[] = [
  { x: roomX(160), y: roomY(102) },
  { x: roomX(120), y: roomY(138) },
  { x: roomX(160), y: roomY(150) },
];
const OFFICE_CAT_SPOTS: readonly OfficeCatSpot[] = [
  { id: "lounge-rug", label: "kleed", x: roomX(86), y: roomY(147) },
  { id: "center-lane", label: "gangpad", x: roomX(156), y: roomY(132) },
  { id: "ops-monitor", label: "monitor", x: roomX(160), y: roomY(112) },
  { id: "plant-corner", label: "plant", x: roomX(225), y: roomY(144) },
  { id: "qa-door", label: "qa", x: roomX(78), y: roomY(112) },
  { id: "eng-corner", label: "engineering", x: roomX(232), y: roomY(115) },
];
const PLANT_CARE_SPOT: IdleSpot = {
  id: "plant-care",
  label: "planthoek",
  x: roomX(236),
  y: roomY(145),
  jitterX: 3,
  jitterY: 3,
};
const PLANT_WATER_TARGET: Spot = { x: roomX(252), y: roomY(139) };
const WORKSTATIONS: readonly WorkstationSpot[] = [
  {
    id: "ws-1",
    label: "Research 1",
    role: "research",
    x: roomX(95),
    y: roomY(65),
    deskX: roomX(74),
    deskY: roomY(42),
    facing: "north",
    screenX: roomScreenX(88),
    screenY: roomScreenY(18),
    screenWidth: 20,
    screenHeight: 10,
    bgScreenX: bitmapRoomX(166),
    bgScreenY: bitmapRoomY(94),
    bgScreenWidth: bitmapRoomWidth(46),
    bgScreenHeight: bitmapRoomHeight(30),
  },
  {
    id: "ws-2",
    label: "Research 2",
    role: "research",
    x: roomX(227),
    y: roomY(65),
    deskX: roomX(208),
    deskY: roomY(42),
    facing: "north",
    screenX: roomScreenX(206),
    screenY: roomScreenY(18),
    screenWidth: 28,
    screenHeight: 10,
    bgScreenX: bitmapRoomX(462),
    bgScreenY: bitmapRoomY(94),
    bgScreenWidth: bitmapRoomWidth(66),
    bgScreenHeight: bitmapRoomHeight(30),
  },
  {
    id: "ws-3",
    label: "Engineering 1",
    role: "engineering",
    x: roomX(246),
    y: roomY(100),
    deskX: roomX(250),
    deskY: roomY(72),
    facing: "west",
    screenX: roomScreenX(269),
    screenY: roomScreenY(70),
    screenWidth: 10,
    screenHeight: 27,
    bgScreenX: bitmapRoomX(593),
    bgScreenY: bitmapRoomY(271),
    bgScreenWidth: bitmapRoomWidth(22),
    bgScreenHeight: bitmapRoomHeight(77),
  },
  {
    id: "ws-4",
    label: "Engineering 2",
    role: "engineering",
    x: roomX(221),
    y: roomY(152),
    deskX: roomX(194),
    deskY: roomY(126),
    facing: "north",
    screenX: roomScreenX(206),
    screenY: roomScreenY(131),
    screenWidth: 20,
    screenHeight: 10,
    bgScreenX: bitmapRoomX(489),
    bgScreenY: bitmapRoomY(466),
    bgScreenWidth: bitmapRoomWidth(50),
    bgScreenHeight: bitmapRoomHeight(22),
  },
  {
    id: "ws-5",
    label: "QA 1",
    role: "qa",
    x: roomX(92),
    y: roomY(104),
    deskX: roomX(22),
    deskY: roomY(76),
    facing: "east",
    screenX: roomScreenX(40),
    screenY: roomScreenY(70),
    screenWidth: 10,
    screenHeight: 27,
    bgScreenX: bitmapRoomX(139),
    bgScreenY: bitmapRoomY(231),
    bgScreenWidth: bitmapRoomWidth(20),
    bgScreenHeight: bitmapRoomHeight(77),
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
    0.46 + Math.random() * 0.2,
    0.3 + Math.random() * 0.7,
  ),
  builder: createDefaultAgent(
    "builder",
    "Builder",
    "#ff7dbb",
    CHAT_SPOTS[1].x,
    1,
    -0.41 + Math.random() * 0.2,
    1.4 + Math.random() * 0.7,
  ),
  reviewer: createDefaultAgent(
    "reviewer",
    "Reviewer",
    "#ff9fd2",
    CHAT_SPOTS[2].x,
    2,
    0.52 + Math.random() * 0.2,
    2.5 + Math.random() * 0.7,
  ),
};

// Idle event/overlay icon system
const IDLE_OVERLAY_ICONS = [
  "💡", "❓", "💤", "❤️", "🤔", "📱", "🎵", "🎮", "😴", "😂", "😎", "👀", "🍕", "☕", "🎉"
];
const IDLE_ACTIONS = [
  { routine: "dance", icon: "🎵", label: "Dansje" },
  { routine: "pause", icon: "🤔", label: "Denken" },
  { routine: "normal", icon: "👀", label: "Kijken" },
  { routine: "phone", icon: "📱", label: "Telefoon" },
  { routine: "wave", icon: "👋", label: "Zwaaien" },
  { routine: "water-plant", icon: "💧", label: "Plant water geven" },
  { routine: "sleep", icon: "💤", label: "Slapen" },
];
interface AgentIdleOverlay {
  icon: string;
  until: number;
  action?: AgentIdleRoutine;
}
const agentIdleOverlays: Record<AgentId, AgentIdleOverlay | null> = {
  scout: null,
  builder: null,
  reviewer: null,
};
const officeCat: OfficeCatState = createDefaultOfficeCat();

function maybeTriggerIdleOverlay(now: number) {
  for (const id of agentOrder) {
    const agent = agentState[id];
    // Alleen als idle, niet slapend, geen overlay actief, en random kans
    if (
      agent.status === "idle" &&
      agent.routine !== "sleep" &&
      !agentIdleOverlays[id] &&
      now >= agent.nextIdleActionAtMs &&
      Math.random() < 0.62
    ) {
      agent.nextIdleActionAtMs = now + randomRange(4_200, 9_800);
      // 1 op 2 kans op een "speciale" actie (dansje, zwaaien, telefoon, slapen)
      if (Math.random() < 0.5) {
        // Trigger een idle-actie
        const action = pickRandom(IDLE_ACTIONS);
        if (action.routine === "sleep" && isBedOccupied(agent.id)) {
          // Sla over als bed bezet
          continue;
        }
        if (
          action.routine === "water-plant" &&
          isPlantCareOccupied(agent.id)
        ) {
          continue;
        }
        // Speciaal: als actie "wave" of "phone", toon icoon en routine
        if (
          action.routine === "wave" ||
          action.routine === "phone" ||
          action.routine === "water-plant"
        ) {
          const actionDuration =
            action.routine === "water-plant"
              ? randomRange(3600, 6200)
              : randomRange(1200, 2600);
          agentIdleOverlays[id] = {
            icon: action.icon,
            until: now + actionDuration,
            action: action.routine,
          };
          agent.routine =
            action.routine === "water-plant" ? "normal" : "pause";
          agent.routineUntilMs = now + actionDuration;
          agent.nextRoutineAtMs = agent.routineUntilMs + randomRange(900, 2400);
          applyZoneFromStatus(agent);
        } else {
          // Normale routine (dans, slapen, etc.)
          agent.routine = action.routine as AgentRoutine;
          agent.routineUntilMs = now + randomRange(1800, 4200);
          agent.nextRoutineAtMs = agent.routineUntilMs + randomRange(900, 2400);
          agentIdleOverlays[id] = {
            icon: action.icon,
            until: now + randomRange(1200, 3200),
            action: action.routine,
          };
          applyZoneFromStatus(agent);
        }
      } else {
        // Toon een overlay-icoon
        const icon = pickRandom(IDLE_OVERLAY_ICONS);
        agentIdleOverlays[id] = {
          icon,
          until: now + randomRange(1200, 3200),
        };
      }
    } else if (agent.status !== "idle" && now >= agent.nextIdleActionAtMs) {
      agent.nextIdleActionAtMs = now + randomRange(3_000, 7_000);
    }
    // Verwijder overlay als verlopen
    if (agentIdleOverlays[id] && now > agentIdleOverlays[id]!.until) {
      const expiredAction = agentIdleOverlays[id]!.action;
      agentIdleOverlays[id] = null;
      agent.nextIdleActionAtMs = now + randomRange(3_200, 7_400);
      if (
        expiredAction === "water-plant" &&
        agent.status === "idle" &&
        agent.idleSpotId === PLANT_CARE_SPOT.id
      ) {
        agent.routine = "normal";
        agent.routineUntilMs = now + randomRange(1500, 2600);
        agent.nextRoutineAtMs = agent.routineUntilMs + randomRange(900, 2200);
        applyZoneFromStatus(agent);
      }
    }
  }
}

const runtimeEvents: PixelRuntimeEvent[] = [];
let currentGitState = createDefaultGitState();
let nextIdleChatAt =
  Date.now() +
  Math.round(randomRange(IDLE_CHAT_MIN_GAP_MS, IDLE_CHAT_MAX_GAP_MS));
let nextBossIdleAt =
  Date.now() + Math.round(randomRange(10_000, 19_000));
const bossMonitorState: BossMonitorState = {
  speechText: "",
  speechVisibleUntil: 0,
  lastEventAt: 0,
  mode: "idle",
};
let spriteSheetImage: HTMLImageElement | undefined;
let roomBackgroundImage: HTMLImageElement | undefined;
let spriteVariants: AgentSpriteVariant[] = [];

function renderConnectionStatus(prefix = "Connected") {
  if (!status) {
    return;
  }
  const spritePart =
    spriteVariants.length > 0
      ? `chars ${spriteVariants.length}`
      : "default sprites";
  const roomPart = roomBackgroundImage ? "bg room ok" : "bg fallback";
  status.textContent = `${prefix} | ${spritePart} | ${roomPart}`;
}

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
    idleSpotId: undefined,
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
    nextIdleActionAtMs: nowMs + randomRange(2600, 6200),
    idlePreviousSpotId: undefined,
    idleHoldUntilMs: 0,
    characterId: `${id}-default`,
    characterLabel: AGENT_MANGA_TITLES[id],
    spriteRect: undefined,
  };
}

function createDefaultOfficeCat(): OfficeCatState {
  const nowMs = performance.now();
  const floorY = roomY(148);
  return {
    active: false,
    personalityId: "default",
    mode: "offstage",
    action: "walk",
    facing: 1,
    x: FLOOR_BOUNDS.left - 28,
    y: floorY,
    targetX: FLOOR_BOUNDS.left - 28,
    targetY: floorY,
    speed: 0.92,
    frame: 0,
    bob: Math.random() * Math.PI * 2,
    enteredAtMs: 0,
    departureAtMs: nowMs,
    actionUntilMs: nowMs,
    nextDecisionAtMs: nowMs,
    nextSpawnAtMs: nowMs + randomRange(OFFICE_CAT_MIN_SPAWN_MS, OFFICE_CAT_MAX_SPAWN_MS),
    exitSide: "right",
    meowText: "",
    meowVisibleUntilMs: 0,
  };
}

function getOfficeCatPersonality(): OfficeCatPersonality {
  return OFFICE_CAT_PERSONALITIES[officeCat.personalityId];
}

function pickWeighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
  const total = items.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
  if (total <= 0) {
    return items[0][0];
  }

  let roll = Math.random() * total;
  for (const [item, weight] of items) {
    roll -= Math.max(0, weight);
    if (roll <= 0) {
      return item;
    }
  }

  return items[items.length - 1][0];
}

function pickOfficeCatPersonalityId(): OfficeCatPersonalityId {
  if (Math.random() < 0.05) {
    return "boss-cat";
  }

  return pickWeighted<OfficeCatPersonalityId>([
    ["default", 48],
    ["chaos-goblin", 29],
    ["senior-office-cat", 23],
  ]);
}

function pickOfficeCatSpot(exceptId?: string): OfficeCatSpot {
  const personality = getOfficeCatPersonality();
  const preferred = OFFICE_CAT_SPOTS.filter(
    (spot) =>
      spot.id !== exceptId && personality.preferredSpotIds.includes(spot.id),
  );
  const candidates = OFFICE_CAT_SPOTS.filter((spot) => spot.id !== exceptId);
  if (preferred.length > 0 && Math.random() < 0.72) {
    return pickRandom(preferred);
  }
  return pickRandom(candidates.length > 0 ? candidates : OFFICE_CAT_SPOTS);
}

function setOfficeCatMeow(text: string, nowMs: number, durationMs?: number) {
  officeCat.meowText = text;
  officeCat.meowVisibleUntilMs =
    nowMs +
    (durationMs ||
      clamp(
        OFFICE_CAT_MEOW_BASE_MS + text.length * 160,
        OFFICE_CAT_MEOW_BASE_MS,
        OFFICE_CAT_MEOW_MAX_MS,
      ));
}

function clearOfficeCatMeow() {
  officeCat.meowText = "";
  officeCat.meowVisibleUntilMs = 0;
}

function pickOfficeCatMeow(extra?: readonly string[]): string {
  const personality = getOfficeCatPersonality();
  const base = OFFICE_CAT_MEOWS.concat(personality.meows);
  const pool = extra ? base.concat(extra) : base;
  return pickRandom(pool);
}

function setOfficeCatTarget(target: Spot) {
  officeCat.targetX = target.x;
  officeCat.targetY = target.y;
  const dx = officeCat.targetX - officeCat.x;
  if (Math.abs(dx) > 0.2) {
    officeCat.facing = dx >= 0 ? 1 : -1;
  }
}

function scheduleOfficeCatDeparture(nowMs: number) {
  const personality = getOfficeCatPersonality();
  officeCat.mode = "leaving";
  officeCat.action = "walk";
  officeCat.speed = personality.speedMin + 0.18 + Math.random() * 0.28;
  const offscreenX =
    officeCat.exitSide === "left"
      ? FLOOR_BOUNDS.left - 30
      : FLOOR_BOUNDS.right + 30;
  setOfficeCatTarget({ x: offscreenX, y: officeCat.y });
  if (Math.random() < 0.42) {
    setOfficeCatMeow(pickOfficeCatMeow(["*verdwijnt*", "*staart omhoog*"]), nowMs);
  }
}

function startOfficeCatAction(nowMs: number, action: OfficeCatAction) {
  const personality = getOfficeCatPersonality();
  officeCat.mode = "lounging";
  officeCat.action = action;

  const duration =
    action === "zoom"
      ? randomRange(1200, 2400)
      : action === "nap"
        ? randomRange(2600, 5200)
        : randomRange(1800, 4200);
  officeCat.actionUntilMs = nowMs + duration;
  officeCat.nextDecisionAtMs = officeCat.actionUntilMs + randomRange(900, 2400);
  officeCat.speed =
    action === "zoom"
      ? personality.speedMax + 0.34 + Math.random() * 0.32
      : personality.speedMin + Math.random() * 0.2;

  if (Math.random() < 0.8) {
    const chatter =
      action === "sit"
        ? pickOfficeCatMeow(["*zit*", "*kijkt streng*"])
        : action === "loaf"
          ? pickOfficeCatMeow(["*plof*", "*broodmodus*"])
          : action === "groom"
            ? pickOfficeCatMeow(["*lik lik*", "*poets*"])
            : action === "zoom"
              ? pickOfficeCatMeow(["*zoom*", "nyoom", "*skrrt*"])
              : pickOfficeCatMeow(["z", "zz", "*dutje*"]);
    setOfficeCatMeow(chatter, nowMs);
  } else {
    clearOfficeCatMeow();
  }
}

function spawnOfficeCat(nowMs: number) {
  officeCat.personalityId = pickOfficeCatPersonalityId();
  const personality = getOfficeCatPersonality();
  const side = Math.random() < 0.5 ? "left" : "right";
  const firstSpot = pickOfficeCatSpot();
  officeCat.active = true;
  officeCat.mode = "entering";
  officeCat.action = "walk";
  officeCat.exitSide = Math.random() < 0.6 ? side : side === "left" ? "right" : "left";
  officeCat.enteredAtMs = nowMs;
  officeCat.departureAtMs =
    nowMs +
    randomRange(OFFICE_CAT_MIN_STAY_MS, OFFICE_CAT_MAX_STAY_MS) *
      personality.stayMultiplier;
  officeCat.actionUntilMs = nowMs + randomRange(1400, 2600);
  officeCat.nextDecisionAtMs = nowMs + randomRange(1800, 3600);
  officeCat.speed =
    personality.speedMin +
    Math.random() * Math.max(0.1, personality.speedMax - personality.speedMin);
  officeCat.frame = 0;
  officeCat.bob = Math.random() * Math.PI * 2;
  officeCat.x = side === "left" ? FLOOR_BOUNDS.left - 30 : FLOOR_BOUNDS.right + 30;
  officeCat.y = firstSpot.y + randomRange(-4, 4);
  officeCat.facing = side === "left" ? 1 : -1;
  clearOfficeCatMeow();
  if (Math.random() < 0.45) {
    setOfficeCatMeow(
      pickOfficeCatMeow(["*sluipt binnen*", "miauw"]),
      nowMs,
      2200,
    );
  }
  setOfficeCatTarget(firstSpot);

  const epochNow = Date.now();
  if (
    bossMonitorState.mode === "idle" &&
    !isBossSpeechVisible(epochNow) &&
    Math.random() < personality.immediateBossChance
  ) {
    setBossSpeechText(
      fillBossCatTemplate(pickRandom(OPS_AI_CAT_IDLE_LINES)),
      epochNow,
      "idle",
    );
  } else {
    nextBossIdleAt = Math.min(nextBossIdleAt, epochNow + 1600);
  }
}

function officeCatDistanceToTarget(): number {
  return Math.hypot(officeCat.targetX - officeCat.x, officeCat.targetY - officeCat.y);
}

function chooseNextOfficeCatBeat(nowMs: number) {
  const personality = getOfficeCatPersonality();
  const stayExceeded = nowMs >= officeCat.departureAtMs;
  if (stayExceeded && Math.random() < 0.68) {
    scheduleOfficeCatDeparture(nowMs);
    return;
  }

  const nextSpot = pickOfficeCatSpot();
  const shouldZoom = Math.random() < personality.zoomChance;
  officeCat.mode = "wandering";
  officeCat.action = shouldZoom ? "zoom" : "walk";
  officeCat.speed = shouldZoom
    ? personality.speedMax + 0.4 + Math.random() * 0.35
    : personality.speedMin + 0.12 + Math.random() * 0.24;
  officeCat.nextDecisionAtMs = nowMs + randomRange(2200, 4600);
  setOfficeCatTarget({
    x: nextSpot.x + randomRange(-5, 5),
    y: nextSpot.y + randomRange(-4, 4),
  });

  if (shouldZoom) {
    setOfficeCatMeow(pickOfficeCatMeow(["*zoom*", "nyoom"]), nowMs, 1800);
  } else if (Math.random() < 0.22) {
    setOfficeCatMeow(pickOfficeCatMeow(["*snif*", "*staar*"]), nowMs, 1800);
  } else {
    clearOfficeCatMeow();
  }
}

function pickOfficeCatLoungeAction(): OfficeCatAction {
  return pickWeighted(getOfficeCatPersonality().actionWeights);
}

function shorten(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}...`;
}

function stripSpeechNoise(value: string): string {
  return value
    .replace(ANSI_SGR_PATTERN, "")
    .replace(/\r/g, "")
    .replace(/^\s*Chunk ID:\s*.*$/gim, "")
    .replace(/^\s*Wall time:\s*.*$/gim, "")
    .replace(/^\s*Process exited with code\s*.*$/gim, "")
    .replace(/^\s*Original token count:\s*.*$/gim, "")
    .replace(/^\s*Total output lines:\s*.*$/gim, "")
    .replace(/^\s*Output:\s*$/gim, "")
    .replace(/^\s*Output:\s*/gim, "")
    .replace(/\|\s*Chunk ID:\s*[^|]+/gi, "")
    .replace(/\|\s*Wall time:\s*[^|]+/gi, "")
    .replace(/\|\s*Process exited with code\s*[^|]+/gi, "")
    .replace(/\|\s*Original token count:\s*[^|]+/gi, "")
    .replace(/\|\s*Total output lines:\s*[^|]+/gi, "")
    .replace(/\|\s*Output:\s*/gi, " | ")
    .trim();
}

function sanitizeBubbleText(value: string): string {
  const cleaned = stripSpeechNoise(value);
  if (!cleaned) {
    return "";
  }

  return cleaned
    .split(/\n+/)
    .map((line) => normalizeSpeechDetail(line) || normalizeSpeechSnippet(line))
    .filter(Boolean)
    .join("\n")
    .trim();
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
        agent.idleSpotId === BED_SPOT.id,
    );
}

function isPlantCareOccupied(exceptAgentId?: AgentId): boolean {
  return agentOrder
    .map((id) => agentState[id])
    .some(
      (agent) =>
        agent.id !== exceptAgentId &&
        agent.status === "idle" &&
        agent.idleSpotId === PLANT_CARE_SPOT.id,
    );
}

function randomizeIdleSpot(spot: IdleSpot): Spot {
  const offsetX = Math.round(randomRange(-spot.jitterX, spot.jitterX));
  const offsetY = Math.round(randomRange(-spot.jitterY, spot.jitterY));
  return {
    x: clamp(spot.x + offsetX, FLOOR_BOUNDS.left, FLOOR_BOUNDS.right),
    y: clamp(spot.y + offsetY, FLOOR_BOUNDS.top, FLOOR_BOUNDS.bottom),
  };
}

function countIdleSpotOccupancy(spotId: string, exceptAgentId?: AgentId): number {
  return agentOrder
    .map((id) => agentState[id])
    .filter(
      (other) =>
        other.id !== exceptAgentId &&
        other.status === "idle" &&
        other.idleSpotId === spotId,
    ).length;
}

function getIdleSpotById(spotId?: string): IdleSpot | undefined {
  if (!spotId) {
    return undefined;
  }
  if (spotId === BED_SPOT.id) {
    return BED_SPOT;
  }
  if (spotId === PLANT_CARE_SPOT.id) {
    return PLANT_CARE_SPOT;
  }
  return IDLE_SPOT_BY_ID.get(spotId);
}

function distanceToTarget(agent: AgentVisualState): number {
  return Math.hypot(agent.targetX - agent.x, agent.targetY - agent.y);
}

function isSettledAtIdleSpot(
  agent: AgentVisualState,
  spot: IdleSpot,
  tolerance = 4.2,
): boolean {
  return agent.idleSpotId === spot.id && distanceToTarget(agent) < tolerance;
}

function isPlantWateringSettled(agent: AgentVisualState): boolean {
  return (
    agentIdleOverlays[agent.id]?.action === "water-plant" &&
    isSettledAtIdleSpot(agent, PLANT_CARE_SPOT)
  );
}

function isSleepSettled(agent: AgentVisualState): boolean {
  return (
    agent.status === "idle" &&
    agent.routine === "sleep" &&
    isSettledAtIdleSpot(agent, BED_SPOT)
  );
}

function assignIdleTarget(
  agent: AgentVisualState,
  spot: IdleSpot,
  options?: { rememberPrevious?: boolean; targetOverride?: Spot },
) {
  if (
    options?.rememberPrevious &&
    agent.idleSpotId &&
    agent.idleSpotId !== spot.id
  ) {
    agent.idlePreviousSpotId = agent.idleSpotId;
  }
  const target = options?.targetOverride ?? randomizeIdleSpot(spot);
  agent.targetX = target.x;
  agent.targetY = target.y;
  agent.locationLabel = spot.label;
  agent.idleSpotId = spot.id;
  agent.lane = spot.id === PLANT_CARE_SPOT.id
    ? IDLE_SPOTS.length + 1
    : spot.id === BED_SPOT.id
      ? IDLE_SPOTS.length
      : Math.max(0, IDLE_SPOTS.findIndex((candidate) => candidate.id === spot.id));
  agent.idleHoldUntilMs = 0;
}

function resolveIdleEntrySpot(agent: AgentVisualState): IdleSpot {
  const preferredIds = AGENT_IDLE_HOME_SPOTS[agent.id];
  const candidates = preferredIds
    .map((spotId) => getIdleSpotById(spotId))
    .filter((spot): spot is IdleSpot => Boolean(spot))
    .map((spot, index) => {
      const occupancyPenalty = countIdleSpotOccupancy(spot.id, agent.id) * 140;
      const distancePenalty =
        Math.hypot(agent.x - spot.x, agent.y - spot.y) * 0.32;
      const anchorPenalty = index * 8;
      return {
        spot,
        score:
          occupancyPenalty + distancePenalty + anchorPenalty + randomRange(0, 8),
      };
    })
    .sort((left, right) => left.score - right.score);

  return candidates[0]?.spot || IDLE_SPOTS[0];
}

function resolveNextIdleSpot(agent: AgentVisualState): IdleSpot {
  const current = getIdleSpotById(agent.idleSpotId) ?? resolveIdleEntrySpot(agent);
  const preferredIds = new Set(AGENT_IDLE_HOME_SPOTS[agent.id]);
  const neighborIds = current.neighbors?.length
    ? current.neighbors
    : AGENT_IDLE_HOME_SPOTS[agent.id];
  const candidates = neighborIds
    .map((spotId) => getIdleSpotById(spotId))
    .filter((spot): spot is IdleSpot => Boolean(spot))
    .map((spot) => {
      const occupancyPenalty = countIdleSpotOccupancy(spot.id, agent.id) * 180;
      const distancePenalty =
        Math.hypot(agent.x - spot.x, agent.y - spot.y) * 0.24;
      const backtrackPenalty =
        agent.idlePreviousSpotId === spot.id ? 42 : 0;
      const centerPenalty =
        agent.id !== "reviewer" && spot.id.startsWith("center") ? 12 : 0;
      const roleBias =
        agent.id === "scout" && spot.id.startsWith("left")
          ? -16
          : agent.id === "builder" && spot.id.startsWith("right")
            ? -16
            : agent.id === "reviewer" &&
                (spot.id.startsWith("center") || spot.id === "south-turn")
              ? -14
              : 0;
      const homeBias = preferredIds.has(spot.id) ? -8 : 0;
      const sameSpotPenalty = agent.idleSpotId === spot.id ? 28 : 0;

      return {
        spot,
        score:
          occupancyPenalty +
          distancePenalty +
          backtrackPenalty +
          centerPenalty +
          sameSpotPenalty +
          roleBias +
          homeBias +
          randomRange(0, 10),
      };
    })
    .sort((left, right) => left.score - right.score);

  return candidates[0]?.spot || current;
}

function resolveIdleSpot(agent: AgentVisualState): IdleSpot {
  if (!agent.idleSpotId) {
    return resolveIdleEntrySpot(agent);
  }

  const currentSpot = getIdleSpotById(agent.idleSpotId);
  if (
    !currentSpot ||
    currentSpot.id === BED_SPOT.id ||
    currentSpot.id === PLANT_CARE_SPOT.id
  ) {
    return resolveIdleEntrySpot(agent);
  }

  const candidates = IDLE_SPOTS.map((spot) => {
    const occupancyPenalty = countIdleSpotOccupancy(spot.id, agent.id) * 120;
    const distancePenalty =
      Math.hypot(agent.x - spot.x, agent.y - spot.y) * 0.24;
    const sameSpotPenalty = agent.idleSpotId === spot.id ? 36 : 0;
    return {
      spot,
      score: occupancyPenalty + distancePenalty + sameSpotPenalty,
    };
  }).sort((left, right) => left.score - right.score);

  return candidates[0]?.spot || IDLE_SPOTS[0];
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

function isNearWorkstation(x: number, y: number, margin = 18): boolean {
  return WORKSTATIONS.some(ws => {
    const dx = Math.abs(ws.x - x);
    const dy = Math.abs(ws.y - y);
    return dx < margin && dy < margin;
  });
}

function applyZoneFromStatus(agent: AgentVisualState) {
  const active = isActiveStatus(agent.status);
  agent.zone = active ? "work" : "lounge";

  if (active) {
    const station = resolveWorkstation(agent);
    agent.targetX = station.x;
    agent.targetY = station.y;
    agent.locationLabel = station.label;
    agent.idleSpotId = undefined;
    agent.workstationId = station.id;
    agent.lane = WORKSTATIONS.findIndex((value) => value.id === station.id);
    agent.idleHoldUntilMs = 0;
  } else {
    agent.workstationId = undefined;
    if (agent.routine === "sleep" && !isBedOccupied(agent.id)) {
      assignIdleTarget(agent, BED_SPOT, { rememberPrevious: true });
    } else {
      if (agent.routine === "sleep" && isBedOccupied(agent.id)) {
        agent.routine = "pause";
      }

      const overlay = agentIdleOverlays[agent.id];
      const wantsPlantCare =
        overlay?.action === "water-plant" && !isPlantCareOccupied(agent.id);
      const wantsBedRest =
        !overlay?.action &&
        agent.routine === "pause" &&
        !isBedOccupied(agent.id) &&
        Math.random() < 0.38;
      if (overlay?.action === "water-plant" && !wantsPlantCare) {
        agentIdleOverlays[agent.id] = null;
      }

      if (wantsPlantCare) {
        assignIdleTarget(agent, PLANT_CARE_SPOT, { rememberPrevious: true });
      } else if (overlay?.action === "phone" || overlay?.action === "wave") {
        agent.targetX = agent.x;
        agent.targetY = agent.y;
        agent.idleHoldUntilMs = 0;
      } else if (wantsBedRest) {
        assignIdleTarget(agent, BED_SPOT, { rememberPrevious: true });
      } else {
        let spot =
          agent.routine === "normal"
            ? resolveIdleSpot(agent)
            : resolveIdleEntrySpot(agent);
        let target = randomizeIdleSpot(spot);
        let tries = 0;
        while (isNearWorkstation(target.x, target.y) && tries < 6) {
          spot = resolveNextIdleSpot(agent);
          target = randomizeIdleSpot(spot);
          tries += 1;
        }

        assignIdleTarget(agent, spot, {
          rememberPrevious: true,
          targetOverride: target,
        });
      }
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

  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;
  const offCtx = offscreen.getContext("2d", { willReadFrequently: true });
  if (!offCtx) {
    return [];
  }

  offCtx.drawImage(image, 0, 0, width, height);
  const data = offCtx.getImageData(0, 0, width, height).data;

  const rects: SpriteRect[] = [];

  for (let row = 0; row < DEFAULT_SPRITE_ROWS; row += 1) {
    for (let col = 0; col < DEFAULT_SPRITE_COLUMNS; col += 1) {
      const x = col * cellWidth;
      const y = row * cellHeight;
      const w = col === DEFAULT_SPRITE_COLUMNS - 1 ? width - x : cellWidth;
      const h = row === DEFAULT_SPRITE_ROWS - 1 ? height - y : cellHeight;

      const sampleInset = Math.max(1, Math.floor(Math.min(w, h) * 0.08));
      const c1 = (Math.max(0, y + sampleInset) * width +
        Math.max(0, x + sampleInset)) *
        4;
      const c2 = (Math.max(0, y + sampleInset) * width +
        Math.min(width - 1, x + w - 1 - sampleInset)) *
        4;
      const c3 = (Math.min(height - 1, y + h - 1 - sampleInset) * width +
        Math.max(0, x + sampleInset)) *
        4;
      const c4 = (Math.min(height - 1, y + h - 1 - sampleInset) * width +
        Math.min(width - 1, x + w - 1 - sampleInset)) *
        4;

      const bgR =
        (data[c1] + data[c2] + data[c3] + data[c4]) /
        4;
      const bgG =
        (data[c1 + 1] + data[c2 + 1] + data[c3 + 1] + data[c4 + 1]) /
        4;
      const bgB =
        (data[c1 + 2] + data[c2 + 2] + data[c3 + 2] + data[c4 + 2]) /
        4;

      let minX = x + w;
      let minY = y + h;
      let maxX = -1;
      let maxY = -1;
      let foregroundPixels = 0;

      for (let py = y; py < y + h; py += 1) {
        for (let px = x; px < x + w; px += 1) {
          const idx = (py * width + px) * 4;
          const alpha = data[idx + 3];
          if (alpha < 20) {
            continue;
          }

          const distance =
            Math.abs(data[idx] - bgR) +
            Math.abs(data[idx + 1] - bgG) +
            Math.abs(data[idx + 2] - bgB);
          if (distance < GRID_TRIM_DISTANCE) {
            continue;
          }

          foregroundPixels += 1;
          if (px < minX) {
            minX = px;
          }
          if (py < minY) {
            minY = py;
          }
          if (px > maxX) {
            maxX = px;
          }
          if (py > maxY) {
            maxY = py;
          }
        }
      }

      if (
        foregroundPixels >= GRID_TRIM_MIN_PIXELS &&
        maxX >= minX &&
        maxY >= minY
      ) {
        const trimmedX = Math.max(x, minX - GRID_TRIM_PADDING);
        const trimmedY = Math.max(y, minY - GRID_TRIM_PADDING);
        const trimmedW = Math.min(x + w - 1, maxX + GRID_TRIM_PADDING) - trimmedX + 1;
        const trimmedH = Math.min(y + h - 1, maxY + GRID_TRIM_PADDING) - trimmedY + 1;

        rects.push({
          x: trimmedX,
          y: trimmedY,
          width: Math.max(1, trimmedW),
          height: Math.max(1, trimmedH),
          pixelCount: foregroundPixels,
        });
        continue;
      }

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

function pickStableColumnVariants(
  variants: AgentSpriteVariant[],
): AgentSpriteVariant[] {
  if (!spriteSheetImage) {
    return [];
  }

  const imageWidth = spriteSheetImage.naturalWidth || spriteSheetImage.width;
  const cellWidth = imageWidth / DEFAULT_SPRITE_COLUMNS;
  const byColumn: AgentSpriteVariant[][] = Array.from(
    { length: DEFAULT_SPRITE_COLUMNS },
    () => [],
  );

  for (const variant of variants) {
    const centerX = variant.rect.x + variant.rect.width / 2;
    const col = clamp(
      Math.floor(centerX / cellWidth),
      0,
      DEFAULT_SPRITE_COLUMNS - 1,
    );
    byColumn[col].push(variant);
  }

  const picks: AgentSpriteVariant[] = [];
  for (const columnVariants of byColumn) {
    if (columnVariants.length === 0) {
      continue;
    }
    columnVariants.sort(
      (left, right) => right.rect.pixelCount - left.rect.pixelCount,
    );
    picks.push(columnVariants[0]);
  }

  return picks;
}

function assignRandomCharactersToAgents() {
  if (spriteVariants.length < agentOrder.length) {
    return;
  }

  const preferred = pickStableColumnVariants(spriteVariants);
  const picks =
    preferred.length >= agentOrder.length
      ? preferred.slice(0, agentOrder.length)
      : pickUniqueRandom(spriteVariants, agentOrder.length);

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
    renderConnectionStatus();
  } catch {
    spriteSheetImage = undefined;
    spriteVariants = [];
    renderConnectionStatus();
  }
}

async function initializeRoomBackground() {
  try {
    roomBackgroundImage = await loadImage(roomBackgroundUrl);
  } catch {
    roomBackgroundImage = undefined;
  }
  renderConnectionStatus();
}

function setBossSpeechText(
  text: string,
  timestamp: number = Date.now(),
  mode: BossMonitorState["mode"] = "receiving",
  targetAgentId?: AgentId,
) {
  const normalized = shorten(
    sanitizeBubbleText(text).replace(/\s+/g, " ").trim(),
    92,
  );
  if (!normalized) {
    bossMonitorState.speechText = "";
    bossMonitorState.speechVisibleUntil = 0;
    bossMonitorState.lastEventAt = 0;
    bossMonitorState.mode = "idle";
    bossMonitorState.targetAgentId = undefined;
    return;
  }

  const visibleDuration = clamp(
    5200 + normalized.length * 44,
    5200,
    12000,
  );
  bossMonitorState.speechText = normalized;
  bossMonitorState.lastEventAt = timestamp;
  bossMonitorState.speechVisibleUntil = timestamp + visibleDuration;
  bossMonitorState.mode = mode;
  bossMonitorState.targetAgentId = targetAgentId;
  nextBossIdleAt = timestamp + Math.round(randomRange(12_000, 24_000));
}

function isBossSpeechVisible(nowMs: number): boolean {
  const visible =
    Boolean(bossMonitorState.speechText) &&
    nowMs <= bossMonitorState.speechVisibleUntil;
  if (!visible) {
    bossMonitorState.mode = "idle";
    bossMonitorState.targetAgentId = undefined;
  }
  return visible;
}

function isBossOnlyEventType(type: string): boolean {
  return /^ops\./.test(type);
}

function bossSpeechPayloadFromEvent(
  event: PixelRuntimeEvent,
):
  | { text: string; mode: BossMonitorState["mode"]; targetAgentId?: AgentId }
  | undefined {
  const text = event.detail || event.summary;
  if (!text) {
    return undefined;
  }

  if (event.type === "chat.userPrompt" || event.type === "codex.userMessage") {
    return { text, mode: "receiving" };
  }

  if (event.type === "ops.dispatch") {
    return { text, mode: "dispatching", targetAgentId: event.agentId };
  }

  return undefined;
}

function syncBossFromEvents(events: readonly PixelRuntimeEvent[]) {
  const latestBossEvent = events.find((event) => Boolean(bossSpeechPayloadFromEvent(event)));
  if (!latestBossEvent) {
    return;
  }

  const payload = bossSpeechPayloadFromEvent(latestBossEvent);
  if (!payload) {
    return;
  }

  setBossSpeechText(
    payload.text,
    latestBossEvent.timestamp || Date.now(),
    payload.mode,
    payload.targetAgentId,
  );
}

function setAgentSpeechText(
  agent: AgentVisualState,
  text: string,
  timestamp: number = Date.now(),
  timing?: {
    baseMs?: number;
    perCharMs?: number;
    maxMs?: number;
  },
) {
  const normalized = shorten(
    sanitizeBubbleText(text).replace(/\s+/g, " ").trim(),
    96,
  );
  if (!normalized) {
    agent.speechText = "";
    agent.lastSpeechAt = 0;
    agent.speechVisibleUntil = 0;
    return;
  }
  const visibleDuration = clamp(
    (timing?.baseMs ?? SPEECH_BASE_VISIBLE_MS) +
      normalized.length * (timing?.perCharMs ?? SPEECH_PER_CHAR_MS),
    timing?.baseMs ?? SPEECH_BASE_VISIBLE_MS,
    timing?.maxMs ?? SPEECH_MAX_VISIBLE_MS,
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
  if (roll >= 0.68 && roll < 0.82) {
    routine = "pause";
  } else if (roll >= 0.82 && roll < 0.94) {
    routine = "dance";
  } else if (roll >= 0.94) {
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
    agent.routineUntilMs = nowMs + randomRange(3800, 6200);
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

  const hasVisibleBubble = agentOrder
    .map((id) => agentState[id])
    .some((agent) => isSpeechVisible(agent, now));
  if (hasVisibleBubble) {
    nextIdleChatAt = now + Math.round(randomRange(4_500, 8_500));
    return;
  }

  const idleAgents = agentOrder
    .map((id) => agentState[id])
    .filter(
      (agent) =>
        agent.status === "idle" &&
        agent.routine !== "sleep" &&
        now - agent.lastSpeechAt >= IDLE_CHAT_RECENT_SPEECH_BLOCK_MS,
    );

  if (idleAgents.length < 2) {
    nextIdleChatAt = now + Math.round(randomRange(5_000, 9_500));
    return;
  }

  if (Math.random() < IDLE_CHAT_SKIP_CHANCE) {
    nextIdleChatAt = now + Math.round(randomRange(6_500, 12_000));
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

function maybeRunBossIdleChatter() {
  const now = Date.now();
  if (now < nextBossIdleAt) {
    return;
  }

  if (bossMonitorState.mode !== "idle") {
    nextBossIdleAt = now + Math.round(randomRange(8_000, 14_000));
    return;
  }

  if (isBossSpeechVisible(now)) {
    nextBossIdleAt = now + Math.round(randomRange(7_000, 12_000));
    return;
  }

  setBossSpeechText(pickBossIdleLine(), now, "idle");
}

function areAllAgentsIdle(): boolean {
  return agentOrder.every((agentId) => agentState[agentId].status === "idle");
}

function summarizeDirtyGitState(git: GitViewState): string {
  const parts: string[] = [];
  if (git.staged > 0) {
    parts.push(`${git.staged} staged`);
  }
  if (git.unstaged > 0) {
    parts.push(`${git.unstaged} unstaged`);
  }
  if (git.conflicts > 0) {
    parts.push(`${git.conflicts} conflict${git.conflicts === 1 ? "" : "s"}`);
  }

  const summary =
    parts.length > 0 ? parts.join(", ") : git.message || "lokale wijzigingen";
  return shorten(summary, 28);
}

function fillBossIdleTemplate(template: string, git: GitViewState): string {
  return template
    .replace(/\{changes\}/g, summarizeDirtyGitState(git))
    .replace(/\{branch\}/g, shorten(git.branch || "detached", 16));
}

function describeOfficeCatAction(action: OfficeCatAction): string {
  if (action === "sit") {
    return "sit-mode";
  }
  if (action === "loaf") {
    return "loaf-mode";
  }
  if (action === "groom") {
    return "self-cleanup";
  }
  if (action === "zoom") {
    return "zoomies";
  }
  if (action === "nap") {
    return "slaapstand";
  }
  return "patrol";
}

function describeOfficeCatPersona(): string {
  return getOfficeCatPersonality().personalityLabel;
}

function findNearestOfficeCatSpot(): OfficeCatSpot {
  return OFFICE_CAT_SPOTS.slice().sort((left, right) => {
    const leftDistance = Math.hypot(officeCat.x - left.x, officeCat.y - left.y);
    const rightDistance = Math.hypot(officeCat.x - right.x, officeCat.y - right.y);
    return leftDistance - rightDistance;
  })[0];
}

function fillBossCatTemplate(template: string): string {
  const nearestSpot = findNearestOfficeCatSpot();
  const personality = getOfficeCatPersonality();
  return template
    .replace(/\{catName\}/g, personality.bossLabel)
    .replace(/\{catPersona\}/g, describeOfficeCatPersona())
    .replace(/\{catAction\}/g, describeOfficeCatAction(officeCat.action))
    .replace(/\{catSpot\}/g, nearestSpot.label);
}

function pickBossIdleLine(): string {
  if (officeCat.active && Math.random() < 0.56) {
    const catLines =
      officeCat.personalityId === "boss-cat"
        ? OPS_AI_BOSS_CAT_IDLE_LINES
        : OPS_AI_CAT_IDLE_LINES;
    return fillBossCatTemplate(pickRandom(catLines));
  }

  if (!currentGitState.available || !currentGitState.hasChanges) {
    return pickRandom(OPS_AI_IDLE_LINES);
  }

  const everyoneIdle = areAllAgentsIdle();
  const dirtyGitChance = everyoneIdle ? 0.78 : 0.34;
  if (Math.random() >= dirtyGitChance) {
    return pickRandom(OPS_AI_IDLE_LINES);
  }

  const pool = everyoneIdle
    ? OPS_AI_DIRTY_GIT_ALL_IDLE_LINES
    : OPS_AI_DIRTY_GIT_IDLE_LINES;
  return fillBossIdleTemplate(pickRandom(pool), currentGitState);
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
  if (event.type === "codex.reasoning") {
    return "hmm... ik zoek het even uit";
  }

  const summary = normalizeSpeechSnippet(event.summary ?? "");
  const detail = normalizeSpeechDetail(event.detail ?? "");

  if (
    event.type === "codex.toolCall" ||
    event.type === "codex.customToolCall" ||
    event.type === "codex.toolResult" ||
    event.type === "codex.customToolResult"
  ) {
    const primary = detail || summary;
    if (!primary) {
      return "";
    }
    return shorten(primary, 52);
  }

  const baseSummary = summary ? shorten(summary, 42) : getActiveLine(agent);
  const compactDetail = detail ? shorten(detail, 54) : "";
  if (compactDetail && compactDetail !== baseSummary) {
    return `${baseSummary}\n${compactDetail}`;
  }
  return baseSummary || getIdleLine(agent, event.timestamp || Date.now());
}

function normalizeSpeechSnippet(value: string): string {
  let text = stripSpeechNoise(value)
    .replace(/\[(codex|local|copilot-export)\]/gi, "")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s+/g, " ")
    .trim();

  text = text
    .replace(/^codex custom tool output\b\s*[-:|]?\s*/i, "")
    .replace(/^codex tool output\b\s*[-:|]?\s*/i, "")
    .replace(/^codex tool:\s*exec_command\b\s*[-:|]?\s*/i, "")
    .replace(/^codex tool:\s*write_stdin\b\s*[-:|]?\s*/i, "")
    .replace(/^codex custom tool:\s*apply_patch\b\s*[-:|]?\s*/i, "patch ")
    .replace(/^codex past bestanden aan\b\s*[-:|]?\s*/i, "patch ")
    .replace(/^codex custom tool:\s*/i, "")
    .replace(/^codex tool:\s*/i, "")
    .replace(/^tool-output ontvangen\b\s*[-:|]?\s*/i, "")
    .replace(/^terminalcommando gestart\b\s*[-:|]?\s*/i, "")
    .replace(/^\$\s*/, "")
    .replace(/^[-:|]\s*/, "")
    .trim();

  return text;
}

function normalizeSpeechDetail(value: string): string {
  const cleaned = normalizeSpeechSnippet(value);
  if (!cleaned) {
    return "";
  }

  const segments = cleaned
    .split(" | ")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter(
      (part) =>
        !/^(stdout|stderr|output|trace|span|model)\s*[:=]/i.test(part) &&
        !/^exit code\s*[:=]?\s*0$/i.test(part),
    );

  if (segments.length === 0) {
    return cleaned;
  }

  if (segments.length === 1) {
    return segments[0];
  }

  const pair = `${segments[0]} | ${segments[1]}`;
  if (pair.length <= 54) {
    return pair;
  }

  return segments[0];
}

function speechTimingForEvent(event: PixelRuntimeEvent): {
  baseMs: number;
  perCharMs: number;
  maxMs: number;
} {
  if (
    /message|response|chat\.completed|chat\.streaming|codex\.response/.test(
      event.type,
    )
  ) {
    return {
      baseMs: MESSAGE_SPEECH_BASE_VISIBLE_MS,
      perCharMs: MESSAGE_SPEECH_PER_CHAR_MS,
      maxMs: MESSAGE_SPEECH_MAX_VISIBLE_MS,
    };
  }

  return {
    baseMs: SPEECH_BASE_VISIBLE_MS,
    perCharMs: SPEECH_PER_CHAR_MS,
    maxMs: SPEECH_MAX_VISIBLE_MS,
  };
}

function setAgentSpeech(agent: AgentVisualState, event: PixelRuntimeEvent) {
  const speech = buildSpeechFromEvent(agent, event);
  if (!speech) {
    return;
  }

  setAgentSpeechText(
    agent,
    speech,
    event.timestamp || Date.now(),
    speechTimingForEvent(event),
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
    /analy|analyse|scan|diagnos|context|plan|read|diff|status|review|explor|reasoning|think|uitzoek/.test(text)
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
  if (/codex\.reasoning/.test(type)) {
    return "analyzing";
  }
  if (
    /idletimeout|wacht|waiting|geen nieuwe events|no new events/.test(combined)
  ) {
    return "waiting-input";
  }
  if (
    /analy|analyse|scan|diagnos|context|plan|read|diff|status|review|explor|reasoning|think|uitzoek/.test(
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

  return "Wacht op input | lounge rustig";
}

function inactivityLimitForAgent(agent: AgentVisualState): number {
  const combined = `${agent.phase} ${agent.lastEventType} ${agent.task}`.toLowerCase();
  if (
    agent.status === "working" &&
    /analy|analyse|explor|reasoning|thinking|context|plan|read|scan|search|inspect|diff|status|uitzoek/.test(
      combined,
    )
  ) {
    return ANALYZING_AGENT_INACTIVITY_LIMIT_MS;
  }
  return DEFAULT_AGENT_INACTIVITY_LIMIT_MS;
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

    if (now - incoming.lastEventAt <= MESSAGE_SPEECH_MAX_VISIBLE_MS) {
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
  for (const agentId of agentOrder) {
    const latestEvent = runtimeEvents.find((event) => event.agentId === agentId);
    if (latestEvent?.type) {
      agentState[agentId].lastEventType = latestEvent.type;
    }
  }
  syncBossFromEvents(runtimeEvents);
  renderGitState(snapshot.git || createDefaultGitState());

  setRuntimeStatus(
    snapshot.statusLine || "Wacht op input | lounge rustig",
  );
  renderAgents();
  renderEvents();
  updateRuntimeStatusFromAgents();
}

function applyEvent(event: PixelRuntimeEvent) {
  if (event.git) {
    renderGitState(event.git);
  }

  const bossPayload = bossSpeechPayloadFromEvent(event);
  if (bossPayload) {
    setBossSpeechText(
      bossPayload.text,
      event.timestamp || Date.now(),
      bossPayload.mode,
      bossPayload.targetAgentId,
    );
  }

  if (event.agentId && !isBossOnlyEventType(event.type)) {
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
  // Minder fel, meer realistisch blauw/groen/geel
  if (role === "research") {
    return `rgb(${Math.round(glow * 0.72)}, ${Math.round(glow * 0.85)}, ${Math.round(200 + glow * 0.18)})`;
  }
  if (role === "engineering") {
    return `rgb(${Math.round(200 + glow * 0.18)}, ${Math.round(glow * 0.85)}, ${Math.round(glow * 0.45)})`;
  }
  // QA: zacht geel/groen
  return `rgb(${Math.round(220 + glow * 0.12)}, ${Math.round(220 + glow * 0.18)}, ${Math.round(glow * 0.18)})`;
}

function resolveWorkstationScreenMode(
  activity?: WorkstationActivity,
): WorkstationScreenMode {
  if (!activity || activity.occupied === 0) {
    return "off";
  }
  if (activity.error > 0) {
    return "error";
  }
  if (activity.completed > 0) {
    return "completed";
  }
  return "working";
}

function getWorkstationScreenRect(station: WorkstationSpot): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const backgroundScene = Boolean(roomBackgroundImage);

  if (
    backgroundScene &&
    typeof station.bgScreenX === "number" &&
    typeof station.bgScreenY === "number" &&
    typeof station.bgScreenWidth === "number" &&
    typeof station.bgScreenHeight === "number"
  ) {
    return {
      x: station.bgScreenX,
      y: station.bgScreenY,
      width: station.bgScreenWidth,
      height: station.bgScreenHeight,
    };
  }

  return {
    x: station.screenX,
    y: station.screenY,
    width: station.screenWidth,
    height: station.screenHeight,
  };
}

function drawWorkstationScreen(
  station: WorkstationSpot,
  nowMs: number,
  pulse: number,
  activity?: WorkstationActivity,
) {
  const mode = resolveWorkstationScreenMode(activity);
  const { x, y, width, height } = getWorkstationScreenRect(station);

  ctx.fillStyle = "#0f1a2a";
  ctx.fillRect(x - 1, y - 1, width + 2, height + 2);
  ctx.fillStyle = "#243348";
  ctx.fillRect(x, y, width, height);

  if (mode === "off") {
    const standbyOn = Math.sin(nowMs * 0.003 + x * 0.8 + y) > 0.72;
    ctx.fillStyle = standbyOn ? "#8fd4e8" : "#4d657d";
    ctx.fillRect(x + width - 2, y + height - 2, 1, 1);
    return;
  }

  const glow = 190 + Math.floor(38 * Math.sin(pulse));
  const baseColor =
    mode === "error"
      ? `rgb(255, ${Math.max(80, glow - 120)}, ${Math.max(125, glow - 75)})`
      : mode === "completed"
        ? `rgb(${Math.max(130, glow - 40)}, 255, ${Math.max(170, glow - 20)})`
        : stationRoleMonitorColor(station.role, glow);
  ctx.fillStyle = baseColor;
  ctx.fillRect(x, y, width, height);

  const scanX =
    ((Math.floor(nowMs / 95) + x + y) %
      (width + 6)) -
    3;
  if (scanX >= 0 && scanX < width) {
    ctx.fillStyle = "rgba(244, 252, 255, 0.5)";
    ctx.fillRect(x + scanX, y, 1, height);
  }

  ctx.fillStyle =
    mode === "error"
      ? "rgba(64, 20, 34, 0.56)"
      : mode === "completed"
        ? "rgba(18, 54, 42, 0.5)"
        : "rgba(13, 33, 48, 0.5)";
  ctx.fillRect(x, y, width, 1);

  const maxBarWidth = Math.max(2, width - 2);
  const rowCount = Math.max(2, Math.floor((height - 2) / 2));
  for (let row = 0; row < rowCount; row += 1) {
    const phase = Math.floor(
      nowMs / (108 + row * 17) + station.deskX + row * 5 + y,
    );
    const barWidth = 1 + (phase % maxBarWidth);
    ctx.fillStyle =
      mode === "error"
        ? "rgba(255, 225, 236, 0.78)"
        : mode === "completed"
          ? "rgba(222, 255, 236, 0.76)"
          : "rgba(226, 245, 255, 0.74)";
    ctx.fillRect(x + 1, y + 1 + row * 2, barWidth, 1);
  }

  const blink = Math.sin(nowMs * 0.012 + x * 0.2) > 0.2;
  if (mode === "working" && blink) {
    const cursorX = x + 1 + (Math.floor(nowMs / 140) % Math.max(1, width - 2));
    ctx.fillStyle = "#f8fdff";
    ctx.fillRect(cursorX, y + height - 2, 1, 1);
  }
  if (mode === "completed" && blink) {
    ctx.fillStyle = "#effff5";
    ctx.fillRect(x + width - 3, y + 1, 2, 1);
    ctx.fillRect(x + width - 2, y + 2, 1, 1);
  }
  if (mode === "error" && blink) {
    ctx.fillStyle = "#fff0f6";
    ctx.fillRect(x + 1, y + 1, 2, 2);
  }
}

function getBossMonitorRect(backgroundScene: boolean) {
  if (backgroundScene) {
    return {
      x: bitmapRoomX(42),
      y: bitmapRoomY(64),
      width: bitmapRoomWidth(90),
      height: bitmapRoomHeight(58),
    };
  }

  return { x: 18, y: 18, width: 58, height: 38 };
}

function drawBossHeadSprite(
  x: number,
  y: number,
  nowMs: number,
  mode: BossMonitorState["mode"],
) {
  const blink = Math.sin(nowMs * 0.008) > 0.82;
  const receiving = mode === "receiving";
  const dispatching = mode === "dispatching";
  const idle = mode === "idle";
  const mouthPulse = dispatching ? Math.sin(nowMs * 0.03) > 0 : receiving;

  drawPixelRect(x + 4, y + 2, 16, 12, "#1e2b40");
  drawPixelRect(x + 5, y + 3, 14, 10, "#8eeeff");
  drawPixelRect(x + 7, y + 4, 10, 2, "#dffcff");
  drawPixelRect(x + 6, y + 7, 12, 5, "#22354f");
  drawPixelRect(x + 8, y + 8, 8, 4, "#ff9aca");
  drawPixelRect(x + 9, y + 6, 6, 1, "#fff2fb");

  if (blink) {
    drawPixelRect(x + 9, y + 9, 2, 1, "#dffcff");
    drawPixelRect(x + 13, y + 9, 2, 1, "#dffcff");
  } else {
    drawPixelRect(x + 9, y + 8, 2, 2, "#dffcff");
    drawPixelRect(x + 13, y + 8, 2, 2, "#dffcff");
  }

  drawPixelRect(x + 10, y + 11, mouthPulse ? 5 : 3, 1, "#dffcff");
  if (receiving) {
    drawPixelRect(x + 2, y + 6, 2, 1, "#ffb9de");
    drawPixelRect(x + 20, y + 6, 2, 1, "#ffb9de");
  }
  if (dispatching) {
    drawPixelRect(x + 3, y + 1, 3, 1, "#a9ffd5");
    drawPixelRect(x + 18, y + 1, 3, 1, "#a9ffd5");
    drawPixelRect(x + 2, y + 4, 1, 4, "#dffef0");
    drawPixelRect(x + 21, y + 4, 1, 4, "#dffef0");
    drawPixelRect(x + 10, y + 0, 4, 1, "#e8fff3");
  }
  if (idle && Math.sin(nowMs * 0.01) > 0.55) {
    drawPixelRect(x + 2, y + 5, 1, 1, "#9ae7ff");
    drawPixelRect(x + 21, y + 5, 1, 1, "#9ae7ff");
  }
  drawPixelRect(x + 3, y + 14, 18, 2, "rgba(104, 220, 255, 0.28)");
}

function drawBossMonitor(nowMs: number) {
  const backgroundScene = Boolean(roomBackgroundImage);
  const rect = getBossMonitorRect(backgroundScene);
  const pulse = 0.58 + Math.sin(nowMs * 0.0048) * 0.24;
  const burst = 0.5 + Math.sin(nowMs * 0.018) * 0.5;
  const activeAccent =
    bossMonitorState.mode === "receiving"
      ? "rgba(255, 148, 209, 0.34)"
      : bossMonitorState.mode === "dispatching"
        ? "rgba(145, 255, 196, 0.38)"
        : "rgba(79, 229, 255, 0.16)";

  if (bossMonitorState.mode !== "idle") {
    const halo =
      bossMonitorState.mode === "receiving"
        ? `rgba(255, 164, 221, ${(0.14 + burst * 0.1).toFixed(3)})`
        : `rgba(169, 255, 213, ${(0.16 + burst * 0.12).toFixed(3)})`;
    ctx.fillStyle = halo;
    ctx.fillRect(rect.x - 6, rect.y - 6, rect.width + 12, rect.height + 12);
  }

  ctx.fillStyle = activeAccent;
  ctx.fillRect(rect.x - 3, rect.y - 3, rect.width + 6, rect.height + 6);
  ctx.fillStyle = "#15263a";
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.fillStyle = "#273a55";
  ctx.fillRect(rect.x + 2, rect.y + 2, rect.width - 4, rect.height - 4);
  ctx.fillStyle = "#081520";
  ctx.fillRect(rect.x + 5, rect.y + 8, rect.width - 10, rect.height - 16);
  ctx.fillStyle = `rgba(114, 238, 255, ${pulse.toFixed(2)})`;
  ctx.fillRect(rect.x + 6, rect.y + 9, rect.width - 12, rect.height - 18);
  if (bossMonitorState.mode === "receiving") {
    ctx.fillStyle = "rgba(255, 174, 221, 0.22)";
    ctx.fillRect(rect.x + 8, rect.y + 11, rect.width - 16, rect.height - 22);
    const scanY =
      rect.y + 12 + (Math.floor(nowMs / 90) % Math.max(3, rect.height - 24));
    ctx.fillStyle = "rgba(255, 239, 247, 0.72)";
    ctx.fillRect(rect.x + 8, scanY, rect.width - 16, 1);
  } else if (bossMonitorState.mode === "dispatching") {
    ctx.fillStyle = "rgba(159, 255, 207, 0.24)";
    ctx.fillRect(rect.x + 8, rect.y + 11, rect.width - 16, rect.height - 22);
    for (let i = 0; i < 3; i += 1) {
      const slashX = rect.x + 10 + ((Math.floor(nowMs / 80) + i * 8) % (rect.width - 22));
      ctx.fillStyle = "rgba(229, 255, 240, 0.66)";
      ctx.fillRect(slashX, rect.y + 14 + i * 4, 4, 1);
      ctx.fillRect(slashX + 1, rect.y + 15 + i * 4, 4, 1);
    }
  }
  ctx.fillStyle = "rgba(244, 252, 255, 0.3)";
  ctx.fillRect(rect.x + 7, rect.y + 10, rect.width - 14, 2);

  if (bossMonitorState.mode !== "idle") {
    const pingColor =
      bossMonitorState.mode === "receiving" ? "#ffb6df" : "#a9ffd5";
    for (let i = 0; i < 3; i += 1) {
      const pingOffset = Math.sin(nowMs * 0.01 + i * 0.8) > 0 ? 1 : 0;
      drawPixelRect(rect.x + 8 + i * 6, rect.y + 4 - pingOffset, 3, 1, pingColor);
    }
    drawPixelRect(rect.x + rect.width - 12, rect.y + 4, 4, 1, pingColor);
    drawPixelRect(rect.x + rect.width - 10, rect.y + 6, 2, 1, pingColor);
  }

  drawBossHeadSprite(
    rect.x + Math.floor(rect.width / 2) - 12,
    rect.y + Math.floor(rect.height / 2) - 7,
    nowMs,
    bossMonitorState.mode,
  );

  ctx.fillStyle = "#e7fbff";
  ctx.font = "bold 6px monospace";
  ctx.fillText("OPS AI", rect.x + 8, rect.y + 7);

  ctx.fillStyle = "#89dff8";
  ctx.fillRect(rect.x + 6, rect.y + rect.height - 5, rect.width - 12, 1);
  ctx.fillStyle = "#1c2f48";
  ctx.fillRect(rect.x + Math.floor(rect.width / 2) - 6, rect.y + rect.height, 12, 3);
}

function drawBossDispatchLink(nowMs: number) {
  if (
    bossMonitorState.mode !== "dispatching" ||
    !bossMonitorState.targetAgentId
  ) {
    return;
  }

  const target = agentState[bossMonitorState.targetAgentId];
  if (!target) {
    return;
  }

  const rect = getBossMonitorRect(Boolean(roomBackgroundImage));
  const startX = rect.x + Math.floor(rect.width / 2);
  const startY = rect.y + rect.height + 2;
  const endX = Math.floor(target.x + 10);
  const endY = Math.floor(target.y - 8 + Math.sin(nowMs * 0.004 + target.bob));

  const pulse = Math.floor(nowMs / 90) % 3;
  const burst = Math.sin(nowMs * 0.018) > 0;
  for (let i = 0; i <= 12; i += 1) {
    if ((i + pulse) % 3 === 0) {
      continue;
    }
    const progress = i / 12;
    const px = Math.round(startX + (endX - startX) * progress);
    const py = Math.round(startY + (endY - startY) * progress);
    drawPixelRect(px, py, 2, 1, "#a9ffd5");
    if (burst) {
      drawPixelRect(px, py - 1, 1, 1, "#effff7");
    }
  }

  for (let i = 0; i <= 7; i += 1) {
    const progress = i / 7;
    const px = Math.round(startX + (endX - startX) * progress);
    const py = Math.round(startY + (endY - startY) * progress);
    drawPixelRect(px - 1, py + 1, 1, 1, "rgba(255, 184, 228, 0.8)");
  }

  const reticleColor = burst ? "#f2fff8" : "#a9ffd5";
  drawPixelRect(endX - 8, endY - 8, 5, 1, reticleColor);
  drawPixelRect(endX + 3, endY - 8, 5, 1, reticleColor);
  drawPixelRect(endX - 8, endY + 7, 5, 1, reticleColor);
  drawPixelRect(endX + 3, endY + 7, 5, 1, reticleColor);
  drawPixelRect(endX - 8, endY - 8, 1, 5, reticleColor);
  drawPixelRect(endX - 8, endY + 3, 1, 5, reticleColor);
  drawPixelRect(endX + 7, endY - 8, 1, 5, reticleColor);
  drawPixelRect(endX + 7, endY + 3, 1, 5, reticleColor);
  if (burst) {
    drawPixelRect(endX - 1, endY - 1, 3, 3, "#ffffff");
  }
}

function drawBossSpeechCloud(nowEpochMs: number) {
  if (!isBossSpeechVisible(nowEpochMs)) {
    return;
  }

  const rect = getBossMonitorRect(Boolean(roomBackgroundImage));
  const lines = wrapBubbleText(
    `Ops AI: ${bossMonitorState.speechText}`,
    28,
    3,
  );
  if (lines.length === 0) {
    return;
  }

  ctx.font = "8px monospace";
  const textWidth = Math.max(
    ...lines.map((line) => Math.ceil(ctx.measureText(line).width)),
  );
  const bubbleWidth = Math.max(92, textWidth + 12);
  const bubbleHeight = 6 + lines.length * 9;
  const x = clamp(
    rect.x + rect.width + 8,
    BUBBLE_EDGE_MARGIN_PX,
    canvas.width - bubbleWidth - BUBBLE_EDGE_MARGIN_PX,
  );
  const y = clamp(
    rect.y,
    BUBBLE_EDGE_MARGIN_PX,
    canvas.height - bubbleHeight - BUBBLE_EDGE_MARGIN_PX,
  );

  const palette =
    bossMonitorState.mode === "idle"
      ? {
          fill: "#e9f5ff",
          line: "#73a9cf",
          text: "#20364a",
        }
      : bossMonitorState.mode === "dispatching"
        ? {
            fill: "#ffe6f0",
            line: "#e4a3bf",
            text: "#4a2738",
          }
        : {
            fill: "#fff5e9",
            line: "#d7b184",
            text: "#4d3720",
          };

  ctx.fillStyle = palette.fill;
  ctx.fillRect(x, y, bubbleWidth, bubbleHeight);
  ctx.fillStyle = palette.line;
  ctx.fillRect(x, y, bubbleWidth, 1);
  ctx.fillRect(x, y + bubbleHeight - 1, bubbleWidth, 1);
  ctx.fillRect(x, y, 1, bubbleHeight);
  ctx.fillRect(x + bubbleWidth - 1, y, 1, bubbleHeight);
  ctx.fillRect(x - 3, y + 10, 3, 2);
  ctx.fillRect(x - 5, y + 11, 2, 1);

  ctx.fillStyle = palette.text;
  for (let index = 0; index < lines.length; index += 1) {
    ctx.fillText(lines[index], x + 5, y + 8 + index * 9);
  }
}

function drawAmbientWallPanel(
  x: number,
  y: number,
  width: number,
  height: number,
  pulse: number,
) {
  ctx.fillStyle = "#123150";
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = "#5b7999";
  ctx.fillRect(x + 1, y + 1, width - 2, height - 2);
  ctx.fillStyle = "#0f253f";
  ctx.fillRect(x + 2, y + 2, width - 4, height - 4);

  const glow = 154 + Math.floor(66 * Math.sin(pulse));
  ctx.fillStyle = `rgb(${Math.max(60, glow - 44)}, ${Math.min(
    255,
    glow + 36,
  )}, 255)`;
  ctx.fillRect(x + 3, y + 3, width - 6, height - 6);

  const sweep = ((Math.floor(pulse * 38) + x + y) % (width - 4)) + 2;
  ctx.fillStyle = "rgba(235, 251, 255, 0.44)";
  ctx.fillRect(x + sweep, y + 3, 1, height - 6);
}

function drawRoomBackground(nowMs: number): boolean {
  if (!roomBackgroundImage) {
    return false;
  }

  const imageWidth = roomBackgroundImage.naturalWidth || roomBackgroundImage.width;
  const imageHeight =
    roomBackgroundImage.naturalHeight || roomBackgroundImage.height;
  if (imageWidth <= 0 || imageHeight <= 0) {
    return false;
  }

  const targetAspect = canvas.width / canvas.height;
  const sourceAspect = imageWidth / imageHeight;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = imageWidth;
  let sourceHeight = imageHeight;

  if (sourceAspect > targetAspect) {
    sourceWidth = imageHeight * targetAspect;
    sourceX = Math.floor((imageWidth - sourceWidth) / 2);
  } else {
    sourceHeight = imageWidth / targetAspect;
    const verticalBias = 0.47;
    sourceY = Math.floor((imageHeight - sourceHeight) * verticalBias);
  }

  ctx.save();
  ctx.globalAlpha = ROOM_BACKGROUND_ALPHA;
  ctx.drawImage(
    roomBackgroundImage,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  ctx.restore();

  if (ROOM_BACKGROUND_OVERLAY_BASE_ALPHA > 0) {
    const glow =
      ROOM_BACKGROUND_OVERLAY_BASE_ALPHA + Math.sin(nowMs * 0.0019) * 0.02;
    ctx.fillStyle = `rgba(10, 18, 31, ${glow.toFixed(3)})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return true;
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
  nowMs: number,
  activity?: WorkstationActivity,
) {
  const x = station.deskX;
  const y = station.deskY;
  const backgroundScene = Boolean(roomBackgroundImage);
  const screenRect = getWorkstationScreenRect(station);
  const occupied = Boolean(activity && activity.occupied > 0);
  const hasError = Boolean(activity && activity.error > 0);
  const hasWorking = Boolean(activity && activity.working > 0);
  const hasCompleted = Boolean(activity && activity.completed > 0);

  if (occupied) {
    const glowColor = hasError
      ? "rgba(255, 110, 160, 0.35)"
      : hasWorking
        ? "rgba(110, 240, 255, 0.3)"
        : hasCompleted
          ? "rgba(120, 255, 190, 0.3)"
          : "rgba(210, 230, 255, 0.22)";

    const glowSize = station.facing === "north" ? 46 : 18;
    ctx.fillStyle = glowColor;
    if (station.facing === "north") {
      ctx.fillRect(x - 2, y - 14, glowSize, 18);
    } else if (station.facing === "east") {
      ctx.fillRect(x + 2, y - 2, 16, 34);
    } else {
      ctx.fillRect(x - 6, y - 2, 16, 34);
    }
  }

  if (!backgroundScene) {
    if (station.facing === "north") {
      ctx.fillStyle = stationRoleDeskColor(station.role);
      ctx.fillRect(x, y, 42, 11);
      ctx.fillStyle = "#a2b7cd";
      ctx.fillRect(x + 2, y + 11, 38, 2);
      ctx.fillStyle = "#7f93ab";
      ctx.fillRect(x + 5, y + 4, 7, 3);
      ctx.fillRect(x + 29, y + 4, 7, 3);
      ctx.fillStyle = "#44597a";
      ctx.fillRect(x + 13, y - 1, 16, 1);
    } else {
      ctx.fillStyle = stationRoleDeskColor(station.role);
      ctx.fillRect(x, y, 12, 34);
      ctx.fillStyle = "#a6bacf";
      ctx.fillRect(x + 1, y + 2, 10, 29);
      ctx.fillStyle = "#304865";
      ctx.fillRect(x + 2, y + 3, 8, 8);
      ctx.fillStyle = "#889eb8";
      ctx.fillRect(x + 2, y + 13, 8, 2);
      ctx.fillRect(x + 2, y + 17, 8, 2);
      ctx.fillRect(x + 2, y + 21, 8, 2);
    }
  }

  if (occupied) {
    const ringColor =
      activity && activity.error > 0
        ? "#ff86be"
        : activity && activity.working > 0
          ? "#8cf6ff"
          : "#b7ffc9";
    ctx.strokeStyle = ringColor;
    ctx.strokeRect(
      screenRect.x - 2,
      screenRect.y - 2,
      screenRect.width + 4,
      screenRect.height + 4,
    );
  }

  drawWorkstationScreen(station, nowMs, pulse, activity);

  if (backgroundScene) {
    ctx.fillStyle = occupied ? "rgba(176, 244, 255, 0.85)" : "rgba(104, 136, 168, 0.8)";
    ctx.fillRect(station.x - 2, station.y + 7, 4, 3);
  } else {
    ctx.fillStyle = "#2f3b4f";
    ctx.fillRect(station.x - 3, station.y + 7, 6, 4);
    ctx.fillStyle = "#55667f";
    ctx.fillRect(station.x - 2, station.y + 6, 4, 1);
  }

  ctx.font = "6px monospace";
  ctx.fillStyle = occupied
    ? backgroundScene
      ? "#e6f6ff"
      : "#dff8ff"
    : backgroundScene
      ? "#b9cade"
      : "#9fb2c7";
  ctx.fillText(
    `${stationRoleCode(station.role)}${station.id.slice(-1)}`,
    backgroundScene ? screenRect.x : x + 15,
    backgroundScene ? screenRect.y - 4 : y + 20,
  );
}

function drawScene(nowMs: number) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const activityByStation = collectWorkstationActivity();

  // Trigger idle overlays/extra idle events
  maybeTriggerIdleOverlay(nowMs);

  const hasBitmapBackground = drawRoomBackground(nowMs);
  if (hasBitmapBackground) {
    const activePulse = 0.18 + Math.sin(nowMs * 0.0028) * 0.08;
    ctx.fillStyle = `rgba(136, 237, 255, ${activePulse.toFixed(3)})`;
    for (const spot of IDLE_SPOTS) {
      ctx.fillRect(spot.x - 2, spot.y + 8, 4, 2);
    }

    const plantPulse = 0.22 + Math.sin(nowMs * 0.0042) * 0.06;
    ctx.fillStyle = `rgba(120, 255, 196, ${plantPulse.toFixed(3)})`;
    ctx.fillRect(PLANT_CARE_SPOT.x - 2, PLANT_CARE_SPOT.y + 7, 4, 2);

    ctx.fillStyle = "rgba(255, 213, 236, 0.26)";
    ctx.fillRect(BED_SPOT.x - 9, BED_SPOT.y + 7, 18, 2);

    WORKSTATIONS.forEach((station, index) => {
      drawWorkstation(
        station,
        nowMs * 0.004 + index * 1.7,
        nowMs,
        activityByStation.get(station.id),
      );
    });

    drawBossMonitor(nowMs);

    ctx.font = "bold 8px monospace";
    ctx.fillStyle = "#9fefff";
    ctx.fillText("RESEARCH", roomX(73), roomY(33));
    ctx.fillStyle = "#ffe7af";
    ctx.fillText("ENGINEERING", roomX(178), roomY(33));
    ctx.fillStyle = "#f8b5de";
    ctx.fillText("QA", roomX(43), roomY(67));
    ctx.fillStyle = "#c8f2ff";
    ctx.fillText("IDLE", roomX(146), roomY(98));
    ctx.fillStyle = "#f0d7e8";
    ctx.fillText("LOUNGE", roomX(60), roomY(125));
    return;
  }

  const shellPoly: ReadonlyArray<Spot> = [
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
  ctx.moveTo(shellPoly[0].x, shellPoly[0].y);
  for (let i = 1; i < shellPoly.length; i += 1) {
    ctx.lineTo(shellPoly[i].x, shellPoly[i].y);
  }
  ctx.closePath();
  ctx.fillStyle = "#b8cadb";
  ctx.fill();
  ctx.strokeStyle = "#e7f3ff";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(42, 18);
  ctx.lineTo(278, 18);
  ctx.lineTo(298, 38);
  ctx.lineTo(298, 142);
  ctx.lineTo(278, 162);
  ctx.lineTo(42, 162);
  ctx.lineTo(22, 142);
  ctx.lineTo(22, 38);
  ctx.closePath();
  ctx.fillStyle = "#0f3153";
  ctx.fill();

  ctx.fillStyle = "#1d466d";
  ctx.fillRect(36, 40, 248, 118);
  ctx.fillStyle = "#d8e3eb";
  ctx.fillRect(146, 40, 28, 118);
  ctx.fillStyle = "#afc1d0";
  ctx.fillRect(150, 40, 20, 118);

  ctx.fillStyle = "#b6c7d4";
  ctx.fillRect(136, 17, 48, 34);
  ctx.fillStyle = "#6d8ba8";
  ctx.fillRect(141, 24, 38, 27);
  ctx.fillStyle = "#edf7ff";
  ctx.fillRect(146, 29, 28, 18);
  ctx.fillStyle = "#8fdfff";
  ctx.fillRect(151, 20, 18, 3);

  ctx.fillStyle = "#4f6f8f";
  ctx.fillRect(34, 40, 252, 2);
  ctx.fillRect(34, 156, 252, 2);

  for (let x = 34; x <= 286; x += 18) {
    ctx.strokeStyle = "rgba(166, 201, 228, 0.44)";
    ctx.beginPath();
    ctx.moveTo(x, 40);
    ctx.lineTo(x, 158);
    ctx.stroke();
  }
  for (let y = 40; y <= 158; y += 18) {
    ctx.strokeStyle = "rgba(166, 201, 228, 0.44)";
    ctx.beginPath();
    ctx.moveTo(34, y);
    ctx.lineTo(286, y);
    ctx.stroke();
  }

  const pulseA = 0.5 + Math.sin(nowMs * 0.0022) * 0.24;
  const pulseB = 0.46 + Math.cos(nowMs * 0.0024) * 0.25;
  ctx.fillStyle = `rgba(110, 234, 255, ${pulseA.toFixed(2)})`;
  ctx.fillRect(49, 24, 94, 3);
  ctx.fillRect(177, 24, 94, 3);
  ctx.fillStyle = `rgba(110, 234, 255, ${pulseB.toFixed(2)})`;
  ctx.fillRect(50, 154, 93, 3);
  ctx.fillRect(177, 154, 93, 3);

  drawAmbientWallPanel(22, 30, 14, 17, nowMs * 0.0041);
  drawAmbientWallPanel(284, 30, 14, 17, nowMs * 0.0044);
  drawAmbientWallPanel(27, 78, 10, 22, nowMs * 0.0047);
  drawAmbientWallPanel(283, 78, 10, 22, nowMs * 0.0049);
  drawAmbientWallPanel(43, 147, 56, 10, nowMs * 0.0043);
  drawAmbientWallPanel(221, 147, 56, 10, nowMs * 0.0039);

  ctx.fillStyle = "#dae4ed";
  ctx.fillRect(58, 131, 56, 21);
  ctx.fillStyle = "#f5fafe";
  ctx.fillRect(62, 135, 48, 9);
  ctx.fillStyle = "#95a8bb";
  ctx.fillRect(60, 145, 52, 3);
  ctx.fillStyle = "#f7fdff";
  ctx.fillRect(58, 134, 6, 7);
  ctx.fillRect(108, 134, 6, 7);

  ctx.fillStyle = "#5a7796";
  ctx.fillRect(154, 145, 12, 20);
  ctx.fillStyle = "#9fb4c9";
  ctx.fillRect(156, 147, 8, 16);
  ctx.fillStyle = "#77dfff";
  ctx.fillRect(157, 149, 6, 4);

  WORKSTATIONS.forEach((station, index) => {
    drawWorkstation(
      station,
      nowMs * 0.004 + index * 1.7,
      nowMs,
      activityByStation.get(station.id),
    );
  });

  drawBossMonitor(nowMs);

  ctx.font = "bold 8px monospace";
  ctx.fillStyle = "#9fefff";
  ctx.fillText("RESEARCH", 62, 33);
  ctx.fillStyle = "#ffe7af";
  ctx.fillText("ENGINEERING", 182, 33);
  ctx.fillStyle = "#f8b5de";
  ctx.fillText("QA", 45, 73);
  ctx.fillStyle = "#c8f2ff";
  ctx.fillText("IDLE", 145, 96);
  ctx.fillStyle = "#f0d7e8";
  ctx.fillText("LOUNGE", 63, 127);
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
  if (isSleepSettled(agent)) {
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

function drawMangaSpeedLines(
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  seed: number,
) {
  for (let i = 0; i < 5; i += 1) {
    const wave = Math.sin(seed * 0.01 + i * 0.9);
    const lineX = x - 5 + i * 5 + Math.round(wave * 2);
    const lineY = y - 4 + i * 3;
    const lineHeight = Math.max(3, Math.floor(height * 0.3));
    drawPixelRect(lineX, lineY, 1, lineHeight, color);
    drawPixelRect(lineX + width + 2, lineY + 1, 1, lineHeight - 1, color);
  }
}

function drawMangaSpark(x: number, y: number, color: string) {
  drawPixelRect(x, y, 1, 1, color);
  drawPixelRect(x - 1, y, 3, 1, color);
  drawPixelRect(x, y - 1, 1, 3, color);
}

function drawPlantWateringEffect(
  agent: AgentVisualState,
  x: number,
  y: number,
  nowMs: number,
) {
  const canX = x + 17;
  const canY = y + 15 + Math.round(Math.sin(nowMs * 0.017 + agent.bob) * 1.2);
  drawPixelRect(canX - 1, canY, 5, 3, "#425369");
  drawPixelRect(canX, canY + 1, 3, 1, "#8ca7c6");
  drawPixelRect(canX + 4, canY + 1, 2, 1, "#425369");
  drawPixelRect(canX + 1, canY - 1, 2, 1, "#425369");

  const flowStep = Math.floor(nowMs / 120) % 5;
  for (let i = 0; i < 5; i += 1) {
    const progress = (i + flowStep * 0.35) / 4.6;
    const dripX = Math.round(
      canX + 4 + (PLANT_WATER_TARGET.x - (canX + 4)) * progress,
    );
    const dripY = Math.round(
      canY + 2 + (PLANT_WATER_TARGET.y - (canY + 2)) * progress,
    );
    drawPixelRect(dripX, dripY, 1, 2, "#97edff");
  }

  const leafPulse = Math.sin(nowMs * 0.013 + agent.bob) > 0 ? "#9ff7c5" : "#7fe2b3";
  drawPixelRect(PLANT_WATER_TARGET.x - 1, PLANT_WATER_TARGET.y - 1, 3, 2, leafPulse);
}

function drawSleepingCharacter(
  agent: AgentVisualState,
  x: number,
  y: number,
  nowMs: number,
) {
  const palette = AGENT_MANGA_PALETTES[agent.id];
  const bodyColor = resolveAgentBodyColor(agent, palette);
  const drift = Math.sin(nowMs * 0.008 + agent.bob) * 0.6;
  const drawX = Math.floor(x - 11);
  const drawY = Math.floor(y + 7 + drift);

  drawPixelRect(drawX + 2, drawY + 18, 24, 2, "rgba(90, 104, 130, 0.24)");

  drawPixelRect(drawX + 1, drawY + 8, 8, 7, "#f5fbff");
  drawPixelRect(drawX + 2, drawY + 9, 6, 5, "#ffffff");
  drawPixelRect(drawX + 1, drawY + 14, 7, 1, "#d7e2ef");

  drawPixelRect(drawX + 7, drawY + 6, 16, 9, palette.outline);
  drawPixelRect(drawX + 8, drawY + 7, 14, 7, bodyColor);
  drawPixelRect(drawX + 11, drawY + 8, 10, 5, palette.coat);
  drawPixelRect(drawX + 20, drawY + 7, 4, 6, palette.coatShade);
  drawPixelRect(drawX + 12, drawY + 9, 3, 2, palette.accent);

  drawPixelRect(drawX + 4, drawY + 5, 8, 8, palette.outline);
  drawPixelRect(drawX + 5, drawY + 6, 6, 6, palette.skin);
  drawPixelRect(drawX + 4, drawY + 3, 8, 4, palette.hair);
  drawPixelRect(drawX + 5, drawY + 5, 6, 2, palette.hairShade);

  drawPixelRect(drawX + 7, drawY + 9, 2, 1, palette.outline);
  drawPixelRect(drawX + 9, drawY + 9, 1, 1, palette.outline);
  drawPixelRect(drawX + 7, drawY + 10, 3, 1, "#e5acb9");

  drawPixelRect(drawX + 22, drawY + 8, 3, 4, palette.outline);
  drawPixelRect(drawX + 23, drawY + 9, 2, 2, palette.accent);

  if (agent.id === "scout") {
    drawPixelRect(drawX + 2, drawY + 12, 2, 3, palette.outline);
    drawPixelRect(drawX + 3, drawY + 13, 1, 1, palette.visor);
  } else if (agent.id === "builder") {
    drawPixelRect(drawX + 23, drawY + 12, 4, 2, palette.accent);
    drawPixelRect(drawX + 24, drawY + 11, 2, 1, palette.effect);
  } else {
    drawPixelRect(drawX + 22, drawY + 13, 4, 3, palette.outline);
    drawPixelRect(drawX + 23, drawY + 14, 2, 1, palette.effect);
  }

  ctx.font = "7px monospace";
  ctx.fillStyle = "#f2f7ff";
  ctx.fillText("z", drawX + 24, drawY + 3);
  ctx.fillText("z", drawX + 27, drawY + 0);
}

function resolveWorkAnimationMode(
  agent: AgentVisualState,
): WorkAnimationMode | undefined {
  if (!isActiveStatus(agent.status) || agent.zone !== "work") {
    return undefined;
  }

  if (agent.status === "error" || agent.phase === "error") {
    return "error";
  }
  if (agent.status === "completed" || agent.phase === "done") {
    return "completed";
  }

  const text = `${agent.task} ${agent.lastEventType}`.toLowerCase();
  if (
    agent.phase === "analyzing" ||
    agent.phase === "responding" ||
    /reason|analy|scan|read|review|prompt|chat|context|diff|status/.test(text)
  ) {
    return "thinking";
  }
  if (/lint|test|check|audit|validate|qa/.test(text)) {
    return "reviewing";
  }
  return "typing";
}

function drawWorkFocusEffect(
  agent: AgentVisualState,
  x: number,
  y: number,
  nowMs: number,
  mode: WorkAnimationMode,
) {
  const phasePulse = Math.sin(nowMs * 0.018 + agent.bob);

  if (mode === "thinking") {
    drawPixelRect(x + 18, y + 3, 2, 2, "#f2fbff");
    drawPixelRect(x + 21, y + 1, 1, 1, "#9fefff");
    drawPixelRect(x + 23, y + 4, 1, 1, "#9fefff");
    if (phasePulse > 0) {
      drawPixelRect(x + 20, y - 2, 2, 1, "#c7f6ff");
      drawPixelRect(x + 23, y - 1, 1, 1, "#c7f6ff");
    }
    return;
  }

  if (mode === "typing") {
    const tap = Math.sin(nowMs * 0.04 + agent.bob) > 0 ? 1 : 0;
    drawPixelRect(x + 2, y + 23 + tap, 3, 1, "#b7f6ff");
    drawPixelRect(x + 15, y + 23 - tap, 3, 1, "#b7f6ff");
    drawPixelRect(x + 18, y + 16, 2, 1, "#ffe2f1");
    return;
  }

  if (mode === "reviewing") {
    drawPixelRect(x + 18, y + 15, 3, 1, "#fff1b7");
    drawPixelRect(x + 19, y + 13, 1, 3, "#fff1b7");
    return;
  }

  if (mode === "completed") {
    drawPixelRect(x + 18, y + 6, 2, 2, "#e8fff2");
    drawPixelRect(x + 20, y + 4, 1, 1, "#e8fff2");
    return;
  }

  drawPixelRect(x + 18, y + 14, 3, 1, "#ff8bc0");
  drawPixelRect(x + 19, y + 12, 1, 3, "#ff8bc0");
}

function drawSpriteCharacter(
  agent: AgentVisualState,
  x: number,
  y: number,
  step: number,
  nowMs: number,
  routineDance: boolean,
  routineSleep: boolean,
  routinePause: boolean,
  settledWork: boolean,
  settledSleep: boolean,
  workMode?: WorkAnimationMode,
) {
  if (settledSleep) {
    drawSleepingCharacter(agent, x, y, nowMs);
    drawMangaBadge(agent, x + 4, y + 8);
    return;
  }

  const palette = AGENT_MANGA_PALETTES[agent.id];
  const bodyColor = resolveAgentBodyColor(agent, palette);
  const variant =
    (Math.floor(nowMs / 1500) + agent.id.length + Math.abs(agent.lane)) % 3;
  const thinkingAtDesk = settledWork && workMode === "thinking";
  const typingAtDesk = settledWork && workMode === "typing";
  const reviewingAtDesk = settledWork && workMode === "reviewing";
  const eyeClosed =
    routineSleep || Math.sin(nowMs * 0.022 + agent.bob * 5.8) > 0.93;
  const danceLift = routineDance ? Math.sin(nowMs * 0.03 + agent.bob) * 3.2 : 0;
  const workBob = settledWork
    ? Math.sin(nowMs * (typingAtDesk ? 0.018 : 0.011) + agent.bob) *
      (typingAtDesk ? 0.9 : 0.55)
    : 0;
  const torsoSway = settledWork
    ? workBob
    : Math.sin(nowMs * 0.009 + agent.bob) * 1.2 + danceLift * 0.35;
  const stride = routineSleep
    ? 0
    : settledWork
      ? 0
    : routineDance
      ? Math.sin(nowMs * 0.03 + agent.bob) > 0
        ? 2
        : -2
      : step * 2;
  const actionLean =
    settledWork ? 0 : agent.status === "working" ? Math.sign(agent.vx || 1) : 0;

  const drawX = Math.floor(x - 2 + actionLean + stride * 0.2);
  const drawY = Math.floor(y - 7 + torsoSway + (routinePause ? 1 : 0));

  drawPixelRect(drawX + 3, drawY + 36, 14, 2, "rgba(90, 104, 130, 0.34)");

  if (agent.status === "working" && !settledWork) {
    drawMangaSpeedLines(
      drawX,
      drawY + 6,
      18,
      24,
      "rgba(167, 237, 255, 0.44)",
      nowMs + agent.bob * 37,
    );
  }

  if (routineDance) {
    drawMangaSpeedLines(
      drawX + 1,
      drawY + 2,
      16,
      18,
      "rgba(255, 168, 216, 0.4)",
      nowMs + 400 + agent.bob * 29,
    );
  }

  const coatWave = settledWork
    ? Math.round(Math.sin(nowMs * 0.013 + agent.bob) * 1.1)
    : Math.round(Math.sin(nowMs * 0.015 + agent.bob) * 1.8);
  const armLift =
    settledWork
      ? thinkingAtDesk
        ? -2
        : typingAtDesk
          ? Math.round(Math.sin(nowMs * 0.05 + agent.bob) * 2)
          : reviewingAtDesk
            ? 1
            : 0
      : routineDance || agent.status === "working"
        ? Math.round(Math.sin(nowMs * 0.024 + agent.bob) * 2)
      : 0;

  drawPixelRect(drawX + 5, drawY + 22 + stride, 3, 9, palette.outline);
  drawPixelRect(drawX + 11, drawY + 22 - stride, 3, 9, palette.outline);
  drawPixelRect(drawX + 6, drawY + 23 + stride, 1, 7, palette.coat);
  drawPixelRect(drawX + 12, drawY + 23 - stride, 1, 7, palette.coat);

  drawPixelRect(drawX + 4, drawY + 31 + stride, 5, 2, palette.outline);
  drawPixelRect(drawX + 10, drawY + 31 - stride, 5, 2, palette.outline);
  drawPixelRect(drawX + 5, drawY + 31 + stride, 3, 1, palette.accent);
  drawPixelRect(drawX + 11, drawY + 31 - stride, 3, 1, palette.accent);

  drawPixelRect(drawX + 3, drawY + 14 + armLift, 3, 9, palette.outline);
  drawPixelRect(drawX + 14, drawY + 14 - armLift, 3, 9, palette.outline);
  drawPixelRect(drawX + 4, drawY + 15 + armLift, 1, 7, palette.coat);
  drawPixelRect(drawX + 15, drawY + 15 - armLift, 1, 7, palette.coat);

  drawPixelRect(drawX + 5, drawY + 12, 10, 12, palette.outline);
  drawPixelRect(drawX + 6, drawY + 13, 8, 10, bodyColor);
  drawPixelRect(drawX + 6, drawY + 18, 8, 5, palette.coat);
  drawPixelRect(drawX + 7, drawY + 14, 6, 2, palette.coatShade);
  drawPixelRect(drawX + 8, drawY + 17, 4, 1, palette.accent);

  drawPixelRect(drawX + 4 + coatWave, drawY + 22, 4, 8, palette.coatShade);
  drawPixelRect(drawX + 12 + coatWave, drawY + 22, 4, 8, palette.coatShade);
  drawPixelRect(drawX + 5 + coatWave, drawY + 25, 3, 4, palette.coat);
  drawPixelRect(drawX + 12 + coatWave, drawY + 25, 3, 4, palette.coat);

  drawPixelRect(drawX + 8, drawY + 10, 4, 2, palette.skin);

  const headY = drawY + (routineSleep ? 2 : thinkingAtDesk ? 1 : 0);
  drawPixelRect(drawX + 4, headY + 1, 12, 12, palette.outline);
  drawPixelRect(drawX + 5, headY + 2, 10, 10, palette.skin);
  drawPixelRect(drawX + 4, headY - 2, 12, 5, palette.hair);
  drawPixelRect(drawX + 5, headY, 10, 3, palette.hairShade);
  drawPixelRect(drawX + 8, headY - 1, 4, 1, "#ffe8f5");

  if (agent.id === "scout") {
    drawPixelRect(drawX + 3, headY + 1, 2, 6, palette.hair);
    drawPixelRect(drawX + 13, headY + 2, 2, 6, palette.hairShade);
    if (variant === 1) {
      drawPixelRect(drawX + 2, headY - 1, 2, 2, palette.hair);
    }
    if (variant === 2) {
      drawPixelRect(drawX + 12, headY - 1, 3, 2, palette.hairShade);
    }
  } else if (agent.id === "builder") {
    drawPixelRect(drawX + 5, headY + 1, 7, 2, palette.hair);
    drawPixelRect(drawX + 11, headY + 1, 3, 7, palette.hairShade);
    drawPixelRect(drawX + 12, headY + 8, 1, 1, palette.hair);
    if (variant === 1) {
      drawPixelRect(drawX + 4, headY - 1, 3, 2, palette.hair);
    }
    if (variant === 2) {
      drawPixelRect(drawX + 7, headY - 2, 3, 1, palette.hairShade);
    }
  } else {
    drawPixelRect(drawX + 5, headY + 2, 2, 7, palette.hair);
    drawPixelRect(drawX + 13, headY + 2, 2, 7, palette.hair);
    drawPixelRect(drawX + 5, headY + 8, 2, 4, palette.hairShade);
    drawPixelRect(drawX + 13, headY + 8, 2, 4, palette.hairShade);
    if (variant === 1) {
      drawPixelRect(drawX + 8, headY - 2, 4, 1, palette.hair);
    }
    if (variant === 2) {
      drawPixelRect(drawX + 9, headY - 1, 3, 1, palette.hairShade);
    }
  }

  if (eyeClosed) {
    drawPixelRect(drawX + 8, headY + 6, 2, 1, palette.outline);
    drawPixelRect(drawX + 11, headY + 6, 2, 1, palette.outline);
  } else {
    drawPixelRect(drawX + 8, headY + 5, 2, 2, palette.visor);
    drawPixelRect(drawX + 11, headY + 5, 2, 2, palette.visor);
    drawPixelRect(drawX + 8, headY + 4, 1, 1, "#f8fdff");
    drawPixelRect(drawX + 11, headY + 4, 1, 1, "#f8fdff");
  }

  drawPixelRect(drawX + 9, headY + 8, 3, 1, "#e5acb9");
  drawPixelRect(drawX + 9, headY + 9, 2, 1, palette.outline);

  if (agent.id === "scout") {
    const scannerPulse = Math.sin(nowMs * 0.02 + agent.bob) > 0 ? palette.visor : palette.effect;
    drawPixelRect(drawX + 16, drawY + 18 + armLift, 3, 4, palette.outline);
    drawPixelRect(drawX + 17, drawY + 19 + armLift, 1, 2, scannerPulse);
  } else if (agent.id === "builder") {
    const swing = agent.status === "working" ? Math.round(Math.sin(nowMs * 0.03 + agent.bob) * 2) : 0;
    drawPixelRect(drawX + 1, drawY + 18 - swing, 2, 8, palette.outline);
    drawPixelRect(drawX - 1, drawY + 16 - swing, 6, 3, palette.accent);
    drawPixelRect(drawX, drawY + 17 - swing, 4, 1, palette.effect);
  } else {
    const panelGlow = Math.sin(nowMs * 0.018 + agent.bob) > 0 ? palette.effect : palette.visor;
    drawPixelRect(drawX + 1, drawY + 18, 5, 6, palette.outline);
    drawPixelRect(drawX + 2, drawY + 19, 3, 4, panelGlow);
    drawPixelRect(drawX + 2, drawY + 20, 2, 1, "#f6feff");
  }

  if (agent.zone === "work" && agent.status === "working") {
    const pulse = Math.sin(nowMs * 0.018 + agent.bob) > 0 ? palette.effect : palette.accent;
    drawPixelRect(drawX + 5, drawY + 11, 10, 1, pulse);
    drawPixelRect(drawX + 4, drawY + 12, 1, 12, "rgba(128, 236, 255, 0.24)");
    drawPixelRect(drawX + 15, drawY + 12, 1, 12, "rgba(255, 138, 205, 0.22)");
  }

  if (settledWork && workMode) {
    drawWorkFocusEffect(agent, drawX, drawY, nowMs, workMode);
  }

  if (agent.status === "completed") {
    drawMangaSpark(drawX + 2, drawY + 4, "#e7fff3");
    drawMangaSpark(drawX + 17, drawY + 9, "#e7fff3");
  }

  if (agent.status === "error") {
    drawPixelRect(drawX + 1, drawY + 17, 3, 1, "#ff7cb6");
    drawPixelRect(drawX + 16, drawY + 13, 3, 1, "#ff7cb6");
    drawPixelRect(drawX + 15, drawY + 14, 1, 3, "#ff7cb6");
  }

  if (routineSleep) {
    ctx.font = "7px monospace";
    ctx.fillStyle = "#f2f7ff";
    ctx.fillText("z", drawX + 19, drawY + 6);
    ctx.fillText("z", drawX + 21, drawY + 3);
  }

  if (routinePause) {
    drawPixelRect(drawX + 16, headY + 4, 1, 2, "#dbe8f8");
    drawPixelRect(drawX + 17, headY + 6, 1, 1, "#dbe8f8");
  }

  drawMangaBadge(agent, drawX + 6, drawY + 2);
}

function drawAgentBlock(agent: AgentVisualState, nowMs: number) {
  const routineDance = agent.status === "idle" && agent.routine === "dance";
  const sleepRequested = agent.status === "idle" && agent.routine === "sleep";
  const routinePause = agent.status === "idle" && agent.routine === "pause";
  const workMode = resolveWorkAnimationMode(agent);
  const settledSleep = isSleepSettled(agent);
  const settledPlantWatering = isPlantWateringSettled(agent);
  const routineSleep = sleepRequested && settledSleep;
  const settledWork =
    Boolean(workMode) &&
    distanceToTarget(agent) < 4.2;

  // Idle-animatie: snelheid en amplitude per agent
  const idleSpeed = AGENT_PERSONALITIES[agent.id].driftFreq;
  const idleAmp = AGENT_PERSONALITIES[agent.id].driftAmp;
  const danceBoost = routineDance
    ? Math.sin(nowMs * 0.02 + agent.bob) * 1.8
    : 0;
  const overlay = agentIdleOverlays[agent.id];
  // Speciale idle-actie: zwaaien of telefoon
  let extraWobble = 0;
  let waving = false;
  let phone = false;
  let wateringPlant = false;
  if (overlay && overlay.action === "wave") {
    waving = true;
    extraWobble = Math.sin(nowMs * 0.08 + agent.bob) * 2.5;
  }
  if (overlay && overlay.action === "phone") {
    phone = true;
    extraWobble = Math.sin(nowMs * 0.03 + agent.bob) * 1.2;
  }
  if (overlay && overlay.action === "water-plant") {
    wateringPlant = settledPlantWatering;
    if (settledPlantWatering) {
      extraWobble = Math.sin(nowMs * 0.025 + agent.bob) * 1.1;
    }
  }
  const workWobble = settledWork
    ? Math.sin(nowMs * 0.009 + agent.bob) * 0.35
    : 0;
  const wobble =
    Math.sin(nowMs * idleSpeed + agent.bob) * (1.5 + idleAmp * 8) +
    danceBoost +
    extraWobble +
    workWobble;
  const x = Math.floor(agent.x);
  const y = Math.floor(agent.y + wobble - 16);
  const paused =
    nowMs < agent.pauseUntilMs ||
    routinePause ||
    settledSleep ||
    settledPlantWatering;
  const cadence =
    agent.id === "builder" ? 16 : agent.id === "reviewer" ? 20 : 18;
  let step =
    paused || settledWork ? 0 : agent.frame % cadence < cadence / 2 ? 0 : 1;
  if (routineDance) {
    step = Math.sin(nowMs * 0.03 + agent.bob) > 0 ? 1 : -1;
  }

  drawSpriteCharacter(
    agent,
    x,
    y,
    step,
    nowMs,
    routineDance,
    routineSleep,
    routinePause,
    settledWork,
    settledSleep,
    workMode,
  );

  if (wateringPlant) {
    drawPlantWateringEffect(agent, x, y, nowMs);
  }

  // Overlay-icoon boven hoofd
  if (overlay) {
    ctx.font = "20px serif";
    ctx.textAlign = "center";
    ctx.globalAlpha = 0.92;
    ctx.fillText(overlay.icon, x + 10, y - 18);
    ctx.globalAlpha = 1.0;
    ctx.textAlign = "start";
  }

  if (agent.lastEventType === "codex.reasoning" && agent.status === "working") {
    ctx.font = "10px monospace";
    ctx.fillStyle = "#eff8ff";
    ctx.fillText("...?", x + 16, y - 12);
  }

  // Extra visuele idle-actie: zwaaien of telefoon
  if (waving) {
    ctx.font = "12px monospace";
    ctx.fillStyle = "#ffb6e6";
    ctx.fillText("zwaai!", x + 18, y - 8);
  }
  if (phone) {
    ctx.font = "11px monospace";
    ctx.fillStyle = "#b6e6ff";
    ctx.fillText("scroll...", x + 18, y - 8);
  }
  if (wateringPlant) {
    ctx.font = "11px monospace";
    ctx.fillStyle = "#9ff7c5";
    ctx.fillText("plant!", x + 18, y - 8);
  }
}

function drawOfficeCatSpeech(nowMs: number, baseX: number, baseY: number) {
  if (!officeCat.meowText || nowMs > officeCat.meowVisibleUntilMs) {
    return;
  }

  ctx.font = "7px monospace";
  const text = shorten(officeCat.meowText, 20);
  const width = Math.max(28, Math.ceil(ctx.measureText(text).width) + 10);
  const height = 12;
  const x = clamp(
    Math.floor(baseX - width / 2),
    BUBBLE_EDGE_MARGIN_PX,
    canvas.width - width - BUBBLE_EDGE_MARGIN_PX,
  );
  const y = clamp(
    baseY - 18,
    BUBBLE_EDGE_MARGIN_PX,
    canvas.height - height - BUBBLE_EDGE_MARGIN_PX,
  );
  const tailX = clamp(baseX, x + 3, x + width - 4);

  ctx.fillStyle = "#fbfcff";
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = "#2f3650";
  ctx.fillRect(x, y, width, 1);
  ctx.fillRect(x, y + height - 1, width, 1);
  ctx.fillRect(x, y, 1, height);
  ctx.fillRect(x + width - 1, y, 1, height);
  ctx.fillRect(tailX - 1, y + height, 3, 2);
  ctx.fillRect(tailX, y + height + 2, 1, 2);
  ctx.fillStyle = "#253048";
  ctx.fillText(text, x + 5, y + 8);
}

function drawOfficeCat(nowMs: number) {
  if (!officeCat.active) {
    return;
  }

  const personality = getOfficeCatPersonality();
  const catWidth = 22;
  const motionBob =
    officeCat.action === "nap"
      ? Math.sin(nowMs * 0.006 + officeCat.bob) * 0.45
      : Math.sin(nowMs * 0.012 + officeCat.bob) * 0.9;
  const baseX = Math.floor(officeCat.x) - 11;
  const baseY = Math.floor(officeCat.y - 12 + motionBob);
  const stride = officeCat.frame % 14 < 7 ? 0 : 1;
  const fur =
    officeCat.action === "nap"
      ? personality.furShade
      : personality.fur;
  const furShade = personality.furShade;
  const outline = personality.outline;
  const ear = personality.ear;
  const eye = officeCat.action === "nap" ? outline : personality.eye;
  const nose = personality.nose;
  const speedLineColor = "rgba(214, 241, 255, 0.4)";

  const catRect = (
    dx: number,
    dy: number,
    width: number,
    height: number,
    color: string,
  ) => {
    const drawX =
      officeCat.facing === 1
        ? baseX + dx
        : baseX + (catWidth - (dx + width));
    drawPixelRect(drawX, baseY + dy, width, height, color);
  };

  drawPixelRect(baseX + 4, baseY + 17, 14, 2, personality.shadow);

  if (officeCat.action === "zoom" || officeCat.mode === "entering" || officeCat.mode === "leaving") {
    drawPixelRect(baseX - 4, baseY + 7, 2, 6, speedLineColor);
    drawPixelRect(baseX - 7, baseY + 9, 1, 4, speedLineColor);
    drawPixelRect(baseX + catWidth + 4, baseY + 7, 2, 6, speedLineColor);
  }

  if (officeCat.action === "loaf" || officeCat.action === "nap") {
    catRect(4, 8, 11, 6, outline);
    catRect(5, 9, 9, 4, fur);
    catRect(12, 6, 5, 5, outline);
    catRect(13, 7, 3, 3, fur);
    catRect(12, 5, 2, 2, outline);
    catRect(13, 6, 1, 1, ear);
    catRect(15, 5, 2, 2, outline);
    catRect(15, 6, 1, 1, ear);
    catRect(3, 10, 3, 2, outline);
    catRect(4, 10, 2, 1, furShade);
    catRect(9, 10, 1, 1, furShade);
    if (officeCat.action === "nap") {
      catRect(13, 8, 1, 1, eye);
      catRect(15, 8, 1, 1, eye);
      ctx.font = "7px monospace";
      ctx.fillStyle = "#f3f7ff";
      ctx.fillText("z", baseX + 19, baseY + 4);
    } else {
      catRect(13, 8, 1, 1, outline);
      catRect(15, 8, 1, 1, outline);
    }
    catRect(14, 9, 1, 1, nose);
  } else if (officeCat.action === "sit" || officeCat.action === "groom") {
    catRect(5, 7, 7, 8, outline);
    catRect(6, 8, 5, 6, fur);
    catRect(11, 5, 5, 6, outline);
    catRect(12, 6, 3, 4, fur);
    catRect(11, 4, 2, 2, outline);
    catRect(12, 5, 1, 1, ear);
    catRect(14, 4, 2, 2, outline);
    catRect(14, 5, 1, 1, ear);
    catRect(3, 11, 3, 4, outline);
    catRect(4, 12, 1, 2, furShade);
    catRect(9, 15, 4, 2, outline);
    catRect(10, 15, 2, 1, furShade);
    catRect(12, 8, 1, 1, eye);
    catRect(14, 8, 1, 1, eye);
    catRect(13, 9, 1, 1, nose);
    if (officeCat.action === "groom") {
      catRect(9, 5, 2, 6, outline);
      catRect(9, 6, 1, 4, fur);
      catRect(9, 4, 1, 1, furShade);
      catRect(14, 12, 1, 1, outline);
    }
  } else {
    const legLift = stride === 0 ? 0 : 1;
    const tailLift = officeCat.action === "zoom" ? -2 : -1;
    catRect(5, 8, 9, 5, outline);
    catRect(6, 9, 7, 3, fur);
    catRect(12, 6, 5, 5, outline);
    catRect(13, 7, 3, 3, fur);
    catRect(12, 4, 2, 3, outline);
    catRect(13, 5, 1, 1, ear);
    catRect(15, 4, 2, 3, outline);
    catRect(15, 5, 1, 1, ear);
    catRect(2, 6 + tailLift, 2, 7, outline);
    catRect(3, 7 + tailLift, 1, 5, furShade);
    catRect(6, 12 + legLift, 2, 4, outline);
    catRect(11, 12, 2, 4, outline);
    catRect(7, 13 + legLift, 1, 2, furShade);
    catRect(12, 13, 1, 2, furShade);
    catRect(13, 8, 1, 1, eye);
    catRect(15, 8, 1, 1, eye);
    catRect(14, 9, 1, 1, nose);
  }

  if (officeCat.action === "zoom") {
    catRect(1, 9, 2, 1, furShade);
    catRect(17, 10, 2, 1, furShade);
  }

  if (personality.id === "chaos-goblin") {
    catRect(6, 8, 2, 1, "#fff1c4");
    catRect(9, 10, 2, 1, "#fff1c4");
    catRect(3, 6, 1, 2, "#8d3b1f");
  } else if (personality.id === "senior-office-cat") {
    catRect(11, 10, 4, 1, "#eef3ff");
    catRect(12, 11, 2, 1, "#eef3ff");
    catRect(7, 15, 5, 1, "#6b7286");
  } else if (personality.id === "boss-cat") {
    catRect(10, 5, 5, 1, "#1f2430");
    catRect(11, 6, 3, 2, "#1f2430");
    catRect(14, 8, 2, 2, "#8fd3ff");
    catRect(15, 9, 1, 1, "#f5fbff");
    catRect(4, 6, 2, 1, "#fff7cf");
    catRect(5, 7, 1, 1, "#fff7cf");
  }

  drawOfficeCatSpeech(nowMs, baseX + 11, baseY);
}

function tickOfficeCat(nowMs: number) {
  if (!officeCat.active) {
    if (nowMs >= officeCat.nextSpawnAtMs) {
      spawnOfficeCat(nowMs);
    }
    return;
  }

  if (officeCat.meowVisibleUntilMs > 0 && nowMs > officeCat.meowVisibleUntilMs) {
    clearOfficeCatMeow();
  }

  const dx = officeCat.targetX - officeCat.x;
  const dy = officeCat.targetY - officeCat.y;
  const distance = officeCatDistanceToTarget();

  if (Math.abs(dx) > 0.1) {
    officeCat.facing = dx >= 0 ? 1 : -1;
  }

  const shouldMove =
    officeCat.mode === "entering" ||
    officeCat.mode === "wandering" ||
    officeCat.mode === "leaving" ||
    officeCat.action === "zoom";

  if (shouldMove && distance > 0.25) {
    const step = Math.min(distance, officeCat.speed);
    officeCat.x += (dx / Math.max(0.0001, distance)) * step;
    officeCat.y += (dy / Math.max(0.0001, distance)) * step;
  }

  officeCat.frame += shouldMove ? 1 : officeCat.action === "nap" ? 0.08 : 0.24;

  if (officeCat.mode === "entering" && distance < 1.8) {
    startOfficeCatAction(nowMs, pickOfficeCatLoungeAction());
  } else if (officeCat.mode === "wandering" && distance < 1.8) {
    startOfficeCatAction(nowMs, pickOfficeCatLoungeAction());
  } else if (officeCat.mode === "lounging" && nowMs >= officeCat.nextDecisionAtMs) {
    chooseNextOfficeCatBeat(nowMs);
  } else if (officeCat.mode === "leaving") {
    const hasExited =
      (officeCat.exitSide === "left" && officeCat.x <= FLOOR_BOUNDS.left - 24) ||
      (officeCat.exitSide === "right" && officeCat.x >= FLOOR_BOUNDS.right + 24);
    if (hasExited) {
      officeCat.active = false;
      officeCat.mode = "offstage";
      officeCat.action = "walk";
      clearOfficeCatMeow();
      officeCat.nextSpawnAtMs =
        nowMs + randomRange(OFFICE_CAT_MIN_SPAWN_MS, OFFICE_CAT_MAX_SPAWN_MS);
    }
  }

  if (officeCat.mode !== "leaving") {
    officeCat.x = clamp(officeCat.x, FLOOR_BOUNDS.left - 32, FLOOR_BOUNDS.right + 32);
  }
  officeCat.y = clamp(officeCat.y, FLOOR_BOUNDS.top + 18, FLOOR_BOUNDS.bottom + 3);
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
  const overlayAction = agentIdleOverlays[agent.id]?.action;

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

  const routinePause = agent.status === "idle" && agent.routine === "pause";
  const sleepSettled = isSleepSettled(agent);
  const plantWateringSettled = isPlantWateringSettled(agent);
  const paused =
    nowMs < agent.pauseUntilMs ||
    routinePause ||
    sleepSettled ||
    plantWateringSettled;

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

  const canRoamLoop =
    agent.status === "idle" &&
    agent.routine === "normal" &&
    overlayAction !== "water-plant";
  if (canRoamLoop) {
    if (distance < 1.6) {
      if (agent.idleHoldUntilMs <= 0) {
        agent.idleHoldUntilMs = nowMs + randomRange(420, 1200);
      } else if (nowMs >= agent.idleHoldUntilMs) {
        const nextSpot = resolveNextIdleSpot(agent);
        assignIdleTarget(agent, nextSpot, { rememberPrevious: true });
      }
    } else {
      agent.idleHoldUntilMs = 0;
    }
  } else {
    agent.idleHoldUntilMs = 0;
  }

  agent.x = clamp(agent.x, FLOOR_BOUNDS.left, FLOOR_BOUNDS.right);
  agent.y = clamp(agent.y, FLOOR_BOUNDS.top, FLOOR_BOUNDS.bottom);
}

function drawFrame() {
  const nowMs = performance.now();
  const nowEpochMs = Date.now();
  maybeRunBossIdleChatter();
  drawScene(nowMs);
  tickOfficeCat(nowMs);
  maybeRunIdleChatter();

  for (const id of agentOrder) {
    const agent = agentState[id];
    tickAgent(agent, nowMs);
    drawAgentBlock(agent, nowMs);
  }

  drawOfficeCat(nowMs);

  drawBossDispatchLink(nowMs);

  const bubbleLayouts = resolveSpeechLayouts(nowMs, nowEpochMs);
  for (const layout of bubbleLayouts) {
    drawSpeechCloud(layout);
  }

  drawBossSpeechCloud(nowEpochMs);

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
    const inactivityLimitMs = inactivityLimitForAgent(agent);
    if (
      agent.status !== "idle" &&
      now - agent.lastEventAt >= inactivityLimitMs
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
setRuntimeStatus("Wacht op input | lounge rustig");
void initializeCharacterSprites();
void initializeRoomBackground();
drawFrame();

vscode.postMessage({ type: "webview-ready" });
vscode.postMessage({ type: "webview-request-snapshot" });

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    renderConnectionStatus("HMR updated");
  });
}
