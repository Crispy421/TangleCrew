const { EmbedBuilder, MessageFlags, SlashCommandBuilder } = require('discord.js');
const {
  SUBMISSION_FORMAT_MESSAGE,
  getLastAcceptedSubmission,
} = require('../utils/submissionIntake');

const DISCORD_GREEN = 0x1a5c2e;
const DISCORD_PURPLE = 0x4a235a;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('submission')
    .setDescription('Post proof submission help or show the latest accepted proof')
    .addSubcommand(subcommand =>
      subcommand
        .setName('format')
        .setDescription('Post the KC and drop proof formats for players')
        .addBooleanOption(option =>
          option
            .setName('private')
            .setDescription('Only show this response to you')
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('last')
        .setDescription('Show the latest accepted KC or drop proof submission')
        .addBooleanOption(option =>
          option
            .setName('private')
            .setDescription('Only show this response to you')
        )
    ),

  async execute(interaction) {
    const privateReply = interaction.options.getBoolean('private') ?? false;
    const flags = privateReply ? MessageFlags.Ephemeral : undefined;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'format') {
      return interaction.reply({
        content: SUBMISSION_FORMAT_MESSAGE,
        flags,
      });
    }

    if (subcommand === 'last') {
      const submission = getLastAcceptedSubmission();
      if (!submission?.acceptedAt) {
        return interaction.reply({
          content: 'No accepted KC or drop proof submissions have been recorded yet.',
          flags,
        });
      }

      return interaction.reply({
        embeds: [buildLastSubmissionEmbed(submission)],
        flags,
      });
    }

    return interaction.reply({
      content: 'Unknown submission command.',
      flags: MessageFlags.Ephemeral,
    });
  },
};

function buildLastSubmissionEmbed(submission) {
  const acceptedTime = Math.floor(new Date(submission.acceptedAt).getTime() / 1000);
  const isDrop = submission.type === 'drop';

  const fields = [
    { name: 'Task', value: submission.taskName ?? 'Unknown', inline: true },
    { name: 'Submitted by', value: submission.discordName ?? 'Unknown', inline: true },
  ];

  if (isDrop) {
    fields.push({ name: 'Item Dropped', value: submission.itemDropped ?? 'Unknown', inline: true });
  } else {
    fields.push(
      { name: 'Monster', value: submission.monsterName ?? 'Unknown', inline: true },
      { name: 'Phase', value: submission.phase ?? 'Unknown', inline: true },
      { name: 'Kill Count', value: String(submission.kcValue ?? 'Unknown'), inline: true },
    );
  }

  if (submission.messageUrl) {
    fields.push({ name: 'Discord Message', value: `[Jump to submission](${submission.messageUrl})`, inline: false });
  }

  fields.push({ name: 'Accepted', value: `<t:${acceptedTime}:R>`, inline: true });

  const embed = new EmbedBuilder()
    .setColor(isDrop ? DISCORD_PURPLE : DISCORD_GREEN)
    .setTitle(isDrop ? 'Latest Accepted Drop Proof' : 'Latest Accepted KC Proof')
    .addFields(fields)
    .setTimestamp(new Date(submission.acceptedAt));

  if (submission.imageUrl) {
    embed.setImage(submission.imageUrl);
  }

  return embed;
}
