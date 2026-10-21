# Telmoni for OpenCode — Agent Guidelines

The OpenCode plugin for Telmoni ([`telmoni/opencode-observability-plugin`](https://github.com/telmoni/opencode-observability-plugin)): a plugin OpenCode runs in its own process, which records each turn of a person's OpenCode sessions as a run, metadata only, through the TypeScript SDK of the platform ([`telmoni/telmoni`](https://github.com/telmoni/telmoni), `sdk/typescript`). It reaches a person's machine as the npm package `@telmoni/opencode-observability-plugin` alone, which OpenCode installs itself from its configuration; one default export serves OpenCode 1 and OpenCode 2. The repository is public, and every file in it is published as written.

## Ground Rules
- **Pre-launch:** nothing has shipped. Change the record and the package to their ideal state; no migration paths.
- **Quality gate:** never weaken a test or leave the tree broken.
- **Ask first:** any dependency change (an edit to `package.json` or `package-lock.json`, lockfile-only refreshes included) and any external-state change (publishing to npm, a listing in OpenCode's ecosystem pages, a call to a live Telmoni with a real key).
- **Metadata only, by construction:** a record holds models, providers, token counts, tool names, subagents' agents, times and outcomes. Never a prompt, a reply, a thought, a tool's input, output or title, a file's path, the working folder, a session's title or an error's message — the plugin reads OpenCode's events and messages no further than it takes to find those, and keeps nothing else.
- **OpenCode never waits:** no hook throws into OpenCode and none waits on the network while OpenCode works; a turn is handed to the outbox and sent in the background. Shutdown alone waits, three seconds at most, for the turns still to send. A failure is a line in `plugin.log` naming its kind, never anything from a session.
- **Nothing written beside OpenCode's configuration:** OpenCode 2 reloads its configuration on every write under `~/.config/opencode/`. The plugin only reads its key file there; its log is in the state folder, and it keeps no state on disk.

## Where Things Live
| Path | What |
|---|---|
| `src/index.ts` | The one default export: OpenCode 2's definition (`id`, `setup`) with OpenCode 1's `server` beside it. |
| `src/v1.ts` | OpenCode 1: a turn from `session.status` busy to idle, its replies noted from `message.updated`, read at idle through OpenCode's client. |
| `src/v2.ts` | OpenCode 2: a turn from `session.execution.started` to its end, its calls gathered from the event stream. |
| `src/record.ts` | A turn as the SDK's `RunRecord`: the run id, the provider's name, the token counts, the steps. |
| `src/send.ts`, `src/settings.ts`, `src/log.ts`, `src/opencode.ts` | Sending through the SDK; the key, endpoint and folders; `plugin.log`; the shapes of OpenCode's the plugin reads, defined here with their guards. |
| `tests/` | The suites; `tests/fixtures/` holds synthetic sessions written from OpenCode's own shapes. |
| `ARCHITECTURE.md` | How the plugin works, and why. |
| [`telmoni/telmoni`](https://github.com/telmoni/telmoni) | Sibling repo, checked out as `../telmoni`: the SDK this plugin is built on (`sdk/typescript`, `recordRun`), which it takes from npm as `telmoni`. |
| [`telmoni/docs`](https://github.com/telmoni/docs) | Sibling repo, checked out as `../docs`: the book, whose `api/coding-agents.mdx` documents this plugin. |

## Commands
- **After every change** (no permission needed; report failures verbatim): `make check` — the types, the bundle and the suites (`npm run verify`).
- **Locally:** an OpenCode 1 whose `plugin` list names this checkout's `dist/index.mjs` by its absolute path, or an OpenCode 2 whose `plugins` list names its `dist` folder (it refuses a file there), loads the plugin last built; `TELMONI_API_KEY` and `TELMONI_ENDPOINT` reach it from the environment OpenCode starts in.

## Code Rules
- TypeScript on Node 22, bundled by tsup into the one ESM file `dist/index.mjs` with the SDK inside it. OpenCode 1 runs plugins in Bun and OpenCode 2 in Bun or Node: plain Node APIs only, never Bun's. Nothing built is committed.
- No OpenCode package is a dependency: the few shapes the plugin reads are defined in `src/opencode.ts`, and every value OpenCode hands over is read through its guards.
- Everything that leaves goes through the SDK's `recordRun`, never a request of the plugin's own: the contract, the content rules and the retries are the SDK's.
- Comments are for a person reading the code, and short: they say *why*, never *what* — a doc comment in a line or two, an inline comment in one, a test's doc in one line on what it proves. The reasoning behind a change (a race worked through, the designs turned down, its history) goes in `ARCHITECTURE.md` or the commit message, never above a function, and editing a comment means shortening its whole block. No AI signatures anywhere.
- Never log a key, a token or anything read from a session; log kinds.

## Agent Hygiene
- **This repo only:** change nothing in another repository unless the user says so for this task; that binds subagents too. Reading is fine.
- Edit `AGENTS.md` only when the user asks outright; otherwise propose a diff.
- No scripted bulk edits. One-off scripts and logs go in `/tmp/telmoni/`. A fixture is synthetic, written from the shapes in OpenCode's sources, every text `…` and every path `/work/…`; one taken from a real session is scrubbed the same way, every id renamed and every time shifted, before it is written here.
- Never read, print or copy a `.env` file, OpenCode's `auth.json` or a `telmoni.json` key file, and never put a real key in a test, a fixture or a commit.

## Git Rules
- Commit only when asked: never `git add` or `git commit` unprompted.
- Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`) of 1–5 lines and the sign-off: a subject, then optionally a blank line and up to 3 lines on *why*. No file lists, test output, AI signatures or `Co-authored-by` trailers.
- Every commit is signed off by the developer it is made for, certifying the [Developer Certificate of Origin](https://developercertificate.org/): `git commit -s` adds `Signed-off-by: Name <email>` from git's `user.name` and `user.email`, which name a person, never an agent.
- No branches, worktrees, pushes or pull requests.

## Definition of Done
- [ ] `make check` passes, or the failure is reported verbatim.
- [ ] No key, no text from a session and no path reaches a log, a record, a fixture or a commit.
- [ ] `ARCHITECTURE.md` and `README.md` say what changed, and the book's `api/coding-agents.mdx` (`../docs`) is fixed or named.
- [ ] Nothing that needs asking happened unasked (dependencies, publishing, live calls, other repos, commits).
