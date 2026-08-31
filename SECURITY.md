# Security policy

## Reporting a vulnerability

**Use GitHub's private reporting:**
<https://github.com/speqkit/speqkit/security/advisories/new> — or the
*Report a vulnerability* button on the repository's Security tab. It opens a
private thread with the maintainers, and it is the only channel that lets a fix
and its advisory be prepared before the problem is public.

If that is unavailable to you, email <stepan.kaziatko@gmail.com> with
`speqkit security` in the subject.

Please do not open a public issue for anything you believe is exploitable.

**What to expect.** An acknowledgement within three working days and an
assessment within seven. If it is a vulnerability, we will agree a disclosure
date with you, credit you in the advisory unless you would rather we did not,
and publish the fix as an ordinary release. If it is not, we will say why —
plainly, and without treating the report as a waste of anyone's time. This is a
small project maintained by volunteers; those numbers are commitments to reply,
not to have shipped a patch.

## Supported versions

Pre-1.0, and shipped continuously: a version bump merged to main is a release.
Only the latest one is supported. There are no maintenance branches and no
backports, so the fix for anything reported here will be in the next version
rather than in a patch to yours.

| Version | Supported |
| --- | --- |
| Latest release | ✅ |
| Anything older | ❌ — upgrade |

## What is in scope

The parts of speqkit that decide what code ends up running on your machine:

- **`@speqkit/installer`** — resolving from a registry, verifying integrity,
  extracting into `~/.speq`, and `speq.lock`. A tarball that escapes the store,
  a hash that is not actually checked, a lock file that installs something other
  than what it names, a ref that resolves to a different commit than the one
  reviewed.
- **The standalone binary and `packaging/install.sh`** — the archive is verified
  against a published sha256 and the script refuses to install without it.
  Anything that gets around that check is a vulnerability.
- **The kernel** — `${...}` resolution, config `extends`, the loader, artifact
  and report paths. Anything that turns data in a test file into code execution
  or a write outside the run's directories.
- **The release pipeline** — `.github/workflows/*`. Anything that lets a fork,
  a pull request or a plugin author cause a publish, reach a secret, or land a
  formula in the tap.

## What is not a vulnerability

**Plugins are arbitrary code, on purpose.** `speq install` downloads plugin
packages and `speq run` executes them in the same process as the kernel, with
your environment and your credentials. There is no sandbox, and none is planned:
a plugin that could not open a socket or read a file would not be able to test
anything. A malicious plugin doing malicious things is the same trust decision
as `npm install`, and it is yours to make — which is what `speq.lock`,
`--frozen` and `speq doctor` are for. A report that a plugin can do harm is a
report about the design; a report that a plugin can do harm **without being
listed in `speq.yaml` and recorded in `speq.lock`** is a vulnerability, and we
want it.

The same goes for `${env:...}`: it puts values from your environment into
requests because that is what it is for.

## Two things worth knowing as a user

- **Reports can contain secrets.** A run records step results, and an HTTP step
  records the response headers — which is where `set-cookie` and a session token
  live. `.speq/reports/` is uploaded as a CI artifact in the workflow we
  recommend. Treat those artifacts with the same access rules as the environment
  the suite ran against.
- **Integrity is checked, but a package can decline to publish a hash.** The
  installer verifies `sha512`/`sha1` from the registry and *warns* rather than
  fails when a package publishes neither. If you require the strong guarantee,
  the warning in `speq install` output is the thing to grep for.

Every package we publish carries [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
— a signed statement, in a public transparency log, of which workflow at which
commit built the tarball. `npm audit signatures` checks it.
