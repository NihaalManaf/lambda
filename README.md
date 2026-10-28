<h1 align="center">λ lambda</h1>

<p align="center"><em>engineer attention. let agents build it.</em></p>

## manifesto

**01 — the enemy.** slop is the enemy of *understanding.*

**02 — attention engineering.** put developer attention where it *pays.*

**03 — show, don't tell.** a diagram beats a hundred paragraphs.

**04 — structure.** one-shot it. do it once, do it *right.*

**05 — values.** simplicity · ease · understanding. *no compromise.*

---

## what it is

Coding agents can write the code. The scarce thing is a developer's attention: deciding *what* to build, spotting the edge cases, checking it actually works.

lambda sits between you and your agents. Describe a feature in two lines and it lays the work out visually — stories, flows, sketches, schema and queue changes — so you review pictures, not paragraphs. Then it checks the result in a real browser.

| | |
|---|---|
| **stories** | "as a / i want / so that" tiles, split into slices you build in order. Every story has browser-checkable acceptance criteria. |
| **flows** | tiny flowcharts (≤ 9 nodes) per lens: journey, data, infra, state. Edge cases pinned to nodes, each one a decision. |
| **ui sketch** | marker-pen notes over a screenshot of *your* running app: insert here, remove this, move that. |
| **schema** | replays your SQL migrations into diagrams. Added / removed / changed tables at a glance, risk chips, no SQL unless you ask. |
| **queues** | maps producers → queues / crons → consumers from your code, and shows what a feature changes. |
| **verify** | Claude Code drives a browser with your team's test login and checks each acceptance criterion. |
| **context** | pulls related Linear issues, Slack threads and past Claude Code sessions into the feature automatically. |
| **talk to lambda** | ⌘K — "add a story for…", "that step is wrong, fix it". Every change lands live as a small card you can click or undo. |

New features generate everything on their own — no clicking "generate" on every tab. Schema and queue tabs only appear when a feature needs them.

---

## run it locally

lambda is in active development. For now you run it on your machine and use it in the browser.

**you need**

- Node 22+ and npm
- an Anthropic API key
- [Claude Code](https://claude.com/claude-code) installed and logged in — only for browser verification
- Python 3 — optional, makes queue scanning more accurate

**1. install**

```bash
git clone https://github.com/NihaalManaf/lambda.git
cd lambda
npm install
npx playwright install chromium
```

**2. add keys** — create `.env.local`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
# optional
LINEAR_API_KEY=lin_api_...
SLACK_BOT_TOKEN=xoxb-...   # or SLACK_TOKEN (user token) for message search
```

Already have these in your app's `.env`? Skip this and point **settings → keys** at that file instead.

**3. run**

```bash
npm run dev
```

Open **http://127.0.0.1:4900** → **settings**, and fill in:

- **your app** — its local URL (e.g. `http://localhost:3000`) and the path to its repo
- **schema** — migrations folder (default `migrations`)
- **queues** — your API's host name(s), so lambda knows which URLs are "yours"
- **test accounts** — a login the browser checks can use

### your data stays local

Everything — features, settings, test-account passwords, pulled-in context, screenshots — lives on your machine in `~/Library/Application Support/lambda/data` (override with `LAMBDA_DATA_DIR`). Files are owner-only (`0600`). The server only listens on `127.0.0.1` and rejects cross-origin requests.

The only things that leave your machine are calls to the model API, and to Slack / Linear when you've given it keys.

---

## development

```bash
npm run dev      # app on :4900 with hot reload
npm test         # unit tests
npm run build    # production build
```

Real-repo test fixtures are opt-in:

```bash
LAMBDA_TEST_REPO=~/code/my-app LAMBDA_TEST_APP_HOSTS=myapp npm test
```

**mac app (experimental)** — the same app in a native window:

```bash
npm run app:dev                              # hot reload inside Electron
npm run app:build && npm run app:install     # → /Applications/lambda.app (unsigned, arm64)
```

Stack: Next.js 16 · React 19 · React Flow · Anthropic SDK · Playwright · Electron.
