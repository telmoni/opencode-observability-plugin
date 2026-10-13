# Telmoni for OpenCode

Records each turn of your [OpenCode](https://opencode.ai) sessions in [Telmoni](https://telmoni.com) as a run: the models it called and their tokens, the tools it used and the subagents it started, each with its times and whether it failed. Never a prompt, a reply, a thought, a tool's input or output, a file's path, the folder you work in or a session's title.

## Install

You need OpenCode 1.18.29 or later, or OpenCode 2. OpenCode installs the plugin itself: the npm package [`telmoni-opencode-observability-plugin`](https://www.npmjs.com/package/telmoni-opencode-observability-plugin), its built file alone.

On OpenCode 1, name it in the `plugin` list of your `opencode.json` — the global one, `~/.config/opencode/opencode.json`, or a project's:

```json
{
  "plugin": ["telmoni-opencode-observability-plugin"]
}
```

or have OpenCode add it to the global one:

```sh
opencode plugin telmoni-opencode-observability-plugin -g
```

On OpenCode 2, the list is `plugins`:

```json
{
  "plugins": ["telmoni-opencode-observability-plugin"]
}
```

or:

```sh
opencode plugin add telmoni-opencode-observability-plugin
```

One key is enough: OpenCode 2 reads an OpenCode 1 `plugin` list too, and sets the plugin up once even where it is named under both.

## Configure

Make a project API key holding the **ingest** scope on your project's API keys page, then make a key file that only you can read, and put the key in it with your editor:

```sh
touch ~/.config/opencode/telmoni.json
chmod 600 ~/.config/opencode/telmoni.json
"${EDITOR:-vi}" ~/.config/opencode/telmoni.json
```

```json
{
  "apiKey": "telmoni_…"
}
```

The plugin reads the file only while it is yours and shut to everyone else (`chmod 600`), and never writes it. `"endpoint"` defaults to `https://api.telmoni.com`; a self-hosted Telmoni gives its own machine host. Where you set `OPENCODE_CONFIG_DIR` or `XDG_CONFIG_HOME`, the file goes in that folder instead. `TELMONI_API_KEY` and `TELMONI_ENDPOINT`, in the environment OpenCode starts in, serve before the file.

Restart OpenCode: the plugin reads its key as OpenCode loads it.

## What it records

Each turn — from your prompt to the agent's last reply, or to your interruption — is a run of the agent `opencode`, and your session is its session, so the console shows a session as a session of traces. Inside the run:

- each reply of the model, a model call with its model, its provider and its token counts, the cache's reads and writes among them;
- each tool call, by its name, with its time, failed where the tool failed and cancelled where you interrupted it;
- each subagent, a step named by its agent (`subagent explore`) holding its own model and tool calls.

A turn is sent as it ends, in the background, and a turn sent twice is stored once. A command you run yourself with `!` is not the agent's turn, and is not recorded.

## When something is wrong

The plugin never slows or interrupts OpenCode: nothing it does while OpenCode works waits on the network, and as OpenCode shuts down it waits three seconds at most for the turns still to send. Anything that went wrong is a line in `~/.local/state/telmoni/opencode/plugin.log` (under `XDG_STATE_HOME` where you set one), naming what kind of thing went wrong and never anything from your session. A turn that could not reach Telmoni is sent again as the next turn ends, while OpenCode runs; one Telmoni answered and refused is not, and the log says what it answered. A turn still running when OpenCode quits is not recorded, and one running when it reloads its plugins is recorded from the reload on; on OpenCode 2, a subagent at work then may show as a run of its own.

## Uninstall

Take `telmoni-opencode-observability-plugin` out of `plugin` or `plugins` (`opencode plugin remove telmoni-opencode-observability-plugin` on OpenCode 2), then delete `~/.config/opencode/telmoni.json` and `~/.local/state/telmoni/opencode/`.

## License

Apache-2.0
