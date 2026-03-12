import * as vscode from 'vscode';

const VIEW_TYPE = 'pixelAgent.visualizer';
const MAX_EVENT_LOG = 30;
const MAX_QUEUED_MESSAGES = 120;
const EVENT_THROTTLE_MS = 350;
const IDLE_TIMEOUT_MS = 8000;
const DEV_SERVER_TIMEOUT_MS = 1200;
const PANEL_READY_TIMEOUT_MS = 2500;
const DEFAULT_DEV_SERVER_URL = 'http://127.0.0.1:5173';
const MAX_COMMAND_PREVIEW_LENGTH = 120;
const AUTO_LOAD_EMBEDDED_WHEN_DEV_CONNECTED = true;
const TEST_EVENT_STEP_DELAY_MS = 420;

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

type ExtensionToWebviewMessage =
  | { type: 'pixel.snapshot'; payload: RuntimeState }
  | { type: 'pixel.event'; payload: PixelRuntimeEvent };

type WebviewToExtensionMessage =
  | { type: 'webview-ready' }
  | { type: 'webview-request-snapshot' }
  | { type: 'retry-dev-server' }
  | { type: 'load-production' }
  | { type: 'load-embedded' };

type PanelMode = 'auto' | 'production' | 'embedded';

const AGENT_LABELS: Record<AgentId, string> = {
  scout: 'Scout',
  builder: 'Builder',
  reviewer: 'Reviewer'
};

let panelRef: vscode.WebviewPanel | undefined;
let panelReady = false;
let queuedMessages: ExtensionToWebviewMessage[] = [];
let preferredPanelMode: PanelMode = 'auto';
let panelReadyWatchdog: NodeJS.Timeout | undefined;
let runtimeState = createInitialRuntimeState();
const idleTimers = new Map<AgentId, NodeJS.Timeout>();
const lastDocumentChangeEventAt = new Map<string, number>();

export function activate(context: vscode.ExtensionContext) {
  runtimeState = createInitialRuntimeState();

  const panelCommand = vscode.commands.registerCommand('pixelAgent.openPanel', () => {
    openPixelPanel(context);
  });

  const emitTestEventsCommand = vscode.commands.registerCommand('pixelAgent.emitTestEvents', () => {
    openPixelPanel(context);
    emitSyntheticTestEvents();
    void vscode.window.showInformationMessage('Pixel Agent test-events verstuurd.');
  });

  context.subscriptions.push(panelCommand, emitTestEventsCommand);

  const participant = vscode.chat.createChatParticipant(
    'pixel-copilot-agent.pixel',
    async (request, _chatContext, stream) => {
      const prompt = request.prompt.trim();
      const requestLabel = request.command ? `/${request.command}` : prompt || 'lege prompt';
      const assignedAgent = pickAgentForPrompt(prompt, request.command);

      emitRuntimeEvent({
        type: 'chat.received',
        timestamp: Date.now(),
        summary: '@pixel aanvraag ontvangen',
        detail: requestLabel,
        agentId: assignedAgent,
        status: 'working',
        progress: 15
      });

      if (request.command === 'show') {
        openPixelPanel(context);
        stream.markdown('Pixel panel geopend.');
        emitRuntimeEvent({
          type: 'chat.completed',
          timestamp: Date.now(),
          summary: '@pixel /show uitgevoerd',
          detail: 'Panel geopend op verzoek.',
          agentId: assignedAgent,
          status: 'completed',
          progress: 100
        });
        scheduleAgentIdle(assignedAgent, IDLE_TIMEOUT_MS);
        return;
      }

      try {
        const workspaceSummary = getWorkspaceSummary();
        const selectionPreview = getActiveSelectionPreview();
        const diagnosticsSummary = getDiagnosticsSummary();

        emitRuntimeEvent({
          type: 'chat.processing',
          timestamp: Date.now(),
          summary: '@pixel antwoord opbouwen',
          detail: 'Context uit workspace en diagnostics verzamelen.',
          agentId: assignedAgent,
          status: 'working',
          progress: 45
        });

        stream.markdown('Ik ben je @pixel agent.\\n\\n');
        stream.markdown(`Vraag: ${prompt || 'geen vraag meegegeven'}\\n\\n`);

        emitRuntimeEvent({
          type: 'chat.streaming',
          timestamp: Date.now(),
          summary: '@pixel response stream actief',
          detail: 'Live update naar chat en panel.',
          agentId: assignedAgent,
          status: 'working',
          progress: 70
        });

        stream.markdown(`Workspace: ${workspaceSummary}\\n\\n`);
        if (selectionPreview) {
          stream.markdown(`Actieve selectie: ${selectionPreview}\\n\\n`);
        }
        stream.markdown(`Diagnostics: ${diagnosticsSummary}\\n\\n`);
        stream.markdown(
          'Pixel panel draait nu op echte events uit @pixel chat, workspace wijzigingen en diagnostics. Interne built-in Copilot agent-events zijn alleen beschikbaar als de publieke API signalen blootstelt.'
        );

        emitRuntimeEvent({
          type: 'chat.completed',
          timestamp: Date.now(),
          summary: '@pixel antwoord afgerond',
          detail: requestLabel,
          agentId: assignedAgent,
          status: 'completed',
          progress: 100
        });
        scheduleAgentIdle(assignedAgent, IDLE_TIMEOUT_MS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitRuntimeEvent({
          type: 'chat.error',
          timestamp: Date.now(),
          summary: '@pixel fout tijdens afhandeling',
          detail: message,
          agentId: assignedAgent,
          status: 'error',
          progress: 100
        });
        scheduleAgentIdle(assignedAgent, IDLE_TIMEOUT_MS + 2000);
        stream.markdown(`Fout tijdens verwerken: ${message}`);
      }
    }
  );

  participant.iconPath = new vscode.ThemeIcon('hubot');
  participant.followupProvider = {
    provideFollowups() {
      return [
        {
          prompt: 'Analyseer deze map en stel een plan voor mijn volgende commit.',
          label: 'Analyse workspace'
        },
        {
          prompt: '/show',
          label: 'Open pixel panel'
        }
      ];
    }
  };

  context.subscriptions.push(participant);
  registerRuntimeListeners(context);

  emitRuntimeEvent({
    type: 'extension.activated',
    timestamp: Date.now(),
    summary: 'Pixel extensie geactiveerd',
    detail: getWorkspaceSummary(),
    agentId: 'scout',
    status: 'working',
    progress: 20
  });
  scheduleAgentIdle('scout', 4000);
}

export function deactivate() {
  for (const timer of idleTimers.values()) {
    clearTimeout(timer);
  }
  idleTimers.clear();
}

function registerRuntimeListeners(context: vscode.ExtensionContext) {
  const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.uri.scheme !== 'file') {
      return;
    }
    if (event.contentChanges.length === 0) {
      return;
    }

    const key = event.document.uri.toString();
    const now = Date.now();
    const lastAt = lastDocumentChangeEventAt.get(key) ?? 0;
    if (now - lastAt < EVENT_THROTTLE_MS) {
      return;
    }
    lastDocumentChangeEventAt.set(key, now);

    const filePath = normalizePath(event.document.uri);
    emitRuntimeEvent({
      type: 'workspace.fileChanged',
      timestamp: now,
      summary: 'Bestand gewijzigd',
      detail: filePath,
      filePath,
      agentId: 'scout',
      status: 'working',
      progress: 35
    });
    scheduleAgentIdle('scout', IDLE_TIMEOUT_MS);
  });

  const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
    if (document.uri.scheme !== 'file') {
      return;
    }

    const filePath = normalizePath(document.uri);
    emitRuntimeEvent({
      type: 'workspace.fileSaved',
      timestamp: Date.now(),
      summary: 'Bestand opgeslagen',
      detail: filePath,
      filePath,
      agentId: 'builder',
      status: 'completed',
      progress: 100
    });
    scheduleAgentIdle('builder', IDLE_TIMEOUT_MS);
  });

  const createListener = vscode.workspace.onDidCreateFiles((event) => {
    const now = Date.now();
    for (const uri of event.files) {
      const filePath = normalizePath(uri);
      emitRuntimeEvent({
        type: 'workspace.fileCreated',
        timestamp: now,
        summary: 'Bestand aangemaakt',
        detail: filePath,
        filePath,
        agentId: 'builder',
        status: 'working',
        progress: 50
      });
    }
    scheduleAgentIdle('builder', IDLE_TIMEOUT_MS);
  });

  const deleteListener = vscode.workspace.onDidDeleteFiles((event) => {
    const now = Date.now();
    for (const uri of event.files) {
      const filePath = normalizePath(uri);
      emitRuntimeEvent({
        type: 'workspace.fileDeleted',
        timestamp: now,
        summary: 'Bestand verwijderd',
        detail: filePath,
        filePath,
        agentId: 'reviewer',
        status: 'working',
        progress: 55
      });
    }
    scheduleAgentIdle('reviewer', IDLE_TIMEOUT_MS);
  });

  const renameListener = vscode.workspace.onDidRenameFiles((event) => {
    const now = Date.now();
    for (const change of event.files) {
      const from = normalizePath(change.oldUri);
      const to = normalizePath(change.newUri);
      emitRuntimeEvent({
        type: 'workspace.fileRenamed',
        timestamp: now,
        summary: 'Bestand hernoemd',
        detail: `${from} -> ${to}`,
        filePath: to,
        agentId: 'scout',
        status: 'working',
        progress: 45
      });
    }
    scheduleAgentIdle('scout', IDLE_TIMEOUT_MS);
  });

  const diagnosticsListener = vscode.languages.onDidChangeDiagnostics((event) => {
    const summary = collectDiagnosticsSummary(event.uris);
    if (summary.total === 0) {
      return;
    }

    const status: AgentStatus = summary.errors > 0 ? 'error' : 'completed';
    emitRuntimeEvent({
      type: 'diagnostics.updated',
      timestamp: Date.now(),
      summary: `Diagnostics ${summary.errors} errors, ${summary.warnings} warnings`,
      detail: summary.sampleFile ?? 'workspace',
      agentId: 'reviewer',
      status,
      progress: 100
    });
    scheduleAgentIdle('reviewer', IDLE_TIMEOUT_MS + 2000);
  });

  const taskStartListener = vscode.tasks.onDidStartTaskProcess((event) => {
    const taskName = event.execution.task.name;
    const agentId = inferAgentForTask(taskName);
    emitRuntimeEvent({
      type: 'task.started',
      timestamp: Date.now(),
      summary: 'Taak gestart',
      detail: taskName,
      agentId,
      status: 'working',
      progress: 60
    });
    scheduleAgentIdle(agentId, IDLE_TIMEOUT_MS + 3000);
  });

  const taskEndListener = vscode.tasks.onDidEndTaskProcess((event) => {
    const taskName = event.execution.task.name;
    const agentId = inferAgentForTask(taskName);
    const code = typeof event.exitCode === 'number' ? event.exitCode : 0;
    const status: AgentStatus = code === 0 ? 'completed' : 'error';
    emitRuntimeEvent({
      type: 'task.finished',
      timestamp: Date.now(),
      summary: code === 0 ? 'Taak succesvol afgerond' : 'Taak gefaald',
      detail: `${taskName} (exit ${code})`,
      agentId,
      status,
      progress: 100
    });
    scheduleAgentIdle(agentId, IDLE_TIMEOUT_MS + 3000);
  });

  const editorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }

    const filePath = normalizePath(editor.document.uri);
    emitRuntimeEvent({
      type: 'workspace.activeEditorChanged',
      timestamp: Date.now(),
      summary: 'Actieve editor gewijzigd',
      detail: filePath,
      filePath,
      agentId: 'scout',
      status: 'working',
      progress: 25
    });
    scheduleAgentIdle('scout', 4500);
  });

  const terminalOpenListener = vscode.window.onDidOpenTerminal((terminal) => {
    emitRuntimeEvent({
      type: 'terminal.opened',
      timestamp: Date.now(),
      summary: 'Terminal geopend',
      detail: terminal.name,
      agentId: 'scout',
      status: 'working',
      progress: 20
    });
    scheduleAgentIdle('scout', 5000);
  });

  const terminalCloseListener = vscode.window.onDidCloseTerminal((terminal) => {
    emitRuntimeEvent({
      type: 'terminal.closed',
      timestamp: Date.now(),
      summary: 'Terminal gesloten',
      detail: terminal.name,
      agentId: 'scout',
      status: 'completed',
      progress: 100
    });
    scheduleAgentIdle('scout', 4500);
  });

  const supportsShellExecStart = typeof (vscode.window as unknown as {
    onDidStartTerminalShellExecution?: vscode.Event<vscode.TerminalShellExecutionStartEvent>;
  }).onDidStartTerminalShellExecution === 'function';

  const supportsShellExecEnd = typeof (vscode.window as unknown as {
    onDidEndTerminalShellExecution?: vscode.Event<vscode.TerminalShellExecutionEndEvent>;
  }).onDidEndTerminalShellExecution === 'function';

  const terminalCommandStartListener = supportsShellExecStart
    ? vscode.window.onDidStartTerminalShellExecution((event) => {
        const command = sanitizeCommandPreview(event.execution.commandLine.value || '');
        const terminalName = event.terminal.name || 'terminal';
        const agentId = inferAgentForCommandLine(command);

        emitRuntimeEvent({
          type: 'terminal.commandStarted',
          timestamp: Date.now(),
          summary: 'Terminal commando gestart',
          detail: `${terminalName}: ${command}`,
          agentId,
          status: 'working',
          progress: 65
        });
        scheduleAgentIdle(agentId, IDLE_TIMEOUT_MS + 2500);
      })
    : undefined;

  const terminalCommandEndListener = supportsShellExecEnd
    ? vscode.window.onDidEndTerminalShellExecution((event) => {
        const command = sanitizeCommandPreview(event.execution.commandLine.value || '');
        const terminalName = event.terminal.name || 'terminal';
        const exitCode = event.exitCode;

        const status: AgentStatus = exitCode === undefined ? 'completed' : exitCode === 0 ? 'completed' : 'error';
        const summary =
          exitCode === undefined
            ? 'Terminal commando afgerond'
            : exitCode === 0
              ? 'Terminal commando succesvol'
              : 'Terminal commando gefaald';
        const detail =
          exitCode === undefined
            ? `${terminalName}: ${command} (exit onbekend)`
            : `${terminalName}: ${command} (exit ${exitCode})`;

        const agentId = inferAgentForCommandLine(command);
        emitRuntimeEvent({
          type: 'terminal.commandFinished',
          timestamp: Date.now(),
          summary,
          detail,
          agentId,
          status,
          progress: 100
        });
        scheduleAgentIdle(agentId, IDLE_TIMEOUT_MS + 2500);
      })
    : undefined;

  context.subscriptions.push(
    changeListener,
    saveListener,
    createListener,
    deleteListener,
    renameListener,
    diagnosticsListener,
    taskStartListener,
    taskEndListener,
    editorListener,
    terminalOpenListener,
    terminalCloseListener
  );

  if (terminalCommandStartListener) {
    context.subscriptions.push(terminalCommandStartListener);
  }
  if (terminalCommandEndListener) {
    context.subscriptions.push(terminalCommandEndListener);
  }
}

function getWorkspaceSummary(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return 'geen geopende workspacefolder';
  }

  const names = folders.map((folder) => folder.name).join(', ');
  return `folders: ${names}`;
}

function getActiveSelectionPreview(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }

  const selected = editor.document.getText(editor.selection).trim();
  if (!selected) {
    return undefined;
  }

  return shorten(selected.replace(/\s+/g, ' '), 120);
}

function getDiagnosticsSummary(): string {
  const entries = vscode.languages.getDiagnostics();
  let errors = 0;
  let warnings = 0;

  for (const [, diagnostics] of entries) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
        errors += 1;
      } else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
        warnings += 1;
      }
    }
  }

  return `${errors} errors, ${warnings} warnings`;
}

function collectDiagnosticsSummary(uris: readonly vscode.Uri[]): {
  total: number;
  errors: number;
  warnings: number;
  sampleFile?: string;
} {
  let errors = 0;
  let warnings = 0;

  for (const uri of uris) {
    if (uri.scheme !== 'file') {
      continue;
    }

    const diagnostics = vscode.languages.getDiagnostics(uri);
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
        errors += 1;
      } else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
        warnings += 1;
      }
    }
  }

  return {
    total: errors + warnings,
    errors,
    warnings,
    sampleFile: uris.length > 0 ? normalizePath(uris[0]) : undefined
  };
}

function pickAgentForPrompt(prompt: string, command?: string): AgentId {
  if (command === 'show') {
    return 'scout';
  }

  const text = prompt.toLowerCase();
  if (/review|lint|test|error|bug|diagnostic/.test(text)) {
    return 'reviewer';
  }
  if (/build|schrijf|write|fix|implement|code/.test(text)) {
    return 'builder';
  }
  return 'scout';
}

function inferAgentForTask(taskName: string): AgentId {
  const lower = taskName.toLowerCase();
  if (/lint|test|review|check|diagnostic/.test(lower)) {
    return 'reviewer';
  }
  if (/build|compile|bundle|fix|generate/.test(lower)) {
    return 'builder';
  }
  return 'scout';
}

function inferAgentForCommandLine(commandLine: string): AgentId {
  const lower = commandLine.toLowerCase();
  if (/lint|eslint|test|review|diagnostic|check/.test(lower)) {
    return 'reviewer';
  }
  if (/build|compile|vite|npm run|pnpm|yarn|tsc|bundle/.test(lower)) {
    return 'builder';
  }
  return 'scout';
}

function sanitizeCommandPreview(commandLine: string): string {
  if (!commandLine) {
    return '(leeg commando)';
  }

  const redacted = commandLine.replace(
    /\b(password|passwd|pwd|token|secret|api[_-]?key)\s*=\s*([^\s]+)/gi,
    '$1=***'
  );

  return shorten(redacted.replace(/\s+/g, ' ').trim(), MAX_COMMAND_PREVIEW_LENGTH);
}

function createInitialRuntimeState(): RuntimeState {
  return {
    agents: {
      scout: createAgentState('scout'),
      builder: createAgentState('builder'),
      reviewer: createAgentState('reviewer')
    },
    eventLog: [],
    statusLine: 'IDLE'
  };
}

function createAgentState(id: AgentId): AgentViewState {
  return {
    id,
    label: AGENT_LABELS[id],
    task: 'wacht op event',
    status: 'idle',
    progress: 0,
    lastEventAt: Date.now()
  };
}

function scheduleAgentIdle(agentId: AgentId, timeoutMs: number) {
  const existing = idleTimers.get(agentId);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    emitRuntimeEvent({
      type: 'agent.idleTimeout',
      timestamp: Date.now(),
      summary: `${AGENT_LABELS[agentId]} terug naar idle`,
      detail: 'Geen recente events.',
      agentId,
      status: 'idle',
      progress: 0
    });
  }, timeoutMs);
  idleTimers.set(agentId, timer);
}

function emitSyntheticTestEvents() {
  const runLabel = new Date().toLocaleTimeString();
  const sequence: Array<{ delayMs: number; event: Omit<PixelRuntimeEvent, 'timestamp'> }> = [
    {
      delayMs: 0,
      event: {
        type: 'test.sequence.started',
        summary: 'Test-sequence gestart',
        detail: `Handmatige validatie run (${runLabel})`,
        agentId: 'scout',
        status: 'working',
        progress: 10
      }
    },
    {
      delayMs: TEST_EVENT_STEP_DELAY_MS,
      event: {
        type: 'test.sequence.workspace',
        summary: 'Workspace scan simulatie',
        detail: 'Scannen van geopende files voor context.',
        agentId: 'scout',
        status: 'working',
        progress: 45
      }
    },
    {
      delayMs: TEST_EVENT_STEP_DELAY_MS * 2,
      event: {
        type: 'test.sequence.builder',
        summary: 'Builder verwerkt wijziging',
        detail: 'src/extension.ts',
        filePath: 'src/extension.ts',
        agentId: 'builder',
        status: 'working',
        progress: 58
      }
    },
    {
      delayMs: TEST_EVENT_STEP_DELAY_MS * 3,
      event: {
        type: 'test.sequence.reviewerWarning',
        summary: 'Reviewer vond waarschuwing',
        detail: '1 warning in test-run (gesimuleerd).',
        agentId: 'reviewer',
        status: 'error',
        progress: 100
      }
    },
    {
      delayMs: TEST_EVENT_STEP_DELAY_MS * 4,
      event: {
        type: 'test.sequence.reviewerResolved',
        summary: 'Reviewer waarschuwing opgelost',
        detail: 'Geen warnings meer in gesimuleerde run.',
        agentId: 'reviewer',
        status: 'completed',
        progress: 100
      }
    },
    {
      delayMs: TEST_EVENT_STEP_DELAY_MS * 5,
      event: {
        type: 'test.sequence.finished',
        summary: 'Test-sequence afgerond',
        detail: 'Panel event rendering werkt zoals verwacht (gesimuleerd).',
        agentId: 'builder',
        status: 'completed',
        progress: 100
      }
    }
  ];

  for (const step of sequence) {
    setTimeout(() => {
      emitRuntimeEvent({
        ...step.event,
        timestamp: Date.now()
      });
    }, step.delayMs);
  }

  const idleDelay = TEST_EVENT_STEP_DELAY_MS * 6;
  scheduleAgentIdle('scout', idleDelay);
  scheduleAgentIdle('builder', idleDelay + 400);
  scheduleAgentIdle('reviewer', idleDelay + 800);
}

function emitRuntimeEvent(event: PixelRuntimeEvent) {
  const normalized: PixelRuntimeEvent = {
    ...event,
    timestamp: event.timestamp || Date.now(),
    progress: normalizeProgress(event.progress)
  };

  applyEventToRuntimeState(normalized);
  queueOrSendMessage({ type: 'pixel.event', payload: normalized });
}

function applyEventToRuntimeState(event: PixelRuntimeEvent) {
  if (event.agentId) {
    const agent = runtimeState.agents[event.agentId];
    agent.lastEventAt = event.timestamp;

    if (typeof event.status === 'string') {
      agent.status = event.status;
    }
    if (typeof event.progress === 'number') {
      agent.progress = event.progress;
    }
    if (event.detail) {
      agent.task = shorten(event.detail, 72);
    } else {
      agent.task = shorten(event.summary, 72);
    }
  }

  runtimeState.eventLog.unshift(event);
  if (runtimeState.eventLog.length > MAX_EVENT_LOG) {
    runtimeState.eventLog.length = MAX_EVENT_LOG;
  }

  runtimeState.statusLine = buildStatusLine(runtimeState.agents);
}

function buildStatusLine(agents: Record<AgentId, AgentViewState>): string {
  let working = 0;
  let completed = 0;
  let errors = 0;

  for (const agentId of Object.keys(agents) as AgentId[]) {
    const status = agents[agentId].status;
    if (status === 'working') {
      working += 1;
    } else if (status === 'completed') {
      completed += 1;
    } else if (status === 'error') {
      errors += 1;
    }
  }

  if (working === 0 && completed === 0 && errors === 0) {
    return 'IDLE';
  }

  return `${working} actief | ${completed} klaar | ${errors} fout`;
}

function normalizeProgress(progress: number | undefined): number | undefined {
  if (typeof progress !== 'number' || Number.isNaN(progress)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, Math.round(progress)));
}

function normalizePath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false);
}

function shorten(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}...`;
}

function openPixelPanel(context: vscode.ExtensionContext) {
  if (panelRef) {
    panelRef.reveal(vscode.ViewColumn.Beside);

    if (!panelReady) {
      preferredPanelMode = 'embedded';
      void renderPanelHtml(panelRef, context);
      armPanelReadyWatchdog(context);
    }

    postSnapshot();
    emitRuntimeEvent({
      type: 'panel.revealed',
      timestamp: Date.now(),
      summary: 'Pixel panel opnieuw zichtbaar',
      detail: 'Bestaand panel hergebruikt.'
    });
    return;
  }

  panelRef = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    'Pixel Agent',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')]
    }
  );

  preferredPanelMode = 'auto';
  panelReady = false;
  panelRef.iconPath = new vscode.ThemeIcon('symbol-color');
  void renderPanelHtml(panelRef, context);
  armPanelReadyWatchdog(context);

  panelRef.onDidDispose(() => {
    panelRef = undefined;
    panelReady = false;
    preferredPanelMode = 'auto';
    queuedMessages = [];
    clearPanelReadyWatchdog();
  });

  panelRef.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
    if (!message || typeof message.type !== 'string') {
      return;
    }

    if (message.type === 'webview-ready') {
      panelReady = true;
      clearPanelReadyWatchdog();
      postSnapshot();
      flushQueuedMessages();
      emitRuntimeEvent({
        type: 'panel.connected',
        timestamp: Date.now(),
        summary: 'Pixel panel verbonden',
        detail: 'Webview ontvangt live events.'
      });
      return;
    }

    if (message.type === 'webview-request-snapshot') {
      postSnapshot();
      return;
    }

    if (message.type === 'retry-dev-server') {
      preferredPanelMode = 'auto';
      if (panelRef) {
        await renderPanelHtml(panelRef, context);
        armPanelReadyWatchdog(context);
      }
      return;
    }

    if (message.type === 'load-production') {
      preferredPanelMode = 'production';
      if (panelRef) {
        await renderPanelHtml(panelRef, context);
        armPanelReadyWatchdog(context);
      }
      return;
    }

    if (message.type === 'load-embedded') {
      preferredPanelMode = 'embedded';
      if (panelRef) {
        await renderPanelHtml(panelRef, context);
        armPanelReadyWatchdog(context);
      }
    }
  });

  emitRuntimeEvent({
    type: 'panel.opened',
    timestamp: Date.now(),
    summary: 'Pixel panel geopend',
    detail: 'Wachten op webview connectie.'
  });
}

async function renderPanelHtml(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): Promise<void> {
  panelReady = false;
  clearPanelReadyWatchdog();

  const devServerUrl = process.env.PIXEL_AGENT_WEBVIEW_DEV_SERVER_URL || DEFAULT_DEV_SERVER_URL;
  const inDevMode = context.extensionMode === vscode.ExtensionMode.Development;

  if (preferredPanelMode === 'embedded') {
    panel.webview.html = getWebviewHtml(panel.webview);
    return;
  }

  if (preferredPanelMode === 'production') {
    const hasBundle = await hasProductionBundle(context.extensionUri);
    panel.webview.html = hasBundle
      ? getProdWebviewHtml(panel.webview, context.extensionUri)
      : getBundleMissingHtml(panel.webview, devServerUrl, 'Production bundle not found.');
    return;
  }

  if (!inDevMode) {
    const hasBundle = await hasProductionBundle(context.extensionUri);
    panel.webview.html = hasBundle
      ? getProdWebviewHtml(panel.webview, context.extensionUri)
      : getBundleMissingHtml(panel.webview, devServerUrl, 'Run npm run build in this repository.');
    return;
  }

  const probe = await probeDevServer(devServerUrl);
  if (probe.ok) {
    if (AUTO_LOAD_EMBEDDED_WHEN_DEV_CONNECTED) {
      panel.webview.html = getWebviewHtml(panel.webview);
      return;
    }

    panel.webview.html = getDevWebviewHtml(panel.webview, devServerUrl);
    return;
  }

  const hasBundle = await hasProductionBundle(context.extensionUri);
  panel.webview.html = getDevServerFallbackHtml(panel.webview, devServerUrl, probe.reason, hasBundle);
}

function clearPanelReadyWatchdog() {
  if (panelReadyWatchdog) {
    clearTimeout(panelReadyWatchdog);
    panelReadyWatchdog = undefined;
  }
}

function armPanelReadyWatchdog(context: vscode.ExtensionContext) {
  clearPanelReadyWatchdog();

  panelReadyWatchdog = setTimeout(() => {
    if (!panelRef || panelReady) {
      return;
    }

    preferredPanelMode = 'embedded';
    const panel = panelRef;
    void renderPanelHtml(panel, context).then(() => {
      emitRuntimeEvent({
        type: 'panel.recovery',
        timestamp: Date.now(),
        summary: 'Panel recovery uitgevoerd',
        detail: 'Geen webview-ready signaal ontvangen, embedded UI opnieuw geladen.',
        agentId: 'builder',
        status: 'working',
        progress: 55
      });
    });
  }, PANEL_READY_TIMEOUT_MS);
}

async function probeDevServer(devServerUrl: string): Promise<{ ok: boolean; reason: string }> {
  const normalizedUrl = devServerUrl.replace(/\/$/, '');
  const clientUrl = `${normalizedUrl}/@vite/client`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, DEV_SERVER_TIMEOUT_MS);

  try {
    const response = await fetch(clientUrl, {
      method: 'GET',
      signal: controller.signal
    });

    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }

    return { ok: true, reason: '' };
  } catch (error) {
    if (error instanceof Error) {
      return { ok: false, reason: error.message };
    }
    return { ok: false, reason: 'Unknown network error' };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function hasProductionBundle(extensionUri: vscode.Uri): Promise<boolean> {
  const scriptUri = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets', 'main.js');
  const styleUri = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets', 'style.css');

  try {
    await vscode.workspace.fs.stat(scriptUri);
    await vscode.workspace.fs.stat(styleUri);
    return true;
  } catch {
    return false;
  }
}

function getDevWebviewHtml(webview: vscode.Webview, devServerUrl: string): string {
  const normalizedUrl = devServerUrl.replace(/\/$/, '');
  const wsOrigin = toWebSocketOrigin(normalizedUrl);
  const nonce = getNonce();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline' ${normalizedUrl}; script-src 'unsafe-eval' 'nonce-${nonce}' ${webview.cspSource} ${normalizedUrl}; connect-src ${normalizedUrl} ${wsOrigin}; font-src ${webview.cspSource} ${normalizedUrl};"
    />
    <title>Pixel Agent</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0f1420;
        --card: #182236;
        --line: #30445e;
        --text: #e7f0ff;
        --muted: #9eb4d1;
        --accent: #7fe2bf;
      }
      body {
        margin: 0;
        min-height: 100vh;
        background: radial-gradient(circle at 18% 18%, rgba(91, 141, 196, 0.24), transparent 40%), var(--bg);
        color: var(--text);
        font-family: 'Avenir Next', 'Segoe UI', sans-serif;
      }
      #boot-shell {
        max-width: 760px;
        margin: 24px auto;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: linear-gradient(165deg, rgba(24, 34, 54, 0.95), rgba(12, 18, 30, 0.96));
        padding: 18px;
      }
      #boot-shell h1 {
        margin: 0 0 8px;
        font-size: 21px;
      }
      #boot-shell p {
        margin: 0 0 8px;
        color: var(--muted);
        line-height: 1.45;
      }
      #boot-shell code {
        display: block;
        margin-top: 6px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgba(8, 13, 22, 0.85);
        color: var(--text);
        padding: 8px 10px;
        word-break: break-word;
      }
      .actions {
        margin-top: 12px;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      button {
        border: 0;
        border-radius: 9px;
        padding: 9px 13px;
        font-weight: 700;
        cursor: pointer;
      }
      button.primary {
        background: var(--accent);
        color: #061018;
      }
      button.secondary {
        border: 1px solid var(--line);
        background: transparent;
        color: var(--text);
      }
    </style>
  </head>
  <body>
    <main id="boot-shell">
      <h1>Loading Pixel Agent UI</h1>
      <p id="boot-status">Connecting to the Vite dev server...</p>
      <code>${escapeHtml(normalizedUrl)}</code>
      <div class="actions" id="boot-actions" hidden>
        <button id="retry" class="primary">Retry Dev Server</button>
        <button id="load-production" class="secondary">Load Production Bundle</button>
        <button id="load-embedded" class="secondary">Load Embedded Panel</button>
      </div>
    </main>
    <div id="app"></div>
    <script nonce="${nonce}">
      const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
      const appRoot = document.getElementById('app');
      const bootShell = document.getElementById('boot-shell');
      const bootStatus = document.getElementById('boot-status');
      const bootActions = document.getElementById('boot-actions');

      let didFinish = false;
      let didFail = false;

      function markReadyIfMounted() {
        if (didFinish || !appRoot) {
          return;
        }
        if (appRoot.childElementCount > 0) {
          didFinish = true;
          bootShell?.remove();
        }
      }

      function showFailure(reason) {
        if (didFinish || didFail) {
          return;
        }
        didFail = true;
        if (bootStatus) {
          bootStatus.textContent = 'Dev UI failed to boot. ' + (reason || 'Open fallback mode.');
        }
        if (bootActions) {
          bootActions.hidden = false;
        }
      }

      window.addEventListener(
        'error',
        (event) => {
          const message = event?.message ? String(event.message) : 'Script error';
          showFailure(message);
        },
        true
      );

      window.addEventListener('unhandledrejection', (event) => {
        const reason = event?.reason ? String(event.reason) : 'Unhandled promise rejection';
        showFailure(reason);
      });

      const mountCheck = setInterval(() => {
        if (didFinish) {
          clearInterval(mountCheck);
          return;
        }
        markReadyIfMounted();
      }, 120);

      setTimeout(() => {
        markReadyIfMounted();
        if (!didFinish) {
          clearInterval(mountCheck);
          showFailure('Timed out while loading modules from dev server.');
        }
      }, 3200);

      document.getElementById('retry')?.addEventListener('click', () => {
        vscodeApi?.postMessage({ type: 'retry-dev-server' });
      });

      document.getElementById('load-production')?.addEventListener('click', () => {
        vscodeApi?.postMessage({ type: 'load-production' });
      });

      document.getElementById('load-embedded')?.addEventListener('click', () => {
        vscodeApi?.postMessage({ type: 'load-embedded' });
      });
    </script>
    <script type="module" src="${normalizedUrl}/@vite/client"></script>
    <script type="module" src="${normalizedUrl}/src/main.ts"></script>
  </body>
</html>`;
}

function getProdWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets', 'main.js')
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets', 'style.css')
  );
  const nonce = getNonce();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Pixel Agent</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
  </body>
</html>`;
}

function getDevServerFallbackHtml(
  webview: vscode.Webview,
  devServerUrl: string,
  reason: string,
  productionBundleAvailable: boolean
): string {
  const nonce = getNonce();
  const safeUrl = escapeHtml(devServerUrl);
  const safeReason = escapeHtml(reason);
  const productionButton = productionBundleAvailable
    ? '<button id="load-production" class="secondary">Load Production Bundle</button>'
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <title>Pixel Agent</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0a1626;
        --bg-card: #13253b;
        --line: #294666;
        --text: #ecf4ff;
        --muted: #96acc8;
        --accent: #7ad1ff;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        background: radial-gradient(circle at 20% 20%, #1e466b 0%, transparent 45%), var(--bg);
        color: var(--text);
        padding: 24px;
      }
      main {
        width: min(740px, 100%);
        background: linear-gradient(170deg, rgba(23, 43, 66, 0.96), var(--bg-card));
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 24px;
      }
      h1 { margin: 0 0 10px; font-size: 24px; }
      p { margin: 0 0 10px; color: var(--muted); line-height: 1.45; }
      code {
        display: block;
        margin-top: 6px;
        padding: 10px 12px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: rgba(7, 17, 30, 0.75);
        color: var(--text);
        word-break: break-word;
      }
      .actions {
        margin-top: 16px;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      button {
        border: 0;
        border-radius: 10px;
        padding: 10px 14px;
        font-weight: 700;
        cursor: pointer;
      }
      button.primary { background: var(--accent); color: #05111d; }
      button.secondary { background: transparent; color: var(--text); border: 1px solid var(--line); }
    </style>
  </head>
  <body>
    <main>
      <h1>Webview dev server is offline</h1>
      <p>Pixel Agent tried to load the Vite dev server, but it was unreachable.</p>
      <p>Expected URL:</p>
      <code>${safeUrl}</code>
      <p>Reason:</p>
      <code>${safeReason || 'Connection failed'}</code>
      <p>Start it with:</p>
      <code>npm run dev:webview</code>
      <div class="actions">
        <button id="retry" class="primary">Retry Dev Server</button>
        ${productionButton}
        <button id="load-embedded" class="secondary">Load Embedded Panel</button>
      </div>
    </main>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.getElementById('retry')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'retry-dev-server' });
      });
      document.getElementById('load-production')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'load-production' });
      });
      document.getElementById('load-embedded')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'load-embedded' });
      });
    </script>
  </body>
</html>`;
}

function getBundleMissingHtml(webview: vscode.Webview, devServerUrl: string, reason: string): string {
  return getDevServerFallbackHtml(webview, devServerUrl, reason, false);
}

function toWebSocketOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${parsed.host}`;
  } catch {
    return 'ws://127.0.0.1:5173';
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function queueOrSendMessage(message: ExtensionToWebviewMessage) {
  if (panelRef && panelReady) {
    void panelRef.webview.postMessage(message);
    return;
  }

  queuedMessages.push(message);
  if (queuedMessages.length > MAX_QUEUED_MESSAGES) {
    queuedMessages = queuedMessages.slice(-MAX_QUEUED_MESSAGES);
  }
}

function flushQueuedMessages() {
  if (!panelRef || !panelReady || queuedMessages.length === 0) {
    return;
  }

  const toFlush = queuedMessages;
  queuedMessages = [];
  for (const message of toFlush) {
    void panelRef.webview.postMessage(message);
  }
}

function postSnapshot() {
  queueOrSendMessage({
    type: 'pixel.snapshot',
    payload: runtimeState
  });
}

function getWebviewHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pixel Agent</title>
  <style>
    :root {
      --bg: #151821;
      --panel: #202534;
      --line: #2f3650;
      --text: #f6f7ff;
      --mint: #69f0c4;
      --sun: #ffd166;
      --rose: #ff6f91;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 20% 20%, rgba(105, 240, 196, 0.14), transparent 40%),
        radial-gradient(circle at 80% 80%, rgba(255, 111, 145, 0.18), transparent 36%),
        var(--bg);
      color: var(--text);
      font-family: 'Courier New', monospace;
      display: grid;
      place-items: center;
      overflow: hidden;
    }

    .wrap {
      width: min(92vw, 700px);
      border: 2px solid var(--line);
      background: linear-gradient(180deg, rgba(32, 37, 52, 0.95), rgba(21, 24, 33, 0.96));
      box-shadow: 0 18px 42px rgba(0, 0, 0, 0.45);
      border-radius: 8px;
      padding: 16px;
    }

    .title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      font-size: 13px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    canvas {
      width: 100%;
      max-width: 660px;
      aspect-ratio: 16 / 9;
      border: 2px solid var(--line);
      image-rendering: pixelated;
      image-rendering: crisp-edges;
      background: #0e1118;
    }

    .footer {
      margin-top: 10px;
      font-size: 12px;
      color: #b7bfd6;
    }

    .agent-list {
      margin-top: 12px;
      border: 2px solid var(--line);
      background: rgba(20, 24, 34, 0.8);
      padding: 8px;
      display: grid;
      gap: 6px;
    }

    .agent-item {
      display: grid;
      grid-template-columns: 70px 1fr 50px;
      align-items: center;
      gap: 8px;
      font-size: 11px;
    }

    .agent-task {
      color: #c8d0e8;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .agent-state {
      text-align: right;
      color: #d6ddf0;
    }

    .event-log {
      margin-top: 10px;
      border: 2px solid var(--line);
      background: rgba(20, 24, 34, 0.82);
      padding: 8px;
    }

    .event-log-title {
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #c8d0e8;
      margin-bottom: 6px;
    }

    .event-log ul {
      margin: 0;
      padding-left: 16px;
      max-height: 120px;
      overflow: auto;
      font-size: 11px;
      line-height: 1.35;
      color: #aeb9d7;
    }

    .event-log li {
      margin-bottom: 4px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="title">
      <span>Pixel Agent Monitor</span>
      <span id="status">IDLE</span>
    </div>
    <canvas id="scene" width="320" height="180"></canvas>
    <div class="agent-list">
      <div class="agent-item">
        <strong>Scout</strong>
        <span class="agent-task" id="task-scout">wacht op event</span>
        <span class="agent-state" id="state-scout">idle 0%</span>
      </div>
      <div class="agent-item">
        <strong>Builder</strong>
        <span class="agent-task" id="task-builder">wacht op event</span>
        <span class="agent-state" id="state-builder">idle 0%</span>
      </div>
      <div class="agent-item">
        <strong>Reviewer</strong>
        <span class="agent-task" id="task-reviewer">wacht op event</span>
        <span class="agent-state" id="state-reviewer">idle 0%</span>
      </div>
    </div>
    <div class="event-log">
      <div class="event-log-title">Eventlog</div>
      <ul id="event-log-list"></ul>
    </div>
    <div class="footer">
      Tip: gebruik <code>@pixel /show</code> in Copilot Chat. Dit panel gebruikt echte extension-events en best-effort Copilot-signalen via publieke API's.
    </div>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const canvas = document.getElementById('scene');
    const status = document.getElementById('status');
    const logList = document.getElementById('event-log-list');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      status.textContent = 'CANVAS ERROR';
      throw new Error('Canvas context niet beschikbaar.');
    }

    const laneYs = [106, 122, 138];
    const walkBounds = {
      left: 10,
      right: canvas.width - 22
    };

    const agents = [
      { id: 'scout', name: 'Scout', x: 42, y: laneYs[0], vx: 0.46, frame: 0, bob: 0.3, color: '#69f0c4', task: 'wacht op event', status: 'idle', progress: 0, lane: 0, lastEventAt: Date.now() },
      { id: 'builder', name: 'Builder', x: 132, y: laneYs[1], vx: -0.41, frame: 0, bob: 1.4, color: '#ffd166', task: 'wacht op event', status: 'idle', progress: 0, lane: 1, lastEventAt: Date.now() },
      { id: 'reviewer', name: 'Reviewer', x: 232, y: laneYs[2], vx: 0.52, frame: 0, bob: 2.5, color: '#ff6f91', task: 'wacht op event', status: 'idle', progress: 0, lane: 2, lastEventAt: Date.now() }
    ];

    const agentById = new Map();
    for (const agent of agents) {
      agentById.set(agent.id, agent);
    }

    const eventLog = [];

    function shorten(value, maxLength) {
      if (!value) {
        return '';
      }
      return value.length <= maxLength ? value : value.slice(0, maxLength - 1) + '...';
    }

    function setStatusLine(text) {
      status.textContent = text || 'IDLE';
    }

    function updateStatusFromAgents() {
      let working = 0;
      let completed = 0;
      let errors = 0;

      for (const agent of agents) {
        if (agent.status === 'working') {
          working += 1;
        } else if (agent.status === 'completed') {
          completed += 1;
        } else if (agent.status === 'error') {
          errors += 1;
        }
      }

      if (working === 0 && completed === 0 && errors === 0) {
        setStatusLine('IDLE');
        return;
      }

      setStatusLine(working + ' actief | ' + completed + ' klaar | ' + errors + ' fout');
    }

    function renderAgentRows() {
      for (const agent of agents) {
        const taskEl = document.getElementById('task-' + agent.id);
        const stateEl = document.getElementById('state-' + agent.id);
        if (taskEl) {
          taskEl.textContent = shorten(agent.task || 'wacht op event', 58);
        }
        if (stateEl) {
          stateEl.textContent = agent.status + ' ' + agent.progress + '%';
        }
      }
    }

    function renderEventLog() {
      logList.innerHTML = '';
      if (eventLog.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'Nog geen events ontvangen.';
        logList.appendChild(li);
        return;
      }

      for (const entry of eventLog.slice(0, 12)) {
        const li = document.createElement('li');
        const stamp = new Date(entry.timestamp).toLocaleTimeString();
        li.textContent = '[' + stamp + '] ' + entry.summary + (entry.detail ? ' - ' + shorten(entry.detail, 80) : '');
        logList.appendChild(li);
      }
    }

    function pushEvent(entry) {
      eventLog.unshift(entry);
      if (eventLog.length > 12) {
        eventLog.length = 12;
      }
      renderEventLog();
    }

    function applyAgentUpdate(event) {
      if (!event.agentId) {
        return;
      }
      const agent = agentById.get(event.agentId);
      if (!agent) {
        return;
      }

      if (typeof event.status === 'string') {
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
      renderAgentRows();
      updateStatusFromAgents();
    }

    function applySnapshot(snapshot) {
      if (!snapshot) {
        return;
      }

      if (snapshot.agents) {
        for (const id of Object.keys(snapshot.agents)) {
          const incoming = snapshot.agents[id];
          const agent = agentById.get(id);
          if (!agent || !incoming) {
            continue;
          }
          agent.task = incoming.task || agent.task;
          agent.status = incoming.status || agent.status;
          agent.progress = typeof incoming.progress === 'number' ? incoming.progress : agent.progress;
          agent.lastEventAt = incoming.lastEventAt || agent.lastEventAt;
        }
      }

      eventLog.length = 0;
      if (Array.isArray(snapshot.eventLog)) {
        for (const entry of snapshot.eventLog.slice(0, 12)) {
          eventLog.push(entry);
        }
      }

      renderAgentRows();
      renderEventLog();
      setStatusLine(snapshot.statusLine || 'IDLE');
    }

    window.addEventListener('message', (rawEvent) => {
      const message = rawEvent.data;
      if (!message || typeof message.type !== 'string') {
        return;
      }

      if (message.type === 'pixel.snapshot') {
        applySnapshot(message.payload);
        return;
      }

      if (message.type === 'pixel.event') {
        const payload = message.payload || {};
        applyAgentUpdate(payload);
        pushEvent(payload);
      }
    });

    setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const agent of agents) {
        if (agent.status === 'working' && now - agent.lastEventAt > 12000) {
          agent.status = 'idle';
          agent.progress = 0;
          agent.task = 'wacht op event';
          changed = true;
        }
      }
      if (changed) {
        renderAgentRows();
        updateStatusFromAgents();
      }
    }, 2000);

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }

    function drawDesk(x, y, pulse) {
      ctx.fillStyle = '#303a52';
      ctx.fillRect(x, y, 38, 10);
      ctx.fillStyle = '#252d41';
      ctx.fillRect(x + 2, y + 10, 34, 2);

      ctx.fillStyle = '#202534';
      ctx.fillRect(x + 12, y - 9, 14, 8);

      const glow = 95 + Math.floor(35 * Math.sin(pulse));
      ctx.fillStyle = 'rgb(' + glow + ', ' + (glow + 20) + ', 180)';
      ctx.fillRect(x + 13, y - 8, 12, 6);

      ctx.fillStyle = '#171c28';
      ctx.fillRect(x + 6, y + 3, 6, 3);
      ctx.fillRect(x + 26, y + 3, 6, 3);
    }

    function drawOfficeScene(nowMs) {
      ctx.fillStyle = '#131824';
      ctx.fillRect(0, 0, canvas.width, 74);

      for (let i = 0; i < 4; i += 1) {
        const wx = 14 + i * 76;
        ctx.fillStyle = '#293753';
        ctx.fillRect(wx, 12, 56, 28);
        ctx.fillStyle = '#3f567f';
        ctx.fillRect(wx + 2, 14, 52, 24);
        ctx.fillStyle = '#6fa8dc';
        ctx.fillRect(wx + 4, 16, 48, 5);
      }

      for (let i = 0; i < 5; i += 1) {
        const lightX = 24 + i * 62;
        const pulse = 0.5 + Math.sin(nowMs * 0.002 + i) * 0.35;
        const value = 210 + Math.floor(pulse * 25);
        ctx.fillStyle = 'rgb(' + value + ', ' + value + ', ' + (value - 20) + ')';
        ctx.fillRect(lightX, 4, 34, 3);
      }

      ctx.fillStyle = '#20283a';
      ctx.fillRect(0, 74, canvas.width, 106);

      for (let y = 76; y < canvas.height; y += 14) {
        ctx.strokeStyle = '#2c354b';
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }

      for (let x = 10; x < canvas.width; x += 50) {
        drawDesk(x, 78, nowMs * 0.004 + x);
        drawDesk(x + 12, 148, nowMs * 0.003 + x * 0.5);
      }

      ctx.fillStyle = '#2d3952';
      for (const laneY of laneYs) {
        ctx.fillRect(0, laneY + 12, canvas.width, 2);
      }

      ctx.fillStyle = '#3f8d5a';
      ctx.fillRect(5, 146, 8, 10);
      ctx.fillRect(canvas.width - 14, 98, 8, 10);
      ctx.fillStyle = '#2a5f3d';
      ctx.fillRect(6, 156, 6, 2);
      ctx.fillRect(canvas.width - 13, 108, 6, 2);
    }

    function colorForStatus(agent) {
      if (agent.status === 'error') {
        return '#ff6f91';
      }
      if (agent.status === 'completed') {
        return '#68d89a';
      }
      if (agent.status === 'idle') {
        return '#7c88a5';
      }
      return agent.color;
    }

    function drawAgentBlock(agent, nowMs) {
      const wobble = Math.sin(nowMs * 0.004 + agent.bob) * 1.5;
      const x = Math.floor(agent.x);
      const y = Math.floor(agent.y + wobble);
      const step = agent.frame % 16 < 8 ? 0 : 1;

      ctx.fillStyle = '#2f3650';
      ctx.fillRect(x - 1, y - 1, 14, 14);

      ctx.fillStyle = colorForStatus(agent);
      ctx.fillRect(x, y, 12, 12);

      ctx.fillStyle = '#f6f7ff';
      ctx.fillRect(x + 3, y + 3, 2, 2);
      ctx.fillRect(x + 7, y + 3, 2, 2);

      ctx.fillStyle = '#202534';
      ctx.fillRect(x + 4, y + 8, 4, 1);

      ctx.fillStyle = '#2f3650';
      ctx.fillRect(x + 2, y + 12 + step, 2, 2);
      ctx.fillRect(x + 8, y + 13 - step, 2, 2);
    }

    function drawSpeechCloud(agent, nowMs) {
      const wobble = Math.sin(nowMs * 0.004 + agent.bob) * 1.5;
      const blockX = Math.floor(agent.x);
      const blockY = Math.floor(agent.y + wobble);

      ctx.font = '8px monospace';
      const label = agent.name + ': ' + shorten(agent.task || 'wacht op event', 26);
      const textWidth = Math.ceil(ctx.measureText(label).width);
      const cloudWidth = Math.max(74, textWidth + 10);
      const cloudHeight = 13;
      const rawX = blockX + 6 - Math.floor(cloudWidth / 2);
      const cloudX = clamp(rawX, 4, canvas.width - cloudWidth - 4);
      const cloudY = blockY - 20;

      ctx.fillStyle = '#f6f7ff';
      ctx.fillRect(cloudX, cloudY, cloudWidth, cloudHeight);

      ctx.fillStyle = '#2f3650';
      ctx.fillRect(cloudX, cloudY, cloudWidth, 1);
      ctx.fillRect(cloudX, cloudY + cloudHeight - 1, cloudWidth, 1);
      ctx.fillRect(cloudX, cloudY, 1, cloudHeight);
      ctx.fillRect(cloudX + cloudWidth - 1, cloudY, 1, cloudHeight);
      ctx.fillRect(blockX + 5, cloudY + cloudHeight, 3, 2);
      ctx.fillRect(blockX + 6, cloudY + cloudHeight + 2, 1, 2);

      ctx.fillStyle = '#202534';
      ctx.fillText(label, cloudX + 5, cloudY + 9);
    }

    function tickAgent(agent, nowMs) {
      agent.x += agent.vx;
      const targetY = laneYs[agent.lane];
      agent.y += (targetY - agent.y) * 0.08;
      agent.frame += 1;

      if (agent.x > walkBounds.right || agent.x < walkBounds.left) {
        agent.vx *= -1;
        const nextLane = Math.floor(Math.random() * laneYs.length);
        agent.lane = nextLane;
      }
    }

    function draw() {
      const nowMs = performance.now();
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      drawOfficeScene(nowMs);

      for (const agent of agents) {
        tickAgent(agent, nowMs);
        drawSpeechCloud(agent, nowMs);
        drawAgentBlock(agent, nowMs);
      }

      requestAnimationFrame(draw);
    }

    renderAgentRows();
    renderEventLog();
    updateStatusFromAgents();
    vscodeApi.postMessage({ type: 'webview-ready' });

    draw();
  </script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
