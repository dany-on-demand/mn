![](public/footer.png)
# mn
**website that syncs &lt;video> stream + anonymous chat**

> akin to a self-hosted [cytube](https://cytu.be) or [rabb.it](https://rabb.it) 🔎 pull requests welcome

### usage
  * `node server.js`
    * runs on default port [3016](https://oeis.org/search?q=3016)
    * websockets on port 8080
  * on production hide behind nginx
  

### features
* sync video watch time with admin
* show any video [supported by browser's <video> tag](https://developer.mozilla.org/en-US/docs/Web/HTML/Supported_media_formats#Browser_compatibility)
* anonymous chat
* chat and sync via websockets
* rudimentary admin authentication
* templating via [slm](https://github.com/slm-lang/slm)
* routing via express


### compatibility  
Tested on `Ubuntu 16.04`, `Debian 8`, `Fedora 24` and `Windows 10.1511` written for `nodev4`, not tested on `nodev6`

### pre-install
install [node.js and npm](nodejs.org), open ports 3016 and 8080 for development, or port 80 for production


### setup
  * clone the repo
  * `npm install`
  
> ![](public/banner.png)
### stats
  *  ~ 500 CLOC + 300 CSS lines
  * tested with 30 users
    * almost no bandwidth overhead
    * 40MB memory usage
