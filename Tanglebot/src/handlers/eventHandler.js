const { Events, MessageFlags } = require('discord.js');
const { syncCommands } = require('./commandHandler');
const { handleSubmissionMessage, loadSubmissionConfig } = require('../utils/submissionIntake');

function loadEvents(client) {
  const submissionConfig = loadSubmissionConfig();
  if (submissionConfig.enabled) {
    console.log('Discord submission intake enabled.');
  }

  client.once(Events.ClientReady, async (c) => {
    console.log(`Logged in as ${c.user.tag}`);
    await syncCommands(client);

    const adminLogChannelId = process.env.ADMIN_LOG_CHANNEL_ID;
    const ownerRoleId = process.env.OWNER_ROLE_ID;
    if (adminLogChannelId) {
      try {
        const channel = await client.channels.fetch(adminLogChannelId);
        await channel.send(`<@&${ownerRoleId}> Bot is online and ready.`);
      } catch (err) {
        console.error('Failed to send startup message to admin log channel:', err);
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      await handleSubmissionMessage(message, submissionConfig);
    } catch (err) {
      console.error('Submission intake error:', err);
    }
  });

  client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
    const channelId = process.env.ANNOUNCEMENT_CHANNEL_ID;
    if (!channelId) return;
    if (newMessage.channelId !== channelId) return;
    if (newMessage.content !== '[Original Message Deleted]') return;
    try {
      await newMessage.delete();
    } catch (err) {
      console.error('Failed to delete stale announcement message:', err);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) return;

    if (interaction.isAutocomplete()) {
      try {
        await command.autocomplete(interaction);
      } catch (err) {
        console.error('Autocomplete error:', err);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(err);
      const msg = { content: 'Something went wrong running that command.', flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
    }
  });
}

module.exports = { loadEvents };
