# CLI package and agent skill

The npm package contains the Bun-required `robodocks` executable, runtime source,
canonical documentation, examples and one companion skill. No compilation,
postinstall hook, credentials or global agent configuration changes are needed.
Bun must already be available on PATH and satisfy package.json engines; Node
alone is not a supported runtime because the ledger uses `bun:sqlite`.

Before any registry release, verify package-name ownership, version selection,
registry credentials and release provenance in a separately authorized release.
This change prepares and tests a local tarball; it does not claim a published
npm version exists.

For a local candidate, run:

    bun pm pack --ignore-scripts
    bun add --global ./robodocks-0.0.1.tgz --ignore-scripts
    robodocks --version
    robodocks --help

The exact tarball name follows package.json version. Use a private explicit
ledger location outside the installation directory. Upgrading the package is
not a database backup or a guarantee that a cloud workspace will survive.

The bundled skill is `skills/robodocks/SKILL.md` within the installed package.
An agent host must explicitly discover or install it through its own supported
mechanism. There is no automatic global skill installation. Read CLI help and
canonical schemas alongside the skill; the skill cannot override CLI policy or
provide authentication.

## Artifact verification

`bun run test:package` packs the candidate with lifecycle scripts disabled,
checks its exact member allowlist, installs that same artifact in a temporary
project outside the checkout with production dependencies only, and exercises
the installed executable. It checks help/version, synthetic plan/replay/inspect, local backup and fresh-path
restore with replay and pending-record continuity, workspace initialization,
task creation and conservative read-only inventory,
invalid-input JSON errors, sanitized help/version output failures using Linux
`/dev/full`, absence of development dependencies, and installed
file bytes against the source package. It never publishes to npm or calls a
live repository. Dependency installation may contact the npm registry.

The smoke uses Linux `tar` and Bun and initially claims Linux/Bun 1.4.4 only.
macOS and Windows have not been validated. Tarball and temporary installation
are deleted on success; failed fixtures are retained with their path for
investigation. No registry publication, bot authentication, live comment
posting, environment-replacement recovery or cross-platform binary support is
implied by a passing package smoke.
