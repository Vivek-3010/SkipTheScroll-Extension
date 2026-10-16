# SkipTheScroll — Chrome extension (MV3)

React 19 + Vite + Tailwind CSS 4 popup. JavaScript/JSX only, no TypeScript.

The popup is intentionally dumb: it reads the active tab's URL, asks the local backend for video
metadata, then for the verdict. **No API key ever exists in this bundle.**

## Build

```bash
npm install
npm run build      # -> dist/  (load this folder in Chrome)
npm run dev        # Vite dev server for UI work (Chrome still needs dist/)
```

## Pointing at a different backend

Default: `http://localhost:5178`. Override at build time:

```bash
# macOS / Linux
VITE_API_BASE_URL=http://192.168.1.20:5178 npm run build

# Windows PowerShell
$env:VITE_API_BASE_URL="http://192.168.1.20:5178"; npm run build
```

If you use a non-localhost host, add it to `host_permissions` in `public/manifest.json` before building.

## Load in Chrome

1. `npm run build`
2. Open `chrome://extensions` → enable **Developer mode**
3. **Load unpacked** → select `dist/`
4. Pin the icon; open a YouTube video; click it
5. Press the refresh icon on the extension card after every rebuild

## Files

| File                          | Role                                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| `public/manifest.json`        | MV3 manifest: popup entry, icons, `tabs`/`activeTab`, backend host permissions, CSP |
| `public/icons/icon*.png`      | 16/32/48/128 icons                                                   |
| `src/popup/index.html`        | Vite HTML entry → builds to `dist/popup/index.html`                  |
| `src/popup/main.jsx`          | React root                                                            |
| `src/popup/Popup.jsx`         | State machine: detect tab → video info → analyze → verdict           |
| `src/popup/popup.css`         | Tailwind import + tiny custom keyframes/scrollbar utilities          |
| `src/components/Header.jsx`   | Title + tagline + logo                                               |
| `src/components/VideoInfo.jsx`| Thumbnail, title, channel, view/comment/like counts, YouTube link    |
| `src/components/AnalyzeButton.jsx` | Primary CTA                                                         |
| `src/components/LoadingState.jsx`  | Staged progress copy + elapsed timer                               |
| `src/components/ErrorState.jsx`| Error message + server hint + retry/back                            |
| `src/components/VerdictView.jsx`  | Verdict, confidence meter, summary, issues, fixes, timestamps, status, warnings, conflicts, evidence gaps |
| `src/lib/api.js`              | `fetch` wrapper with timeouts and normalised `{ code, message, hint }` errors |
| `src/lib/youtube.js`          | URL parsing (`watch?v=`, `youtu.be`, `/shorts/`, `/embed/`, `/live/`), number formatting |
| `src/lib/constants.js`        | Backend URL, fetch cap (`MAX_COMMENTS`), timeouts, progress stages, verdict/status colour maps |

## Popup states

```
loading ─┬─► unsupported  (not a YouTube video page)
         ├─► error        (backend down / bad key / video not found)
         └─► ready        (thumbnail + title + channel + "Analyze Comments")
                └─► analyzing (3 progress stages)
                       └─► done (verdict view + "Analyze again" / "New video")
```

## Permissions

| Permission                    | Why                                                              |
| ----------------------------- | ---------------------------------------------------------------- |
| `tabs`, `activeTab`           | Read the current tab URL to get the video ID. No page access, no scraping. |
| `http://localhost:5178/*`     | Talk to your own SkipTheScroll backend.                          |
| `content_security_policy`     | MV3 default: only local scripts, no remote code, no eval.         |

The extension never reads the DOM of YouTube, never injects content scripts and never ships an API key.
