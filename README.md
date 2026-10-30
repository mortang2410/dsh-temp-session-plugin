# Temporary Sessions for DeepSeek Harness

[中文](README.zh.md)

A small, dependency-free DSH plugin that adds **temporary sessions** in two
shapes:

- a workspace-bound throwaway **chat** created from the normal New Session flow;
- a **side chat** opened in the right sidebar from selected text, forked from
  the current conversation, with the selection prefilled in the composer.

Both run the real agent and both are deleted when the application exits. There
is no promotion path: a temporary chat cannot become permanent.

The plugin is a standard DSH bundle (Host plugin + Web client module). It is
plain JavaScript with no build step, so it installs directly from GitHub.

![Workspace + menu with New session and Temporary chat](docs/screenshot.png)

## Features

- **Workspace + menu** — a workspace row's `+` now opens a small menu with
  **New session** and **Temporary chat**. The temporary chat is created in
  that exact workspace, so it never asks you to pick one afterwards. A
  `Temporary` pill in the New Session row still marks a freshly started blank
  session as well.
- **Selection side chat** — select text in a conversation and click the floating
  **Temporary chat** action. A forked copy of the conversation opens in the
  right sidebar, with the selection prefilled as a quote in the composer.
- **No promotion** - the browser has no keep button, and a stale host promote
  call is refused with `promotion is disabled`.
- **Full native session** — temporary chats run the real agent with the usual
  tools, model, permissions, streaming, and inherited context.
- **Clear marking** — a dashed strip above the composer says the chat is
  temporary and offers the end action, even for a blank session. Once the first
  message is sent, the row is titled `Temporary chat · HH:mm`, gains a small
  badge while idle, and the conversation header shows a `Temporary` chip.
- **Hidden side chats** - while temporary, forked side chats stay out of the
  sidebar and search for their whole lifetime.
- **End without opening** — end a main temporary chat from the strip above the
  composer. It is archived (hidden from the list) immediately. Closing a side-chat tab discards it.
- **Deleted on quit** - the Host removes every temporary session's log
  directory on exit (normal exit, `SIGTERM`, or `SIGINT`).
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
dsh plugin --profile web add 'github:wj-spec/dsh-temp-session-plugin#v0.2.2'
```

### Uninstall

```sh
dsh plugin --profile web remove dsh-temp-session-plugin
```

Removing the bundle stops new temporary sessions and disables boot-time cleanup.
If temporary logs remain, delete them manually: the registry at
`$DSH_HOME/temp-session/records.json` lists each recorded session directory.

## Usage

### A temporary chat in a workspace

1. Hover a workspace row and click its `+`. A menu offers **New session** and
   **Temporary chat**.
2. Choose **Temporary chat**. The new chat is attached to that workspace; the
   dashed strip above the composer confirms it.
3. Chat normally. The row is titled `Temporary chat · HH:mm` once the first
   message is sent, and the header shows a `Temporary` chip.
4. End it from the strip above the composer, or just quit the app. Its log
   directory is deleted on exit.

You can also start a normal **New session** and click the **Temporary** pill in
the New Session row to adopt it as temporary.

### A temporary side chat from selected text

1. Open a conversation that has at least one completed turn.
2. Select text in the transcript. A floating **Temporary chat** action appears.
3. Click it. A fork of the conversation opens in the right sidebar, the
   selection is prefilled as a quote, and the tab is marked temporary.
4. Ask your side question in the right pane. The main conversation stays as it
   was. While temporary, the fork is hidden from the sidebar.
5. Close the tab to discard the side chat.

You can keep multiple temporary chats open at once. Each side chat inherits the
parent conversation up to its last completed turn; the inherited history is
reference context, not a continuation of the main task.

## How it works

The bundle has two halves:

- **Host** (`index.js`, `core.js`) — records a temporary session id, its kind,
  its direct parent Session and the exact per-session directory returned by the
  JSONL store. It titles the session, detaches a side chat from the inherited
  goal, and owns deletion. A mutable index lives at
  `$DSH_HOME/temp-session/records.json` (mode `0600`); an append-only ownership
  journal at `$DSH_HOME/temp-session/ownership.jsonl` records why a Session is
  temporary before its transcript is indexed.
- **Web client** (`client.js`) — registers the New Session pill, the sidebar
  shortcut, the composer strip, the header chip, the row menu item and badge,
  the selection action, the `tempchat` right-sidebar tab, and the hidden-side-chat
  filter. A side chat is a normal `session.fork` plus a
  `tempSession/register(kind: "side")` Remote call. `tempSession/promote` stays
  only to refuse stale callers with `promotion is disabled`.

Deletion points:

| Moment | What happens |
|---|---|
| App exit / `SIGTERM` / `SIGINT` | Every directory in the validated exit snapshot is deleted synchronously; exit never parses the registry file. |
| Plugin unload / live profile reload | Pending sessions are stopped again, and only members whose stop is confirmed idle with no owned job are deleted; live or unconfirmed work stays. |
| Next boot | Journal-pending sessions resume their stop before the browser connects; confirmed members are deleted and their archive entries are cleared. |

Safety boundaries:

- A main temporary chat must be **fresh, empty, top-level, and unseeded**. A side
  chat must be a **fork whose child-owned tail is unused** (only the inherited
  prefix carries turns). Neither can convert arbitrary existing history, and a
  subagent Session is refused.
- A subagent the Host creates under a recorded chat is recorded automatically
  (`kind: "subagent"`) and follows that chat through exit, discard, and unload
  cleanup. Discard archives each chat with its activity stop, cancels live
  Agents, and kills owned jobs; records stay visibly stopping until settlement
  is confirmed. Plugin unload deletes only members it confirms idle with no
  owned job; process exit deletes every directory in its validated exit
  snapshot, and the next boot resumes a pending stop and deletes confirmed
  members. A descendant is recorded only when
  its parent chain reaches a recorded temporary id through live ordinary forks
  or subagent Sessions. A chain with no recorded ancestor is never recorded.
- Deletion only targets a directory whose final path segment contains the
  session id, is absolute, and is nested at least three levels deep.
- Records are stored under `$DSH_HOME`, and the registry is written atomically.
- The plugin never deletes attachments or other sessions' data.

## Privacy

Temporary means **the conversation log is deleted**, not that nothing is ever
written:

- For the duration of the session, DSH writes its normal checkpointed log. This
  is what makes streaming, tools, and crash handling work.
- A side chat is a **fork**: its new log contains a copy of the parent history
  up to the fork point. Deleting the side chat does not touch the parent; keep
  that copy in mind if the parent conversation is sensitive.
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

- A side chat needs a **completed turn** in the parent; a brand-new chat shows a
  notice instead of forking.
- Ending a main temporary chat archives and hides it, and asks the Host to stop
  its Agents and jobs, but its log remains on disk until unload confirms it
  idle, the app exits, or the next boot resumes the stop. Closing a side-chat
  tab marks it the same way.
- Closing a side-chat tab is permanent for that temporary fork: there is no
  reopen entry, and it is deleted on exit.
- A hidden temporary side chat is kept out of the sidebar by a client-side
  filter over the shipped workspace browser; a page reload rehydrates the hidden
  set from the Host registry. It also stays in its workspace's membership list
  after deletion, which the browser filters out (a harmless dangling id).
- Remote/mobile peers are not granted access to the `tempSession` Remote
  namespace; creating a temporary session from a remote connection is refused.
- Only the default JSONL backend is supported. The plugin refuses to register on
  a backend that cannot locate a session directory.
- UI integration relies on stable `0.2.x` slots (`conversation.hero.options`,
  `conversation.session.header.actions`, `conversation.input.dock`,
  `sidebar.session.row.leading`, `sidebar.right.pane.tab`, `shell.overlay`,
  and the workspace browser's trailing `+` button). A future DSH release may
  rename or reorder them.

## Verification

- `npm run check`: 207 Host/client tests with no dependencies.
- Playwright against a disposable `0.2.1-rc.1` Web profile: workspace `+` menu
  (both choices), no sidebar-foot temporary entry, selection action, fork,
  native right-sidebar conversation, quoted draft prefill, hidden sidebar row,
  tab-close discard, `SIGTERM` log deletion, and boot cleanup.
- Not verified: a real model answer inside a side chat (the test environment had
  no credentials; the fork was cut from a completed-but-failed turn), and a
  stale promote refusal through a real browser or Gateway. The Desktop app uses
  the same Host and client pieces but was not re-run separately.

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
| `client.js` | Browser module: entries, side chat, badge, end/stopping actions, notice |
| `cordis.patch.yml` | Bundle layer inserting the Host row |
| `locale/*.json` | Plugin-manager title and description |

## License

MIT — see [LICENSE](LICENSE).
