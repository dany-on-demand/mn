![](public/footer.png)

# mn

**website that syncs &lt;video> stream + anonymous chat**

> akin to a self-hosted [cytube](https://cytu.be) or [rabb.it](https://rabb.it) 🔎 pull requests welcome

### usage

- `node server.js`
  - runs on default port [3016](https://oeis.org/search?q=3016)
  - websockets on port 8080
- on production hide behind [nginx](https://github.com/dany-on-demand/mn/wiki)
- mn assumes the file you want to stream is stored in /media
- login route, admin password and admin page route are printed to the console on startup, write them down
- changing media_file will reload the video for everyone

### features

- sync video watch time with admin
- show any video [supported by browser's <video> tag](https://developer.mozilla.org/en-US/docs/Web/HTML/Supported_media_formats#Browser_compatibility)
- anonymous chat
- hot-reload of videos for clients
- client notification
- chat and sync via websockets
- rudimentary admin authentication
- templating via [slm](https://github.com/slm-lang/slm)
- routing via express

### pre-install

install [Node.js v22.16.0 or later](nodejs.org), open ports 3016 and 8080 for development, or port 80 for production

### setup

- clone the repo
- `npm install`

> ![](public/banner.png)
