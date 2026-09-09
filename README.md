# p3

Paul's shareable [Pi](https://pi.dev) extensions, themes, and workflows.

## Install

```sh
pi install git:github.com/therealpaulgg/p3
```

To try it without adding it to your settings:

```sh
pi -e git:github.com/therealpaulgg/p3
```

## Included resources

- Advisor, model-routing, task-list, tutor-mode, and workflow extensions
- Telegram notification extension
- Catppuccin, Dracula, Synthwave, and Matrix themes
- The `rpiv` workflow

The Telegram extension expects an executable at `~/.local/bin/pi-telegram-notify` that accepts the notification body on stdin. It remains disabled when that helper is unavailable.

## Development

```sh
./scripts/test-extensions.sh
```
