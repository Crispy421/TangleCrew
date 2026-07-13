const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildMenuEmbed, buildCategoryButtonsRow } = require('../utils/roleMenu');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lfg-pings')
    .setDescription('Get your private LFG Pings menu (Bossing / Raids)'),

  async execute(interaction) {
    const embed = buildMenuEmbed();
    const row = buildCategoryButtonsRow();

    await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });

    // Auto-delete this menu after 60 seconds. Roles already picked stay assigned.
    setTimeout(() => {
      interaction.deleteReply().catch((err) => {
        console.error('Could not delete /lfg-pings menu message:', err.message);
      });
    }, 60 * 1000);
  },
};
