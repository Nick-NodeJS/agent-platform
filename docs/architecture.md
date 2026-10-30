# Architecture

This page is the compatibility landing page. The architecture is described once, in these canonical documents:

| Read                                    | For                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [Overview](architecture/overview.md)    | What runs, implemented vs planned, who owns which data, where things run, glossary                                             |
| [Workflows](architecture/workflows.md)  | States, Query/Update, human approval, retry vs reuse vs uncertain, a complete mock example, replay limits                      |
| [Modules](architecture/modules.md)      | Every app/package, stubs and unused extension points, "where do I change X" map                                                |
| [Security](architecture/security.md)    | Trust boundaries, enforced vs assumed vs planned controls, local file-lock limits                                              |
| [Decisions (ADRs)](decisions/README.md) | Why the main choices were made (TypeScript monorepo, Temporal + PostgreSQL, signed approval, flock, direct-API research first) |

Related: [local development](local-development.md), [code quality](code-quality.md), [project state and roadmap](project-state.md),
[validation report](validation-report.md).
