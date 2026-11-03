# Pinpoint

Collect feedback on demos: reviewers highlight an area of the page, add a comment and their name, and a screenshot is saved to your server. You review everything in a dashboard. Works on static hosting such as GitHub Pages, because the widget is one script tag and the server runs separately.

See [PRD.md](PRD.md) for the design.

## Run the server

Needs Node 22.5+ (uses the built-in `node:sqlite`; no npm install required).

```bash
cd server
ADMIN_PASSWORD='choose-a-password' npm start
```

Or with Docker:

```bash
cd server
docker build -t pinpoint .
docker run -p 3000:3000 -v pinpoint-data:/data -e ADMIN_PASSWORD='choose-a-password' pinpoint
```

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | random, printed at startup | Dashboard login |
| `PORT` | `3000` | Listen port |
| `DATA_DIR` | `server/data` | SQLite database, screenshots, session secret |

The server must be reachable by your reviewers over **https** if your demos are on https (browsers block mixed content). Put it behind a reverse proxy or host it on any platform that runs a container; set `X-Forwarded-Proto` so the session cookie is marked `Secure`.

## Connect a demo

1. Open `<server>/dashboard`, sign in, click **New project**.
2. Copy the snippet shown for the project and paste it before `</body>` in your demo:

   ```html
   <script src="https://your-server/embed.js" data-project="pk_..." defer></script>
   ```

3. In the project panel, set **Allowed origins** to where the demo is published (for example `https://you.github.io`). New projects allow any origin (`*`) until you do.

Optional attributes: `data-position` (`bottom-right`, `bottom-left`, `top-right`, `top-left`), `data-label`, `data-color`, `data-hidden` (button appears only with `?feedback=1` in the URL).

JS API: `Pinpoint.open()`, `Pinpoint.close()`, `Pinpoint.identify({ name })`.

If the demo sets a Content-Security-Policy, allow the server in `script-src`, `connect-src` and `img-src`.

## Claude skill

`add-feedback-widget` (in `~/.claude/skills/`) inserts the snippet when Claude builds a demo. Put your server URL in its `config.json`.

## Tests

```bash
cd server && npm test
```

## Known limitations

- Screenshots are taken in the browser with `html-to-image`. Cross-origin images without CORS headers, iframes, video and WebGL/canvas content can come out blank.
- Content inside scrolled inner containers (`overflow: auto` panes) may not match what is on screen. Fixed, sticky and absolutely positioned elements are handled.
- Submissions that fail to capture are still saved, without an image.
- The project key is public by design; the origin allowlist is a browser-side guard, not strong security against non-browser clients. Rate limiting (20 per minute per IP and project) applies.
- Screenshots can contain sensitive demo data. Keep the dashboard password private; images are only served to a signed-in admin.
- Not yet implemented from the PRD: webhooks, email digests, retention, per-owner accounts.
