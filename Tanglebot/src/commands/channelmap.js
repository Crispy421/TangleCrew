const { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('channelmap')
    .setDescription('Generate a channel-to-event env var snippet for proof intake')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(option =>
      option
        .setName('channel')
        .setDescription('Channel to generate the mapping snippet for')
        .addChannelTypes(ChannelType.GuildText)
    ),

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    const mapping = JSON.stringify({ [channel.id]: 'REPLACE_WITH_EVENT_ID' });

    return interaction.reply({
      content: [
        `Channel: <#${channel.id}>`,
        `Channel ID: \`${channel.id}\``,
        '',
        'JSON pair:',
        `\`${mapping}\``,
        '',
        'Full env var example:',
        `\`DISCORD_SUBMISSION_CHANNEL_EVENT_MAP=${mapping}\``,
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  },
};
