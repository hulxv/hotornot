# Deploying to a VPS

The data files are not in git. Instead of copying them from a laptop, the server downloads the same raw data from NASA and rebuilds them with `deploy/data.sh`, stopping at 13 November 2026, the last day in the data the app was built with.

What you need:
- **Server:** Ubuntu 24.04 (it ships Python 3.12), 2 vCPUs, 4 GB of RAM, 20 GB of free disk.
- **Key:** a NASA FIRMS MAP_KEY (https://firms.modaps.eosdis.nasa.gov/api/map_key/).
- **Domain (optional):** a domain name pointing at the server, for HTTPS.

## 1. Install Node 24, git and Caddy

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git caddy tmux
```

## 2. Get the code

```sh
sudo useradd --system --create-home --shell /bin/bash hotornot
sudo mkdir /opt/hotornot && sudo chown hotornot: /opt/hotornot
sudo -u hotornot git clone https://github.com/hulxv/hotornot.git /opt/hotornot
sudo -u hotornot sh -c 'umask 077; echo "FIRMS_MAP_KEY=your-key-here" > /opt/hotornot/pipeline/.env'
```

The key stays in `pipeline/.env`, readable only by the `hotornot` user. Git ignores it.

## 3. Build the data (about 5 hours)

Run it inside tmux, so it keeps going after you log out:

```sh
sudo -u hotornot tmux new -s data
cd /opt/hotornot && deploy/data.sh build
```

Detach with Ctrl+B then D; reattach later with `sudo -u hotornot tmux attach -t data`.

What it does:
1. **Downloads into `pipeline/data/`:**
   - NASA's yearly FIRMS files for 2000 to 2025 (about 30 min)
   - the overpass lists from NASA CMR (about 30 min)
   - the FIRMS API up to 13 November 2026 (about 3 hours: the MAP_KEY's rate limit sets the pace)
2. **Runs the pipeline:** normalize, coverage, static-mask, series, matchups, model, validate.
3. **Publishes `latest.json` and the version folder into `web/public/data/`.** It uses the same weighting method as the current data (`model_v1`).

If it stops for any reason, run the same command again: finished downloads are skipped. Don't run another download with the same MAP_KEY at the same time, since both share its rate limit. `deploy/data.sh status` shows what is published and how many rows the database holds.

The sources, cutoff day, method and random seed are the same as the current data, so the numbers should match, except for any days NASA has reprocessed since. Version numbers count builds on each machine, so the How it works page will say "Data version v1".

## 4. Run the web app

```sh
sudo cp /opt/hotornot/deploy/hotornot.service /etc/systemd/system/
sudo systemctl enable --now hotornot
curl -sI http://127.0.0.1:3000/ | head -1
```

You can start it before the build finishes: until then it serves the built-in mock data, labelled as mock. It switches to the real data on its own within 10 minutes of the build publishing, with no restart.

## 5. HTTPS with Caddy

Point the domain's DNS A record at the server. Then put this in `/etc/caddy/Caddyfile`:

```
hotornot.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Reload with `sudo systemctl reload caddy`. Caddy gets and renews the certificate itself. Without a domain, use `:80 {` instead of the domain name for plain HTTP.

## 6. Firewall

```sh
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

The app listens on port 3000 on every interface. The firewall keeps that port closed, so visitors only reach it through Caddy.

## Before the demo

- **Warm the caches,** so the first visitors don't wait for slow first loads: `node /opt/hotornot/web/scripts/prewarm.js https://hotornot.example.com`.
- **Request a FortiGuard web filter classification** for the new domain. The Space Apps submission guide recommends it, so judges' networks don't block the site.
