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

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- A Discord bot token and application — create one at [discord.com/developers](https://discord.com/developers/applications)

### Install

```bash
npm install
```

### Environment variables

Copy `.env.example` to `.env` and fill in the values:

```
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_id
CLAN_ID=your_server_id
OWNER_ID=your_discord_user_id
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
