# Calorie Tracker PWA

This folder now contains a static, offline-ready version of the Calorie Tracker. The UI runs in the browser using HTML/CSS/JS, while your original nutrition formulas stay in Python and execute client-side through Pyodide.

## Project layout

- `index.html` – app shell and UI controls
- `styles.css` – neumorphic-inspired theme
- `app.js` – controller that loads Pyodide, talks to IndexedDB, and wires the UI
- `py/calorie_logic.py` – Python module shared with Pyodide
- `manifest.webmanifest` – metadata so the site can be installed as a PWA
- `service-worker.js` – caches core assets for offline use
- `icons/` – PWA icons generated with Pillow

## Run locally

```bash
cd web
python3 -m http.server 8000
```

Now open `http://localhost:8000` in a browser that supports Pyodide (Chromium, Firefox, Safari). The first load requires network access to fetch Pyodide from jsDelivr; afterwards the service worker keeps the core files cached.

## Deploy to GitHub Pages

1. Commit the new `web/` folder to your repo.
2. Push to GitHub.
3. In the repo settings → *Pages*, choose **Deploy from a branch**.
4. Select the branch you pushed and set the folder to `/web`.
5. Save. Within a minute the site will be available at `https://<user>.github.io/<repo>/`.
6. Update the *Custom domain* section if you want your own hostname.

GitHub Pages automatically serves static content, so no build step is necessary.

## Deploy to Cloudflare Pages

1. Commit and push as above.
2. In the Cloudflare dashboard choose **Workers & Pages → Create application → Pages**.
3. Connect the GitHub repo and grant access.
4. When prompted:
   - *Framework preset*: `None`
   - *Build command*: `npm run build` → replace with `echo "No build"`
   - *Build output directory*: `web`
5. Trigger the first deploy and wait for the assigned `*.pages.dev` URL.
6. (Optional) Bind your custom domain in the Pages settings and add DNS records Cloudflare suggests.

Both hosting options serve the same offline-first PWA. After deploying, open the URL once to allow the browser to cache the Pyodide runtime for offline sessions.
