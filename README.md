# Sentinel-Dev

Sentinel-Dev is an autonomous developer agent designed to automatically fix issues labeled with `fix-me` in your repository. It leverages AST analysis, unit testing, and LLM-powered code generation to resolve bugs and implement features.

## Features

- **Automated Issue Resolution**: Triggers on GitHub labels.
- **AST Analysis**: Understands code structure for precise modifications.
- **Self-Correction**: Runs tests and iterates on solutions.
- **Real-time Updates**: Pushes progress logs via Poke.

## Getting Started

1. Add the `fix-me` label to any issue.
2. The GitHub Action will spin up a Sentinel-Dev environment.
3. Sentinel-Dev will analyze the issue, write code, and open a Pull Request.

## Tech Stack

- TypeScript
- Docker
- GitHub Actions
- Poke API/Webhooks
