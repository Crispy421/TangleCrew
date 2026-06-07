require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Partials } = require('discord.js');
const { loadCommands } = require('./handlers/commandHandler');
const { loadEvents } = require('./handlers/eventHandler');

if (!process.env.DISCORD_TOKEN) {
  throw new Error('Missing required environment variable: DISCORD_TOKEN. Copy Tanglebot/.env.example to Tanglebot/.env and fill in your bot token.');
}

const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
];

if (process.env.DISCORD_SUBMISSION_CHANNEL_EVENT_MAP) {
  intents.push(GatewayIntentBits.MessageContent);
}

const client = new Client({
  intents,
  partials: [Partials.Channel],
});

client.commands = new Collection();

loadCommands(client);
loadEvents(client);

client.login(process.env.DISCORD_TOKEN);
