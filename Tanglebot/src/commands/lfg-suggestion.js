const { SlashCommandBuilder } = require('discord.js');
const { sendCategoryPicker } = require('../utils/lfgSuggestion');

module.exports = {
  requiredEnv: ['ADMIN_LOG_CHANNEL_ID'],

  data: new SlashCommandBuilder()
    .setName('lfg-suggestion')
    .setDescription('Suggest a new LFG activity or changes to an existing one')
    .addStringOption((opt) =>
      opt
        .setName('type')
        .setDescription('Suggest a brand new activity, or changes to an existing one?')
        .setRequired(true)
        .addChoices(
          { name: 'New Activity', value: 'new' },
          { name: 'Edit Existing Activity', value: 'edit' }
        )
    ),

  async execute(interaction) {
    const mode = interaction.options.getString('type'); // 'new' | 'edit'
    await sendCategoryPicker(interaction, mode);
  },
};
