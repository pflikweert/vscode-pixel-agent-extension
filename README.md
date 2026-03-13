# Pixel Copilot Agent

Standalone VS Code extensie in een eigen repository met:

- een @pixel chat participant voor Copilot Chat
- een Pixel Agent panel met runtime events (chat, workspace, diagnostics, taken en terminal commands)
- een hybride webview-flow:
  - devserver via Vite voor snelle UI-iteratie
  - production bundle in dist/webview voor packaged runs
  - fallback-scherm bij offline devserver

## Wat Je Nu Krijgt

- live panel met Scout, Builder en Reviewer status
- eventlog met realtime updates uit extension host
- echte Copilot Language Model call-flow via `vscode.lm.selectChatModels` + streaming response
- terminal command telemetry (start/einde + exit status)
- Endfield Command Grid scene met middenplein, workstations (Research/Engineering/QA) en rustbed
- fasegestuurde agentstatus in UI (`wacht op input`, `analyseert`, `antwoordt`, `bezig`, `afgerond`, `fout`)
- dynamische character sprites uit `webview-ui/src/assets/agent-characters.jpg` (auto-detectie + grid fallback)
- robuuste webview-start met dev/prod/embedded recovery in plaats van zwart scherm

## Projectstructuur

- src/extension.ts: extension-host logica, @pixel participant, runtime events en webview loading modes
- webview-ui/src/\*: Vite webview frontend met HMR
- webview-ui/src/assets/\*: sprite-sheet(s) en andere frontend-assets
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

## Scripts

- npm run build: bouwt extension en webview-assets
- npm run build:extension: compileert extension host
- npm run build:webview: buildt webview-ui naar dist/webview
- npm run watch: TypeScript watch voor extension host
- npm run dev:webview: start Vite devserver op 127.0.0.1:5173

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
- workspace events: file change/save/create/delete/rename en actieve editor
- diagnostics updates: errors en warnings
- VS Code tasks: gestart/afgerond inclusief exit status
- terminal events: terminal open/close en shell command start/einde met exit code
- git events: branch, ahead/behind, staged/unstaged/conflicts en clean/changed/conflict transitions

## Ondersteunde event types (actueel)

Runtime event types (in eventLog, via `emitRuntimeEvent`):

- Extension lifecycle: `extension.activated`
- Chat lifecycle: `chat.received`, `chat.processing`, `chat.streaming`, `chat.completed`, `chat.error`
- Copilot LM/export: `copilot.modelSelected`, `copilot.exportSent`, `copilot.exportFailed`, `copilot.exportSkipped`
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

## Git monitoring

- gebruikt de publieke VS Code Git API (`vscode.git`) wanneer beschikbaar
- kiest automatisch de repository van de actieve editor (of anders de eerste repo)
- stuurt debounced git-state events om event-spam te vermijden
- toont branch + change counts + statusboodschap in embedded en Vite webview UI

## Agentgedrag in de scene

- de scene is een command-grid met middenplein (idle), workstations (Research/Engineering/QA) en rustbed (max 1 slapende agent)
- agents verplaatsen automatisch naar een workstation bij `working`, `completed` of `error`
- workstation-keuze gebeurt op basis van status + fase + taaktekst (bijv. lint/test/review -> QA, build/tsc/vite -> Engineering)
- idle agents doen korte routines (pause/dance/sleep) en idle chatter in speech bubbles met overlap-avoidance
- character sprites worden bij opstart uit de sprite-sheet geladen; als detectie faalt, gebruikt de UI een grid fallback
- na inactiviteit gaat een agent automatisch terug naar idle (`agent.idleTimeout` in extension host, en webview-reset na ~10s)
- typing bursts op file-wijzigingen sturen extra ritmische progress-events per agent
- bestandsnamen sturen agent-keuze mee:
  - docs/readme/notities -> Scout
  - test/spec/lint/qa/diagnostic/ci -> Reviewer
  - overig -> Builder

## Copilot dekking

- In scope: events van de eigen @pixel participant via publieke API
- Best effort: publieke workspace/task/diagnostics signalen
- Niet beschikbaar: interne built-in Copilot agent-events zonder publieke extensie-API

## Ontwikkelflow

1. Start de extension host via debug (Run Pixel Agent Extension).
2. Open panel met Pixel Agent: Open Panel of @pixel /show.
3. Voer acties uit via Copilot, tasks of terminal en bekijk live events in het panel.
4. Gebruik fallback acties als je devserver tijdelijk niet bereikbaar is.
