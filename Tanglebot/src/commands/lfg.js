const { SlashCommandBuilder } = require('discord.js');
const { sendSetupMenu } = require('../utils/lfgGroup');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lfg')
    .setDescription('Create a Looking For Group post to find teammates'),

  async execute(interaction) {
    await sendSetupMenu(interaction);
  },
};
