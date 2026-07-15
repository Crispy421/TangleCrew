/**
 * One-time script: creates every Discord role referenced by the LFG system
 * (Bossing / Raids / Skilling-Minigame) that doesn't already exist in your
 * server. Safe to re-run — it skips any role that's already there by name.
 *
 * Usage:
 *   node scripts/create-lfg-roles.js
 *
 * Requires DISCORD_BOT_TOKEN and CLAN_ID in your .env (same ones the bot
 * already uses). The bot's own role must be positioned high enough in the
 * role list to create roles (needs the "Manage Roles" permission, which it
 * should already have).
 */

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { CATEGORIES } = require('../src/utils/roleMenu');

const discordBotToken = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
const guildId = process.env.CLAN_ID;

if (!discordBotToken || !guildId) {
  throw new Error('Missing DISCORD_BOT_TOKEN and/or CLAN_ID in .env');
}

// Pull every unique role name out of CATEGORIES automatically, so this
// script always matches whatever roleMenu.js currently defines.
function collectRoleNames() {
  const names = new Set();
  for (const category of Object.values(CATEGORIES)) {
    for (const role of category.roles) {
      names.add(role.roleName);
    }
  }
  return [...names];
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const guild = await client.guilds.fetch(guildId);
  await guild.roles.fetch(); // make sure the cache is fresh

  const roleNames = collectRoleNames();
  console.log(`Checking ${roleNames.length} role(s)...`);

  let created = 0;
  let skipped = 0;

  for (const name of roleNames) {
    const existing = guild.roles.cache.find((r) => r.name === name);
    if (existing) {
      console.log(`  Skipping "${name}" — already exists.`);
      skipped++;
      continue;
    }

    try {
      await guild.roles.create({
        name,
        hoist: false,
        mentionable: false,
        reason: 'Auto-created by create-lfg-roles.js for the LFG system',
      });
      console.log(`  ✅ Created "${name}"`);
      created++;
    } catch (err) {
      console.error(`  ⚠️ Failed to create "${name}":`, err.message);
    }
  }

  console.log(`\nDone. Created ${created}, skipped ${skipped} (already existed).`);
  console.log('Reminder: drag the bot\'s own role ABOVE all of these in Server Settings -> Roles so it can assign them.');

  process.exit(0);
});

client.login(discordBotToken);
