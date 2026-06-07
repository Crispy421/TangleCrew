![Tangle Crew Banner](images/TCBanner.jpg)

# Tanglebot

A Discord bot built for the **Tangle Crew** clan in [Old School RuneScape](https://oldschool.runescape.com/).

> **This bot was built with the assistance of [Claude](https://claude.ai/) by Anthropic — an AI coding assistant that helped design, write, debug, and iterate on all of the features described below.**

---

## Tangle Crew

| | |
|---|---|
| **Discord** | [discord.gg/na6rhxJ3fQ](https://discord.gg/na6rhxJ3fQ) |
| **Wise Old Man** | [wiseoldman.net/groups/12447](https://wiseoldman.net/groups/12447) |

---

## Commands

### 🎡 `/spinwheel` — Prize Wheel

Spins an animated prize wheel and picks one or more random winners from a list of entries.

**When to use it:**
- Giveaways (pick a winner from everyone who entered)
- Loot splits (randomly assign a drop from a boss trip)
- Event prizes (randomly select who gets first pick of a reward)
- Deciding activities (spin between bossing locations, minigames, or skilling tasks)
- Any situation where you want a fair, visible, and fun random pick

**Options:**

| Option | Required | Description |
|--------|----------|-------------|
| `entries` | Yes | Comma-separated list of names or numeric ranges, e.g. `Alice,Bob,Carol` or `1-10` or `Alice,1-5,Bob` |
| `title` | No | Label shown on the wheel (default: `Wheel Spin`) |
| `winners` | No | How many winners to pick (1–10, default: 1) |
| `message` | No | Custom win message — use `{winner}` as a placeholder (default: `Winner is {winner}`) |
| `shuffle` | No | Shuffle the entry order before spinning (default: false) |
| `ping` | No | Send an `@here` or `@everyone` notification when the winner is announced |

**Range auto-fill:** Entries like `1-10` automatically expand to `1,2,3,4,5,6,7,8,9,10`. Works with any range in either direction (e.g. `5-1` counts down).

**How it works:**
1. The bot renders and sends an animated GIF of the wheel spinning, easing to a stop on the winner's slice.
2. Once the GIF finishes playing, the bot edits the same message to reveal the winner alongside the full entry list.
3. If a ping option was selected, a short follow-up is sent so Discord fires the notification.

---

### 📋 `/getdiscids` — Export Member List

Exports all non-bot server members to a CSV file with their Discord ID, username, and nickname. Useful for building or updating the rank spreadsheet before running `/syncranks`.

Requires **Manage Server** permission.

---

### 🧾 `/submission` — Proof Submission Help

Posts the accepted KC/drop proof formats or shows the latest accepted proof submission.

**Subcommands:**

| Subcommand | Description |
|------------|-------------|
| `format` | Posts the KC and drop proof formats for players |
| `last` | Shows the latest accepted KC or drop proof submission |

Both subcommands support a `private` option to show the response only to the person running the command. By default, responses are public so staff can post the format directly in a submission channel.

---

## Message Features

### KC and Drop Proof Intake

When configured, Tanglebot watches selected Discord submission channels and forwards valid proof posts to the configured Supabase intake endpoint for manual review on the site.

Supported KC format:

```text
Task name on Board: <tile title>
Monster being Killed: <monster name>
Starting or Ending: Starting
Starting Kill Count: 1234
```

Supported drop format:

```text
Task name on Board: <tile title>
Item Dropped: <item name>
```

Each submission must include exactly one image attachment. For ending KC submissions, `Starting or Ending: Ending`, `Ending Kill Count: 1234`, or `Kill Count: 1234` are accepted.

The intake stays disabled unless all three intake environment variables are set, so existing slash-command functionality can run without site integration configured.

---

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- A Discord bot token and application — create one at [discord.com/developers](https://discord.com/developers/applications)
- The Discord bot's **Server Members Intent** enabled in the Developer Portal for `/getdiscids`
- The Discord bot's **Message Content Intent** enabled in the Developer Portal if using KC/drop proof intake

### Install

```bash
cd Tanglebot
npm install
```

### Environment variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

```
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_id
CLAN_ID=your_server_id
OWNER_ID=your_discord_user_id
OWNER_ROLE_ID=your_owner_role_id
COORDINATOR_ROLE_ID=your_coordinator_role_id

# Optional proof intake
DISCORD_SUBMISSION_CHANNEL_EVENT_MAP={"submission_channel_id":"site_event_id"}
SUPABASE_DISCORD_KC_INTAKE_URL=https://your-project.supabase.co/functions/v1/discord-kc-intake
DISCORD_KC_INTAKE_SECRET=your_shared_intake_secret
```

### Deploy slash commands

```bash
npm run deploy
```

### Start the bot

```bash
npm start
```

---

## Built With

- [discord.js](https://discord.js.org/) v14
- [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) — wheel frame rendering
- [gif-encoder-2](https://github.com/benjaminadk/gif-encoder-2) — animated GIF generation
- [Claude by Anthropic](https://claude.ai/) — AI-assisted development
