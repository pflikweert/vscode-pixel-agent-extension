import './styles.css';

const vscode = acquireVsCodeApi();

type AgentId = 'scout' | 'builder' | 'reviewer';
type AgentStatus = 'idle' | 'working' | 'completed' | 'error';

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
}

interface RuntimeState {
  agents: Record<AgentId, AgentViewState>;
  eventLog: PixelRuntimeEvent[];
  statusLine: string;
}

type ExtensionMessage =
  | { type: 'pixel.snapshot'; payload: RuntimeState }
  | { type: 'pixel.event'; payload: PixelRuntimeEvent };

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Missing #app container.');
}

app.innerHTML = `
  <main class="screen">
    <section class="card">
      <header class="title-row">
        <div>
          <p class="kicker">Pixel Agent</p>
          <h1>Live Event Monitor</h1>
        </div>
        <button id="refresh-button" type="button">Refresh Snapshot</button>
      </header>

      <div class="status-row">
        <span>Runtime</span>
        <strong id="runtime-status">IDLE</strong>
      </div>

      <div class="status-row">
        <span>Webview</span>
        <strong id="hmr-status">Connected</strong>
      </div>

      <div class="agent-list" id="agent-list"></div>

      <section class="event-log">
        <h2>Events</h2>
        <ul id="event-log-list"></ul>
      </section>
    </section>
  </main>
`;

const status = app.querySelector<HTMLElement>('#hmr-status');
const runtimeStatus = app.querySelector<HTMLElement>('#runtime-status');
const refreshButton = app.querySelector<HTMLButtonElement>('#refresh-button');
const agentList = app.querySelector<HTMLDivElement>('#agent-list');
const eventList = app.querySelector<HTMLUListElement>('#event-log-list');

const agentOrder: AgentId[] = ['scout', 'builder', 'reviewer'];
const agentState: Record<AgentId, AgentViewState> = {
  scout: createDefaultAgent('scout', 'Scout'),
  builder: createDefaultAgent('builder', 'Builder'),
  reviewer: createDefaultAgent('reviewer', 'Reviewer')
};

const runtimeEvents: PixelRuntimeEvent[] = [];

function createDefaultAgent(id: AgentId, label: string): AgentViewState {
  return {
    id,
    label,
    task: 'wacht op event',
    status: 'idle',
    progress: 0,
    lastEventAt: Date.now()
  };
}

function shorten(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}...`;
}

function renderAgents() {
  if (!agentList) {
    return;
  }

  agentList.innerHTML = agentOrder
    .map((agentId) => {
      const agent = agentState[agentId];
      return `
        <article class="agent-item">
          <div>
            <p class="agent-name">${agent.label}</p>
            <p class="agent-task">${escapeHtml(shorten(agent.task, 72))}</p>
          </div>
          <p class="agent-state ${agent.status}">${agent.status} ${agent.progress}%</p>
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
    .slice(0, 12)
    .map((event) => {
      const time = new Date(event.timestamp).toLocaleTimeString();
      const detail = event.detail ? ` - ${escapeHtml(shorten(event.detail, 82))}` : '';
      return `<li>[${time}] ${escapeHtml(event.summary)}${detail}</li>`;
    })
    .join('');
}

function setRuntimeStatus(value: string) {
  if (runtimeStatus) {
    runtimeStatus.textContent = value;
  }
}

function applySnapshot(snapshot: RuntimeState) {
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
  }

  runtimeEvents.length = 0;
  runtimeEvents.push(...snapshot.eventLog.slice(0, 12));

  setRuntimeStatus(snapshot.statusLine || 'IDLE');
  renderAgents();
  renderEvents();
}

function applyEvent(event: PixelRuntimeEvent) {
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
    }
  }

  runtimeEvents.unshift(event);
  if (runtimeEvents.length > 12) {
    runtimeEvents.length = 12;
  }

  renderAgents();
  renderEvents();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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

renderAgents();
renderEvents();
setRuntimeStatus('IDLE');

vscode.postMessage({ type: 'webview-ready' });
vscode.postMessage({ type: 'webview-request-snapshot' });

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    if (status) {
      status.textContent = 'HMR updated';
    }
  });
}
