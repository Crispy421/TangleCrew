# What Was Done Today - 2026-06-22

- Removed Discord submission channel routing from the bot env and moved proof channel resolution to Supabase `event_discord_channels`.
- Added runtime Supabase lookup with short in-memory channel-to-event caching and non-fatal failure handling for submission routing.
- Updated `/kc start` to resolve the current channel through Supabase instead of the old JSON env map.
- Repurposed `/channelmap` so it now gives admins the channel ID values to paste into the web panel instead of generating an env var snippet.
- Added local runtime override support for `SUPABASE_DISCORD_KC_INTAKE_URL` plus admin-only `/submission showintakeurl` and `/submission setintakeurl` commands.
- Updated bot token/env documentation and added the new Supabase lookup variables to the README and `.env.example`.
- Switched the runtime lookup from `events.discord_submission_channel_id` to `event_discord_channels` using `channel_kind = submission` and `channel_id`.
