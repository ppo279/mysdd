# Issue tracker: GitHub

Issues for this repo live as GitHub issues on `ppo279/mysdd`. Use the `gh` CLI for all operations.

> **Local source material**: PRDs and issue drafts live at `docs/prd/*.md` and `docs/issues/*.md`. These are the source from which GitHub issues are published. Do **not** write to both places when a skill asks you to "publish an issue" — publish to GitHub only. The local markdown is kept in sync by humans, not by skills.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** External PRs are not a request source for this repo — `/triage` does not pull them in.

## When a skill says "publish to the issue tracker"

Create a GitHub issue. **Never** duplicate into `docs/issues/*.md` — that file is human-maintained source material, owned by the PRD author.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.