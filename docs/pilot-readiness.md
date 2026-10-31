# GitHub App pilot readiness

This is a public-safe operational checklist, not an installation guide that grants
permission to act. The selected architecture is a dedicated GitHub App, an
assistant-managed cloud workspace and external-agent reasoning. No personal
computer or mandatory paid model provider is required. The initial pilot target
is `DocksDocks/robodocks`; other operators must choose their own explicit target.

The library publisher is implemented and tested with isolated transports. It has
no default live transport, publishing CLI, token discovery or enabled automation.
Passing tests is not evidence that an operational host has been provisioned.
See [architecture](architecture.md) and [security boundaries](security.md).

## Proposed registration settings — not applied

| Setting                                           | Initial pilot choice                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| Ownership                                         | Operator-controlled account owning the selected pilot repository             |
| App name                                          | Dedicated Robodocks identity; check global name availability before creation |
| Homepage                                          | Public project repository URL                                                |
| Installation availability                         | Only on the owning account                                                   |
| Webhooks                                          | Active unchecked; no receiver or event subscriptions                         |
| User OAuth / device flow                          | Not requested; installation identity only                                    |
| Repository permission                             | Issues: read and write; Metadata: read-only                                  |
| Other repository/account/organization permissions | No access                                                                    |
| Installation repository selection                 | Only the explicitly approved pilot repository                                |

GitHub supports registration without active webhooks, and a public repository
URL can serve as the homepage. Registration availability and repository selection
are different controls: restricting an App to its owner's account does not
restrict an installation to one repository. [Registration reference](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

The conversation-comment endpoint accepts Issues write **or** Pull requests
write. This implementation's lease contract selects Issues write; do not add
Pull requests write, Contents write, Actions or Administration just for this
operation. GitHub's permission is broader than one comment: it also permits
other issue operations. Robodocks' one-intent restriction is an application/host
control, not a narrower GitHub permission. Public source/context acquisition
remains unauthenticated. Private repository support is not part of this pilot.
[Comment endpoint permissions](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment),
[installation permission and repository selection](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party).

Registration, installation and credential issuance are separate consequential
steps. This document approves none of them. Do not generate keys or retrieve
secrets while merely preparing the registration settings.

## Required host evidence

Record actual evidence in a private operator runbook. Do not fill unknowns with
inferred capability or a successful local unit test.

| Capability                 | Evidence required before live operation                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolated credential issuer | Concrete host mechanism keeps App key/signing authority outside the agent/repository execution workspace                                                             |
| Scoped credential lease    | Issuer verifies installation, App, bot and numeric repository identity; issues short-lived credentials scoped to the selected repository and Issues write            |
| Scoped request transport   | Lease transport uses those credentials, restricts requests to the intended GitHub operation/target, and does not leak them through errors, redirects, output or logs |
| One-intent authorization   | Trusted host approves the exact immutable proposal, body digest, target/head and expiry; repository text cannot mint approval                                        |
| Authoritative ledger       | Private single-writer location, access controls and known lifecycle across task/workspace replacement                                                                |
| Independent recovery copy  | Private destination outside the disposable workspace, supported snapshot process, retention owner and explicit loss/recovery objectives                              |
| Runtime                    | Clean packaged artifact works on the actual host with the pinned supported Bun runtime                                                                               |
| Recovery drill             | Fresh environment restores history and pending/uncertain states; migrated/restored v2 remains quarantined                                                            |
| Operational ownership      | Named operator can revoke access, stop dispatch and preserve evidence after an uncertain result                                                                      |

An installation-token issuer must explicitly narrow repository IDs and
permissions rather than inherit all installation access. Tokens are opaque; do
not assume a fixed length or parse token text to establish identity.
[Installation-token reference](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

A readable directory, a second SQLite file in the same workspace, or an existing
GitHub connector does not establish these capabilities. A connector's identity
must not be assumed to be the dedicated App's identity. Do not select an unrelated
saved environment just because it is available. A development workspace
does not by itself prove secret isolation or durable retention.

## Evidence status at the initial readiness review

- Implemented: explicit library publisher, one-intent authorization boundary,
  persisted sending/unknown/acknowledged attempts, bounded positive reconciliation,
  schema migration/recovery validation, and restore/migration quarantine.
- Not established: dedicated App registration/installation, protected issuer,
  production lease transport, durable host lifecycle, actual replacement recovery,
  or an authorized live pilot comment.
- Host selection remains an evidence gate: verify the chosen workspace rather
  than treating development access as proof of a persistent operational service.

This status is dated **2026-10-31**, not a permanent platform limitation. Update
it only with observed evidence. Keep environment references, account operational
IDs, storage locations, keys and tokens out of public repository documents.

## Staged operational acceptance

1. **Read-only preparation:** confirm the chosen host's documented capabilities,
   registration settings and private evidence plan. No new infrastructure is
   silently selected or purchased.
2. **Registration approval:** obtain explicit permission for the concrete App
   registration. Record its actual identity privately; do not assume name
   availability. Installation and key generation are not included by implication.
3. **Provisioning approvals:** separately authorize the exact installation scope,
   protected key/issuer setup and storage changes. Do not download an App key into
   the agent workspace. Do not paste credentials into chat or commit them.
4. **No-post validation:** validate identity, permissions, expiry, target isolation,
   transport behavior and recovery on the selected host without enabling comment
   dispatch. Credential issuance itself still requires authorization.
5. **First-comment approval:** approve one exact proposal on one selected PR only
   after the host evidence gates pass. No recurring permission, webhook or schedule
   follows from that approval.
6. **Verify outcome:** validate comment identity/author/body and persisted
   acknowledgement. On uncertainty, reconcile; do not resend because no matching
   comment is currently visible.

Stop at the first missing capability or authorization and name it precisely.
Another preview, readiness Boolean or mock host is not a substitute for evidence.

## Recovery is intentionally fail-closed

Migration and supported v2 backup/restore quarantine publishing. Reconciliation
cannot clear quarantine, and there is no operational release/unquarantine feature
in this slice. A first pilot should use a genuinely new authoritative ledger,
not a replacement ledger created to evade uncertain history. A restored pilot
must remain stopped until a separately reviewed recovery process establishes
safe resumption. An old snapshot can omit an already successful external write;
local persistence does not create exactly-once posting.

## Public versus private records

This file is the reusable public checklist. Keep the actual App/installation/bot
IDs, host configuration, storage paths, approval evidence and recovery drill
results in the operator's private runbook; secret values belong only in the
approved secret system. Public PRs can report a redacted capability/result, never
credential material or private operational details. Do not change unrelated
roadmap issue dispositions as part of completing this checklist.
