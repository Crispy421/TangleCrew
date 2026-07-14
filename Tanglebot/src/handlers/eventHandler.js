const { Events, MessageFlags } = require('discord.js');
const { syncCommands } = require('./commandHandler');
const { handleSubmissionMessage, loadSubmissionConfig } = require('../utils/submissionIntake');
const {
  handleHoneypotButtonInteraction,
  handleHoneypotMessage,
  loadHoneypotConfig,
  sendHoneypotStartupMessage,
} = require('../utils/honeypot');
const { handleRoleMenuButtonInteraction } = require('../utils/roleMenu');
const {
  handleLfgSelectInteraction,
  handleLfgButtonInteraction,
  handleLfgGroupButtonInteraction,
} = require('../utils/lfgGroup');
const {
  handleLfgForumSelectInteraction,
  handleLfgForumButtonInteraction,
  handleLfgForumModalSubmit,
  handleLfgForumGroupButtonInteraction,
} = require('../utils/lfgForum');

function loadEvents(client) {
  const submissionConfig = loadSubmissionConfig();
  client.submissionConfig = submissionConfig;
  if (submissionConfig.enabled) {
    console.log('Discord submission intake enabled.');
  }

  const honeypotConfig = loadHoneypotConfig();
  client.honeypotConfig = honeypotConfig;
  if (honeypotConfig.enabled) {
    console.log('Honeypot channel trap enabled.');
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

    await sendHoneypotStartupMessage(client, honeypotConfig);
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      await handleSubmissionMessage(message, submissionConfig);
    } catch (err) {
      console.error('Submission intake error:', err);
    }

    try {
      await handleHoneypotMessage(message, honeypotConfig, client);
    } catch (err) {
      console.error('Honeypot error:', err);
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
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('hp:')) {
        try {
          await handleHoneypotButtonInteraction(interaction);
        } catch (err) {
          console.error('Honeypot button interaction error:', err);
        }
      } else if (interaction.customId.startsWith('roles:')) {
        try {
          await handleRoleMenuButtonInteraction(interaction);
        } catch (err) {
          console.error('Role menu button interaction error:', err);
          await replyOrFollowUp(interaction, 'Something went wrong updating your roles.');
        }
      } else if (interaction.customId.startsWith('lfggroup:')) {
        try {
          await handleLfgGroupButtonInteraction(interaction);
        } catch (err) {
          console.error('LFG group button interaction error:', err);
          await replyOrFollowUp(interaction, 'Something went wrong updating that group.');
        }
      } else if (interaction.customId.startsWith('lfgforumgroup:')) {
        try {
          await handleLfgForumGroupButtonInteraction(interaction);
        } catch (err) {
          console.error('LFG forum group button interaction error:', err);
          await replyOrFollowUp(interaction, 'Something went wrong updating that group.');
        }
      } else if (interaction.customId.startsWith('lfgforum:')) {
        try {
          await handleLfgForumButtonInteraction(interaction);
        } catch (err) {
          console.error('LFG forum setup button interaction error:', err);
          await replyOrFollowUp(interaction, 'Something went wrong creating your LFG forum post.');
        }
      } else if (interaction.customId.startsWith('lfg:')) {
        try {
          await handleLfgButtonInteraction(interaction);
        } catch (err) {
          console.error('LFG setup button interaction error:', err);
          await replyOrFollowUp(interaction, 'Something went wrong creating your LFG post.');
        }
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('lfgforum:')) {
        try {
          await handleLfgForumSelectInteraction(interaction);
        } catch (err) {
          console.error('LFG forum select interaction error:', err);
          await replyOrFollowUp(interaction, 'Something went wrong updating your LFG forum setup.');
        }
      } else if (interaction.customId.startsWith('lfg:')) {
        try {
          await handleLfgSelectInteraction(interaction);
        } catch (err) {
          console.error('LFG select interaction error:', err);
          await replyOrFollowUp(interaction, 'Something went wrong updating your LFG setup.');
        }
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('lfgforum:')) {
        try {
          await handleLfgForumModalSubmit(interaction);
        } catch (err) {
          console.error('LFG forum modal submit error:', err);
          await replyOrFollowUp(interaction, 'Something went wrong creating your LFG forum post.');
        }
      }
      return;
    }

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
      await replyOrFollowUp(interaction, 'Something went wrong running that command.');
    }
  });
}

async function replyOrFollowUp(interaction, content) {
  const msg = { content, flags: MessageFlags.Ephemeral };
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(msg).catch(() => {});
  } else {
    await interaction.reply(msg).catch(() => {});
  }
}

module.exports = { loadEvents };
