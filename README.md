# Local-LLM software-development graph

The intended system is a complete development graph: issue readiness and
decomposition, Codex goal-based implementation, deterministic checks, parallel
specialist reviewers, manager consolidation and human escalation, recording,
and separate scheduled graphs for self-improvement, refactoring discovery, and
new-feature suggestions. The durable GitHub → Mastra loop below is the first
implemented slice, not the complete workflow.

Future agent sessions should begin with `AGENTS.md`. The full design, reviewer
contract, conflict handling, visual-design evidence, recorder, and learning
boundary are documented in `docs/architecture.md`. Machine-readable node status
and the required reviewer set live in `src/graph-definition.ts`.

## How we arrived at this architecture

This project grew out of a discussion about three overlapping ways of thinking
about AI-assisted development. Harness engineering gives a coding agent its
working environment: repository context, tools, skills, constraints, and a goal.
The agent can think, act, inspect the result, and correct itself within a turn.
Codex goal mode adds a durable outcome and verification criteria across that
work, but it is not the same as an independent reviewer.

Loop engineering moves beyond a single human prompt and agent turn. We used the
four-loop model in which the agent loop performs the work, the verification loop
sends failed work back, the event-driven loop starts runs from GitHub events or
schedules, and the hill-climbing loop improves the system from accumulated
experience. These loops are nested rather than competing ideas:

```mermaid
flowchart LR
  H["Hill-climbing loop"] --> E["Event-driven loop"]
  E --> V["Verification loop"]
  V --> A["Agent loop"]
```

Graph engineering does not claim that these mechanisms are new. It foregrounds
an aspect that can become hard to see when everything is called a loop: the
topology connecting agents, deterministic checks, parallel reviewers, joins,
repair routes, persisted state, side effects, and human decisions. The concise
distinction for the webinar is: loop engineering focuses on repeated execution
and feedback; graph engineering focuses attention on the relationships through
which that work moves.

For this implementation, Codex is the write-capable software-development worker,
while Mastra is the durable TypeScript orchestration layer around it. That
separation lets the coding harness concentrate on implementation and lets the
graph control triggers, correlation, retries, suspension, concurrency, and
review routing. Mastra also fits the Angular meetup context better than making a
Python-first orchestration framework the centre of the demonstration. OpenHands
and Hermes were considered useful coding-agent or self-evolution references,
but neither replaces the explicit orchestration graph needed here. Hermes's
self-evolution work particularly influenced the separation between recording a
run and later evaluating a proposed improvement.

The development graph begins with a GitHub issue or pull-request event. Before
implementation, a readiness node verifies that the issue has enough information
and meaningful acceptance criteria. It may ask a human for missing context or
propose multiple child issues when the work contains independently deliverable
outcomes. The system must not invent product decisions merely to keep moving.

One Codex worker then implements an accepted issue in an isolated worktree. Its
inner self-correction answers whether its latest action worked; goal validation
answers whether the overall requested outcome is complete. Deterministic checks
then run repository-owned tests, builds, linting, type checks, and policies.
Agent-written tests are useful implementation output, but they cannot alone be
independent proof that the same agent understood the requirement correctly.
Acceptance criteria, existing tests, externally defined checks, independent
review, and human evaluation form that boundary.

After those checks, read-only specialist reviewers independently examine
security, architecture, framework-specific practices, performance, tests,
accessibility, code quality, likely bugs, and visual design. Visual design is a
real rendered-output review: it needs baseline and candidate screenshots and
application design references, not merely source-code inspection.

A manager node consolidates reviewer evidence rather than counting votes. It
deduplicates findings, resolves compatible recommendations, and returns one
bounded repair brief to implementation. If architecture and performance, for
example, recommend genuinely incompatible choices and the acceptance criteria do
not establish the priority, the manager suspends the run. A human then receives
both arguments, their evidence and costs, and the precise decision required.

Finally, a recorder captures enough evidence to reconstruct what happened:
inputs, attempts, commands, changed files, deterministic results, reviewer and
manager decisions, human feedback, outcomes, and exact graph, prompt, skill,
rubric, and model versions. Learning is deliberately a separate scheduled
process. It reads new experiences after `lastAnalysedRunId`, distils recurring
lessons, proposes versioned candidates, and replays the same cases against a
frozen baseline. Regression and safety gates plus human approval are required
before a candidate can affect future runs. The production graph never rewrites
itself while it is running.

## Implemented control-plane slice

GitHub events are recorded in SQLite first and acknowledged quickly. A
coordinator gives Mastra at most one implementation slot by default. An event
that arrives while Mastra is working never interrupts the current model turn.

Before the simulated implementation step, a real readiness agent calls the
OpenAI-compatible model configured in `.env`. It evaluates the issue title,
body, labels, and human clarifications against a structured schema. Every
attempt appends its input, decision, model ID, prompt version, graph version, timing, usage,
and error state to `readiness_evaluations`. An underspecified issue suspends at
the readiness step; a subsequent human issue comment is durable input to a new
evaluation of that same Mastra run. Issue decomposition is not implemented yet.

For the same issue, the coordinator attaches the event to the existing run's
inbox. For a different issue it creates another run, which waits for the local
implementation slot. GitHub delivery IDs make retries harmless, and messages
produced by the configured bot are ignored to prevent feedback loops.

```mermaid
flowchart LR
  GH["GitHub event"] --> IN["Durable SQLite inbox"]
  IN --> ROUTE{"Existing run for issue?"}
  ROUTE -->|yes| ATTACH["Attach to its inbox"]
  ROUTE -->|no| QUEUE["Create queued run"]
  ATTACH --> WAIT{"Waiting for human?"}
  WAIT -->|human comment| RESUME["Resume same Mastra run"]
  WAIT -->|currently working| BOUNDARY["Read at safe step boundary"]
  QUEUE --> SLOT["Acquire implementation slot"]
  SLOT --> MASTRA["Mastra workflow"]
  RESUME --> MASTRA
```

## Run it locally

Node 24 and pnpm are required.

```sh
pnpm install
cp .env.example .env
pnpm start
```

The readiness agent expects an OpenAI-compatible model server. These values are
deployment configuration and belong in the ignored `.env` file:

```dotenv
MODEL_BASE_URL=http://127.0.0.1:8888/v1
MODEL_API_KEY=local
READINESS_MODEL=unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_XL
READINESS_TIMEOUT_MS=120000
```

`READINESS_TIMEOUT_MS` prevents a stalled local generation from occupying the
workflow indefinitely. No small output-token limit is imposed.

The service listens only on `127.0.0.1:4317`. `GET /health` shows whether an
implementation occupies the slot, and `GET /runs` shows the durable run state.
The event database and Mastra workflow snapshots and observability traces live
separately under `.data/`. Structured runtime logs are also written to the
terminal.

### Post readiness questions to GitHub

The receiver can use a GitHub App to post a readiness question directly on the
issue that owns the suspended run. Create an app with repository permissions
**Metadata: read** and **Issues: read and write**, install it on the target
repository, download its private key, and place that PEM file in the ignored
`.secrets/` directory. Then configure the ignored `.env` file:

```dotenv
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=78901234
GITHUB_APP_PRIVATE_KEY_PATH=.secrets/github-app.pem
GITHUB_BOT_LOGIN=your-app-slug[bot]
```

All three `GITHUB_APP_*` settings must be present together. With no GitHub App
configured, readiness still suspends and its question remains visible in
Mastra Studio and in the pending `github_comment_outbox` row, but nothing is
posted externally.

Question delivery is independent of the short Actions job. The suspension and
outbox row are committed together; the local outbox worker obtains a short-lived
installation token, looks for the unique run marker, and then posts if needed.
Transient failures use exponential backoff. On restart, an uncertain send is
reconciled by marker before another comment can be created. The marker also
causes the resulting bot webhook to be ignored, preventing a feedback loop.
Only human comments received after the recorded suspension boundary can resume
that question.

`GET /health` reports whether GitHub comment delivery is enabled and the number
of pending or failed deliveries. `GET /github-comments` exposes the local
outbox history, including attempts, errors, and the resulting GitHub comment
URL.

Run Mastra Studio to inspect the workflow graph and execution history:

```sh
pnpm studio
```

Open `http://localhost:4111`, select **Workflows**, then select the
`github-implementation` workflow. Select a run in its **Runs** list to see step
status, inputs, outputs, suspension state, timing, and traces persisted in
`.data/mastra.sqlite`.

The included [GitHub Actions workflow](.github/workflows/implementer.yml) uses a
self-hosted runner labelled `implementer`. That runner opens an outbound
connection to GitHub, receives the job, and posts the event to the loop service
on the same machine. The local machine therefore needs no public inbound port.
For a direct GitHub webhook, expose the receiver through a secure tunnel and set
`GITHUB_WEBHOOK_SECRET`; the receiver validates `x-hub-signature-256`.

## Install the GitHub runner

The runner setup belongs to this checkout, while the downloaded GitHub runner,
its credentials, and job workspace remain under the ignored
`.data/actions-runner/` directory. Authenticate GitHub CLI with an account that
can administer Actions runners for this repository, then configure the runner:

```sh
gh auth login
pnpm runner:setup
pnpm runner:start
```

Select the repository in `.env` using its `owner/repository` name:

```dotenv
GITHUB_REPOSITORY=Soverius-AI/software-development-workflow-local-llms
```

`runner:start` keeps the runner in the foreground. On macOS or Linux it can
instead be installed through the service helper supplied by GitHub's runner:

```sh
pnpm runner:service:install
pnpm runner:service:start
pnpm runner:service:status
```

If `GITHUB_REPOSITORY` is empty, setup derives the repository from `origin`. It
names the runner after the machine and adds the `implementer` label required by
the workflow. `RUNNER_NAME`, `RUNNER_LABELS`, and a one-time `RUNNER_TOKEN` can
override those values. The repository setting is used when the runner is first
registered; changing it later does not move an existing registration. Do not
commit the downloaded runner or its registration credentials.

## Human decisions

Create an issue without enough information or observable acceptance criteria to
demonstrate suspension. Mastra stores the suspended readiness snapshot and the
control database records the pending step, clarification question, reply
boundary, and durable GitHub comment. A subsequent human issue comment resumes
the exact readiness step and triggers a new recorded evaluation. Other issues
may proceed while this one waits.

## Where Codex fits today

The readiness portion of `readiness-and-decomposition` is implemented; deciding
whether to propose child issues remains planned. The implementation step still
deliberately waits for `SIMULATED_IMPLEMENTATION_MS`; this makes concurrency
deterministic in the demo and tests. It still needs to be replaced by the real
Codex goal worker. The reviewers, manager, general recorder, pull-request
integration, and all three scheduled graphs—self-improvement, refactoring
discovery, and new-feature suggestion—remain planned. Refactoring and feature
discovery only create human-reviewed proposals; approved proposals re-enter the
ordinary production graph as issues.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm test:readiness:live
```

The integration tests cover the critical race: a second delivery arrives while
the first Mastra run is active, attaches to that run, and does not create a
second implementation. They also exercise readiness success, recorded retry,
and real Mastra suspension and resumption from a GitHub comment. The live check
is intentionally separate because it requires the configured local model.
