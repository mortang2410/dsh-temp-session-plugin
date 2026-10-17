# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-17

### Added

- Temporary sessions: create a throwaway chat from the sidebar foot, marked in
  the session row and the conversation header.
- End action in the header and in the session row menu; ended sessions are
  archived and their logs are deleted when the application exits.
- Crash recovery: the Host deletes leftover temporary sessions during the next
  boot, before the browser can list them.
- Synchronous cleanup on normal exit, `SIGTERM`, and `SIGINT`.
- English and Chinese UI and plugin metadata.
- Unit tests for the Host registry/cleanup rules and the browser wiring, run
  with the built-in `node --test`.
