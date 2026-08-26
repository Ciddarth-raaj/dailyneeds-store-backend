---
name: autodeploy-branch
description: >-
  Enforces main-autodeploy as the integration branch for this backend repo.
  Use when making code changes, creating branches, committing, merging, pushing,
  or deploying. Same rules as AGENTS.md.
---

# Autodeploy branch workflow

Same rules as [AGENTS.md](../../../AGENTS.md).

## Hard rules

- Integration branch = **`main-autodeploy`**
- **Never** commit to, merge into, or push **`master`** unless the user explicitly asks
- Never start feature work from `master`
- Pushing `main-autodeploy` triggers deploy — only push when intending to ship
- On merge conflicts: stop and report; never force-push

## Workflow for every change request

```text
1. git fetch origin
2. git checkout main-autodeploy && git pull origin main-autodeploy
3. git checkout -b <feature-branch>
4. Implement and commit
5. git push -u origin <feature-branch>
6. git checkout main-autodeploy && git pull
7. git merge <feature-branch>
8. git push origin main-autodeploy
```

## Feature branch names

Short kebab-case from the request (`feat/...`, `fix/...`, `chore/...`).
