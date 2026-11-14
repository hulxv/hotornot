# Deploying Hot or Not on a VPS

The app is a single Node.js process with no dependencies and no build step: `node server.js` serves the pages from `web/public/` and the API from `web/api/`. It needs two things on the server:

1. **The code,** from GitHub.
2. **The published data,** which git ignores. It lives in `web/public/data/`:
   ```
   web/public/data/
   ├── latest.json          says which version to read ("v3")
   └── v3/
       ├── serving.sqlite   66 MB: calendar, verdicts, regions, test results
       └── points/          ~400 MB: 378 map tiles, points/<region>/<tile>.csv.gz
   ```
   That's about 470 MB. Nothing else is needed: not `web/public/data/v2/` (an older build) and not `pipeline/data/` (raw downloads, 8 GB).

Without the data, the app still runs, but shows its built-in mock data, labelled as mock.

## What you need

- A VPS with Ubuntu 24.04 (any Linux with Node 24 works). 1 vCPU, 2 GB of RAM and 5 GB of free disk are plenty for the app.
- SSH access with `sudo`.
- Optional: a domain name, for HTTPS.

Commands marked "on the server" run over SSH. Commands marked "on the Mac" run in the `hotornot` folder on your laptop.

## 1. Install Node 24, git, rsync and Caddy

On the server:

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git rsync caddy
node --version    # must print v24 or newer
```

Node 24 matters: the app uses Node's built-in SQLite module. If `apt` cannot find `caddy`, install it from Caddy's own repository instead: https://caddyserver.com/docs/install#debian-ubuntu-raspbian

## 2. Get the code

On the server:

```sh
sudo useradd --system --create-home --shell /bin/bash hotornot
sudo mkdir /opt/hotornot && sudo chown hotornot: /opt/hotornot
sudo -u hotornot git clone https://github.com/hulxv/hotornot.git /opt/hotornot
```

The app runs as its own `hotornot` user, which owns `/opt/hotornot`.

## 3. Put the data on the server

Pick one way.

### A. Upload it from the Mac (simplest today)

On the Mac, upload the two items to your home folder on the server (replace `you@your-server`):

```sh
rsync -av --progress web/public/data/latest.json web/public/data/v3 you@your-server:~/hotornot-data/
```

On the server, move them into place:

```sh
sudo mkdir -p /opt/hotornot/web/public/data
sudo rsync -a ~/hotornot-data/ /opt/hotornot/web/public/data/
sudo chown -R hotornot: /opt/hotornot/web/public/data
rm -rf ~/hotornot-data
ls /opt/hotornot/web/public/data    # latest.json  v3
```

### B. Commit the data to git

The `git clone` in step 2 then brings the data too, and you can skip this step on the server. On the Mac, replace the `web/public/data/` line in `.gitignore` with these three lines, then commit and push:

```
web/public/data/*
!web/public/data/latest.json
!web/public/data/v3/
```

This adds 470 MB to the repository's history for good. The largest file, `serving.sqlite` (66 MB), is under GitHub's 100 MB limit; GitHub prints a warning for files over 50 MB but accepts them.

### C. Rebuild it on the server from NASA

`deploy/data.sh build` downloads the raw data from NASA and runs the whole pipeline on the server, stopping at 13 November 2026 so the result matches the current data.
- **Needs:** a NASA FIRMS MAP_KEY, Python 3.12, about 5 hours and 10 GB of disk.
- **Before you can use it:** push `deploy/data.sh` and the `--until` change in `pipeline/hotornot/ingest/ingest.py` to GitHub.
- **How to run it:** the comments at the top of the script.

## 4. Run the app as a service

On the server, create `/etc/systemd/system/hotornot.service` (the same file is in `deploy/hotornot.service`):

```sh
sudo tee /etc/systemd/system/hotornot.service > /dev/null <<'EOF'
[Unit]
Description=Hot or Not web app
After=network-online.target
Wants=network-online.target

[Service]
User=hotornot
WorkingDirectory=/opt/hotornot/web
Environment=PORT=3000
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now hotornot
```

Check that it answers with the real data:

```sh
curl -s http://127.0.0.1:3000/api/metadata | head -c 60; echo
curl -sI http://127.0.0.1:3000/api/metadata | grep -i x-hotornot
```

The first command should print `{"data_version":"v3",...`. The second should print nothing; if it prints `x-hotornot-data: mock`, the app cannot find the data (see Troubleshooting).

## 5. HTTPS with Caddy

With a domain:
1. Point its DNS A record at the server's IP address.
2. Replace the contents of `/etc/caddy/Caddyfile` with:
   ```
   hotornot.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```
3. Run `sudo systemctl reload caddy`. Caddy gets and renews the HTTPS certificate itself.

Without a domain, use `:80 {` instead of the domain name. The site is then plain HTTP at `http://<server-ip>/`.

## 6. Firewall

On the server:

```sh
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

The app listens on port 3000 on every network interface. The firewall keeps that port closed, so visitors only reach the app through Caddy.

Now open your domain (or `http://<server-ip>/`) in your browser. Pick a region: the calendar, the verdict and the map dots should load, and "How it works" should show the test results.

## Before the demo

- **Warm the caches,** so the first visitors don't wait for slow first loads, especially the map dots for a whole year:
  ```sh
  node /opt/hotornot/web/scripts/prewarm.js https://hotornot.example.com
  ```
- **Request a FortiGuard web filter classification** for the new domain, using the form linked from the "Sharing Files to Your Project Submission Page" section of the Space Apps submission guide. Category: "web-based application" or "education"; company name: "N/A". The guide recommends it, so judges' networks don't block the site.
- **Test the link** in a private browser window, and on a phone over mobile data.

## Updating later

- **Code:** on the server, run `sudo -u hotornot git -C /opt/hotornot pull`, then `sudo systemctl restart hotornot`.
- **Data:** upload the new version folder (for example `v4/`) first, then the new `latest.json`. The app switches within 10 minutes, or at once after a restart. Then the old version folder can be deleted.

## Troubleshooting

| Symptom | Check |
|---|---|
| `x-hotornot-data: mock`, or the page says "This page is showing mock data for development, not satellite observations." | `/opt/hotornot/web/public/data/latest.json` exists, and the version it names has a folder next to it with `serving.sqlite` inside. Files must be readable by the `hotornot` user: `sudo chown -R hotornot: /opt/hotornot/web/public/data`. |
| The service keeps restarting | `journalctl -u hotornot -n 50`. An error about `node:sqlite` means Node is older than 24. |
| Caddy shows "502 Bad Gateway" | The app is not running: `systemctl status hotornot`. |
| No HTTPS certificate | The domain's DNS must point at the server, and ports 80 and 443 must be open. See `journalctl -u caddy -n 50`. |
| Map dots are slow the first time | Normal for a whole year in a big region; the answer is cached afterwards. Run the prewarm command above. |
