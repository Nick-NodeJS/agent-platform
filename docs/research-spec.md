# Research constraints, outputs and acceptance (roadmap Step 2)

What the researcher and business-owner agents are given, what they must return, and how the platform checks it.
All of this is implemented with **mock agents**; real agents come in Steps 3-4. Context: [overview](architecture/overview.md).

## Goal and the two human gates

The business-owner agent decides whether a proposal is good. The owner (human) approves only:

1. **Start of implementation** (with its budget), and
2. **Go-live**.

Today the workflow has one human gate, placed after the business-owner evaluation; it is the future "start of implementation" gate. Stopping
automatically on an agent "do-not-proceed" and the go-live gate are **not implemented yet** (Step 4 and later). Until then a failed
evaluation is shown by `pnpm cli status` and the human decides. See [ADR 6](decisions/0006-limits-and-two-human-gates.md).

## The constraints file

[`config/platform-constraints.json`](../config/platform-constraints.json) is validated by `platformConstraintsSchema`
([`constraints.ts`](../packages/contracts/src/constraints.ts)) and is the default for `pnpm cli start`. Flags override single limits:
`--constraints-file`, `--build-budget-usd`, `--monthly-run-cap-usd`, `--launch-deadline-weeks`, `--notes`. Anything unset is `unknown`, never guessed.

| Field                            | Meaning                                                                                                                           | Agreed value                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `limits.buildBudgetUsd`          | Total spend to build and launch the product (not the agents' own compute)                                                         | 50                                                   |
| `limits.monthlyRunCapUsd`        | Recurring monthly running cost cap                                                                                                | 50                                                   |
| `limits.launchDeadlineWeeks`     | Latest launch, weeks from approval                                                                                                | 4                                                    |
| `limits.minimumMonthlyMarginUsd` | Required monthly revenue minus running cost (0 = break-even)                                                                      | unknown (to set)                                     |
| `limits.agentSpend`              | Agents' own allowance, separate from the product budget (`usd` or `weekly-allowance`)                                             | unknown (Step 3)                                     |
| `hosting`                        | Preferred provider `aws`; any provider allowed; production-grade required (no sandbox/demo setups)                                | as agreed                                            |
| `architecture`                   | Single deployable preferred; more than 2 deployable units, or kubernetes/microservices/multi-region, need a written justification | **defaults chosen by the assistant, please confirm** |
| `productTypes`                   | `api`, `web`, `mobile` allowed; preference order api, web, mobile (store fees may not fit the budget)                             | as agreed                                            |
| `excludedDomains`                | Business domains to avoid                                                                                                         | unknown (to set)                                     |

Team size was removed: the team is the agent roles and the owner only approves.

## Structured outputs

- **Research proposal** (`researchProposalSchema`, [`research.ts`](../packages/contracts/src/research.ts)): product type, domain, market, customer, problem,
  value proposition, **demand** (evidence list, validation plan, willingness to pay), **hosting** (provider, services, production-grade flag and notes),
  **delivery** (weeks to launch, deployable units, optional complexity justification), **cost** (build USD, monthly run USD, expected monthly revenue,
  break-even months; revenue and break-even may be `unknown`), assumptions and unknowns. Estimates are explicit numbers so they can be checked.
- **Business evaluation** (`businessEvaluationSchema`): recommendation (`proceed` / `do-not-proceed`), score 0-10, rationale, `isHumanApproval: false`
  and `constraintChecks`.

## Acceptance: what the platform checks in code

`checkProposalAgainstConstraints` is deterministic and I/O-free. `enforceConstraintChecks` runs in the `runBusinessOwner` Activity: it **replaces whatever
checks the executor returned** and turns a `proceed` into `do-not-proceed` (with the failed rules in the rationale) when any rule fails. It never upgrades a
`do-not-proceed`. A model is not trusted to apply the limits.

| Rule                       | Fails when                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `build-budget`             | estimated build cost is above `buildBudgetUsd`                                          |
| `monthly-run-cap`          | estimated monthly running cost is above `monthlyRunCapUsd`                              |
| `launch-deadline`          | weeks to launch is above `launchDeadlineWeeks`                                          |
| `product-type-allowed`     | the product type is not in `productTypes.allowed`                                       |
| `hosting-provider-allowed` | the provider is not allowed (any provider passes while `allowedProviders` is `any`)     |
| `production-grade-hosting` | the proposal describes a sandbox or demo setup                                          |
| `simple-architecture`      | more deployable units than allowed, with no complexity justification                    |
| `no-forbidden-technology`  | a forbidden technology is used with no justification                                    |
| `domain-not-excluded`      | the domain matches an excluded domain                                                   |
| `minimum-monthly-margin`   | revenue minus running cost is below the minimum margin, or no revenue estimate is given |
| `demand-evidence-present`  | no demand evidence or no validation plan is given                                       |

A limit that is `unknown` makes its rule `not-applicable` (shown as such, never as a pass).

## What the business-owner judges (not enforceable by rules)

Quality of the demand evidence, market size, willingness to pay, risk and score. For real runs (Step 4) the acceptance bar is: every rule above passes **and**
the evidence includes at least one cheap demand test (waitlist, interviews, pre-orders) with a stated cost and time within the limits. Step 5 measures
accuracy, usefulness, cost and recovery on a small sample.

## Profit and metrics

Before launch, revenue and margin are **assumptions** and are labelled as such. After go-live the agents are to track revenue minus costs (hosting, agent
spend) and recommend scale, change or shutdown; spending beyond the limits needs the owner's approval. Profit is a managed metric, not a guarantee. Post-launch
tracking is planned (Steps 9-12), not implemented.

## Not implemented yet

Automatic stop on "do-not-proceed" without a human step; the go-live gate; runtime spend enforcement and agent allowance accounting (Step 3);
real researcher/business-owner agents (Step 4); demand-test execution and post-launch metrics.
