# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A fork made from a temporary chat is temporary at every depth, including a
  fork of a fork and a fork of a recorded subagent. Its true direct parent is
  recorded, and a late descendant of a pending tree inherits pending/stopping
  and is enqueued for a stop.
- The browser follows the Host publisher epoch and per-response sequence,
  ignores delayed replies, keeps pending state terminal until the record is
  dropped, and shows a per-chat stopping entry independent of closed chat views.
- A subagent child of a recorded temporary chat is recorded when the Host announces it
  (`session/created`), with `kind: "subagent"` and `parentSessionId` (the nearest recorded ancestor).
  Exit, discard, and unload cleanup delete it with its chat. A chain that does not reach a
  recorded id through live Sessions is never recorded. The record shape gains two fields; the
  file's top-level shape and version are unchanged.

### Changed

- Promotion is removed. The browser has no promote control, and a stale host
  `promote()` call is refused with `promotion is disabled`.
- A side-chat registration upgrades its existing fork record in place to
  `kind: "side"` and prepares it once.

### Fixed

- A side-chat upgrade that loses its first title save or final index save now
  finishes goal detachment, boundary instruction and native title on the next
  register, including after a reload.
- A restored pending side tab is retried after its saved layout is adopted, a
  pending fork selected later in the main view is closed, and a side chat that
  becomes pending while its fork is in flight is never opened.
- `register()` now resolves the storage directory and publishes the registry record before the
  session log is materialized. Previously it flushed the log first and saved the record after, so
  a turn persisted during registration was visible while the Session was still unregistered, to
  every reader that gates on this file (mirrors, retention hooks). The locator computes the path
  from the header, so no flush is needed to resolve it; a backend that cannot answer is refused
  before anything is written.
- A `flush()` failure rolls the record back only when the log artifact did not land. The Host
  backend creates the session directory first, then links the log, then syncs the directory, so a
  failure after the directory exists says nothing about the transcript: the check is the final
  artifact path the locator returns. A publication that did land keeps the record, and a
  publication that did not is not gated.
- Subagent records of a temporary chat are narrowed and kept longer. A subagent whose parent chain
  passes through a live, unrecorded ordinary (non-subagent) Session is no longer recorded, so discard
  and unload cleanup cannot delete a transcript the chat does not own. A live profile reload keeps a
  settled child record and its log while the chat stays live, and a later discard deletes them.
  Process exit also deletes a child whose registry save has not finished, because its record is read
  from memory as well as from disk. Discard no longer sends `cancel` to subagent children, which the
  Host refuses: a running child keeps running until it settles, and its record is marked for deletion
  with its chat.

## [0.2.2] - 2026-10-18

### Changed

- Removed the separate sidebar-foot Temporary chat entry and its active count.
  Temporary chats are now created from the workspace row's `+`, which opens a
  **New session / Temporary chat** menu in that exact workspace.
- New Session's `Temporary` pill remains as the adopt-this-blank-session path.

### Fixed

- The floating selection action keeps its opaque background on hover; the
  previous transparent hover token let the selected text show through, which
  looked like the text floating up behind the button.

## [0.2.1] - 2026-10-18

### Fixed

- The floating selection action no longer sets a native `title` tooltip, whose
  hover bubble overlapped the transcript. The hint remains its accessible name.
- Removed the `End temporary chat` entry from the session row's "…" menu; the
  composer strip remains the place to end a main temporary chat.

## [0.2.0] - 2026-10-17

### Added

- Workspace-bound temporary chats: a **Temporary** option directly in the New
  Session row, so the normal workspace choice is reused and the composer never
  asks for a workspace again. The sidebar-foot entry resolves the current or
  most recent workspace instead of creating a workspace-less Session.
- Temporary **side chats**: select text in a conversation, click the floating
  action, and a forked copy opens in the right sidebar with the selection
  prefilled as a quote. The fork inherits the parent context and workspace,
  stays out of the sidebar and search while temporary. This release also
  introduced promotion, which Unreleased removes.
- `tempSession/register` now carries a `kind` (`main` or `side`); the Host
  accepts a fork only when its child-owned tail is unused, clears the inherited
  goal, and adds a side-chat boundary instruction.
- `tempSession/promote` dropped the temporary record so exit and boot cleanup
  kept the log; Unreleased removes that path and refuses stale calls.

### Changed

- `tempSession/list` returns ended records with `pendingDelete` so a page reload
  can keep hiding a closed side chat until the Host deletes it.

## [0.1.0] - 2026-10-17

### Added

- Temporary sessions: create a throwaway chat from the sidebar foot, marked by a
  strip above the composer, an active count in the sidebar foot, a title-row
  chip, and a session-row badge.
- End action above the composer and in the session row menu; ended sessions are
  archived and their logs are deleted when the application exits.
- Crash recovery: the Host deletes leftover temporary sessions during the next
  boot, before the browser can list them.
- Synchronous cleanup on normal exit, `SIGTERM`, and `SIGINT`.
- English and Chinese UI and plugin metadata.
- Unit tests for the Host registry/cleanup rules and the browser wiring, run
  with the built-in `node --test`.
