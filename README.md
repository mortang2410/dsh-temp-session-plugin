# Temporary Sessions for DeepSeek Harness

[中文](README.zh.md)

A small, dependency-free DSH plugin that adds **temporary sessions**: start a
throwaway chat from the sidebar, use it like any other session, and have its
stored log deleted when the application exits. Temporary sessions never show up
in your history after a restart.

The plugin is a standard DSH bundle (Host plugin + Web client module). It is
plain JavaScript with no build step, so it installs directly from GitHub.

![Temporary session entry and composer marker](docs/screenshot.png)

## Features

- **Sidebar entry** — a "Temporary chat" button at the foot of the sidebar.
- **Full native session** — the temporary session runs the real agent with the
  usual tools, model, permissions, streaming, and attachments.
- **Clear marking** — a dashed strip above the composer says the chat is
  temporary and offers the end action, even for a blank session; the sidebar
  foot counts active temporary chats. Once the first message is sent, the row
  is titled `Temporary chat · HH:mm`, gains a small badge while idle, and the
  conversation header shows a `Temporary` chip.
- **End without opening** — end a temporary session from the header or from the
  session row's "…" menu. It is archived (hidden from the list) immediately.
- **Deleted on quit** — the Host removes every temporary session's log directory
  on exit (normal exit, `SIGTERM`, or `SIGINT`).
- **Crash recovery** — if the process was killed hard, the next boot deletes the
  leftover logs before the browser can list them.
- **Bilingual UI** — Chinese and English, following the DSH language setting.

## Requirements

- DeepSeek Harness `0.2.x` (`engines.dsh` is declared; verified with the
  `0.2.1-rc.1` Web profile and its client bundle. Desktop uses the same Host and
  client extension points).
- The shipped JSONL session store (`@deepseek-ai/dsh-session-persistence-jsonl`),
  which is the default in the Web and Desktop profiles. Registration is refused
  with a clear message on a storage backend that cannot report its session
  directory.

## Install

The repository itself is the installable bundle. No build step and no
`prepare` script are involved.

### Desktop app

Open **Settings → Plugins**, add this install target, then enable it:

```text
github:wj-spec/dsh-temp-session-plugin
```

Or install it with the CLI into the Desktop profile:

```sh
dsh plugin --profile desktop add 'github:wj-spec/dsh-temp-session-plugin'
```

Restart the app (or let the live profile reload apply the Host row) and refresh
the page so the browser loads the client module.

### Web profile

```sh
dsh plugin --profile web add 'github:wj-spec/dsh-temp-session-plugin'
```

Restart the Web process and refresh the page.

### Pin a version

After a release tag exists, pin the tag so later pushes cannot change what runs:

```sh
dsh plugin --profile web add 'github:wj-spec/dsh-temp-session-plugin#v0.1.0'
```

### Uninstall

```sh
dsh plugin --profile web remove dsh-temp-session-plugin
```

Removing the bundle stops new temporary sessions. A previously recorded session
is still cleaned up on the next boot **only if the plugin was loaded at least
once** in that process; if you uninstall the plugin while temporary logs remain,
delete them manually (see Privacy).

## Usage

1. Click **Temporary chat** at the foot of the sidebar. A fresh, blank session
   opens in the current project directory (or the first workspace's directory
   when no session is open).
2. Chat normally. The header shows the `Temporary` chip.
3. Click the trash button in the header (or use the session row's "…" menu →
   **End temporary chat**) to archive and hide it.
4. Quit the app. Every temporary session's log directory is deleted.

You can keep multiple temporary sessions alive at once. They are ordinary
sessions until they end; they are not inherited context for each other.

## How it works

The bundle has two halves:

- **Host** (`index.js`, `core.js`) — records a temporary session id plus the
  exact per-session directory returned by the JSONL store, titles the session,
  and owns deletion. The registry lives at
  `$DSH_HOME/temp-session/records.json` (mode `0600`).
- **Web client** (`client.js`) — registers the sidebar entry with an active
  count, the composer marker and end action, the header chip, the row menu item,
  and the row badge. Creation is a normal `session.create` call followed by a
  custom `tempSession/register` Remote call.

Deletion points:

| Moment | What happens |
|---|---|
| App exit / `SIGTERM` / `SIGINT` | Every recorded temporary session directory is deleted synchronously. |
| Plugin unload / live profile reload | Only sessions the user already ended are deleted; live ones stay. |
| Next boot | Recorded sessions with no live agent are deleted before the browser connects, and their archive entries are cleared. |

Safety boundaries:

- Only a **fresh, empty, top-level, unseeded** session may become temporary, so
  a caller cannot convert existing history.
- Deletion only targets a directory whose final path segment contains the
  session id, is absolute, and is nested at least three levels deep.
- Records are stored under `$DSH_HOME`, and the registry is written atomically.
- The plugin never deletes attachments or other sessions' data.

## Privacy

Temporary means **the conversation log is deleted**, not that nothing is ever
written:

- For the duration of the session, DSH writes its normal checkpointed log. This
  is what makes streaming, tools, and crash handling work.
- **Attachments are not deleted.** DSH stores images and other attachment blobs
  content-addressed under `$DSH_HOME/attachments/v1`, without a session owner.
  Avoid attaching sensitive files to a temporary session if you need a clean
  slate.
- **The projection cache is not purged.** DSH's `session_projcache` may keep a
  row keyed by the session id. Once the log is gone the row is unreachable and
  never listed or resumed, but it is not physically removed by this plugin.
- If the process is killed with `SIGKILL` (or the machine loses power), logs
  survive until the next successful boot of the same profile.

## Known limitations

- Ending a temporary session archives and hides it, but its log remains on disk
  until the app exits. DSH `0.2.x` does not expose a per-session delete command
  for a live agent.
- Remote/mobile peers are not granted access to the `tempSession` Remote
  namespace; creating a temporary session from a remote connection is refused.
- Only the default JSONL backend is supported. The plugin refuses to register on
  a backend that cannot locate a session directory.
- UI integration relies on stable `0.2.x` slots (`sidebar.footer.action`,
  `conversation.session.header.actions`,
  `sidebar.workspaces.session.menu.item`, `sidebar.session.row.leading`,
  `shell.overlay`). A future DSH release may rename them.

## Development

Use a disposable profile, never your daily one:

```sh
dsh --profile temp-dev --from-default-profile web --dump-config
dsh plugin --profile temp-dev add /absolute/path/to/dsh-temp-session-plugin
dsh --profile temp-dev --dump-config
dsh --profile temp-dev
```

Tests require no dependencies:

```sh
npm test       # Host registry cleanup + browser wiring
npm run check  # syntax + tests
```

Source map:

| File | Role |
|---|---|
| `index.js` | Host plugin: services, Remote contribution, boot/signal cleanup |
| `core.js` | Registry, path safety, async/sync deletion (no Cordis dependency) |
| `remote.js` | Host Typert Remote descriptors |
| `client.js` | Browser module: entries, badge, end actions, notice |
| `cordis.patch.yml` | Bundle layer inserting the Host row |
| `locale/*.json` | Plugin-manager title and description |

## License

MIT — see [LICENSE](LICENSE).
