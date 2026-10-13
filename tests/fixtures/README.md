# Fixtures

Every file here is **synthetic**. OpenCode is not run to make them, and no real session is in them. Each is written by hand from the shapes OpenCode's own sources give, read on 2026-10-12:

- `v1/`: OpenCode 1.19.0. The events are what its `event` hook is handed (`{ id, type, properties }`). `sessions` holds what `client.session.get` and `client.session.messages` answer for each session (`packages/schema/src/v1/session.ts`).
- `v2/`: OpenCode 2.0.27. The events are what its plugin context's `event.subscribe()` yields (`{ id, type, created, data, location?, durable? }`; `packages/schema/src/session-event.ts`).

Every field OpenCode writes is filled in, those the plugin must never read among them, so the suites can show they never reach a record:

- every text, thought, prompt, title, tool input and output, error message and diff is `…`;
- every path is `/work/…`.

No record may hold `…` or `/`.

Ids are invented: `ses_`, `msg_`, `prt_`, `call_` and `evt_` with a running number. Times are milliseconds from 2026-10-12T09:00:00Z (`1791795600000`); the suites that run the built plugin shift them all to the moment they run.

| File | What it holds |
|---|---|
| `v1/turn.json` | One turn: three replies, one of them in two steps, with five tools, one of which failed. |
| `v1/subagent.json` | A turn whose `task` call ran a subagent, which ran a subagent of its own. |
| `v1/interrupted.json` | A turn the person interrupted mid-tool. |
| `v1/failed.json` | A turn whose last reply failed with the provider's error. |
| `v2/turn.json` | One execution: three replies, one of them retried, with two tools, one of which failed. |
| `v2/subagent.json` | An execution whose `subagent` call ran a subagent in a child session. |
| `v2/interrupted.json` | An execution the person interrupted mid-tool. |
| `v2/shutdown.json` | An execution OpenCode's shutdown interrupted, resumed at its next start. |
| `v2/failed.json` | An execution that failed on the provider's rate limit. |
