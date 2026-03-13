import * as vscode from "vscode";

const VIEW_TYPE = "pixelAgent.visualizer";
const MAX_EVENT_LOG = 30;
const MAX_QUEUED_MESSAGES = 120;
const EVENT_THROTTLE_MS = 350;
const IDLE_TIMEOUT_MS = 8000;
const DEV_SERVER_TIMEOUT_MS = 1200;
const PANEL_READY_TIMEOUT_MS = 2500;
const DEFAULT_DEV_SERVER_URL = "http://127.0.0.1:5173";
const MAX_COMMAND_PREVIEW_LENGTH = 170;
const AUTO_LOAD_EMBEDDED_WHEN_DEV_CONNECTED = false;
const TEST_EVENT_STEP_DELAY_MS = 420;
const AGENT_INACTIVITY_IDLE_MS = 10000;
const MIN_AGENT_IDLE_MS = 2200;
const GIT_STATE_EVENT_DEBOUNCE_MS = 450;
const TYPING_BURST_IDLE_MS = 1600;
const MAX_OPEN_CONTEXT_FILES = 8;
const MAX_CONTEXT_SNIPPET_LENGTH = 120;
const MAX_EXPORTED_RESPONSE_LENGTH = 12000;
const EXPORT_CONFIG_ROOT = "pixelAgent.copilotExport";
const DEFAULT_EXPORT_TIMEOUT_MS = 4500;

type AgentId = "scout" | "builder" | "reviewer";
type AgentStatus = "idle" | "working" | "completed" | "error";

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

interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
}

interface GitRepository {
  rootUri: vscode.Uri;
  state: GitRepositoryState;
}

interface GitRepositoryState {
  HEAD:
    | {
        name?: string;
        commit?: string;
        ahead?: number;
        behind?: number;
      }
    | undefined;
  indexChanges: GitChange[];
  workingTreeChanges: GitChange[];
  mergeChanges: GitChange[];
  onDidChange: vscode.Event<void>;
}

interface GitChange {
  uri: vscode.Uri;
}

interface TypingBurstState {
  filePath: string;
  agentId: AgentId;
  lastChangeAt: number;
  changes: number;
  charsChanged: number;
  pulseIndex: number;
  nextProgress: number;
  heartbeatTimer?: NodeJS.Timeout;
  stopTimer?: NodeJS.Timeout;
}

interface AgentBurstProfile {
  heartbeatMs: number;
  startSummary: string;
  tickSummaries: string[];
  pauseSummary: string;
  minProgress: number;
  maxProgress: number;
  rhythm: number[];
}

interface CopilotInteractionContext {
  workspaceSummary: string;
  diagnosticsSummary: string;
  activeFile?: string;
  languageId?: string;
  selectionPreview?: string;
  openFiles: string[];
}

interface CopilotExportConfig {
  enabled: boolean;
  endpoint: string;
  timeoutMs: number;
  includeOpenFiles: boolean;
  redactSensitiveData: boolean;
}

interface CopilotExportPayload {
  source: string;
  requestId: string;
  timestamp: number;
  prompt: string;
  response: string;
  model: string;
  context: {
    workspaceSummary: string;
    diagnosticsSummary: string;
    activeFile?: string;
    languageId?: string;
    selectionPreview?: string;
    openFiles: string[];
  };
}

type ExtensionToWebviewMessage =
  | { type: "pixel.snapshot"; payload: RuntimeState }
  | { type: "pixel.event"; payload: PixelRuntimeEvent };

type WebviewToExtensionMessage =
  | { type: "webview-ready" }
  | { type: "webview-request-snapshot" }
  | { type: "retry-dev-server" }
  | { type: "load-production" }
  | { type: "load-embedded" };

type PanelMode = "auto" | "production" | "embedded";

const AGENT_LABELS: Record<AgentId, string> = {
  scout: "Scout",
  builder: "Builder",
  reviewer: "Reviewer",
};

const AGENT_BURST_PROFILES: Record<AgentId, AgentBurstProfile> = {
  scout: {
    heartbeatMs: 980,
    startSummary: "Scout verkent context",
    tickSummaries: [
      "Scout leest referenties",
      "Scout vergelijkt aanpakken",
      "Scout markeert aandachtspunten",
    ],
    pauseSummary: "Scout rondt de verkenning af",
    minProgress: 26,
    maxProgress: 86,
    rhythm: [5, 3, 6, 4, 2],
  },
  builder: {
    heartbeatMs: 760,
    startSummary: "Builder start met coderen",
    tickSummaries: [
      "Builder typt featurecode",
      "Builder werkt implementatie bij",
      "Builder plakt de laatste pixels",
    ],
    pauseSummary: "Builder pauzeert even",
    minProgress: 34,
    maxProgress: 94,
    rhythm: [8, 6, 7, 5, 9],
  },
  reviewer: {
    heartbeatMs: 1120,
    startSummary: "Reviewer duikt in checks",
    tickSummaries: [
      "Reviewer checkt randgevallen",
      "Reviewer scherpt validaties aan",
      "Reviewer fixt feedbackpunten",
    ],
    pauseSummary: "Reviewer zet de checks klaar",
    minProgress: 28,
    maxProgress: 90,
    rhythm: [4, 5, 3, 6, 4],
  },
};

let panelRef: vscode.WebviewPanel | undefined;
let panelReady = false;
let queuedMessages: ExtensionToWebviewMessage[] = [];
let preferredPanelMode: PanelMode = "auto";
let panelReadyWatchdog: NodeJS.Timeout | undefined;
let runtimeState = createInitialRuntimeState();
const idleTimers = new Map<AgentId, NodeJS.Timeout>();
const lastDocumentChangeEventAt = new Map<string, number>();
const typingBurstStates = new Map<string, TypingBurstState>();
const balancedAgentRotation: AgentId[] = ["scout", "builder", "reviewer"];
let balancedAgentIndex = 0;

export function activate(context: vscode.ExtensionContext) {
  runtimeState = createInitialRuntimeState();

  const panelCommand = vscode.commands.registerCommand(
    "pixelAgent.openPanel",
    () => {
      openPixelPanel(context);
    },
  );

  const emitTestEventsCommand = vscode.commands.registerCommand(
    "pixelAgent.emitTestEvents",
    () => {
      openPixelPanel(context);
      emitSyntheticTestEvents();
      void vscode.window.showInformationMessage(
        "Pixel Agent test-events verstuurd.",
      );
    },
  );

  context.subscriptions.push(panelCommand, emitTestEventsCommand);

  const participant = vscode.chat.createChatParticipant(
    "pixel-copilot-agent.pixel",
    async (request, _chatContext, stream, token) => {
      const prompt = request.prompt.trim();
      const requestLabel = request.command
        ? `/${request.command}`
        : prompt || "lege prompt";
      const assignedAgent = pickAgentForPrompt(prompt, request.command);

      emitRuntimeEvent({
        type: "chat.received",
        timestamp: Date.now(),
        summary: "@pixel aanvraag ontvangen",
        detail: requestLabel,
        agentId: assignedAgent,
        status: "working",
        progress: 15,
      });

      if (request.command === "show") {
        openPixelPanel(context);
        stream.markdown("Pixel panel geopend.");
        emitRuntimeEvent({
          type: "chat.completed",
          timestamp: Date.now(),
          summary: "@pixel /show uitgevoerd",
          detail: "Panel geopend op verzoek.",
          agentId: assignedAgent,
          status: "completed",
          progress: 100,
        });
        scheduleAgentIdle(assignedAgent, IDLE_TIMEOUT_MS);
        return;
      }

      const requestId = createRequestId();

      try {
        const interactionContext = getCopilotInteractionContext();

        emitRuntimeEvent({
          type: "chat.processing",
          timestamp: Date.now(),
          summary: "@pixel analyseert prompt en context",
          detail: `requestId=${requestId}`,
          agentId: assignedAgent,
          status: "working",
          progress: 45,
        });

        stream.markdown("Ik ben je @pixel agent.\\n\\n");
        stream.markdown(`Vraag: ${prompt || "geen vraag meegegeven"}\\n\\n`);

        const model = await selectCopilotChatModel();
        if (!model) {
          throw new Error(
            "Geen beschikbaar Copilot model gevonden via vscode.lm.selectChatModels.",
          );
        }

        const modelLabel = formatModelLabel(model);
        emitRuntimeEvent({
          type: "copilot.modelSelected",
          timestamp: Date.now(),
          summary: "Copilot model geselecteerd",
          detail: modelLabel,
          agentId: assignedAgent,
          status: "working",
          progress: 58,
        });
        stream.markdown(`Model: ${modelLabel}\\n\\n`);

        emitRuntimeEvent({
          type: "chat.streaming",
          timestamp: Date.now(),
          summary: "@pixel response stream actief",
          detail: "Streaming output van geselecteerd Copilot model.",
          agentId: assignedAgent,
          status: "working",
          progress: 70,
        });

        const responseText = await streamCopilotResponse(
          model,
          prompt,
          interactionContext,
          stream,
          token,
        );
        const normalizedResponse =
          responseText.trim() || "(geen modeloutput ontvangen)";
        if (!responseText.trim()) {
          stream.markdown(`${normalizedResponse}\\n\\n`);
        }

        const exportResult = await sendCopilotInteractionToExternal(
          {
            source: "pixel-copilot-agent",
            requestId,
            timestamp: Date.now(),
            prompt,
            response: shorten(normalizedResponse, MAX_EXPORTED_RESPONSE_LENGTH),
            model: modelLabel,
            context: {
              workspaceSummary: interactionContext.workspaceSummary,
              diagnosticsSummary: interactionContext.diagnosticsSummary,
              activeFile: interactionContext.activeFile,
              languageId: interactionContext.languageId,
              selectionPreview: interactionContext.selectionPreview,
              openFiles: interactionContext.openFiles,
            },
          },
          assignedAgent,
        );

        if (exportResult) {
          emitRuntimeEvent({
            type: "copilot.exportSent",
            timestamp: Date.now(),
            summary: "Copilot payload extern verzonden",
            detail: `requestId=${requestId}`,
            agentId: assignedAgent,
            status: "working",
            progress: 92,
          });
        }

        emitRuntimeEvent({
          type: "chat.completed",
          timestamp: Date.now(),
          summary: "@pixel antwoord afgerond",
          detail: requestLabel,
          agentId: assignedAgent,
          status: "completed",
          progress: 100,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitRuntimeEvent({
          type: "chat.error",
          timestamp: Date.now(),
          summary: "@pixel fout tijdens afhandeling",
          detail: message,
          agentId: assignedAgent,
          status: "error",
          progress: 100,
        });
        stream.markdown(`Fout tijdens verwerken: ${message}`);
      } finally {
        scheduleAgentIdle(assignedAgent, IDLE_TIMEOUT_MS);
      }
    },
  );

  participant.iconPath = new vscode.ThemeIcon("hubot");
  participant.followupProvider = {
    provideFollowups() {
      return [
        {
          prompt:
            "Analyseer deze map en stel een plan voor mijn volgende commit.",
          label: "Analyse workspace",
        },
        {
          prompt: "/show",
          label: "Open pixel panel",
        },
      ];
    },
  };

  context.subscriptions.push(participant);
  registerRuntimeListeners(context);
  void registerGitRuntimeListeners(context);

  emitRuntimeEvent({
    type: "extension.activated",
    timestamp: Date.now(),
    summary: "Pixel extensie geactiveerd",
    detail: getWorkspaceSummary(),
    agentId: "scout",
    status: "working",
    progress: 20,
  });
  scheduleAgentIdle("scout", 4000);
}

export function deactivate() {
  for (const timer of idleTimers.values()) {
    clearTimeout(timer);
  }
  idleTimers.clear();

  for (const state of typingBurstStates.values()) {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
    }
    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
    }
  }
  typingBurstStates.clear();
}

function registerRuntimeListeners(context: vscode.ExtensionContext) {
  const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.uri.scheme !== "file") {
      return;
    }
    if (event.contentChanges.length === 0) {
      return;
    }

    const key = event.document.uri.toString();
    const now = Date.now();
    const filePath = normalizePath(event.document.uri);
    const changedChars = estimateChangedCharacters(event.contentChanges);
    const typingAgentId = startOrUpdateTypingBurst(
      key,
      filePath,
      changedChars,
      now,
    );

    const lastAt = lastDocumentChangeEventAt.get(key) ?? 0;
    if (now - lastAt < EVENT_THROTTLE_MS) {
      return;
    }
    lastDocumentChangeEventAt.set(key, now);

    emitRuntimeEvent({
      type: "workspace.fileChanged",
      timestamp: now,
      summary: "Bestand gewijzigd",
      detail: filePath,
      filePath,
      agentId: typingAgentId,
      status: "working",
      progress: 35,
    });
    scheduleAgentIdle(typingAgentId, IDLE_TIMEOUT_MS);
  });

  const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
    if (document.uri.scheme !== "file") {
      return;
    }

    stopTypingBurst(document.uri.toString(), false);

    const filePath = normalizePath(document.uri);
    const agentId = inferAgentForFilePath(filePath);
    emitRuntimeEvent({
      type: "workspace.fileSaved",
      timestamp: Date.now(),
      summary: "💾 Bestand opgeslagen",
      detail: filePath,
      filePath,
      agentId,
      status: "completed",
      progress: 100,
    });
    scheduleAgentIdle(agentId, IDLE_TIMEOUT_MS);
  });

  const createListener = vscode.workspace.onDidCreateFiles((event) => {
    const now = Date.now();
    for (const uri of event.files) {
      const filePath = normalizePath(uri);
      const agentId = inferAgentForFilePath(filePath);
      emitRuntimeEvent({
        type: "workspace.fileCreated",
        timestamp: now,
        summary: "✨ Bestand aangemaakt",
        detail: filePath,
        filePath,
        agentId,
        status: "working",
        progress: 50,
      });
      scheduleAgentIdle(agentId, IDLE_TIMEOUT_MS);
    }
  });

  const deleteListener = vscode.workspace.onDidDeleteFiles((event) => {
    const now = Date.now();
    for (const uri of event.files) {
      stopTypingBurst(uri.toString(), false);
      const filePath = normalizePath(uri);
      const agentId = inferAgentForFilePath(filePath);
      emitRuntimeEvent({
        type: "workspace.fileDeleted",
        timestamp: now,
        summary: "🗑️ Bestand verwijderd",
        detail: filePath,
        filePath,
        agentId,
        status: "working",
        progress: 55,
      });
      scheduleAgentIdle(agentId, IDLE_TIMEOUT_MS);
    }
  });

  const renameListener = vscode.workspace.onDidRenameFiles((event) => {
    const now = Date.now();
    for (const change of event.files) {
      stopTypingBurst(change.oldUri.toString(), false);
      const from = normalizePath(change.oldUri);
      const to = normalizePath(change.newUri);
      const agentId = inferAgentForFilePath(to);
      emitRuntimeEvent({
        type: "workspace.fileRenamed",
        timestamp: now,
        summary: "🔁 Bestand hernoemd",
        detail: `${from} -> ${to}`,
        filePath: to,
        agentId,
        status: "working",
        progress: 45,
      });
      scheduleAgentIdle(agentId, IDLE_TIMEOUT_MS);
    }
  });

  const diagnosticsListener = vscode.languages.onDidChangeDiagnostics(
    (event) => {
      const summary = collectDiagnosticsSummary(event.uris);
      if (summary.total === 0) {
        return;
      }

      const status: AgentStatus = summary.errors > 0 ? "error" : "completed";
      emitRuntimeEvent({
        type: "diagnostics.updated",
        timestamp: Date.now(),
        summary: `Diagnostics ${summary.errors} errors, ${summary.warnings} warnings`,
        detail: summary.sampleFile ?? "workspace",
        agentId: "reviewer",
        status,
        progress: 100,
      });
      scheduleAgentIdle("reviewer", IDLE_TIMEOUT_MS + 2000);
    },
  );

  const taskStartListener = vscode.tasks.onDidStartTaskProcess((event) => {
    const taskName = event.execution.task.name;
    const agentId = inferAgentForTask(taskName);
    const taskType = describeTaskFriendly(taskName);
    emitRuntimeEvent({
      type: "task.started",
      timestamp: Date.now(),
      summary: `⚙️ ${taskType} gestart`,
      detail: `${taskName}\nproces gestart`,
      agentId,
      status: "working",
      progress: 60,
    });
    scheduleAgentIdle(agentId, IDLE_TIMEOUT_MS + 3000);
  });

  const taskEndListener = vscode.tasks.onDidEndTaskProcess((event) => {
    const taskName = event.execution.task.name;
    const agentId = inferAgentForTask(taskName);
    const taskType = describeTaskFriendly(taskName);
    const code = typeof event.exitCode === "number" ? event.exitCode : 0;
    const status: AgentStatus = code === 0 ? "completed" : "error";
    emitRuntimeEvent({
      type: "task.finished",
      timestamp: Date.now(),
      summary:
        code === 0 ? `✅ ${taskType} afgerond` : `❌ ${taskType} gefaald`,
      detail: `${taskName}\nexit ${code}`,
      agentId,
      status,
      progress: 100,
    });
    scheduleAgentIdle(agentId, IDLE_TIMEOUT_MS + 3000);
  });

  const editorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!editor || editor.document.uri.scheme !== "file") {
      return;
    }

    const filePath = normalizePath(editor.document.uri);
    const agentId = inferAgentForFilePath(filePath);
    emitRuntimeEvent({
      type: "workspace.activeEditorChanged",
      timestamp: Date.now(),
      summary: "📄 Actieve editor gewijzigd",
      detail: filePath,
      filePath,
      agentId,
      status: "working",
      progress: 25,
    });
    scheduleAgentIdle(agentId, 4500);
  });

  const terminalOpenListener = vscode.window.onDidOpenTerminal((terminal) => {
    const agentId = nextBalancedAgent();
    emitRuntimeEvent({
      type: "terminal.opened",
      timestamp: Date.now(),
      summary: "🖥️ Terminal geopend",
      detail: terminal.name,
      agentId,
      status: "working",
      progress: 20,
    });
    scheduleAgentIdle(agentId, 5000);
  });

  const terminalCloseListener = vscode.window.onDidCloseTerminal((terminal) => {
    const agentId = nextBalancedAgent();
    emitRuntimeEvent({
      type: "terminal.closed",
      timestamp: Date.now(),
      summary: "🧹 Terminal gesloten",
      detail: terminal.name,
      agentId,
      status: "completed",
      progress: 100,
    });
    scheduleAgentIdle(agentId, 4500);
  });

  const supportsShellExecStart =
    typeof (
      vscode.window as unknown as {
        onDidStartTerminalShellExecution?: vscode.Event<vscode.TerminalShellExecutionStartEvent>;
      }
    ).onDidStartTerminalShellExecution === "function";

  const supportsShellExecEnd =
    typeof (
      vscode.window as unknown as {
        onDidEndTerminalShellExecution?: vscode.Event<vscode.TerminalShellExecutionEndEvent>;
      }
    ).onDidEndTerminalShellExecution === "function";

  const terminalCommandStartListener = supportsShellExecStart
    ? vscode.window.onDidStartTerminalShellExecution((event) => {
        const command = sanitizeCommandPreview(
          event.execution.commandLine.value || "",
        );
        const terminalName = event.terminal.name || "terminal";
        const agentId = inferAgentForCommandLine(command);
        const friendly = buildFriendlyTerminalMessage(
          command,
          terminalName,
          "started",
        );

        emitRuntimeEvent({
          type: "terminal.commandStarted",
          timestamp: Date.now(),
          summary: friendly.summary,
          detail: friendly.detail,
          agentId,
          status: "working",
          progress: 65,
        });
        scheduleAgentIdle(agentId, IDLE_TIMEOUT_MS + 2500);
      })
    : undefined;

  const terminalCommandEndListener = supportsShellExecEnd
    ? vscode.window.onDidEndTerminalShellExecution((event) => {
        const command = sanitizeCommandPreview(
          event.execution.commandLine.value || "",
        );
        const terminalName = event.terminal.name || "terminal";
        const exitCode = event.exitCode;

        const status: AgentStatus =
          exitCode === undefined
            ? "completed"
            : exitCode === 0
              ? "completed"
              : "error";
        const friendly = buildFriendlyTerminalMessage(
          command,
          terminalName,
          "finished",
          exitCode,
        );

        const agentId = inferAgentForCommandLine(command);
        emitRuntimeEvent({
          type: "terminal.commandFinished",
          timestamp: Date.now(),
          summary: friendly.summary,
          detail: friendly.detail,
          agentId,
          status,
          progress: 100,
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
    terminalCloseListener,
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
    return "geen geopende workspacefolder";
  }

  const names = folders.map((folder) => folder.name).join(", ");
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

  return shorten(selected.replace(/\s+/g, " "), MAX_CONTEXT_SNIPPET_LENGTH);
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

function createRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getOpenContextFiles(): string[] {
  const deduped = new Set<string>();
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.scheme !== "file") {
      continue;
    }
    deduped.add(normalizePath(editor.document.uri));
    if (deduped.size >= MAX_OPEN_CONTEXT_FILES) {
      break;
    }
  }

  return [...deduped];
}

function getCopilotInteractionContext(): CopilotInteractionContext {
  const editor = vscode.window.activeTextEditor;
  const activeFile =
    editor && editor.document.uri.scheme === "file"
      ? normalizePath(editor.document.uri)
      : undefined;

  return {
    workspaceSummary: getWorkspaceSummary(),
    diagnosticsSummary: getDiagnosticsSummary(),
    activeFile,
    languageId: editor?.document.languageId,
    selectionPreview: getActiveSelectionPreview(),
    openFiles: getOpenContextFiles(),
  };
}

function buildCopilotPrompt(
  prompt: string,
  context: CopilotInteractionContext,
): string {
  const lines: string[] = [];
  lines.push(
    "Je bent @pixel, een VS Code assistent voor code- en workspacevragen.",
  );
  lines.push("Geef een direct, concreet antwoord in markdown.");
  lines.push("");
  lines.push(`Gebruikersvraag: ${prompt || "(lege vraag)"}`);
  lines.push(`Workspace: ${context.workspaceSummary}`);
  lines.push(`Diagnostics: ${context.diagnosticsSummary}`);

  if (context.activeFile) {
    lines.push(`Actief bestand: ${context.activeFile}`);
  }
  if (context.languageId) {
    lines.push(`Taal: ${context.languageId}`);
  }
  if (context.selectionPreview) {
    lines.push(`Selectie: ${context.selectionPreview}`);
  }
  if (context.openFiles.length > 0) {
    lines.push(`Geopende bestanden: ${context.openFiles.join(", ")}`);
  }

  return lines.join("\n");
}

async function selectCopilotChatModel(): Promise<
  vscode.LanguageModelChat | undefined
> {
  const preferred = await vscode.lm.selectChatModels({ vendor: "copilot" });
  if (preferred.length > 0) {
    return preferred[0];
  }

  const fallback = await vscode.lm.selectChatModels();
  return fallback[0];
}

function formatModelLabel(model: vscode.LanguageModelChat): string {
  const typed = model as unknown as {
    vendor?: string;
    family?: string;
    id?: string;
    name?: string;
  };
  const parts = [typed.vendor, typed.family, typed.id || typed.name].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return parts.length > 0 ? parts.join("/") : "copilot-model";
}

function extractModelChunkText(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (!chunk || typeof chunk !== "object") {
    return "";
  }

  const typed = chunk as { value?: unknown; text?: unknown };
  if (typeof typed.value === "string") {
    return typed.value;
  }
  if (typeof typed.text === "string") {
    return typed.text;
  }

  return "";
}

async function streamCopilotResponse(
  model: vscode.LanguageModelChat,
  prompt: string,
  context: CopilotInteractionContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<string> {
  const promptWithContext = buildCopilotPrompt(prompt, context);
  const request = await model.sendRequest(
    [vscode.LanguageModelChatMessage.User(promptWithContext)],
    {},
    token,
  );

  let fullResponse = "";
  for await (const chunk of request.text) {
    const text = extractModelChunkText(chunk);
    if (!text) {
      continue;
    }

    fullResponse += text;
    stream.markdown(text);
  }

  return fullResponse;
}

function getCopilotExportConfig(): CopilotExportConfig {
  const config = vscode.workspace.getConfiguration(EXPORT_CONFIG_ROOT);
  const timeoutMs = config.get<number>("timeoutMs", DEFAULT_EXPORT_TIMEOUT_MS);

  return {
    enabled: config.get<boolean>("enabled", false),
    endpoint: (config.get<string>("endpoint", "") || "").trim(),
    timeoutMs: Math.max(500, Math.min(60000, Math.round(timeoutMs))),
    includeOpenFiles: config.get<boolean>("includeOpenFiles", true),
    redactSensitiveData: config.get<boolean>("redactSensitiveData", true),
  };
}

function redactSensitiveText(value: string): string {
  return value.replace(
    /(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi,
    (_match, key: string) => `${key}=***`,
  );
}

async function sendCopilotInteractionToExternal(
  payload: CopilotExportPayload,
  agentId: AgentId,
): Promise<boolean> {
  const exportConfig = getCopilotExportConfig();
  if (!exportConfig.enabled) {
    return false;
  }
  if (!exportConfig.endpoint) {
    emitRuntimeEvent({
      type: "copilot.exportSkipped",
      timestamp: Date.now(),
      summary: "Externe export overgeslagen",
      detail: "pixelAgent.copilotExport.endpoint is leeg.",
      agentId,
      status: "working",
      progress: 88,
    });
    return false;
  }
  if (typeof fetch !== "function") {
    emitRuntimeEvent({
      type: "copilot.exportSkipped",
      timestamp: Date.now(),
      summary: "Externe export niet beschikbaar",
      detail: "fetch API ontbreekt in deze extension host.",
      agentId,
      status: "working",
      progress: 88,
    });
    return false;
  }

  const body: CopilotExportPayload = {
    ...payload,
    prompt: exportConfig.redactSensitiveData
      ? redactSensitiveText(payload.prompt)
      : payload.prompt,
    response: exportConfig.redactSensitiveData
      ? redactSensitiveText(payload.response)
      : payload.response,
    context: {
      ...payload.context,
      selectionPreview:
        exportConfig.redactSensitiveData && payload.context.selectionPreview
          ? redactSensitiveText(payload.context.selectionPreview)
          : payload.context.selectionPreview,
      openFiles: exportConfig.includeOpenFiles ? payload.context.openFiles : [],
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), exportConfig.timeoutMs);

  try {
    const response = await fetch(exportConfig.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitRuntimeEvent({
      type: "copilot.exportFailed",
      timestamp: Date.now(),
      summary: "Externe export mislukt",
      detail: message,
      agentId,
      status: "working",
      progress: 88,
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
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
    if (uri.scheme !== "file") {
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
    sampleFile: uris.length > 0 ? normalizePath(uris[0]) : undefined,
  };
}

function estimateChangedCharacters(
  changes: readonly vscode.TextDocumentContentChangeEvent[],
): number {
  let total = 0;
  for (const change of changes) {
    total += Math.max(change.rangeLength, change.text.length);
  }
  return Math.max(1, Math.min(2000, total));
}

function inferAgentForFilePath(filePath: string): AgentId {
  const lower = filePath.toLowerCase();
  if (/(test|spec|lint|eslint|qa|diagnostic|ci)/.test(lower)) {
    return "reviewer";
  }
  if (/(readme|docs?|\.md$|changelog|notes)/.test(lower)) {
    return "scout";
  }
  return "builder";
}

function getBurstProfile(agentId: AgentId): AgentBurstProfile {
  return AGENT_BURST_PROFILES[agentId];
}

function nextBurstProgress(state: TypingBurstState): number {
  const profile = getBurstProfile(state.agentId);
  const rhythmStep = profile.rhythm[state.pulseIndex % profile.rhythm.length];
  state.pulseIndex += 1;

  const hesitation = state.changes % 6 === 0 ? -2 : 0;
  const next = state.nextProgress + rhythmStep + hesitation;
  return Math.max(profile.minProgress, Math.min(profile.maxProgress, next));
}

function startOrUpdateTypingBurst(
  key: string,
  filePath: string,
  changedChars: number,
  now: number,
): AgentId {
  let state = typingBurstStates.get(key);

  if (!state) {
    const agentId = inferAgentForFilePath(filePath);
    const profile = getBurstProfile(agentId);

    state = {
      filePath,
      agentId,
      lastChangeAt: now,
      changes: 0,
      charsChanged: 0,
      pulseIndex: 0,
      nextProgress: profile.minProgress,
    };

    state.heartbeatTimer = setInterval(() => {
      const active = typingBurstStates.get(key);
      if (!active) {
        return;
      }

      if (Date.now() - active.lastChangeAt > TYPING_BURST_IDLE_MS) {
        return;
      }

      const activeProfile = getBurstProfile(active.agentId);
      active.nextProgress = nextBurstProgress(active);
      const tickSummary =
        activeProfile.tickSummaries[
          active.pulseIndex % activeProfile.tickSummaries.length
        ];

      emitRuntimeEvent({
        type: "workspace.typingBurstTick",
        timestamp: Date.now(),
        summary: tickSummary,
        detail: `${active.filePath} | ${active.changes} edits, ${active.charsChanged} chars`,
        filePath: active.filePath,
        agentId: active.agentId,
        status: "working",
        progress: active.nextProgress,
      });
      scheduleAgentIdle(active.agentId, IDLE_TIMEOUT_MS);
    }, profile.heartbeatMs);

    typingBurstStates.set(key, state);

    emitRuntimeEvent({
      type: "workspace.typingBurstStarted",
      timestamp: now,
      summary: profile.startSummary,
      detail: filePath,
      filePath,
      agentId,
      status: "working",
      progress: state.nextProgress,
    });
    scheduleAgentIdle(agentId, IDLE_TIMEOUT_MS);
  }

  state.filePath = filePath;
  state.lastChangeAt = now;
  state.changes += 1;
  state.charsChanged += changedChars;

  if (state.changes % 5 === 0) {
    state.nextProgress = Math.max(
      getBurstProfile(state.agentId).minProgress,
      state.nextProgress - 1,
    );
  }

  scheduleTypingBurstStop(key);
  return state.agentId;
}

function scheduleTypingBurstStop(key: string) {
  const state = typingBurstStates.get(key);
  if (!state) {
    return;
  }

  if (state.stopTimer) {
    clearTimeout(state.stopTimer);
  }

  state.stopTimer = setTimeout(() => {
    stopTypingBurst(key, true);
  }, TYPING_BURST_IDLE_MS);
}

function stopTypingBurst(key: string, emitPauseEvent: boolean) {
  const state = typingBurstStates.get(key);
  if (!state) {
    return;
  }

  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
  }
  if (state.stopTimer) {
    clearTimeout(state.stopTimer);
  }

  typingBurstStates.delete(key);

  if (!emitPauseEvent) {
    return;
  }

  const profile = getBurstProfile(state.agentId);

  emitRuntimeEvent({
    type: "workspace.typingBurstIdle",
    timestamp: Date.now(),
    summary: profile.pauseSummary,
    detail: `${state.filePath} | ${state.changes} edits, ${state.charsChanged} chars`,
    filePath: state.filePath,
    agentId: state.agentId,
    status: "completed",
    progress: 100,
  });
  scheduleAgentIdle(state.agentId, IDLE_TIMEOUT_MS);
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

function createGitUnavailableState(message: string): GitViewState {
  return {
    ...createDefaultGitState(),
    message,
  };
}

function pickPrimaryRepository(
  repositories: GitRepository[],
): GitRepository | undefined {
  if (repositories.length === 0) {
    return undefined;
  }

  const editorUri = vscode.window.activeTextEditor?.document.uri;
  if (editorUri?.scheme === "file") {
    const editorPath = editorUri.fsPath;
    const matching = repositories
      .filter((repo) => editorPath.startsWith(repo.rootUri.fsPath))
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length);
    if (matching.length > 0) {
      return matching[0];
    }
  }

  return repositories[0];
}

function collectGitViewState(api: GitApi): GitViewState {
  const repository = pickPrimaryRepository(api.repositories);
  if (!repository) {
    return createGitUnavailableState(
      "Geen Git repository gevonden in deze workspace.",
    );
  }

  const head = repository.state.HEAD;
  const branch = head?.name || "(detached)";
  const ahead = head?.ahead ?? 0;
  const behind = head?.behind ?? 0;
  const staged = repository.state.indexChanges.length;
  const unstaged = repository.state.workingTreeChanges.length;
  const conflicts = repository.state.mergeChanges.length;
  const hasChanges = staged + unstaged + conflicts > 0;
  const lastCommit = head?.commit ? head.commit.slice(0, 7) : "-";
  const repositoryRoot =
    normalizePath(repository.rootUri) || repository.rootUri.fsPath;

  const message =
    conflicts > 0
      ? `${conflicts} conflict(en) open`
      : hasChanges
        ? `${staged} staged, ${unstaged} unstaged`
        : "Werkboom schoon";

  return {
    available: true,
    branch,
    ahead,
    behind,
    staged,
    unstaged,
    conflicts,
    hasChanges,
    lastCommit,
    repositoryRoot,
    message,
  };
}

function describeGitState(git: GitViewState): string {
  return `staged ${git.staged}, unstaged ${git.unstaged}, conflicts ${git.conflicts}, ahead ${git.ahead}, behind ${git.behind}, head ${git.lastCommit}`;
}

function buildGitStateSignature(git: GitViewState): string {
  return [
    git.available,
    git.branch,
    git.ahead,
    git.behind,
    git.staged,
    git.unstaged,
    git.conflicts,
    git.hasChanges,
    git.lastCommit,
    git.repositoryRoot,
    git.message,
  ].join("|");
}

function buildGitRuntimeEvent(git: GitViewState): PixelRuntimeEvent {
  if (!git.available) {
    return {
      type: "git.unavailable",
      timestamp: Date.now(),
      summary: "Git status niet beschikbaar",
      detail: git.message,
      agentId: "scout",
      status: "completed",
      progress: 100,
      git,
    };
  }

  if (git.conflicts > 0) {
    return {
      type: "git.conflictsDetected",
      timestamp: Date.now(),
      summary: `Git conflicts gedetecteerd (${git.conflicts})`,
      detail: `${git.branch} | ${describeGitState(git)}`,
      agentId: "reviewer",
      status: "error",
      progress: 100,
      git,
    };
  }

  if (git.hasChanges) {
    return {
      type: "git.stateChanged",
      timestamp: Date.now(),
      summary: `Git status gewijzigd op ${git.branch}`,
      detail: describeGitState(git),
      agentId: "builder",
      status: "working",
      progress: 70,
      git,
    };
  }

  return {
    type: "git.clean",
    timestamp: Date.now(),
    summary: `Git werkboom schoon op ${git.branch}`,
    detail: describeGitState(git),
    agentId: "scout",
    status: "completed",
    progress: 100,
    git,
  };
}

async function registerGitRuntimeListeners(context: vscode.ExtensionContext) {
  const gitExtension =
    vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!gitExtension) {
    const unavailable = createGitUnavailableState(
      "Git extension niet gevonden.",
    );
    runtimeState.git = unavailable;
    emitRuntimeEvent(buildGitRuntimeEvent(unavailable));
    return;
  }

  let gitApi: GitApi | undefined;
  try {
    const gitExports = gitExtension.isActive
      ? gitExtension.exports
      : await gitExtension.activate();
    gitApi = gitExports?.getAPI(1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unavailable = createGitUnavailableState(
      `Git API kon niet starten: ${message}`,
    );
    runtimeState.git = unavailable;
    emitRuntimeEvent(buildGitRuntimeEvent(unavailable));
    return;
  }

  if (!gitApi) {
    const unavailable = createGitUnavailableState("Git API niet beschikbaar.");
    runtimeState.git = unavailable;
    emitRuntimeEvent(buildGitRuntimeEvent(unavailable));
    return;
  }

  const repoStateListeners = new Map<string, vscode.Disposable>();
  let refreshTimer: NodeJS.Timeout | undefined;
  let lastSignature = "";

  const refreshGitState = (emitEvent: boolean) => {
    const nextState = collectGitViewState(gitApi);
    runtimeState.git = nextState;

    const signature = buildGitStateSignature(nextState);
    if (signature === lastSignature) {
      return;
    }
    lastSignature = signature;

    if (!emitEvent) {
      return;
    }

    const event = buildGitRuntimeEvent(nextState);
    emitRuntimeEvent(event);
    if (event.agentId) {
      scheduleAgentIdle(event.agentId, IDLE_TIMEOUT_MS + 2500);
    }
  };

  const scheduleRefresh = (emitEvent = true) => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }

    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refreshGitState(emitEvent);
    }, GIT_STATE_EVENT_DEBOUNCE_MS);
  };

  const trackRepository = (repository: GitRepository) => {
    const key = repository.rootUri.toString();
    if (repoStateListeners.has(key)) {
      return;
    }

    const listener = repository.state.onDidChange(() => {
      scheduleRefresh(true);
    });
    repoStateListeners.set(key, listener);
  };

  const untrackRepository = (repository: GitRepository) => {
    const key = repository.rootUri.toString();
    const listener = repoStateListeners.get(key);
    if (!listener) {
      return;
    }

    listener.dispose();
    repoStateListeners.delete(key);
  };

  for (const repository of gitApi.repositories) {
    trackRepository(repository);
  }

  const openRepositoryListener = gitApi.onDidOpenRepository((repository) => {
    trackRepository(repository);
    scheduleRefresh(true);
  });

  const closeRepositoryListener = gitApi.onDidCloseRepository((repository) => {
    untrackRepository(repository);
    scheduleRefresh(true);
  });

  context.subscriptions.push(openRepositoryListener, closeRepositoryListener, {
    dispose() {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      for (const listener of repoStateListeners.values()) {
        listener.dispose();
      }
      repoStateListeners.clear();
    },
  });

  refreshGitState(false);

  emitRuntimeEvent({
    type: "git.monitoringReady",
    timestamp: Date.now(),
    summary: "Git monitoring actief",
    detail: `${runtimeState.git.repositoryRoot} | ${runtimeState.git.branch}`,
    agentId: "scout",
    status: "completed",
    progress: 100,
    git: runtimeState.git,
  });
  scheduleAgentIdle("scout", 4000);
}

function pickAgentForPrompt(prompt: string, command?: string): AgentId {
  if (command === "show") {
    return "scout";
  }

  const text = prompt.toLowerCase();
  if (/review|lint|test|error|bug|diagnostic/.test(text)) {
    return "reviewer";
  }
  if (/build|schrijf|write|fix|implement|code/.test(text)) {
    return "builder";
  }
  return "scout";
}

function nextBalancedAgent(): AgentId {
  const agentId =
    balancedAgentRotation[balancedAgentIndex % balancedAgentRotation.length];
  balancedAgentIndex = (balancedAgentIndex + 1) % balancedAgentRotation.length;
  return agentId;
}

function describeTaskFriendly(taskName: string): string {
  const lower = taskName.toLowerCase();
  if (/lint|test|review|check|diagnostic|audit|typecheck/.test(lower)) {
    return "kwaliteitscheck";
  }
  if (/build|compile|bundle|pack|release|generate/.test(lower)) {
    return "build-run";
  }
  if (/watch|serve|dev|start/.test(lower)) {
    return "dev-run";
  }
  if (/git|status|log|diff|scan|analy/.test(lower)) {
    return "verkenning";
  }
  return "taak";
}

function describeCommandCategory(commandLine: string): string {
  const lower = commandLine.toLowerCase();

  if (/\bgit\s+(status|log|diff|show|branch|blame)\b/.test(lower)) {
    return "git-onderzoek";
  }
  if (
    /\bgit\s+(add|commit|push|pull|merge|rebase|cherry-pick|stash)\b/.test(
      lower,
    )
  ) {
    return "git-werkflow";
  }
  if (/(npm|pnpm|yarn)\s+(install|add|remove|update)/.test(lower)) {
    return "dependencies";
  }
  if (/\b(build|compile|bundle|tsc|vite\s+build)\b/.test(lower)) {
    return "build";
  }
  if (/\b(dev|serve|start|watch|vite)\b/.test(lower)) {
    return "dev-server";
  }
  if (/\b(test|lint|eslint|vitest|jest|check|typecheck|audit)\b/.test(lower)) {
    return "checks";
  }
  if (/\b(format|prettier)\b/.test(lower)) {
    return "formatting";
  }

  return "terminal";
}

function buildFriendlyTerminalMessage(
  commandLine: string,
  terminalName: string,
  phase: "started" | "finished",
  exitCode?: number,
): { summary: string; detail: string } {
  const category = describeCommandCategory(commandLine);
  const agentId = inferAgentForCommandLine(commandLine);
  const emoji =
    agentId === "builder" ? "🛠️" : agentId === "reviewer" ? "🔎" : "🧭";

  const actionLabel: Record<string, string> = {
    "git-onderzoek": "Git check",
    "git-werkflow": "Git actie",
    dependencies: "Dependencies",
    build: "Build",
    "dev-server": "Dev run",
    checks: "Checks",
    formatting: "Formatting",
    terminal: "Terminal commando",
  };

  const label = actionLabel[category] || "Terminal commando";

  if (phase === "started") {
    return {
      summary: `${emoji} ${label} gestart`,
      detail: `${terminalName} bereidt uitvoering voor\n${commandLine}`,
    };
  }

  if (typeof exitCode === "number" && exitCode !== 0) {
    return {
      summary: `${emoji} ${label} mislukt`,
      detail: `${terminalName} stopte met exit ${exitCode}\n${commandLine}`,
    };
  }

  if (typeof exitCode === "number") {
    return {
      summary: `${emoji} ${label} afgerond`,
      detail: `${terminalName} klaar met exit ${exitCode}\n${commandLine}`,
    };
  }

  return {
    summary: `${emoji} ${label} afgerond`,
    detail: `${terminalName} rondde af zonder exitcode\n${commandLine}`,
  };
}

function inferAgentForTask(taskName: string): AgentId {
  const lower = taskName.toLowerCase();
  if (/lint|test|review|check|diagnostic|audit|typecheck/.test(lower)) {
    return "reviewer";
  }
  if (
    /build|compile|bundle|fix|generate|pack|release|dev|serve|watch|start/.test(
      lower,
    )
  ) {
    return "builder";
  }
  if (/scan|analy|readme|docs?|status|log|diff/.test(lower)) {
    return "scout";
  }
  return nextBalancedAgent();
}

function inferAgentForCommandLine(commandLine: string): AgentId {
  const lower = commandLine.toLowerCase();
  if (/\bgit\s+(status|log|diff|show|branch|blame)\b/.test(lower)) {
    return "scout";
  }
  if (/lint|eslint|test|review|diagnostic|check|audit|typecheck/.test(lower)) {
    return "reviewer";
  }
  if (
    /\bgit\s+(add|commit|push|pull|merge|rebase|cherry-pick|stash)\b/.test(
      lower,
    )
  ) {
    return "builder";
  }
  if (
    /build|compile|vite|npm run|pnpm|yarn|tsc|bundle|install|dev|serve|start|watch/.test(
      lower,
    )
  ) {
    return "builder";
  }
  return nextBalancedAgent();
}

function sanitizeCommandPreview(commandLine: string): string {
  if (!commandLine) {
    return "(leeg commando)";
  }

  const redacted = commandLine.replace(
    /\b(password|passwd|pwd|token|secret|api[_-]?key)\s*=\s*([^\s]+)/gi,
    "$1=***",
  );

  return shorten(
    redacted.replace(/\s+/g, " ").trim(),
    MAX_COMMAND_PREVIEW_LENGTH,
  );
}

function createInitialRuntimeState(): RuntimeState {
  return {
    agents: {
      scout: createAgentState("scout"),
      builder: createAgentState("builder"),
      reviewer: createAgentState("reviewer"),
    },
    eventLog: [],
    statusLine: "IDLE",
    git: createDefaultGitState(),
  };
}

function createAgentState(id: AgentId): AgentViewState {
  return {
    id,
    label: AGENT_LABELS[id],
    task: "wacht in lounge",
    status: "idle",
    progress: 0,
    lastEventAt: Date.now(),
  };
}

function scheduleAgentIdle(
  agentId: AgentId,
  timeoutMs: number = AGENT_INACTIVITY_IDLE_MS,
) {
  const existing = idleTimers.get(agentId);
  if (existing) {
    clearTimeout(existing);
  }

  const delayMs = Math.max(
    MIN_AGENT_IDLE_MS,
    Math.min(timeoutMs, AGENT_INACTIVITY_IDLE_MS),
  );

  const timer = setTimeout(() => {
    emitRuntimeEvent({
      type: "agent.idleTimeout",
      timestamp: Date.now(),
      summary: `${AGENT_LABELS[agentId]} terug naar idle`,
      detail: `${Math.round(delayMs / 1000)}s geen nieuwe events ontvangen.`,
      agentId,
      status: "idle",
      progress: 0,
    });
  }, delayMs);
  idleTimers.set(agentId, timer);
}

function emitSyntheticTestEvents() {
  const runLabel = new Date().toLocaleTimeString();
  const sequence: Array<{
    delayMs: number;
    event: Omit<PixelRuntimeEvent, "timestamp">;
  }> = [
    {
      delayMs: 0,
      event: {
        type: "test.sequence.started",
        summary: "Test-sequence gestart",
        detail: `Handmatige validatie run (${runLabel})`,
        agentId: "scout",
        status: "working",
        progress: 10,
      },
    },
    {
      delayMs: TEST_EVENT_STEP_DELAY_MS,
      event: {
        type: "test.sequence.workspace",
        summary: "Workspace scan simulatie",
        detail: "Scannen van geopende files voor context.",
        agentId: "scout",
        status: "working",
        progress: 45,
      },
    },
    {
      delayMs: TEST_EVENT_STEP_DELAY_MS * 2,
      event: {
        type: "test.sequence.builder",
        summary: "Builder verwerkt wijziging",
        detail: "src/extension.ts",
        filePath: "src/extension.ts",
        agentId: "builder",
        status: "working",
        progress: 58,
      },
    },
    {
      delayMs: TEST_EVENT_STEP_DELAY_MS * 3,
      event: {
        type: "test.sequence.reviewerWarning",
        summary: "Reviewer vond waarschuwing",
        detail: "1 warning in test-run (gesimuleerd).",
        agentId: "reviewer",
        status: "error",
        progress: 100,
      },
    },
    {
      delayMs: TEST_EVENT_STEP_DELAY_MS * 4,
      event: {
        type: "test.sequence.reviewerResolved",
        summary: "Reviewer waarschuwing opgelost",
        detail: "Geen warnings meer in gesimuleerde run.",
        agentId: "reviewer",
        status: "completed",
        progress: 100,
      },
    },
    {
      delayMs: TEST_EVENT_STEP_DELAY_MS * 5,
      event: {
        type: "test.sequence.finished",
        summary: "Test-sequence afgerond",
        detail: "Panel event rendering werkt zoals verwacht (gesimuleerd).",
        agentId: "builder",
        status: "completed",
        progress: 100,
      },
    },
  ];

  for (const step of sequence) {
    setTimeout(() => {
      emitRuntimeEvent({
        ...step.event,
        timestamp: Date.now(),
      });
    }, step.delayMs);
  }

  scheduleAgentIdle("scout");
  scheduleAgentIdle("builder");
  scheduleAgentIdle("reviewer");
}

function emitRuntimeEvent(event: PixelRuntimeEvent) {
  const normalized: PixelRuntimeEvent = {
    ...event,
    timestamp: event.timestamp || Date.now(),
    progress: normalizeProgress(event.progress),
  };

  applyEventToRuntimeState(normalized);
  queueOrSendMessage({ type: "pixel.event", payload: normalized });
}

function applyEventToRuntimeState(event: PixelRuntimeEvent) {
  if (event.git) {
    runtimeState.git = event.git;
  }

  if (event.agentId) {
    const agent = runtimeState.agents[event.agentId];
    agent.lastEventAt = event.timestamp;

    if (typeof event.status === "string") {
      agent.status = event.status;
    }
    if (typeof event.progress === "number") {
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
    if (status === "working") {
      working += 1;
    } else if (status === "completed") {
      completed += 1;
    } else if (status === "error") {
      errors += 1;
    }
  }

  if (working === 0 && completed === 0 && errors === 0) {
    return "IDLE";
  }

  return `${working} actief | ${completed} klaar | ${errors} fout`;
}

function normalizeProgress(progress: number | undefined): number | undefined {
  if (typeof progress !== "number" || Number.isNaN(progress)) {
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

    // Always refresh HTML on reveal so a stale retained webview cannot stay visually broken.
    preferredPanelMode = "auto";
    void renderPanelHtml(panelRef, context);
    armPanelReadyWatchdog(context);

    postSnapshot();
    emitRuntimeEvent({
      type: "panel.revealed",
      timestamp: Date.now(),
      summary: "Pixel panel opnieuw zichtbaar",
      detail: "Bestaand panel hergebruikt.",
    });
    return;
  }

  panelRef = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    "Pixel Agent",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
      ],
    },
  );

  preferredPanelMode = "auto";
  panelReady = false;
  panelRef.iconPath = new vscode.ThemeIcon("symbol-color");
  void renderPanelHtml(panelRef, context);
  armPanelReadyWatchdog(context);

  panelRef.onDidDispose(() => {
    panelRef = undefined;
    panelReady = false;
    preferredPanelMode = "auto";
    queuedMessages = [];
    clearPanelReadyWatchdog();
  });

  panelRef.webview.onDidReceiveMessage(
    async (message: WebviewToExtensionMessage) => {
      if (!message || typeof message.type !== "string") {
        return;
      }

      if (message.type === "webview-ready") {
        panelReady = true;
        clearPanelReadyWatchdog();
        postSnapshot();
        flushQueuedMessages();
        emitRuntimeEvent({
          type: "panel.connected",
          timestamp: Date.now(),
          summary: "Pixel panel verbonden",
          detail: "Webview ontvangt live events.",
        });
        return;
      }

      if (message.type === "webview-request-snapshot") {
        postSnapshot();
        return;
      }

      if (message.type === "retry-dev-server") {
        preferredPanelMode = "auto";
        if (panelRef) {
          await renderPanelHtml(panelRef, context);
          armPanelReadyWatchdog(context);
        }
        return;
      }

      if (message.type === "load-production") {
        preferredPanelMode = "production";
        if (panelRef) {
          await renderPanelHtml(panelRef, context);
          armPanelReadyWatchdog(context);
        }
        return;
      }

      if (message.type === "load-embedded") {
        preferredPanelMode = "embedded";
        if (panelRef) {
          await renderPanelHtml(panelRef, context);
          armPanelReadyWatchdog(context);
        }
      }
    },
  );

  emitRuntimeEvent({
    type: "panel.opened",
    timestamp: Date.now(),
    summary: "Pixel panel geopend",
    detail: "Wachten op webview connectie.",
  });
}

async function renderPanelHtml(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
): Promise<void> {
  panelReady = false;
  clearPanelReadyWatchdog();

  const devServerUrl =
    process.env.PIXEL_AGENT_WEBVIEW_DEV_SERVER_URL || DEFAULT_DEV_SERVER_URL;
  const inDevMode = context.extensionMode === vscode.ExtensionMode.Development;

  if (preferredPanelMode === "embedded") {
    await renderEmbeddedPanelHtml(panel, context.extensionUri);
    return;
  }

  if (preferredPanelMode === "production") {
    const hasBundle = await hasProductionBundle(context.extensionUri);
    panel.webview.html = hasBundle
      ? getProdWebviewHtml(panel.webview, context.extensionUri)
      : getBundleMissingHtml(
          panel.webview,
          devServerUrl,
          "Production bundle not found.",
        );
    return;
  }

  if (!inDevMode) {
    const hasBundle = await hasProductionBundle(context.extensionUri);
    panel.webview.html = hasBundle
      ? getProdWebviewHtml(panel.webview, context.extensionUri)
      : getBundleMissingHtml(
          panel.webview,
          devServerUrl,
          "Run npm run build in this repository.",
        );
    return;
  }

  const probe = await probeDevServer(devServerUrl);
  if (probe.ok) {
    if (AUTO_LOAD_EMBEDDED_WHEN_DEV_CONNECTED) {
      await renderEmbeddedPanelHtml(panel, context.extensionUri);
      return;
    }

    panel.webview.html = getDevWebviewHtml(panel.webview, devServerUrl);
    return;
  }

  const hasBundle = await hasProductionBundle(context.extensionUri);
  panel.webview.html = getDevServerFallbackHtml(
    panel.webview,
    devServerUrl,
    probe.reason,
    hasBundle,
  );
}

async function renderEmbeddedPanelHtml(
  panel: vscode.WebviewPanel,
  extensionUri: vscode.Uri,
): Promise<void> {
  const hasBundle = await hasProductionBundle(extensionUri);
  if (hasBundle) {
    panel.webview.html = getProdWebviewHtml(panel.webview, extensionUri);
    return;
  }

  panel.webview.html = getWebviewHtml(panel.webview);
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

    preferredPanelMode = "embedded";
    const panel = panelRef;
    void renderPanelHtml(panel, context).then(() => {
      emitRuntimeEvent({
        type: "panel.recovery",
        timestamp: Date.now(),
        summary: "Panel recovery uitgevoerd",
        detail:
          "Geen webview-ready signaal ontvangen, embedded UI opnieuw geladen.",
        agentId: "builder",
        status: "working",
        progress: 55,
      });
    });
  }, PANEL_READY_TIMEOUT_MS);
}

async function probeDevServer(
  devServerUrl: string,
): Promise<{ ok: boolean; reason: string }> {
  const normalizedUrl = devServerUrl.replace(/\/$/, "");
  const clientUrl = `${normalizedUrl}/@vite/client`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, DEV_SERVER_TIMEOUT_MS);

  try {
    const response = await fetch(clientUrl, {
      method: "GET",
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }

    return { ok: true, reason: "" };
  } catch (error) {
    if (error instanceof Error) {
      return { ok: false, reason: error.message };
    }
    return { ok: false, reason: "Unknown network error" };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function hasProductionBundle(extensionUri: vscode.Uri): Promise<boolean> {
  const scriptUri = vscode.Uri.joinPath(
    extensionUri,
    "dist",
    "webview",
    "assets",
    "main.js",
  );
  const styleUri = vscode.Uri.joinPath(
    extensionUri,
    "dist",
    "webview",
    "assets",
    "style.css",
  );

  try {
    await vscode.workspace.fs.stat(scriptUri);
    await vscode.workspace.fs.stat(styleUri);
    return true;
  } catch {
    return false;
  }
}

function getDevWebviewHtml(
  webview: vscode.Webview,
  devServerUrl: string,
): string {
  const normalizedUrl = devServerUrl.replace(/\/$/, "");
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

function getProdWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "assets", "main.js"),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "assets", "style.css"),
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
  productionBundleAvailable: boolean,
): string {
  const nonce = getNonce();
  const safeUrl = escapeHtml(devServerUrl);
  const safeReason = escapeHtml(reason);
  const productionButton = productionBundleAvailable
    ? '<button id="load-production" class="secondary">Load Production Bundle</button>'
    : "";

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
      <code>${safeReason || "Connection failed"}</code>
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

function getBundleMissingHtml(
  webview: vscode.Webview,
  devServerUrl: string,
  reason: string,
): string {
  return getDevServerFallbackHtml(webview, devServerUrl, reason, false);
}

function toWebSocketOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    const wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtocol}//${parsed.host}`;
  } catch {
    return "ws://127.0.0.1:5173";
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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
    type: "pixel.snapshot",
    payload: runtimeState,
  });
}

function getWebviewHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pixel Agent</title>
  <style>
    :root {
      --bg: #121826;
      --panel: #1b2538;
      --line: #314662;
      --text: #ecf3ff;
      --muted: #9cb0cb;
      --mint: #66e0be;
      --sun: #ffd27a;
      --rose: #ff7e9f;
      --cyan: #7cd9ff;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 14% 14%, rgba(102, 224, 190, 0.2), transparent 38%),
        radial-gradient(circle at 83% 88%, rgba(255, 126, 159, 0.22), transparent 42%),
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
      background: linear-gradient(180deg, rgba(27, 37, 56, 0.96), rgba(17, 24, 37, 0.98));
      box-shadow: 0 24px 52px rgba(1, 6, 14, 0.58);
      border-radius: 12px;
      padding: 18px;
      animation: panel-in 260ms ease-out;
    }

    .title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      font-size: 13px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .scene-caption {
      margin-top: 8px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 10px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 8px;
      color: var(--muted);
      background: rgba(17, 24, 37, 0.72);
    }

    .pill.lounge {
      border-color: rgba(102, 224, 190, 0.45);
      color: #abefdc;
    }

    .pill.work {
      border-color: rgba(124, 217, 255, 0.45);
      color: #bde9ff;
    }

    canvas {
      width: 100%;
      max-width: 660px;
      aspect-ratio: 16 / 9;
      border: 2px solid var(--line);
      image-rendering: pixelated;
      image-rendering: crisp-edges;
      background: #16243e;
    }

    .git-strip {
      margin-top: 10px;
      border: 2px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      background: rgba(17, 24, 37, 0.78);
      display: grid;
      gap: 4px;
      font-size: 11px;
      color: var(--muted);
    }

    .git-strip strong {
      color: #d7e6ff;
      font-size: 12px;
    }

    .footer {
      margin-top: 12px;
      font-size: 12px;
      color: var(--muted);
    }

    .agent-list {
      margin-top: 12px;
      border: 2px solid var(--line);
      background: rgba(17, 24, 37, 0.74);
      padding: 8px;
      display: grid;
      gap: 6px;
      border-radius: 8px;
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
      background: rgba(17, 24, 37, 0.78);
      padding: 8px;
      border-radius: 8px;
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
      max-height: 136px;
      overflow: auto;
      font-size: 11px;
      line-height: 1.35;
      color: #aeb9d7;
    }

    .event-log li {
      margin-bottom: 4px;
    }

    @keyframes panel-in {
      from {
        opacity: 0;
        transform: translateY(8px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
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
    <div class="scene-caption">
      <span class="pill lounge">Lounge: idle agents praten hier</span>
      <span class="pill work">Werkvloer: actieve agents werken hier</span>
    </div>
    <div class="git-strip">
      <strong id="git-branch">git: laden...</strong>
      <span id="git-counts">staged 0 | unstaged 0 | conflicts 0</span>
      <span id="git-message">Git monitoring wordt geladen.</span>
    </div>
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
      Tip: gebruik <code>@pixel /show</code>. Een agent gaat naar de werkvloer bij activiteit en keert na 60s zonder nieuwe events terug naar idle in de lounge.
    </div>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const canvas = document.getElementById('scene');
    const status = document.getElementById('status');
    const logList = document.getElementById('event-log-list');
    const gitBranchEl = document.getElementById('git-branch');
    const gitCountsEl = document.getElementById('git-counts');
    const gitMessageEl = document.getElementById('git-message');
    const ctx = canvas ? canvas.getContext('2d') : null;
    const CANVAS_W = (canvas && canvas.width) ? canvas.width : 320;
    const CANVAS_H = (canvas && canvas.height) ? canvas.height : 180;

    if (!ctx) {
      if (status) { status.textContent = 'CANVAS ERROR - herlaad het panel'; }
    }

    const loungeLaneYs = [124, 138, 152];
    const workLaneYs = [94, 112, 130];
    const loungeBounds = {
      left: 16,
      right: 132
    };
    const workBounds = {
      left: 174,
      right: CANVAS_W - 20
    };
    const INACTIVITY_LIMIT_MS = 60000;
    const SPEECH_VISIBLE_MS = 2000;
    const BUBBLE_MAX_LINES = 2;
    const BUBBLE_LINE_MAX_CHARS = 34;
    const IDLE_CHAT_MIN_GAP_MS = 1500;
    const IDLE_CHAT_MAX_GAP_MS = 4800;
    const IDLE_REPLY_MIN_DELAY_MS = 450;
    const IDLE_REPLY_MAX_DELAY_MS = 1050;
    const IDLE_JOKES = [
      { setup: 'Waarom breekt de build altijd vrijdag?', reply: 'Omdat bugs weekendplannen hebben.' },
      { setup: 'Ik had een race condition opgelost.', reply: 'Top, was je op tijd voor jezelf?' },
      { setup: 'Deze feature was vijf minuten werk.', reply: 'Ja, plus 2 uur naming-discussie.' },
      { setup: 'Mijn test is flaky, maar alleen bij maanlicht.', reply: 'Dan noemen we het een astrologische dependency.' },
      { setup: 'Ik heb 1 semicolon gefixt.', reply: 'Perfect, nu durft lint weer te ademen.' },
      { setup: 'Code review zei: kleine wijziging.', reply: 'Klein, als je 19 files negeert.' },
      { setup: 'Waarom praat jij tegen de compiler?', reply: 'Omdat docs soms stiller zijn dan errors.' },
      { setup: 'Ik heb de bug niet kunnen reproduceren.', reply: 'Mooi, dan reproduceert hij jou straks.' }
    ];
    const AGENT_PERSONALITIES = {
      scout: {
        idleLines: [
          'ik scan nog even de context.',
          'waar zit de volgende winst?',
          'commit-plan wordt scherp gezet.',
          "ik spot alvast de risico's.",
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

    const nowMs = performance.now();
    const agents = [
      {
        id: 'scout',
        name: 'Scout',
        x: 42,
        y: loungeLaneYs[0],
        vx: 0.46,
        frame: 0,
        bob: 0.3,
        color: '#69f0c4',
        task: 'wacht in lounge',
        status: 'idle',
        progress: 0,
        lane: 0,
        zone: 'lounge',
        lastEventAt: Date.now(),
        lastSpeechAt: 0,
        speechText: '',
        pauseUntilMs: nowMs,
        nextPauseAtMs: nowMs + 1200 + Math.random() * 2200,
        routine: 'normal',
        routineUntilMs: nowMs + 1800 + Math.random() * 1200,
        nextRoutineAtMs: nowMs + 1100 + Math.random() * 1500
      },
      {
        id: 'builder',
        name: 'Builder',
        x: 92,
        y: loungeLaneYs[1],
        vx: -0.41,
        frame: 0,
        bob: 1.4,
        color: '#ffd166',
        task: 'wacht in lounge',
        status: 'idle',
        progress: 0,
        lane: 1,
        zone: 'lounge',
        lastEventAt: Date.now(),
        lastSpeechAt: 0,
        speechText: '',
        pauseUntilMs: nowMs,
        nextPauseAtMs: nowMs + 1200 + Math.random() * 2200,
        routine: 'normal',
        routineUntilMs: nowMs + 1800 + Math.random() * 1200,
        nextRoutineAtMs: nowMs + 1100 + Math.random() * 1500
      },
      {
        id: 'reviewer',
        name: 'Reviewer',
        x: 126,
        y: loungeLaneYs[2],
        vx: 0.52,
        frame: 0,
        bob: 2.5,
        color: '#ff6f91',
        task: 'wacht in lounge',
        status: 'idle',
        progress: 0,
        lane: 2,
        zone: 'lounge',
        lastEventAt: Date.now(),
        lastSpeechAt: 0,
        speechText: '',
        pauseUntilMs: nowMs,
        nextPauseAtMs: nowMs + 1200 + Math.random() * 2200,
        routine: 'normal',
        routineUntilMs: nowMs + 1800 + Math.random() * 1200,
        nextRoutineAtMs: nowMs + 1100 + Math.random() * 1500
      }
    ];

    const agentById = new Map();
    for (const agent of agents) {
      applyZoneFromStatus(agent);
      agentById.set(agent.id, agent);
    }

    const eventLog = [];
    let nextIdleChatAt = Date.now() + Math.round(IDLE_CHAT_MIN_GAP_MS + Math.random() * (IDLE_CHAT_MAX_GAP_MS - IDLE_CHAT_MIN_GAP_MS));

    function renderGitState(git) {
      if (!git) {
        gitBranchEl.textContent = 'git: onbekend';
        gitCountsEl.textContent = 'staged 0 | unstaged 0 | conflicts 0';
        gitMessageEl.textContent = 'Geen git-data ontvangen.';
        return;
      }

      gitBranchEl.textContent = 'git: ' + (git.branch || '-');
      gitCountsEl.textContent =
        'staged ' + (git.staged || 0) +
        ' | unstaged ' + (git.unstaged || 0) +
        ' | conflicts ' + (git.conflicts || 0) +
        ' | ahead ' + (git.ahead || 0) +
        ' | behind ' + (git.behind || 0);
      gitMessageEl.textContent = git.message || 'Git monitoring actief.';
    }

    function shorten(value, maxLength) {
      if (!value) {
        return '';
      }
      return value.length <= maxLength ? value : value.slice(0, maxLength - 1) + '...';
    }

    function isActiveStatus(statusValue) {
      return statusValue === 'working' || statusValue === 'completed' || statusValue === 'error';
    }

    function applyZoneFromStatus(agent) {
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

    function getIdleLine(agent, nowMs) {
      const lines = AGENT_PERSONALITIES[agent.id].idleLines;
      const tick = Math.floor(nowMs / 4200);
      const offset = agent.id.length * 3 + agent.lane;
      const index = (tick + offset) % lines.length;
      const icon = pickAgentIcon(agent, nowMs);
      return lines[index] + ' ' + icon;
    }

    function getActiveLine(agent) {
      const fallback = AGENT_PERSONALITIES[agent.id].workFallback;
      const core = shorten(agent.task || fallback, 22);
      const icon = pickAgentIcon(agent, Date.now());

      if (agent.status === 'completed') {
        return 'klaar: ' + core + ' ' + icon;
      }
      if (agent.status === 'error') {
        return 'let op: ' + core + ' ' + icon;
      }
      if (agent.id === 'scout') {
        return 'scan: ' + core + ' ' + icon;
      }
      if (agent.id === 'builder') {
        return 'bouwt: ' + core + ' ' + icon;
      }
      return 'checkt: ' + core + ' ' + icon;
    }

    function pickAgentIcon(agent, seed) {
      const icons = AGENT_PERSONALITIES[agent.id].icons;
      const index = Math.abs(Math.floor(seed / 850) + agent.lane + agent.id.length) % icons.length;
      return icons[index];
    }

    function pickRandom(items) {
      const index = Math.floor(Math.random() * items.length);
      return items[index];
    }

    function randomRange(min, max) {
      return min + Math.random() * (max - min);
    }

    function setAgentSpeechText(agent, text, timestamp) {
      const when = typeof timestamp === 'number' ? timestamp : Date.now();
      const normalized = shorten(String(text || '').replace(/\\s+/g, ' ').trim(), 96);
      agent.speechText = normalized;
      agent.lastSpeechAt = when;
    }

    function chooseNextIdleRoutine(agent, nowMs) {
      const roll = Math.random();
      let routine = 'normal';
      if (roll >= 0.56 && roll < 0.74) {
        routine = 'pause';
      } else if (roll >= 0.74 && roll < 0.9) {
        routine = 'dance';
      } else if (roll >= 0.9) {
        routine = 'sleep';
      }

      agent.routine = routine;

      if (routine === 'pause') {
        agent.routineUntilMs = nowMs + randomRange(1300, 2600);
      } else if (routine === 'dance') {
        agent.routineUntilMs = nowMs + randomRange(1800, 3600);
      } else if (routine === 'sleep') {
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

      const idleAgents = agents.filter((agent) => agent.status === 'idle' && agent.routine !== 'sleep');
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

      setAgentSpeechText(speaker, joke.setup + ' ' + pickAgentIcon(speaker, now), now);

      const delay = Math.round(randomRange(IDLE_REPLY_MIN_DELAY_MS, IDLE_REPLY_MAX_DELAY_MS));
      setTimeout(() => {
        if (responder.status !== 'idle' || responder.routine === 'sleep') {
          return;
        }
        setAgentSpeechText(responder, joke.reply + ' ' + pickAgentIcon(responder, Date.now()));
      }, delay);

      nextIdleChatAt = now + Math.round(randomRange(IDLE_CHAT_MIN_GAP_MS, IDLE_CHAT_MAX_GAP_MS));
    }

    function wrapWords(line, maxChars) {
      const words = line.trim().split(/\\s+/).filter(Boolean);
      if (words.length === 0) {
        return [];
      }

      const expanded = [];
      for (const word of words) {
        if (word.length <= maxChars) {
          expanded.push(word);
          continue;
        }

        for (let index = 0; index < word.length; index += maxChars) {
          expanded.push(word.slice(index, index + maxChars));
        }
      }

      const wrapped = [];
      let current = expanded[0];
      for (let i = 1; i < expanded.length; i += 1) {
        const next = current + ' ' + expanded[i];
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

    function wrapBubbleText(text, maxChars, maxLines) {
      const parts = String(text || '')
        .split('\n')
          .map((part) => part.replace(/\\s+/g, ' ').trim())
        .filter(Boolean);

      const lines = [];
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
          lines[lastIndex] = shorten(lines[lastIndex], Math.max(4, maxChars - 4)) + '...';
        }
      }

      return lines;
    }

    function buildSpeechFromEvent(agent, event) {
      const summary = event.summary ? shorten(String(event.summary).replace(/\\s+/g, ' ').trim(), 74) : getActiveLine(agent);
      const detail = event.detail ? shorten(String(event.detail).trim(), 90) : '';
      if (detail && detail !== summary) {
        return summary + '\n' + detail;
      }
      return summary || getIdleLine(agent, event.timestamp || Date.now());
    }

    function setAgentSpeech(agent, event) {
      setAgentSpeechText(agent, buildSpeechFromEvent(agent, event), event.timestamp || Date.now());
    }

    function setStatusLine(text) {
      status.textContent = text || 'IDLE';
    }

    function updateStatusFromAgents() {
      let working = 0;
      let completed = 0;
      let errors = 0;
      let idle = 0;

      for (const agent of agents) {
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

      if (working === 0 && completed === 0 && errors === 0 && idle === agents.length) {
        setStatusLine('IDLE | lounge chat actief');
        return;
      }

      setStatusLine(working + ' actief | ' + completed + ' klaar | ' + errors + ' fout | ' + idle + ' lounge');
    }

    function renderAgentRows() {
      for (const agent of agents) {
        const taskEl = document.getElementById('task-' + agent.id);
        const stateEl = document.getElementById('state-' + agent.id);
        if (taskEl) {
          taskEl.textContent = shorten(agent.task || 'wacht in lounge', 58);
        }
        if (stateEl) {
          const location = agent.zone === 'work' ? 'werkplek' : 'lounge';
          stateEl.textContent = agent.status + ' ' + agent.progress + '% ' + location;
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
      if (event.git) {
        renderGitState(event.git);
      }

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
      setAgentSpeech(agent, event);
      applyZoneFromStatus(agent);
      renderAgentRows();
      updateStatusFromAgents();
    }

    function applySnapshot(snapshot) {
      if (!snapshot) {
        return;
      }

      renderGitState(snapshot.git);

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

          if (Date.now() - agent.lastEventAt <= SPEECH_VISIBLE_MS) {
            const speech = incoming.task ? shorten(incoming.task, 88) : getActiveLine(agent);
            setAgentSpeechText(agent, speech, agent.lastEventAt);
          } else {
            agent.speechText = '';
            agent.lastSpeechAt = 0;
          }

          applyZoneFromStatus(agent);
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
      updateStatusFromAgents();
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
        if (agent.status !== 'idle' && now - agent.lastEventAt >= INACTIVITY_LIMIT_MS) {
          agent.status = 'idle';
          agent.progress = 0;
          agent.task = 'wacht in lounge';
          agent.routine = 'normal';
          agent.routineUntilMs = performance.now() + randomRange(1400, 2600);
          agent.nextRoutineAtMs = performance.now() + randomRange(800, 2000);
          applyZoneFromStatus(agent);
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
      const splitX = 158;

      // Ceiling
      ctx.fillStyle = '#0d1520';
      ctx.fillRect(0, 0, CANVAS_W, 74);

      // Pulsing zone accent strips below ceiling
      const loungePulse = 0.55 + Math.sin(nowMs * 0.002) * 0.3;
      const workPulse = 0.52 + Math.cos(nowMs * 0.0025) * 0.3;
      ctx.fillStyle = 'rgba(80, 220, 140,' + loungePulse.toFixed(2) + ')';
      ctx.fillRect(18, 8, 110, 4);
      ctx.fillStyle = 'rgba(80, 180, 255,' + workPulse.toFixed(2) + ')';
      ctx.fillRect(186, 8, 118, 4);

      // Lounge floor - clearly green-tinted
      ctx.fillStyle = '#0e2218';
      ctx.fillRect(8, 74, splitX - 12, 106);
      // Lounge floor header band
      ctx.fillStyle = '#1a4028';
      ctx.fillRect(8, 74, splitX - 12, 16);

      // Work floor - clearly blue-tinted
      ctx.fillStyle = '#0e1d30';
      ctx.fillRect(splitX, 74, CANVAS_W - splitX, 106);
      // Work floor header band
      ctx.fillStyle = '#183554';
      ctx.fillRect(splitX, 74, CANVAS_W - splitX, 16);

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

      // Divider wall
      ctx.fillStyle = '#8ab4e8';
      ctx.fillRect(splitX - 2, 74, 4, 106);

      // Work floor grid lines
      for (let y = 92; y < CANVAS_H; y += 14) {
        ctx.strokeStyle = '#1e3a5c';
        ctx.beginPath();
        ctx.moveTo(splitX + 2, y);
        ctx.lineTo(CANVAS_W, y);
        ctx.stroke();
      }

      // Zone labels (10px, clearly readable)
      ctx.font = 'bold 9px monospace';
      ctx.fillStyle = '#6ee8a8';
      ctx.fillText('LOUNGE', 18, 70);
      ctx.fillStyle = '#7ecfff';
      ctx.fillText('WERKVLOER', 184, 70);
    }

    function colorForStatus(agent) {
      if (agent.status === 'error') {
        return '#ff6f91';
      }
      if (agent.status === 'completed') {
        return '#68d89a';
      }
      return agent.color;
    }

    function limbPalette(agent) {
      if (agent.id === 'scout') {
        return { arm: '#aef0dd', hand: '#79d9c1', boot: '#63bda7' };
      }
      if (agent.id === 'builder') {
        return { arm: '#ffe3aa', hand: '#ffd27a', boot: '#cda24f' };
      }
      return { arm: '#ffd3de', hand: '#ff9eb8', boot: '#c8748f' };
    }

    function routineBadgeText(agent, nowMs) {
      if (agent.status === 'idle' && agent.routine === 'sleep') {
        return 'zz';
      }
      if (agent.status === 'idle' && agent.routine === 'dance') {
        return '♪';
      }
      if (agent.status === 'idle' && agent.routine === 'pause') {
        return '...';
      }
      return pickAgentIcon(agent, nowMs);
    }

    function drawAgentIconBadge(agent, x, y, nowMs) {
      const badge = routineBadgeText(agent, nowMs);
      ctx.fillStyle = 'rgba(18, 24, 38, 0.84)';
      ctx.fillRect(x - 4, y - 10, 14, 7);
      ctx.fillStyle = '#eaf3ff';
      ctx.font = '6px monospace';
      ctx.fillText(badge, x - 2, y - 5);
    }

    function drawAgentBlock(agent, nowMs) {
      const routineDance = agent.status === 'idle' && agent.routine === 'dance';
      const routineSleep = agent.status === 'idle' && agent.routine === 'sleep';
      const routinePause = agent.status === 'idle' && agent.routine === 'pause';

      const danceBoost = routineDance ? Math.sin(nowMs * 0.02 + agent.bob) * 1.8 : 0;
      const wobble = Math.sin(nowMs * 0.004 + agent.bob) * 1.5 + danceBoost;
      const x = Math.floor(agent.x);
      const y = Math.floor(agent.y + wobble);
      const paused = nowMs < agent.pauseUntilMs || routinePause || routineSleep;
      const cadence = agent.id === 'builder' ? 14 : agent.id === 'reviewer' ? 18 : 16;
      let step = paused ? 0 : agent.frame % cadence < cadence / 2 ? 0 : 1;
      if (routineDance) {
        step = Math.sin(nowMs * 0.03 + agent.bob) > 0 ? 1 : -1;
      }
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
      if (routineSleep) {
        ctx.fillRect(x + 3, y + 4, 2, 1);
        ctx.fillRect(x + 7, y + 4, 2, 1);
        ctx.fillStyle = '#202534';
        ctx.fillRect(x + 4, y + 8, 4, 1);
      } else {
        ctx.fillRect(x + 3, y + 3, 2, 2);
        ctx.fillRect(x + 7, y + 3, 2, 2);
        ctx.fillStyle = '#202534';
        ctx.fillRect(x + 4, y + 8, 4, 1);
      }

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

      drawAgentIconBadge(agent, x, y, nowMs);
    }

    function drawSpeechCloud(agent, nowMs) {
      const now = Date.now();
      if (!agent.speechText || now - agent.lastSpeechAt > SPEECH_VISIBLE_MS) {
        return;
      }

      const wobble = Math.sin(nowMs * 0.004 + agent.bob) * 1.5;
      const blockX = Math.floor(agent.x);
      const blockY = Math.floor(agent.y + wobble);

      ctx.font = '8px monospace';
      const lines = wrapBubbleText(agent.name + ': ' + agent.speechText, BUBBLE_LINE_MAX_CHARS, BUBBLE_MAX_LINES);
      if (lines.length === 0) {
        return;
      }

      const textWidth = Math.max.apply(
        null,
        lines.map((line) => Math.ceil(ctx.measureText(line).width))
      );
      const cloudWidth = Math.max(84, textWidth + 12);
      const cloudHeight = 6 + lines.length * 9;
      const rawX = blockX + 6 - Math.floor(cloudWidth / 2);
      const cloudX = clamp(rawX, 4, canvas.width - cloudWidth - 4);
      const cloudY = Math.max(4, blockY - (cloudHeight + 7));

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

    function tickAgent(agent, nowMs) {
      const inWorkZone = agent.zone === 'work';
      const personality = AGENT_PERSONALITIES[agent.id];
      const lanePool = inWorkZone ? workLaneYs : loungeLaneYs;
      const bounds = inWorkZone ? workBounds : loungeBounds;

      agent.lane = clamp(agent.lane, 0, lanePool.length - 1);

      if (agent.status === 'idle') {
        if (nowMs >= agent.nextRoutineAtMs) {
          chooseNextIdleRoutine(agent, nowMs);
        }
      } else {
        agent.routine = 'normal';
        agent.routineUntilMs = nowMs;
        agent.nextRoutineAtMs = nowMs + randomRange(1200, 2800);
      }

      if (nowMs >= agent.nextPauseAtMs) {
        const busyPause = inWorkZone && agent.status === 'working';
        const pauseDuration = busyPause ? randomRange(900, 2200) : randomRange(350, 1100);
        agent.pauseUntilMs = nowMs + pauseDuration;
        agent.nextPauseAtMs = agent.pauseUntilMs + (busyPause ? randomRange(1300, 3600) : randomRange(2100, 4900));
      }

      const routinePause = agent.status === 'idle' && (agent.routine === 'pause' || agent.routine === 'sleep');
      const paused = nowMs < agent.pauseUntilMs || routinePause;

      const speedBase = inWorkZone ? 1.1 : 0.85;
      const speed = speedBase * (inWorkZone ? personality.workSpeed : personality.loungeSpeed);
      if (!paused) {
        agent.x += agent.vx * speed;
      }
      const targetY = lanePool[agent.lane];
      agent.y += (targetY - agent.y) * (inWorkZone ? 0.09 : 0.07);
      if (!paused || (agent.status === 'idle' && agent.routine === 'dance')) {
        agent.frame += 1;
      }

      if (!inWorkZone) {
        agent.x += Math.sin(nowMs * personality.driftFreq + agent.bob) * personality.driftAmp;
        if (agent.status === 'idle') {
          agent.y += Math.sin(nowMs * personality.poseFreq + agent.bob) * personality.poseAmp;
          if (agent.routine === 'dance') {
            agent.x += Math.sin(nowMs * 0.016 + agent.bob) * 0.45;
            agent.y += Math.cos(nowMs * 0.023 + agent.bob) * 0.4;
          }
        }
      }

      if (agent.x > bounds.right || agent.x < bounds.left) {
        agent.vx *= -1;
        agent.x = clamp(agent.x, bounds.left, bounds.right);
        const nextLane = Math.floor(Math.random() * lanePool.length);
        agent.lane = nextLane;
      }
    }

    function draw() {
      const nowMs = performance.now();
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

      drawOfficeScene(nowMs);
      maybeRunIdleChatter();

      for (const agent of agents) {
        tickAgent(agent, nowMs);
        drawSpeechCloud(agent, nowMs);
        drawAgentBlock(agent, nowMs);
      }

      requestAnimationFrame(draw);
    }

    renderAgentRows();
    renderEventLog();
    renderGitState(null);
    updateStatusFromAgents();
    vscodeApi.postMessage({ type: 'webview-ready' });

    if (ctx) { draw(); } else { console.error('[Pixel] canvas ctx is null - canvas not available in this webview'); }
  </script>
</body>
</html>`;
}

function getNonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
