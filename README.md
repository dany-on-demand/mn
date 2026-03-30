![](public/footer.png)

# mn

**website that syncs `<video>` stream + chat — now with auth & a database**

> akin to a self-hosted [cytube](https://cytu.be) or [rabb.it](https://rabb.it) 🔎 pull requests welcome

## features

- 🔐 **Proper authentication** – users stored in SQLite with `scrypt`-hashed passwords
- 💬 **Chat** – real-time via WebSocket (same port as HTTP, no separate WS port needed)
- 🎬 **Synced video** – admin controls channel seek time for all viewers
- ⚙️ **Admin panel** – manage users, settings, and media file live in the browser
- 🐳 **Docker-ready** – `Dockerfile` + `docker-compose.yml` included
- 🌐 **Modern frontend** – vanilla ES-module JS, no server-side templates
- 🔒 **HTTPS-ready** – put it behind nginx/Caddy with TLS; the app handles `wss://` automatically

---

## quick start (Docker)

```sh
# 1. Clone the repo
git clone https://github.com/dany-on-demand/mn && cd mn

# 2. Drop your video file into ./media/
cp /path/to/movie.mp4 media/

# 3. Start
docker compose up -d

# 4. The generated admin password is in the container logs (first run only)
docker compose logs mn
```

Then open **http://localhost:3016** in your browser.

---

## quick start (Node.js)

**Requirements:** Node.js ≥ 22

```sh
git clone https://github.com/dany-on-demand/mn && cd mn
npm install
cp /path/to/movie.mp4 media/
node server.mjs
```

On first startup the admin credentials are printed to the console.

---

## configuration

Copy `.env.example` to `.env` and edit as needed:

| Variable         | Default  | Description                                   |
|------------------|----------|-----------------------------------------------|
| `PORT`           | `3016`   | HTTP port                                     |
| `ADMIN_USERNAME` | `admin`  | Admin username (applied on first run only)    |
| `ADMIN_PASSWORD` | random   | Admin password (applied on first run only)    |
| `SESSION_SECRET` | random\* | Cookie-signing secret                         |

\* When omitted a secret is generated and persisted in the database so it survives restarts.

---

## admin panel

After logging in as an admin, click the **admin** button in the navbar to:

- Change the **media file** being streamed (resets seek time for everyone)
- Edit the **message of the day** shown in chat
- Manage **users** (add / delete)
- **Change your password**

---

## production (nginx + HTTPS)

See the [wiki](https://github.com/dany-on-demand/mn/wiki) for a full nginx reverse-proxy config.
The app automatically uses `wss://` when served over HTTPS.

---

> ![](public/banner.png)
