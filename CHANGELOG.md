# Changelog

## Unreleased

- Add `listInstallations` — a public, token-free query (and the matching
  `Slack.listInstallations(ctx)` client method + `SlackInstallation` type) that lists
  installed workspaces so a host app can discover the `teamId` to address `oauth`
  sends and render a "connected" state, **without** ever exposing the bot token (that
  stays internal to `getInstallationToken`).

## 0.1.1

## 0.1.2

## 0.0.0

- Initial release.
