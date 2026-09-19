# Public API

Hub exposes organization-scoped operator operations under `/api/v1`:

| Operation                                   | Scope                    | Endpoint                                 |
| ------------------------------------------- | ------------------------ | ---------------------------------------- |
| List active projects                        | `projects:read`          | `GET /api/v1/projects`                   |
| Validate configuration without writing      | `configuration:validate` | `POST /api/v1/configurations/validate`   |
| List resolvable configuration resources     | `configuration:validate` | `GET /api/v1/configuration-resources`    |
| Install and activate configuration          | `configuration:install`  | `POST /api/v1/configurations/install`    |
| Dispatch a durable manual run               | `runs:dispatch`          | `POST /api/v1/manual-runs`               |
| Issue a short-lived daemon enrollment token | `daemons:enroll`         | `POST /api/v1/daemons/enrollment-tokens` |

Create a scoped API key in the Hub dashboard or approve `paseo hub login` in the browser, then send the resulting organization credential as `Authorization: Bearer <credential>`. CLI credentials carry all current operator scopes, are stored server-side only as verifiers, and can be revoked under Settings → API keys → CLI logins. They are not daemon credentials.

CLI login starts anonymously at `POST /api/v1/cli-authorizations` and polls at `POST /api/v1/cli-authorizations/poll`. An authenticated owner or admin explicitly approves the active organization at `/cli-login`. The expiring grant is poll-throttled and discloses its durable credential exactly once. Daemons enroll only through the short-lived, single-use token issued by the authenticated enrollment-token operation. A daemon may connect with no permissions and remain available for identity and presence only; only daemons that explicitly grant `hub.execute` are eligible workflow targets.

The canonical, executable operation and schema reference is served by each Hub instance at `/api/reference`; its OpenAPI 3.1 document is `/api/openapi.json`. There are no unversioned operator aliases.

Every canonical `/api/v1` response, including unknown paths and wrong methods, uses RFC 9457 `application/problem+json` on failure and includes `X-Request-ID`; callers may supply that header to correlate a request. Wrong methods return `405` with `Allow`, while unknown paths return `404`. Every `401` response also includes `WWW-Authenticate: Bearer`.

Configuration YAML may include an optional top-level `name` slug as deployment metadata. An explicit request `projectSlug` (including the CLI's `--project`/`-p` option) is authoritative. Otherwise Hub resolves or creates the named project in the authenticated organization; without either field, it resolves or restores that organization's `default` project. Changing `name` targets a different project and leaves the old project's history intact.

Configuration validation and installation accept the same YAML, optional `projectSlug`, and prompt-partial bundle. Both use the same parser, compiler, project selection, daemon/provider resolution, and business validation. Validation returns the resolved `projectSlug` and `wouldCreateProject` without creating a project, recording a revision, or changing active configuration. Installation silently creates a missing bundle-named or default project, then records and activates the revision.

## Workflow MCP tools

Hub sends each daemon the authored rendered prompt unchanged. Execution tools are exposed through the provider-native Hub MCP server and its exact tool policy; Hub does not prepend a tool inventory or otherwise rewrite the prompt. Completion is exposed as `finish_execution`; allowed and materialized output tools use their registered names, such as `reply`. For structured-output steps, `finish_execution` accepts the configured result under `output`. Completing an execution does not necessarily complete the whole workflow.

## Trigger prompt and optional context

`${{ paseo.prompt }}` is exactly the complete text received by any textual trigger, including provider mentions, command markers, typed-input headers, and whitespace. Parsing those elements can select a trigger or populate `${{ paseo.inputs }}`, but never rewrites the prompt. Structured manual input without a textual prompt produces an empty string. `${{ paseo.context }}` is a separate opt-in merge value containing safe ambient provider data. Each workflow step opts in independently: a step that does not author `${{ paseo.context }}` receives no ambient context, no automatic attachment list, and no prompt mutation. Context history and attachment descriptors are fetched and materialized only when an opting step launches; attachment descriptors are Hub URLs scoped to that execution. Provider credentials, raw tokens, private provider download URLs, and unrelated webhook fields are not exposed. There is no alias or fallback for the removed automatic prompt behavior.

Daemon environments may author `worktree.newBranch: "trigger-${{ paseo.execution.id }}"` for a stable branch name unique to each agent execution. Hub materializes the execution UUID before persisting or dispatching the launch intent; recovery reuses that fully rendered intent. This is independent of whether a manual, Slack, Discord, GitHub, or Linear trigger selected the reusable environment. No prompt, context, input, value, step output, or provider event namespace is available in environment configuration, and unsupported expressions fail bundle activation at the authored `newBranch` field.

`deliveryKey` is caller-supplied request identity for the existing durable manual-event path. Hub namespaces it by the authenticated organization and resolved project before persistence, so the same caller key can be used independently in different tenants or projects. Existing receipt/run de-duplication applies, but this API does not promise exactly-once execution or guaranteed response replay; retries can still fail or conflict during restart and timing races. A successful representation contains `deliveryKey`, `providerEventReceiptId`, `triggerRunId`, `configuredTriggerName`, and the durable `workflowStatus`.

## Room projections

Hub serves read-only projections of ANVIL Room authority — the `anvil_core` store on Neo is the single durable authority for Room and execution state. Hub never mints Room identities, never writes authority tables, and never claims authority for what it serves.

| Operation                        | Scope        | Endpoint                            |
| -------------------------------- | ------------ | ----------------------------------- |
| List readable Rooms              | `rooms:read` | `GET /api/v1/rooms`                 |
| Get a Room snapshot              | `rooms:read` | `GET /api/v1/rooms/{roomId}`        |
| Replay Room events from a cursor | `rooms:read` | `GET /api/v1/rooms/{roomId}/events` |

Every successful projection response carries `observed_at` — when the authority state backing the response was observed — and `stale`, computed at serve time from `observed_at` against the instance's freshness budget (`PASEO_HUB_ANVIL_PROJECTION_STALE_MS`, default `30000` ms). An observation older than the budget, or one that cannot be dated, reports `stale: true`. Freshness fields are descriptive metadata about when state was last observed, not a guarantee of currency; callers should treat `stale: true` responses as last-known state.

Event replay is a deterministic cursor over the authority-assigned `room_seq`: re-issuing a cursor replays an identical page, and `next_cursor`/`has_more` derive from the committed high-water `latest_seq`. Event `kind` passes through unchanged — the authority taxonomy is owned by ANVIL and grows without Hub redeployment. Events whose payload carries an observation contract (today `sieve.projection`, carrying `observed_at` and `stale_after_ms`) are additionally annotated with a per-event `freshness: {observed_at, stale}` computed at serve time; the stored event is never mutated.

Hub reads authority through the Neo-side read API — the `anvil-neo-mcp` MCP surface, bearer-authenticated over the tailnet — when `PASEO_HUB_ANVIL_READ_API_URL` plus `PASEO_HUB_ANVIL_READ_API_TOKEN` or `PASEO_HUB_ANVIL_READ_API_TOKEN_FILE` are configured. It never opens a tailnet-direct Postgres connection to Neo. A dedicated read-only Postgres pool (`PASEO_HUB_ANVIL_DATABASE_URL`) remains for authority-adjacent deployments; configuring both transports fails closed at boot. Either way, every projected row passed a durable `room.read` grant check for the Hub instance's bound ANVIL subject (`PASEO_HUB_ANVIL_SUBJECT`).

Hub's own `agent_executions` table is workflow bookkeeping internal to this Hub instance — a projection of execution state, not authority (ANVIL integration campaign, demotion F2). It is not served as Room authority and must not be cited as the source of truth for execution identity; that lives in `anvil_core` (`room_events`, `execution_bindings`). The demotion is documented here and at the schema; the table is not deleted.

The self-hosted Scalar reference is served with a restrictive Content Security Policy and does not require external fonts, scripts, telemetry, registries, or proxies.

## Plan catalog

`GET /api/billing/plans` is unauthenticated and read-only. It returns the plan catalog mirrored
from Stripe (see docs/billing.md) as marketing copy and pricing only. It never includes the
entitlement template (`granted` caps/flags/meters); that stays internal to `src/billing/` and
`src/entitlements/`. This is the shape the marketing site (paseo.sh) fetches to render pricing;
Hub itself has no pricing page.

It returns the plans that are for sale. The catalog also carries the internal record that
authors the no-subscription entitlement floor; that one is withheld here and everywhere else a
customer can see. Today the hosted offer is one plan:

```json
{
  "plans": [
    {
      "slug": "hosted",
      "name": "Hosted",
      "billing": {
        "model": "per_unit",
        "unit": {
          "key": "seat",
          "label": "seat"
        }
      },
      "features": [
        {
          "key": "hub-operation",
          "label": "Paseo operates Hub",
          "tooltip": null
        }
      ],
      "prices": [
        {
          "interval": "monthly",
          "intervalCount": 1,
          "unitAmount": 1500,
          "currency": "eur",
          "tooltip": "Seats are Hub members and pending invitations. People who only trigger agents through GitHub, Slack, or Discord do not count as seats."
        }
      ]
    }
  ]
}
```

`unitAmount` is the amount per billing unit in the smallest currency unit (cents for `eur`),
matching Stripe's own `Price` convention. An interval is absent when the plan has no active price
at that interval. A
self-hosted instance without `STRIPE_SECRET_KEY` 404s this route rather than serving an empty
catalog — the billing boundary means the route is never registered on an unconfigured instance.
See docs/billing.md.
