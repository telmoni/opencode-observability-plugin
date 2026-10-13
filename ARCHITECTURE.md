# Architecture

How the OpenCode plugin records a session, and why it is built so. What a person installs and sees is the book's page, [telmoni.com/docs/api/coding-agents](https://telmoni.com/docs/api/coding-agents).

## The shape

```
OpenCode 1 ──(the event hook)──▶ V1Turns: notes each reply made while its session is busy
                                    │ at idle, reads the session's messages through OpenCode's client
                                    ▼
OpenCode 2 ──(the event stream)──▶ V2Turns: gathers each call as its events come
                                    │ at the execution's end
                                    ▼
                           RunRecord ──▶ the SDK's recordRun ──(in the background)──▶ POST /otlp/v1/traces
```

A turn of the agent is a run of `opencode`; OpenCode's session id is the run's session, so a session reads in the console as a session of traces. Each reply of the model is a model call, each tool a tool call, and each subagent a step holding the subagent's own calls. OpenCode keeps a plugin running in its own process for as long as it runs, so the plugin watches each turn as it happens and records it once, as it ends.

## One package for both majors

OpenCode 1 (`opencode-ai`, its plugins listed under `plugin`) and OpenCode 2 (`@opencode/cli`, under `plugins`) are both current, and load a plugin differently:

- OpenCode 1 imports the package's `./server` export, or its `main`, and, finding a default export that is an object with an `id` and a `server` function, calls `server(input, options)` once for each folder it opens, keeping the hooks it returns.
- OpenCode 2 imports `./server`, or the package's root, reads the default export as a definition with a string `id` and a `setup` function, and calls `setup(context)`.

Each passes over the other's half, so the one default export is `{ id: 'telmoni.observability', setup, server }`, as Langfuse's plugin has. No OpenCode package is imported: the two majors publish their types under different names, and the plugin needs none of them at run time, so the few shapes it reads are defined in `src/opencode.ts` and every value OpenCode hands over is read through guards that pass over a field of the wrong shape.

OpenCode 2 reads an OpenCode 1 `plugin` list too, folding it into `plugins`; a plugin listed under both keys would be loaded twice. Both copies would record the same turn as the same bytes, which ingest answers once, but the README names one key.

## A plugin that never holds OpenCode

OpenCode 1 calls the `event` hook from inside its own publishing, without waiting on it: a throw there would reach whatever published the event, and a rejection would go unhandled. OpenCode 2 waits on `setup` and on the cleanup it returns. So every hook does its bookkeeping at once, catches everything, and returns. Reading a turn that has ended goes on after the event that ended it; the turn is handed to the outbox (`send.ts`), and its export runs in the background, awaited by no hook while OpenCode works. OpenCode 2 hands events through a stream the plugin follows in the background, its queue unbounded, so even a slow plugin would not slow OpenCode; but each event is handled at once.

Shutdown alone waits: OpenCode 1's `dispose` and OpenCode 2's cleanup wait for the turns still being read and sent, for three seconds at most (`SHUTDOWN_WAIT_MS`). A one-shot `opencode run` exits as its turn ends, with `process.exit()` on OpenCode 1, and nothing interactive waits on a shutdown, so a short wait there costs no one anything and keeps that turn from being lost.

## Turns in OpenCode 1

**When a turn ends.** A turn runs from its session's `session.status` turning `busy` — a `retry` is still busy — to its turning `idle`. OpenCode publishes the deprecated `session.idle` right after; whichever comes first ends the turn, so it is recorded once, and a release that drops either still ends it.

**Which replies are the turn's.** OpenCode 1 writes each step of the agent's loop as a reply — an assistant message answering the latest prompt — and publishes `message.updated` for it as it is made. The plugin notes the id of each reply made while its session is busy: a fork, which copies its history through the same event, does so outside any busy turn of its own, and a reply made more than a second before its session went busy is not the turn's, whatever brought it up again. OpenCode calls the hook as it publishes, so the moment the session went busy precedes the turn's first reply.

**Reading it.** At idle, the session's messages are read through the client OpenCode hands the plugin: the newest page of fifty, then a page further back each time (`before`, from `X-Next-Cursor`) until every noted reply and the prompt the first answers are in, forty pages at most. The events carry the parts' text as it streams, over and over; one read at the end gets each reply and part once, settled. Of a reply the plugin reads its ids, times, model, provider, agent, token counts and its error's name; of a part its type and times; of a tool part its name, status, and two fields of its metadata, whether it was interrupted and the subagent session it started. Never a part's text, a tool's input, output or title, a path, or an error's message.

**Model calls.** A reply is the model's where a step of it began or finished, or it failed: a command the person runs in the shell (`!`) is written as a reply holding the command as a tool, with no step, and is no model call, and a turn with no model call is no run. A model call runs from its reply's creation to the end of its answer — its last text or thought, or the last tool it asked for — since a reply is completed only once its tools are, and they are calls of their own. Its tokens are its `step-finish` parts' summed: OpenCode writes a reply's own count over at each step, keeping only the last.

**Outcomes.** A reply whose error is `MessageAbortedError` was interrupted, and its model call is cancelled; any other error fails it with the error's name (`APIError`), never its message. A tool whose state is `error` failed (`ToolError`), unless OpenCode marked it `interrupted`, when it is cancelled; one never answered, pending or running when the turn ended, is cancelled and ends with its reply. The run takes its last model call's outcome. A call OpenCode retried is one model call; its retries are not counted apart.

**Subagents.** A `task` call's metadata names the session it ran (`sessionId`). That session's messages are read from the call's start to the start of the next call that took the same session up again, its replies' calls making the step `subagent <agent>`; a nested subagent's calls join its parent's step, beside the call that started them, four deep at most. A session OpenCode named a subagent's — `parentID` on its `session.created`, or, where that went unseen, on what `client.session.get` answers — is never a run of its own. A subagent run in the background is recorded as far as it had got when its parent's turn ended.

## Turns in OpenCode 2

**When a turn ends.** OpenCode 2 publishes no `session.status` or `session.idle`: they are in its schema, and nothing publishes them. A turn is an execution, from `session.execution.started` to `.succeeded`, `.failed` or `.interrupted`. An interruption by OpenCode's own shutdown keeps the turn open, since the execution resumed at the next start carries on the same turn.

**Gathered as it comes.** Every event a record needs carries what it needs: `session.step.started` a reply's model, provider and when its request went out; `.streamed` when its answer ended; `.ended` or `.failed` its tokens and its error's kind; `session.tool.input.started` a tool's name, `.called` when it ran, `.success` or `.failed` when it ended and how. So a turn's calls are gathered as their events come, and nothing is read back — OpenCode 2's plugin context has no way to list a session's messages, only its current context, which compaction may cut. Of an event the plugin reads its type and time, and of its payload the ids, the agent, the model and provider, token counts, a tool's name, the kind of an error and the subagent session a call started. Never a text, a thought, a tool's input or output, a path, a title or an error's message.

**Named by its prompt.** A prompt reaches a session as an inbox item, delivered (`session.inbox.delivered`) inside the execution, and the message it becomes takes the item's id, which names the turn. A turn the plugin came into while it ran, having been loaded then, is named by its first reply.

**Model calls.** A model call runs from its request to the end of its answer (`.streamed`), since the step settles only after its tools. A reply tried again after an error is one model call, from its first request to its last answer. A compaction's own request (`session.compaction.ended`, with its model and tokens) is a model call too. The model calls OpenCode makes beside the agent's loop for itself, a session's title among them, are in no event a plugin is given, and are not recorded.

**Outcomes.** An error of kind `aborted` — the person, or OpenCode, stopped it — cancels a call; any other fails it, a model call with the error's kind (`provider.rate-limit`), a tool with `ToolError`. A call never settled when the turn ended is cancelled and ends with it. An execution that failed fails the run with its error's kind; one interrupted cancels it.

**Subagents.** A `subagent` call's metadata names the session it started (`sessionID`), as that session's `session.created` names its parent; neither is ever a run of its own. A subagent's calls are kept while the turn that started it runs, and at its end become the call's step, from the call to the next call that took the same subagent up again. A subagent still working when the turn ends is recorded as far as it had got: its calls in flight end with the turn, cancelled, and what it does after is not recorded.

## Ids, and sending each turn once

A run's id is a version 5 UUID of the session's id and the id of the turn's user message, under the plugin's own namespace, so a turn recorded twice is the same run. A turn with no user message of its own is named by its first reply instead: on OpenCode 1, one that takes up a prompt an earlier turn already answered, so two turns never share an id; on OpenCode 2, one the plugin came into while it ran. The SDK derives every span's id from the run's id and its place in the record, and queues a record in one synchronous pass, so the same turn sent again is the same bytes, which ingest answers as it answered the first, for an hour.

The plugin keeps what it knows of each turn in memory, and nothing on disk. The Claude Code plugin keeps an offset per session because its hook is a process started anew at each stop; this one is loaded once and sees each turn end as it happens, so there is nothing to remember between turns, and no file is written per turn — OpenCode 2 watches its configuration folder and reloads on every write there, and the person's disk is not the plugin's to fill. The cost: a turn running when OpenCode exits is not recorded, and one running when OpenCode reloads its plugins is recorded from where the plugin came back in — OpenCode 1 says a session is busy again at each step of its loop, and on OpenCode 2 the next reply opens the turn.

**Sending again.** Each turn is sent from an SDK client of its own, made for it and shut down after, so the SDK's warnings are that turn's alone: a turn counts as taken when its flush settles with no warning, as in the Claude Code plugin. Every send goes through one chain, so two turns ending together never send at once. A turn the platform did not take — after the SDK's own retries of a `429`, a `503` or a failed connection — stays in the outbox, oldest first, and goes again at the next turn's end and at shutdown, before the new one; a Telmoni that does not answer is asked once a round, not once a turn. The outbox keeps the newest 200 and says in the log how many older ones it dropped. It lives in memory, as everything here does: what is still waiting when OpenCode exits, past the shutdown's three seconds, is not sent.

## Where things are kept

Nothing per turn. `plugin.log`, in `telmoni/opencode/` under the person's state folder (`XDG_STATE_HOME`, `~/.local/state` by default), is written only when something goes wrong, mode `600` in a folder of mode `700`, and moved to `plugin.log.1` past a megabyte. Never under OpenCode's configuration folder, which OpenCode 2 watches.

The key and the endpoint are the SDKs' own `TELMONI_API_KEY` and `TELMONI_ENDPOINT`, each, where unset, from `telmoni.json` (`{ "apiKey": …, "endpoint": … }`) in OpenCode's configuration folder: `OPENCODE_CONFIG_DIR` where it is set, then `XDG_CONFIG_HOME`'s `opencode`, `~/.config/opencode` on Linux and macOS alike, the first file found deciding. The plugin reads the file and never writes it, and reads it only where it is the person's own and shut to everyone else, mode `600`, as `ssh` reads a key: a file others could write could name an endpoint of theirs, and the key would go to it. Both are read as OpenCode loads the plugin. Without a key nothing is sent, and the log says so once each load; an endpoint that would carry the key in the clear, plain HTTP off this machine, is refused by the SDK, and nothing is sent.

The provider is OpenCode's id where the GenAI conventions spell it the same (`anthropic`, `openai`), their name where they spell it otherwise (`amazon-bedrock` is `aws.bedrock`, `google` is `gcp.gemini`, `google-vertex` and `google-vertex-anthropic` are `gcp.vertex_ai`, `azure` and `azure-cognitive-services` are `azure.ai.openai`, `mistral` is `mistral_ai`, `xai` is `x_ai`), and OpenCode's id where they have no name for it (`openrouter`, `github-copilot`, a person's own).

## What ships

The npm package `telmoni-opencode-observability-plugin` holds `dist/index.mjs` — tsup's one bundle of the plugin, the SDK and OpenTelemetry — beside `package.json`, `README.md` and `LICENSE`, which npm always adds; `main` and `exports` (`.` and `./server`) name the bundle, where each major looks. OpenCode installs the package itself, under `~/.cache/opencode/`, and runs none of its scripts; nothing is installed beside it. OpenCode 1 runs plugins in Bun and OpenCode 2 in Bun or Node, so the plugin uses plain Node APIs. It names no `engines.opencode`, which OpenCode 1 alone checks, and against which it would skip the plugin on a prerelease build; 1.18.29, the first release documented to load a plugin's default object, is the README's floor.

Until the SDKs are published, the SDK is a development dependency by path (`file:../telmoni/sdk/typescript`), bundled at build; publishing this package waits on theirs, and the dependency becomes the registry's `telmoni` in the same change.

## Testing

`tests/` replays each major's turns from synthetic sessions written from OpenCode's own shapes (`tests/fixtures/`, every text `…` and every path `/work/…`): the records' calls, times, tokens and outcomes, subagents, interruptions and failures, and that no record holds a text or a path; the key file and the folders; the sender through the real SDK to a fake ingest; and the built plugin loaded as each major's loader loads it, sending to the fake ingest, never throwing and never waiting on it. No OpenCode runs in the suites: none is installed here, and no session of a person's is recorded.
