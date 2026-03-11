# Contributing

Thanks for your interest in contributing to MapleStory MVP Detector.

## Getting Started

```bash
git clone https://github.com/NecturaLabs/MapleStory-MVP-Detector.git
cd MapleStory-MVP-Detector
bun install
bun run dev
```

## Guidelines

- **No secrets in code.** All credentials go through GitHub Secrets, never in source files.
- **Test your changes.** Run `bunx tsc --noEmit` and `bun run test` before opening a PR.
- **Keep it client-side.** This app runs entirely in the browser — no backend dependencies.

## Pull Requests

1. Fork the repo and create a branch from `develop`
2. Make your changes
3. Ensure `bunx tsc --noEmit`, `bun run test`, and `bun run build` all pass
4. Open a PR — CI will run automatically and post a Netlify preview link

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
