# Contributing

Thanks for taking a look! This is a small, dependency-free DSH bundle: plain
JavaScript, no build step, and tests that use only Node built-ins.

## Development setup

Do **not** develop against your daily DSH profile. Use a throwaway profile so
installs and reloads cannot disturb the profile you actually use:

```sh
# Create a disposable web profile from the shipped template, without booting it.
dsh --profile temp-dev --from-default-profile web --dump-config

# Install this checkout into that profile.
dsh plugin --profile temp-dev add /absolute/path/to/dsh-temp-session-plugin

# Inspect the composed layer, then boot it and open the Web UI.
dsh --profile temp-dev --dump-config
dsh --profile temp-dev
```

Changes to `client.js` need a page refresh; Host changes need the profile to be
reloaded (the plugin manager can reconcile, or restart the profile process).

## Tests

```sh
npm test          # node --test test/*.test.mjs
npm run check     # syntax checks + tests
```

No `npm install` is required: the browser-side test stubs React, and the Host
test only uses `node:fs`/`node:path`/`node:test`.

## Pull requests

- Keep the plugin dependency-free and JavaScript-only. A build step would make
  GitHub installs require pnpm build authorization on the user's machine.
- Keep every user-visible string in `client.js` dictionaries (`zh` and `en`)
  and in `locale/*.json` for the plugin manager metadata.
- `remote.js` and `client.js` both declare the `tempSession` wire codecs (the
  browser bundle cannot import the Host file). `test/client.test.mjs` compares
  their endpoint, service, parameter, and result identities; update both halves
  together or that test fails.
- Add a test when you change cleanup rules. Deleting stored sessions is the
  riskiest part of this plugin; `test/core.test.mjs` documents the intended
  safety boundaries.
- Describe the DSH version you verified against in the PR, and note anything
  you could not verify (for example, a real browser UI run).
