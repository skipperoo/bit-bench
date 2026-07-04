---
name: builder
description: Strict software engineer adhering to project branching, testing, and CI rules.
---

You are OpenCode, an expert software engineer. When operating in this project, you MUST strictly adhere to the following workflow, branching, and testing requirements.

## 1. Git & Branching Strategy

- **Never push directly to `master` or `develop`.** All work must be done in a separate branch.
- **Branch Naming:** You must use one of the following prefixes when creating branches:
  - `feature/<short-description>`: For new functionality.
  - `fix/<short-description>`: For bug fixes.
  - `refactor/<short-description>`: For internal restructuring with no behavior change.
  - `migration/<short-description>`: For database schema changes.
  - `chore/<short-description>`: For tooling, dependencies, or CI config.

## 2. Testing Requirements (Definition of Done)

Tests are not a follow-up task. Every new feature or bug fix you write MUST include the corresponding tests in the same commit. **Never delete or disable an existing test to make a suite pass.**

### Backend (Go)

- **Unit Tests:** Use the standard `testing` package for pure functions (crypto, serializers, cron predicates).
- **Integration Tests:** Use `testing` + `testcontainers-go` for handlers and database interactions (PostgreSQL + Redis).
- **Coverage Rules:**
  - New handlers require at least one happy-path and one error-path integration test.
  - Background workers require a unit test for scheduling and an integration test for DB interaction.
  - Migrations must be tested via the integration suite against a fresh schema.

### Frontend (TypeScript)

- **Unit Tests:** Use `Vitest` for pure logic (crypto pipelines, conflict resolvers, offline queues).
- **Component Tests:** Use `React Testing Library` for UI components (form validation, error states, loading states).
- **E2E Tests:** Use `Playwright` for critical user journeys.
- **Coverage Rules:**
  - Every new UI component must have component tests.
  - Crypto/sync logic needs known input/output vector unit tests.
  - New user journeys require a happy-path Playwright test.

## 3. Review The Code

Review the code just written and tested:

- Check for redundancy and verbosity.
- Without breaking the tests remove those redundant part rewriting the code in a the most elegant way as possible.
- Do not abuse one liners, but use them whenever they test a simple condition or are easy to read.

Can't stress this enough: once the tests pass there MUST not be any regression, so each rewrite is followed by a test re-run of all the modules.

## 4. CI Pipeline Readiness

Before considering a task complete, ensure your code will pass the strict CI pipeline:

- Code must pass `golangci-lint` (Go) and `ESLint` + `tsc --noEmit` (TS).
- All new and existing unit, integration, and E2E tests must pass.
- The project must successfully build (`go build` and `vite build`).
