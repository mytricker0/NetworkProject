This project launches a set of Docker containers that allow you to browse Tor and I2P sites using Puppeteer. A local Tor proxy and an I2P router are started, and a Node.js app (in `puppeteer_tor`) launches Chromium either in headless or full GUI mode.

## Requirements
- Docker and Docker Compose
- An X server if you want to see Chromium's GUI (i.e. not running in `HEADLESS` mode)

## Quick start
1. Copy `.env` and adjust settings if needed. The provided values work out of the box.
2. Make sure your `DISPLAY` environment variable points to your X server (e.g. `:0`).
3. Run `./run.sh` which checks the `DISPLAY` variable and then executes `docker compose up --build`.

If you prefer running without GUI you can set `HEADLESS=true` in `.env`.

## Services and ports

The `docker-compose.yml` file defines three services:

- **tor** – exposes the Tor SOCKS proxy on `9050` and the control port on `9051`.
- **puppeteer_tor** – runs the Node.js script that launches Chromium via Tor or I2P. It shares the host network so it can use the host X11 socket (`DISPLAY`) to show the browser when `HEADLESS` is `false`.
- **i2p** – an I2P router. The web console is accessible on port `7657` and the HTTP proxy on port `4444`. Ports `12345` TCP/UDP are used for peer connectivity.

## Environment variables

The `.env` file configures how Puppeteer connects to Tor and I2P:

- `TOR_HOST` / `TOR_PORT` – address of the SOCKS proxy provided by the `tor` container.
- `TOR_CONTROL_PORT` – Tor control port used to renew circuits.
- `TOR_PASSWORD` – plain password used by the `tor` container.
- `HASHED_PASSWORD` – hashed version of `TOR_PASSWORD` (used internally by Tor).
- `I2P_HOST` / `I2P_PORT` – address of the I2P HTTP proxy.
- `HEADLESS` – set to `true` for headless Chromium or `false` to display the GUI.

## Display variable

The `puppeteer_tor` container runs Chromium. When `HEADLESS=false`, Chromium needs access to your host's X server. The `run.sh` script checks that your `DISPLAY` variable is set (e.g. `:0`) and configures X11 permissions with `xhost +local:docker` and `xhost +local:root`. If `DISPLAY` isn't set correctly, the script warns you and exits so you can fix it before launching the containers.