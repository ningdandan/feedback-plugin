# PRD: Demo Feedback Plugin (working name: "Pinpoint")

Status: Draft v0.1 · Owner: n.zhang · Date: 2026-11-03

## 1. Summary

A drop-in feedback widget for living demos. A demo owner adds one `<script>` tag to any web demo (including static GitHub Pages sites). Reviewers click the widget, highlight an area of the page, type a comment and their name, and submit. Each submission is stored on a hosted server as **a screenshot + a comment + a name**, and the demo owner reviews everything in a dashboard.

## 2. Problem

Demos are published as static pages and passed around the organization. Feedback today arrives through Slack, email and meetings, and it is:

- **Context-free**: "the button on the second screen is confusing" with no screenshot or URL.
- **Scattered**: spread across channels, with no single place to review it.
- **High-friction to give**: reviewers have to screenshot, annotate and write up a message.
- **Impossible to collect from static hosting**: GitHub Pages has no backend, so owners can't add a form that stores anything.

## 3. Goals and non-goals

### Goals
1. Add feedback collection to any demo with one line of HTML and no changes to the demo's hosting.
2. Make leaving feedback take under 30 seconds: highlight, type, send.
3. Every feedback item carries visual context (screenshot of the highlighted area) automatically.
4. Give the demo owner one dashboard to view, triage and export feedback across all their demos.
5. Setup under 5 minutes, including running the server.

### Non-goals (v1)
- Not a full bug tracker or Jira replacement (export and webhook only).
- No video/session replay.
- No threaded discussion or reviewer-to-reviewer replies.
- No native mobile app support (mobile web is best-effort).
- No user accounts for reviewers. The name is self-declared.

## 4. Users and personas

| Persona | Description | Needs |
|---|---|---|
| **Demo owner** | Builds and publishes demos, often a PM, designer or engineer | Easy install, see all feedback in one place, know which page and element it refers to |
| **Reviewer** | Anyone in the org who receives the demo link | Zero setup, no login, fast way to point at something and say what's wrong |
| **Admin** (optional) | Runs the server for the org | Simple deploy, access control, data retention |

## 5. User stories

**Reviewer**
- As a reviewer, I open a demo and see an unobtrusive "Feedback" button.
- I click it, drag a rectangle over the part of the page I care about, type a comment, enter my name (remembered next time), and submit.
- I see a confirmation, and I can immediately leave another.

**Demo owner**
- I create a project in the dashboard and get a snippet to paste into my demo.
- I open the dashboard and see a feed of feedback with screenshot, comment, name, page URL and time.
- I filter by demo, status or reviewer, mark items resolved, and export to CSV/JSON.
- I get notified (email or webhook to Slack) when new feedback arrives. *(P1)*

## 6. Functional requirements

Priority: **P0** = required for v1, **P1** = soon after, **P2** = later.

### 6.1 Embeddable widget

| ID | Requirement | Pri |
|---|---|---|
| W1 | Installed with one script tag: `<script src="https://<server>/embed.js" data-project="PROJECT_KEY" defer></script>` | P0 |
| W2 | Works on static sites (GitHub Pages, Netlify, S3), single-page apps and plain HTML, with no build step | P0 |
| W3 | Floating button, rendered in a **Shadow DOM** so demo CSS can't break it and it can't break the demo | P0 |
| W4 | Click the button to enter capture mode: dimmed overlay, drag to draw a highlight rectangle, resizable and redo-able | P0 |
| W5 | After the highlight, a small form with comment (required), name (required) and Submit/Cancel | P0 |
| W6 | Name is saved in `localStorage` and prefilled next time | P0 |
| W7 | Screenshot is captured in the browser (e.g. `html-to-image` / `html2canvas`) and includes the full viewport with the highlight drawn on it, plus a cropped close-up of the region | P0 |
| W8 | Widget hides itself during capture so it isn't in the screenshot | P0 |
| W9 | Also records: page URL, scroll position, viewport size, highlight coordinates (relative to the page), CSS selector of the element under the highlight, user agent, timestamp | P0 |
| W10 | Config via data attributes: position, button label, theme color, `data-hidden` (open only via `?feedback=1` or JS API) | P1 |
| W11 | JS API: `Pinpoint.open()`, `Pinpoint.close()`, `Pinpoint.identify({name})` so demos can use their own trigger or prefill the name | P1 |
| W12 | Keyboard shortcut to open and Esc to cancel | P1 |
| W13 | Fallback when DOM capture fails (cross-origin images, canvas, iframes): offer the browser's screen-capture API, or submit without an image and flag the item "no screenshot" | P1 |
| W14 | Optional "Show existing feedback pins" overlay for the owner | P2 |
| W15 | Basic touch support for mobile | P2 |

### 6.2 Server and API

| ID | Requirement | Pri |
|---|---|---|
| S1 | A single deployable service: API, widget bundle hosting, dashboard, storage | P0 |
| S2 | `POST /api/feedback` accepts `{project, name, comment, screenshot, meta}` and returns `201` | P0 |
| S3 | `GET /embed.js` serves the widget with CORS enabled | P0 |
| S4 | Submissions authenticated by a **public project key** plus an **origin allowlist** per project, enforced server-side | P0 |
| S5 | Rate limiting per IP and per project, with max payload size (e.g. 5 MB) and image-type validation | P0 |
| S6 | Persistent storage: metadata in a database, images in file/object storage | P0 |
| S7 | Webhook on new feedback (Slack-compatible payload) | P1 |
| S8 | Email notification digest | P2 |
| S9 | Configurable retention (auto-delete after N days) | P1 |

### 6.3 Dashboard

| ID | Requirement | Pri |
|---|---|---|
| D1 | Owner login (see Open Questions for auth method) | P0 |
| D2 | Create and manage projects: name, key, allowed origins, and a copy-paste install snippet | P0 |
| D3 | Feedback feed (newest first) showing thumbnail, comment, name, page URL and time | P0 |
| D4 | Detail view: full screenshot with the highlighted region outlined, link to "open page", and metadata (browser, viewport, selector) | P0 |
| D5 | Filter and search by project, status, name, date and comment text | P0 |
| D6 | Status workflow: New, Acknowledged, Resolved (plus archive) | P0 |
| D7 | Delete an item, hard delete including the image | P0 |
| D8 | Export CSV/JSON, and download a ZIP with images | P1 |
| D9 | Group by page, and a summary count per page | P1 |
| D10 | Share-a-view link or read-only collaborator access | P2 |
| D11 | Owner notes and assignment | P2 |

## 7. User experience flow

```
Reviewer opens demo → clicks "Feedback"
  → page dims, cursor becomes crosshair
  → drags a rectangle over the area
  → popover appears next to the highlight: [Comment] [Your name] [Send]
  → widget captures screenshot, uploads, shows "Thanks!"

Owner opens dashboard → picks project → sees feed
  → clicks an item → sees annotated screenshot, comment, who, where
  → marks Resolved
```

Design principles: no login for reviewers, fewer than 3 inputs, never block or alter the demo, always visibly cancelable.

## 8. Technical approach (proposed)

**Architecture**

```
Demo page (any host)                 Pinpoint server
┌──────────────────┐   POST          ┌────────────────────────┐
│ <script embed.js>│ ───────────────▶│ API  (auth: key+origin)│
│  Shadow DOM UI   │   screenshot    │ Storage: DB + images   │
│  html-to-image   │   + metadata    │ Dashboard (web app)    │
└──────────────────┘                 └────────────────────────┘
```

**Recommended stack (v1)**
- Server: Node.js (TypeScript) with SQLite and local-disk images, shipped as a single Docker image and runnable with `npx`/one command. This is the simplest "easy to connect" path.
- Alternative to evaluate: Cloudflare Workers + D1 + R2 (zero-ops, free tier, good for static-hosted demos). Choose based on the org's hosting constraints (see Open Questions).
- Widget: vanilla TypeScript, bundled to one file of ~50 KB gzipped or smaller (lazy-load the screenshot library on first click), with no framework dependency.
- Dashboard: lightweight SPA served by the same server.

**Data model**

- `Project`: id, name, public_key, allowed_origins[], created_at, retention_days
- `Feedback`: id, project_id, name, comment, status, page_url, page_title, screenshot_full_path, screenshot_crop_path, region {x, y, w, h}, scroll {x, y}, viewport {w, h}, selector, user_agent, created_at

**Key technical risks**
- *Client-side screenshot fidelity*: DOM-to-image libraries mishandle cross-origin images, iframes, canvas/WebGL, video and some CSS. Mitigation: W13 fallbacks, an `ignore` attribute, and documenting known limits.
- *Spam / abuse* from a public key on a public page: origin allowlist, rate limits and a honeypot field. Origin checks are not strong security against non-browser clients, so the key is treated as public.
- *Content Security Policy* on some demos may block the script or the POST. Mitigation: document the required `script-src`/`connect-src`.

## 9. Security and privacy

- Screenshots can capture sensitive demo or customer data. The dashboard must be access-controlled, images are served only via authenticated URLs, and the install docs should state this.
- Reviewer names are the only personal data collected, plus user agent. No cookies on the demo domain, and `localStorage` is used only for the name.
- Hard delete must remove DB rows and image files.
- Server enforces size and type limits, and sanitizes all text rendered in the dashboard (XSS).
- Admin credentials and project keys are rotatable.

## 10. Success metrics

- **Time to install**: under 5 minutes from zero to first feedback received (measured by usability test).
- **Time to submit** for a reviewer: median under 30 seconds.
- **Adoption**: at least 5 demos with the plugin installed within 4 weeks of launch.
- **Feedback quality**: at least 90% of items include a usable screenshot.
- **Demo impact**: no measurable layout/performance regression (script under 50 KB gz at load, no layout shift).

## 11. Milestones

| Phase | Scope | Outcome |
|---|---|---|
| **M0: Spike** (≈3 days) | Screenshot capture + region crop on 3 representative demos (static HTML, React SPA, one with charts/canvas) | Confirm capture approach |
| **M1: MVP** (≈2 weeks) | W1–W9, S1–S6, D1–D7 | End-to-end: embed, submit, view in dashboard |
| **M2: Polish** (≈1–2 weeks) | JS API, config options, fallbacks, webhook, export, retention, deploy docs | Ready to share org-wide |
| **M3: Later** | Email digests, pins overlay, assignment, mobile | Based on usage |

## 12. Open questions

1. **Where does the server run?** Internal infrastructure, a personal cloud account, or a serverless platform? This decides the stack, and org policy may restrict where screenshots (possibly with confidential data) can be stored.
2. **Dashboard auth**: shared admin password (simplest), company SSO/OIDC (best for the org), or GitHub login?
3. **Do all reviewers have to be internal?** If so, should the widget itself require an org login to submit, instead of a self-declared name? That changes "no login for reviewers".
4. **Multi-owner**: one owner total, or many owners each seeing only their own projects?
5. **Name field**: free-text, or optionally restrict/validate against an org directory?
6. **Notifications**: is Slack webhook enough for v1?
7. **Product name** and whether this will be open-sourced inside the org.

## 13. Out of scope for this document

Detailed visual design, pricing/licensing, and the integration with ticketing tools (Jira, GitHub Issues). These can follow once M0 results are in.
