const { Events, MessageFlags } = require('discord.js');
const { restoreReminders } = require('../utils/scheduler');
const { handleSubmissionMessage, loadSubmissionConfig } = require('../utils/submissionIntake');

function loadEvents(client) {
  const submissionConfig = loadSubmissionConfig();
  if (submissionConfig.enabled) {
    console.log('Discord submission intake enabled.');
  }

  client.once(Events.ClientReady, async (c) => {
    console.log(`Logged in as ${c.user.tag}`);
    restoreReminders(client);
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      await handleSubmissionMessage(message, submissionConfig);
    } catch (err) {
      console.error('Submission intake error:', err);
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
