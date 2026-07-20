# Hosting Mimir at mimir.dpdns.org (free, via Cloudflare Tunnel)

The stack (Node backend + Postgres + Redis + Python AI service with FinBERT/Chronos
models + live Upstox WebSocket feed) is too heavy for free static/serverless hosts.
The right free setup is a **Cloudflare Tunnel**: the app keeps running on this PC,
Cloudflare gives it a public HTTPS URL at your domain, no port-forwarding, no cost.

## One-time setup (~10 minutes + DNS wait)

### 1. Add the domain to Cloudflare
1. Create a free account at https://dash.cloudflare.com
2. **Add a domain** → enter `mimir.dpdns.org` → select the **Free** plan.
   (dpdns.org is on the Public Suffix List, so Cloudflare accepts your subdomain
   as its own zone.)
3. Skip the DNS-record review (records get created by the tunnel later).
4. Cloudflare shows you **2 nameservers**, e.g. `ada.ns.cloudflare.com` and
   `bob.ns.cloudflare.com` (yours will differ).

### 2. Point your domain at Cloudflare
In your dpdns.org (DigitalPlat) dashboard where you see the **8 nameserver
slots**: enter the 2 Cloudflare nameservers in the first two slots and leave
the other six **empty**. Save.

Wait until Cloudflare emails you / the dashboard shows the zone **Active**
(usually minutes, can take a couple of hours).

### 3. Create the tunnel (run once, in this repo)
```
cloudflared tunnel login          # opens browser — pick mimir.dpdns.org
cloudflared tunnel create mimir
cloudflared tunnel route dns mimir mimir.dpdns.org
```

## Every demo day
Double-click **`deploy\start-demo.cmd`** (or run the four pieces yourself).
It starts: AI service → backend → frontend production preview → tunnel.
The app is then live at **https://mimir.dpdns.org** (HTTPS + WebSockets work
automatically; Cloudflare provides the TLS certificate).

Before market open: authorize the daily Upstox token, or every panel will
honestly show "—" instead of live data.

## Notes
- The public URL is only up while this PC and the tunnel are running.
- Do not enable Cloudflare's "Always Online"/caching for `/api/*` — dynamic
  data must not be cached. Default settings are fine.
- To stop sharing: close the tunnel window (the app stays available locally).
