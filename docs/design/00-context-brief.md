# Context Brief: Autonomous Software Development Control Plane (Codename: Camino)

> Founding brief provided by David on 2026-07-15, preserved verbatim as the source input for the design process.

## Purpose of this discussion

I want to explore the design of a product that enables a substantially autonomous software-development pathway.

This document is not intended to be a final PRD or architecture decision. It summarizes my current intent, the ideas discussed so far, and the design questions that need deeper investigation.

I plan to use Claude Code with a high-quality model at maximum reasoning for the primary design process, followed by adversarial review through Codex. I want the planning process to remain iterative and open to materially different approaches.

## My underlying goal

I want to be able to provide the system with a detailed product or feature specification describing:

* The desired end state
* The product intent
* Functional and non-functional requirements
* Architectural constraints
* Important risks and edge cases
* What must not change
* What outcomes must be demonstrated
* What tests and evidence are required to prove those outcomes

The system should then be capable of turning that specification into an executable development plan.

That plan may consist of issues, slices, tasks, milestones, dependency graphs, or some other representation. I am not committed to Linear tickets or any particular planning abstraction.

From there, autonomous agents should be able to:

1. Select eligible work.
2. Understand the relevant repository context.
3. Implement the assigned slice.
4. Add or update the necessary tests.
5. Run the required validation.
6. Produce evidence that the slice satisfies its contract.
7. Open or update a GitHub pull request.
8. Respond to validation and review failures.
9. Merge safely when all required gates have passed.
10. Optionally deploy and perform post-deployment validation.

The target is not merely autonomous code generation. It is autonomous delivery of software whose intended behaviour has been demonstrated.

## Desired human role

I do not necessarily want to remove myself from development.

I want to move my involvement to the highest-leverage points:

* Defining product intent
* Reviewing and refining plans
* Approving consequential architectural decisions
* Intervening when requirements are genuinely ambiguous
* Reviewing material risks
* Making precise modifications after broad implementation is complete

For targeted changes, I will still use tools such as the Codex app or Claude Code interactively.

The autonomous system should handle broad implementation work, validation loops, repository operations, and routine delivery processes without requiring me to supervise every agent turn.

## Existing tools and constraints

My current environment includes:

* GitHub for repositories and pull requests
* Linear for backlog and project management
* OpenAI Codex and ChatGPT subscriptions
* Anthropic and Claude Code subscriptions
* OpenAI Symphony for issue-to-agent execution
* Claude Code and Codex for direct implementation work
* Existing repository-specific validation infrastructure
* Browser automation and development tooling

I would ideally like the system to use my existing Codex and Anthropic subscriptions where technically and contractually practical.

However, the architecture should not become permanently constrained by subscription-based authentication. It may eventually need to support:

* Provider APIs
* Enterprise service accounts
* Self-hosted models
* Other coding-agent harnesses
* Customer-controlled execution environments

Symphony may remain useful as an execution component or reference implementation, but it is currently closer to a scheduler and runner than the full control plane I am considering.

## Model allocation and routing

I want different models and harnesses to perform different roles.

For example:

* A frontier reasoning model could turn a broad PRD into a detailed development and validation plan.
* A second frontier model from another provider could challenge that plan.
* Codex could perform backend or repository-heavy implementation.
* Claude Code could perform frontend work, architectural work, or broader contextual tasks.
* Smaller or mid-tier models could classify failures, summarize evidence, draft GitHub metadata, or perform routine review.
* Deterministic software should perform routine Git, CI, testing, merge, and deployment operations wherever a model is unnecessary.

The system should eventually support a model-routing policy based on factors such as:

* Task type
* Risk
* Complexity
* Repository area
* Required context
* Historical model performance
* Prior failed attempts
* Latency
* Cost
* Available subscription or API capacity

I do not necessarily need an adaptive or learned router in the first version. Explicit routing policies may be preferable initially.

## Planning and decomposition

A major part of the product is the transformation from product intent into executable work.

The planner should not merely generate a list of generic tickets. It should identify:

* The outcomes that must be achieved
* The boundaries between work slices
* Dependencies between slices
* Which slices may safely run concurrently
* Architectural interfaces between slices
* Required migrations and compatibility work
* Risks and rollback considerations
* Tests required for each slice
* Full-mission integration tests
* Observable user flows
* Evidence required before the work may be accepted

The resulting plan should be reviewable by a human and criticizable by another model before implementation begins.

A key open question is what representation should become authoritative:

* A structured mission contract
* A dependency graph
* A collection of tickets
* A versioned specification plus generated execution plan
* A richer combination of these

Linear could reflect this state for human visibility, but it may not be suitable as the authoritative store for execution attempts, evidence, contract versions, retries, and orchestration state.

## Validation contracts

One of the most important concepts discussed is a validation contract.

Before implementation begins, the system should know what must be proven.

A validation contract might describe:

* Required functional outcomes
* Required negative behaviours
* Compatibility requirements
* Performance thresholds
* Security properties
* Required unit tests
* Required integration tests
* Required migration tests
* Required browser or end-to-end flows
* Required evidence artifacts
* Conditions under which the work must be rejected
* Conditions requiring human escalation

The implementation agent should not be allowed to silently redefine success.

The approved contract may therefore need to be:

* Immutable or versioned
* Stored outside the worker's writable workspace
* Hash-addressed
* Reviewed independently
* Referenced by every attempt and pull request

Agents should be allowed to add tests and propose contract changes, but a worker should not be able to weaken its own acceptance criteria.

## Verification and proof

The system should distinguish between implementation and verification.

A worker reporting that its tests passed is useful, but not sufficient.

Potential verification layers include:

**Worker self-validation** — The implementation agent runs targeted tests and checks while working.

**Independent deterministic validation** — The work is checked again in a fresh environment using commands controlled by the system rather than the worker. This may include:

* Compilation
* Type checking
* Linting
* Unit tests
* Integration tests
* Migration tests
* Security checks
* Performance checks
* Full relevant test suites

**Independent semantic review** — A separate model reviews the approved requirements, implementation diff, tests, and evidence. It should determine whether:

* The requested outcomes were actually implemented
* Tests meaningfully prove the behaviour
* The implementation narrowed or misunderstood the requirements
* Important edge cases remain unproven
* The change introduces unacceptable risk

For higher-risk work, the verifier may need to use a different model family from the implementer.

**User-observable proof** — For interface and workflow changes, the system should be able to demonstrate behaviour using tools such as:

* Playwright
* Chrome or browser automation
* Screenshots
* Video recordings
* Browser traces
* Console output
* Network logs
* Accessibility snapshots
* API state
* Database state

Computer use may supplement deterministic browser automation where visual or interaction judgement is necessary.

The output may be an evidence packet associated with the mission, slice, attempt, commit, and pull request.

## Autonomous execution loop

The conceptual autonomous loop discussed so far is:

1. Receive or create an approved specification.
2. Compile it into a structured mission and dependency graph.
3. Review the mission adversarially.
4. Identify a ready slice.
5. Allocate an appropriate model and execution harness.
6. Create an isolated workspace.
7. Implement the slice.
8. Run worker-level checks.
9. Validate independently in a fresh environment.
10. Perform semantic and behavioural review.
11. Generate an evidence packet.
12. Open or update a pull request.
13. Respond to CI or review failures.
14. Merge when the required gates pass.
15. Reconcile downstream slices after the merge.
16. Optionally deploy.
17. Perform post-deployment validation.
18. Roll back or reopen work if production proof fails.

The system should be durable enough to resume after:

* Process crashes
* Machine restarts
* Provider failures
* Rate limits
* Network interruptions
* Stale branches
* CI failures
* Human pauses
* Long-running approvals

## Control plane and execution environments

A possible architectural separation is:

**Control plane** — Responsible for:

* Missions
* Specifications and contract versions
* Dependency graphs
* Scheduling
* Agent allocation
* Model routing
* Attempts
* Retries
* Validation results
* Evidence
* GitHub state
* Human interventions
* Audit history
* Deployment state

**Execution plane** — Responsible for running work inside a controlled environment containing:

* Repository access
* Git worktrees or isolated checkouts
* Codex
* Claude Code
* Docker
* Test dependencies
* Browser tooling
* GitHub credentials with limited permissions
* Deployment tooling where permitted

This could allow provider credentials and source code to remain on a local or customer-controlled runner while the control plane coordinates work.

This is an architectural hypothesis rather than a settled decision.

## Durable workflow state

The system likely requires explicit state beyond agent conversations or ticket statuses.

A slice may move through states such as:

* Draft
* Awaiting contract review
* Approved
* Ready
* Claimed
* Implementing
* Worker validation
* Independent validation
* Repair required
* Pull request open
* CI pending
* Merge ready
* Merged
* Deployed
* Post-deployment validation
* Complete
* Blocked
* Escalated
* Cancelled

Every transition should potentially record:

* The responsible actor
* Model and harness
* Contract version
* Repository base commit
* Worker output
* Commands executed
* Evidence created
* Failure classification
* Retry decision
* Human intervention
* Final outcome

A durable workflow technology such as Temporal or Trigger.dev may be relevant, but the implementation choice remains open.

## GitHub and deployment

Routine repository operations should generally be controlled by deterministic software rather than delegated entirely to an LLM.

This includes:

* Branch creation
* Worktree creation
* Rebasing
* Commit handling
* Pushes
* Pull-request creation
* CI status collection
* Merge-queue submission
* Merging
* Deployment invocation
* Rollback invocation

Models may write summaries, PR descriptions, risk assessments, or explanations, but credentials and policy enforcement should remain constrained.

Potential safeguards include:

* Protected main branches
* Required checks
* Merge queues
* Fresh CI after branch updates
* No worker access to push directly to main
* Risk-based approval rules
* Post-deployment smoke testing
* Automatic rollback or escalation

During early development, direct deployment to production may be acceptable for projects without active users, but this should be a configurable policy rather than a permanent assumption.

## Possible product thesis

The product is not primarily another coding-agent interface.

A possible product thesis is:

**Convert an approved software specification into merged, demonstrably correct software with minimal human supervision.**

Potential sources of differentiation include:

* High-quality mission decomposition
* Explicit validation contracts
* Independent verification
* Evidence generation
* Durable failure recovery
* Cross-model routing
* Repository-specific operational knowledge
* Auditable merge decisions
* Governance and intervention controls

The ability to call coding models is likely to become increasingly commoditized. Reliable planning, proof, orchestration, and trust may be the more durable product value.

## Initial scope discussed

One proposed starting point was deliberately narrow:

For one configured GitHub repository, accept an approved machine-readable feature contract, execute its implementation slices in isolated workspaces, independently validate each slice, produce an evidence packet, and open a pull request only when the required outcomes are proven.

This was suggested as an initial vertical slice rather than a final product boundary.

Possible early constraints include:

* One repository
* One mission at a time
* Sequential slices initially
* Codex as one implementation worker
* Claude as planner or reviewer
* Manual contract approval
* Manual merge approval
* Deterministic tests
* Playwright-based proof
* GitHub integration
* No automatic deployment initially
* No sophisticated adaptive router initially

However, I want to reconsider these boundaries during planning rather than accept them automatically.

## Questions that remain open

The planning process should investigate at least the following.

**Product boundary**

* Is this initially a personal internal control plane, a developer product, or infrastructure for a future commercial platform?
* Is the primary unit a mission, project, feature, ticket, pull request, or something else?
* How much autonomy should be permitted by default?
* What should require human approval?

**Planning**

* How should broad PRDs be converted into executable specifications?
* How should plan quality be evaluated before execution?
* Should the planner also generate tests?
* How should cross-cutting and architectural work be represented?
* How should the system recognize that a specification is not ready for autonomous execution?

**Validation**

* How should outcomes be expressed formally?
* Which tests should be visible to workers?
* Should protected or hidden acceptance tests exist?
* How should visual requirements be proven?
* How should the system detect weak or tautological tests?
* What level of evidence is necessary for different risk categories?

**Execution**

* Should work happen in worktrees, containers, virtual machines, remote sandboxes, or some combination?
* How should agents coordinate when slices overlap?
* Should an agent remain attached to a slice through repair cycles?
* When should a failed slice be reassigned to another model?
* How should context and knowledge be transferred between attempts?

**Routing**

* Which roles should be performed by models, and which should be deterministic?
* How should model quality, cost, and latency be balanced?
* How should subscription-backed CLIs coexist with APIs?
* How should historical performance influence routing?
* How should provider outages and quota exhaustion be handled?

**Source control and integration**

* Should each slice create its own PR?
* Should a mission produce one PR, stacked PRs, or an integration branch?
* How should dependencies and merge order be handled?
* How should conflicts with newly merged work be resolved?
* How should partial mission completion be represented?

**State and durability**

* What is the authoritative system of record?
* Is Linear merely a projection?
* What workflow engine is appropriate?
* How should every action and decision be audited?
* How should the system recover after long interruptions?

**Security**

* Where should credentials live?
* What permissions should workers receive?
* How should untrusted repository content be handled?
* How should prompt injection through source code, issues, or web pages be mitigated?
* How should outbound network access and secret use be controlled?

**User experience**

* What should the operator see?
* Should the main interface be a mission graph, event stream, evidence viewer, or exception queue?
* How should human interventions be incorporated without corrupting reproducibility?
* How should the system explain why it passed, failed, retried, escalated, or merged work?

**Evaluation**

* What benchmark repository and task set should be created?
* How should historical issues and PRs be replayed?
* What constitutes a successful autonomous delivery?
* How should false approvals and false rejections be measured?
* What is the appropriate north-star metric?

## Desired planning approach

Please treat this as the beginning of a long design process.

I do not want to jump immediately into implementation or lock the system around the ideas above.

I would like the process to:

1. Clarify the product objective and intended users.
2. Identify the most consequential design assumptions.
3. Challenge those assumptions.
4. Explore materially different architectures.
5. Distinguish near-term internal tooling from a scalable product architecture.
6. Identify the smallest experiments that reduce the most uncertainty.
7. Design the system around observed failure modes rather than imagined elegance.
8. Keep validation, evidence, and trust central.
9. Avoid unnecessary LLM involvement where deterministic software is better.
10. Produce an architecture and development path that can be adversarially reviewed by Codex.

Please begin by analyzing the intent, identifying ambiguities or contradictions, and proposing the major design decisions that should be resolved before creating a detailed PRD.
