# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-17

### Added

- Workspace-bound temporary chats: a **Temporary** option directly in the New
  Session row, so the normal workspace choice is reused and the composer never
  asks for a workspace again. The sidebar-foot entry resolves the current or
  most recent workspace instead of creating a workspace-less Session.
- Temporary **side chats**: select text in a conversation, click the floating
  action, and a forked copy opens in the right sidebar with the selection
  prefilled as a quote. The fork inherits the parent context and workspace,
  stays out of the sidebar and search while temporary, and can be **promoted**
  to a long-term session.
- `tempSession/register` now carries a `kind` (`main` or `side`); the Host
  accepts a fork only when its child-owned tail is unused, clears the inherited
  goal, and adds a side-chat boundary instruction.
- `tempSession/promote` drops the temporary record so exit and boot cleanup keep
  the log; the browser renames it from the selection.

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
