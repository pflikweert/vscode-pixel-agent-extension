
# Pixel Copilot Agent

## Nieuw in maart 2026

- **Volledige Copilot Language Model integratie**: native chatflow via VS Code LM API, met modelselectie, editorcontext en streaming response.
- **Hybride externe export**: optionele export van prompt, response en context naar een extern endpoint, configureerbaar via settings.
- **Codex import & auto-discovery**: import van externe Codex/OpenAI agent events via JSONL-bestand of automatische detectie van lokale Codex sessies.
- **Verbeterde panel fallback**: robuuste recovery bij devserver issues, automatische terugval op embedded/prod UI.
- **Uitgebreide event types**: nu ook Copilot LM, Codex, export, git, terminal, tasks, diagnostics en meer.
- **Dynamische agent scene**: command-room met Ops AI monitor, workstations, bureau-specifieke werkanimaties, idle-lus, plantzorg, routegestuurde kantoor-kat cameos, klikbare scene-hotspots en custom sprites.


Standalone VS Code extensie in een eigen repository met:

- een @pixel chat participant voor Copilot Chat
- een Pixel Agent panel met runtime events (chat, workspace, diagnostics, taken, terminal commands en Codex telemetry)
- een hybride webview-flow:
  - devserver via Vite voor snelle UI-iteratie
  - production bundle in dist/webview voor packaged runs
  - fallback-scherm bij offline devserver

## Wat Je Nu Krijgt

- live panel met Scout, Builder en Reviewer status
- centrale Ops AI monitor die prompts ontvangt en de gekozen agent zichtbaar dispatcht
- eventlog met realtime updates uit extension host
- echte Copilot Language Model call-flow via `vscode.lm.selectChatModels` + streaming response
- Codex telemetry via handmatige JSONL-import en automatische native discovery van `~/.codex` of `$CODEX_HOME`
- terminal command telemetry (start/einde + exit status), inclusief source-detectie voor `local` en `codex`
- vernieuwde vierkante lounge-scene met kamerachtergrond, workstations, Ops AI monitor, speech bubbles en idle acties
- git-aware Ops AI idle chatter die inspeelt op dirty branches en lounge-status
- spontane kantoor-kat visits met meerdere persoonlijkheden, meow/speech bubbles en routegestuurde wandelingen via meerdere in- en uitgangen
- klikbare scene-hotspots: het rustbed roept een willekeurige lounge-kat op, de Ops AI monitor roept `Director Whiskers` op
- fasegestuurde agentstatus in UI (`wacht op input`, `analyseert`, `antwoordt`, `bezig`, `afgerond`, `fout`)
- custom pixel/manga agent-rendering met statusaccenten voor working/completed/error en werkmodi zoals thinking/typing/reviewing
- opgeschoonde speech bubbles voor Codex tool-output, zonder terminalruis zoals chunk headers of ANSI kleurcodes
- robuuste webview-start met dev/prod/embedded recovery in plaats van zwart scherm

## Projectstructuur

- src/extension.ts: extension-host logica, @pixel participant, runtime events en webview loading modes
- webview-ui/src/\*: Vite webview frontend met HMR
- webview-ui/src/assets/\*: room background, character-sheet(s) en andere frontend-assets
- dist/: gecompileerde extension output
- dist/webview/: productie webview assets

## Snel starten

1. Open deze map als eigen root-workspace in VS Code.
2. Installeer dependencies:

```bash
npm install
```

3. Start debugconfig Run Pixel Agent Extension.
   Deze start automatisch parallel:
   - npm: watch
   - npm: dev:webview

4. Test in de Extension Development Host:
   - Command Palette: Pixel Agent: Open Panel
   - Command Palette: Pixel Agent: Emit Test Events
   - Copilot Chat: @pixel /show
   - klik in het panel op het rustbed of de Ops AI monitor om direct een kantoor-kat spawn te triggeren

## Scripts

- npm run build: bouwt extension en webview-assets
- npm run build:extension: compileert extension host
- npm run build:webview: buildt webview-ui naar dist/webview
- npm run watch: alias voor `npm run watch:extension`
- npm run watch:extension: TypeScript watch voor extension host
- npm run dev:webview: start Vite devserver op 127.0.0.1:5173
- npm run lint: lint extension host en webview TypeScript bestanden

## Copilot LM Integratie

De chat participant gebruikt nu de VS Code Language Model API:

- modelselectie met `vscode.lm.selectChatModels(...)`
- prompt-opbouw met actieve editorcontext (actieve file, selectie, open files, diagnostics)
- streaming response direct naar de chat via de response stream

Belangrijk:

- minimale VS Code engine: `^1.99.0`
- `enabledApiProposals` staat expliciet op leeg, omdat de gebruikte LM/chat APIs stabiel zijn in deze baseline

## Externe Export (hybride)

Optioneel kan de extensie prompt + response + context naar een extern endpoint sturen.

Settings:

- `pixelAgent.copilotExport.enabled`: zet export aan/uit
- `pixelAgent.copilotExport.endpoint`: URL voor `POST` JSON payload
- `pixelAgent.copilotExport.timeoutMs`: request-timeout
- `pixelAgent.copilotExport.includeOpenFiles`: voeg open files toe aan context
- `pixelAgent.copilotExport.redactSensitiveData`: eenvoudige redactie van secret-achtige key/value paren

Voorbeeld in je settings.json:

```json
{
  "pixelAgent.copilotExport.enabled": true,
  "pixelAgent.copilotExport.endpoint": "http://127.0.0.1:8787/copilot-events",
  "pixelAgent.copilotExport.timeoutMs": 4500,
  "pixelAgent.copilotExport.includeOpenFiles": true,
  "pixelAgent.copilotExport.redactSensitiveData": true
}
```

## Codex Import


## Lokaal installeren, updaten en verwijderen

### Installeren

1. Bouw het .vsix bestand:
  ```sh
  npx vsce package --no-dependencies --out pixel-copilot-agent.vsix
  ```
2. Installeer de extensie lokaal:
  ```sh
  code --install-extension pixel-copilot-agent.vsix
  ```

### Updaten

1. Bouw een nieuwe .vsix:
  ```sh
  npx vsce package --no-dependencies --out pixel-copilot-agent.vsix
  ```
2. Installeer opnieuw (overschrijft oude versie):
  ```sh
  code --install-extension pixel-copilot-agent.vsix
  ```

### Verwijderen

Verwijder de extensie met:
```sh
code --uninstall-extension pixel-copilot-agent
```

---
Je kunt nu ook externe Codex of OpenAI coding agent telemetry inlezen via een lokaal JSONL-bestand.

Settings:

- `pixelAgent.codexImport.enabled`: zet Codex import aan of uit
- `pixelAgent.codexImport.filePath`: absoluut pad naar een JSONL of NDJSON bestand
- `pixelAgent.codexImport.pollMs`: polling-interval voor nieuwe regels

Voorbeeld in je settings.json:

```json
{
  "pixelAgent.codexImport.enabled": true,
  "pixelAgent.codexImport.filePath": "/absolute/path/to/codex-events.jsonl",
  "pixelAgent.codexImport.pollMs": 1200
}
```

Ondersteund inputformaat:

- één JSON object per regel
- of een regel met een JSON array
- of een object met een `events` array

Voorbeeld JSONL regels:

```json
{"type":"terminal.commandStarted","command":"npm test","status":"working","timestamp":"2026-03-13T12:00:00Z"}
{"event":"tool.call","tool":"run_in_terminal","command":"git status","traceId":"abc123","model":"codex"}
{"type":"chat.completed","summary":"Codex antwoord klaar","status":"completed","tokenUsage":{"prompt":220,"completion":94,"total":314}}
```

De imported events verschijnen in het panel met source `codex`.

## Codex Auto-discovery

Als Codex lokaal aanwezig is, leest de extensie ook native sessie-events automatisch in zonder extra setting.

Gedrag:

- zoekt eerst `CODEX_HOME`, en valt anders terug op `~/.codex`
- pollt `session_index.jsonl` voor nieuwe of bijgewerkte sessies
- zoekt de actieve rollout in `sessions/` of `archived_sessions/`
- toont alleen native Codex sessies waarvan de `cwd` binnen de huidige VS Code workspace valt
- vertaalt native Codex records naar Pixel runtime events met source `codex`
- koppelt Codex standaard aan de `Builder` agent, zodat coding-agent activiteit direct zichtbaar is in de scene

Native Codex runtime events:

- `codex.session`
- `codex.session_meta`
- `codex.userMessage`
- `codex.response`
- `codex.toolCall`
- `codex.toolResult`
- `codex.customToolCall`
- `codex.customToolResult`
- `codex.reasoning`
- `codex.command`
- `codex.complete`

## Fallback gedrag

Als devserver niet bereikbaar is in development mode:

- panel toont fallback met foutreden
- Retry Dev Server probeert opnieuw
- Load Production Bundle laadt dist/webview assets als beschikbaar
- Load Embedded Panel laadt de ingebouwde monitor-UI

Als devserver wel bereikbaar is bij panel-start:

- panel laadt de Vite-webview (HMR)
- als geen `webview-ready` binnen ~2.5s komt, triggert `panel.recovery` en valt de panel-flow terug op embedded/prod

## Realtime events

- @pixel chat lifecycle: ontvangen, verwerken, streaming, klaar/fout
- Codex events: live JSONL import en automatische native sessie-discovery
- ops-dispatch events: prompt-routing vanuit de centrale Ops AI monitor naar de gekozen agent
- workspace events: file change/save/create/delete/rename en actieve editor
- diagnostics updates: errors en warnings
- VS Code tasks: gestart/afgerond inclusief exit status
- terminal events: terminal open/close en shell command start/einde met exit code en bron-tagging (`local` of `codex`)
- git events: branch, ahead/behind, staged/unstaged/conflicts en clean/changed/conflict transitions

## Ondersteunde event types (actueel)

Runtime event types (in eventLog, via `emitRuntimeEvent`):

- Extension lifecycle: `extension.activated`
- Chat lifecycle: `chat.received`, `chat.userPrompt`, `chat.processing`, `chat.streaming`, `chat.completed`, `chat.error`
- Ops orchestration: `ops.dispatch`
- Copilot LM/export: `copilot.modelSelected`, `copilot.exportSent`, `copilot.exportFailed`, `copilot.exportSkipped`
- Codex native: `codex.session`, `codex.session_meta`, `codex.userMessage`, `codex.response`, `codex.toolCall`, `codex.toolResult`, `codex.customToolCall`, `codex.customToolResult`, `codex.reasoning`, `codex.command`, `codex.complete`
- Codex import: `codex.importReady`, `codex.importWaiting`, `codex.importReset`, `codex.importParseError`, `codex.importFailed`
- Workspace files: `workspace.fileChanged`, `workspace.fileSaved`, `workspace.fileCreated`, `workspace.fileDeleted`, `workspace.fileRenamed`, `workspace.activeEditorChanged`
- Workspace typing burst: `workspace.typingBurstStarted`, `workspace.typingBurstTick`, `workspace.typingBurstIdle`
- Diagnostics: `diagnostics.updated`
- Tasks: `task.started`, `task.finished`
- Terminal: `terminal.opened`, `terminal.closed`, `terminal.commandStarted`, `terminal.commandFinished`
- Git: `git.monitoringReady`, `git.unavailable`, `git.conflictsDetected`, `git.stateChanged`, `git.clean`
- Panel lifecycle: `panel.opened`, `panel.revealed`, `panel.connected`, `panel.recovery`
- Agent status: `agent.idleTimeout`
- Test command events (`Pixel Agent: Emit Test Events`): `test.sequence.started`, `test.sequence.workspace`, `test.sequence.builder`, `test.sequence.reviewerWarning`, `test.sequence.reviewerResolved`, `test.sequence.finished`

Webview berichttypes:

- Extension -> webview: `pixel.snapshot`, `pixel.event`
- Webview -> extension: `webview-ready`, `webview-request-snapshot`, `retry-dev-server`, `load-production`, `load-embedded`

Belangrijkste velden per runtime event:

- Verplicht: `type`, `timestamp`, `summary`
- Optioneel: `detail`, `filePath`, `agentId`, `status`, `progress`, `source`, `traceId`, `spanId`, `model`, `latencyMs`, `tokenUsage`, `git`
- `source` gebruikt op dit moment o.a. `local`, `copilot-export` en `codex`

## Git monitoring

- gebruikt de publieke VS Code Git API (`vscode.git`) wanneer beschikbaar
- kiest automatisch de repository van de actieve editor (of anders de eerste repo)
- stuurt debounced git-state events om event-spam te vermijden
- toont branch + change counts + statusboodschap in embedded en Vite webview UI

## Agentgedrag in de scene

- de scene is nu een vierkante lounge/command-room (`320x320`) met kamerachtergrond, workstations (Research/Engineering/QA), brede lounge-lus, rustbed, planthoek en centrale Ops AI monitor
- de Ops AI monitor reageert op binnenkomende prompts (`chat.userPrompt`, `codex.userMessage`) en laat dispatches (`ops.dispatch`) richting de gekozen agent zien
- de Ops AI monitor heeft extra idle chatter voor dirty git states en kantoor-kat activiteit, zodat de command-room ook zonder nieuwe events levendig blijft
- agents verplaatsen automatisch naar een workstation bij `working`, `completed` of `error`
- workstation-keuze gebeurt op basis van status + fase + taaktekst (bijv. lint/test/review -> QA, build/tsc/vite -> Engineering)
- idle agents volgen een lounge-route en doen korte routines zoals pause/dance/sleep, telefoon, zwaaien en plantzorg; het rustbed blijft bezet door maximaal 1 slapende agent tegelijk en settle-momenten houden slaap- en plantanimaties rustiger op hun plek
- een kantoor-kat kan af en toe de vloer opkomen, rondzwerven, loungen bij vaste spots, miauwen en weer vertrekken; persoonlijkheden variëren van `Stacktrace` tot `Director Whiskers`
- kantoor-katten gebruiken nu een intern routenetwerk met meerdere entry/exit nodes, scenic detours en vaste lounge-spots, zodat bewegingen minder teleport-achtig en natuurlijker ogen
- het rustbed en de Ops AI monitor zijn klikbaar in de canvas-scene; bed-click spawnt een willekeurige lounge-kat, monitor-click triggert direct de boss-cat `Director Whiskers`
- agenten worden als custom pixel/manga karakters gerenderd met visuele statusaccenten zoals speed lines, sparks en error-markers
- zodra een agent bij een werkplek is aangekomen, wisselt de animatie mee met de taak (`thinking`, `typing`, `reviewing`, `completed`, `error`)
- speech bubbles en Ops AI-dialogen strippen tooling-metadata zoals `Chunk ID`, `Wall time`, `Process exited with code` en ANSI escape-sequenties voordat tekst in de scene verschijnt
- analyse- en reasoning-events kunnen de busy-state langer vasthouden; daarna gaat een agent automatisch terug naar idle via `agent.idleTimeout`
- typing bursts op file-wijzigingen sturen extra ritmische progress-events per agent
- bestandsnamen sturen agent-keuze mee:
  - docs/readme/notities -> Scout
  - test/spec/lint/qa/diagnostic/ci -> Reviewer
  - overig -> Builder

## Copilot dekking

- In scope: events van de eigen @pixel participant via publieke API
- Best effort: publieke workspace/task/diagnostics signalen
- Niet beschikbaar: interne built-in Copilot agent-events zonder publieke extensie-API

## Workspace isolatie

- iedere VS Code window draait zijn eigen Pixel Agent runtime en eventlog
- workspace-, task-, terminal-, diagnostics- en git-events komen alleen uit de huidige IDE/workspace
- native Codex auto-discovery wordt gefilterd op sessies waarvan de `cwd` binnen de huidige workspace valt
- handmatige Codex import gebruikt workspace-context zoals `cwd`, `workspaceRoot`, `repositoryRoot` of absolute `filePath`/`path` wanneer die in records aanwezig is

## Ontwikkelflow

1. Start de extension host via debug (Run Pixel Agent Extension).
2. Open panel met Pixel Agent: Open Panel of @pixel /show.
3. Voer acties uit via Copilot, tasks of terminal en bekijk live events in het panel.
4. Gebruik fallback acties als je devserver tijdelijk niet bereikbaar is.
