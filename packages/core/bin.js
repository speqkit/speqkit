#!/usr/bin/env node
// The file `bin` names, kept out of `dist` on purpose.
//
// A package manager links `node_modules/.bin/speq` while it installs, and it
// links nothing when the file the manifest names is not there yet. In a
// published tarball `dist` always is. In this repository it is not: install
// comes before build, so pointing `bin` straight at `dist/bin.js` meant a
// fresh clone printed twenty "Failed to create bin" warnings and then had no
// `speq` on its path — including in `examples/basic`, which is the first
// thing a stranger runs.
//
// So the manifest names a file that is committed, and the built entry is one
// import away. Nothing else changes: the standalone binaries and the publish
// check bundle `dist/bin.js` directly, as they did before.
import './dist/bin.js'
