const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const {
  KC_SESSION_DURATION_MS,
  SUBMISSION_FORMAT_MESSAGE,
  getActiveSession,
  resolveEventIdForChannel,
  setActiveSession,
} = require('../utils/submissionIntake');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kc')
    .setDescription('Start or end a proof submission session')
    .addSubcommand(subcommand =>
      subcommand
        .setName('start')
        .setDescription('Start a KC/drop proof submission session in this channel')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('end')
        .setDescription('End your active KC/drop proof submission session')
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const config = interaction.client.submissionConfig;
    const sessionDurationMinutes = Math.floor(KC_SESSION_DURATION_MS / 60000);

    if (subcommand === 'start') {
      if (!config?.enabled) {
        return interaction.reply({
          content: 'Proof intake is not configured right now. Ask an admin to finish the submission intake environment setup first.',
          flags: MessageFlags.Ephemeral,
        });
      }

      let eventId;
      try {
        eventId = await resolveEventIdForChannel(interaction.channelId, config);
      } catch {
        return interaction.reply({
          content: 'Submission routing is temporarily unavailable. Please try again in a moment.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (!eventId) {
        return interaction.reply({
          content: 'This channel is not configured for proof intake in the web panel yet.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const existingSession = getActiveSession(interaction.user.id);
      if (existingSession && existingSession.channelId !== interaction.channelId) {
        return interaction.reply({
          content: `You already have an active proof session in <#${existingSession.channelId}>. Run \`/kc end\` there first or finish that submission.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const session = {
        channelId: interaction.channelId,
        eventId,
        expiresAt: new Date(Date.now() + KC_SESSION_DURATION_MS).toISOString(),
        mode: 'start',
        startedAt: new Date().toISOString(),
        userId: interaction.user.id,
      };

      setActiveSession(session);

      return interaction.reply({
        content: [
          existingSession
            ? 'Your active proof session in this channel was refreshed.'
            : 'Your proof session is now active for this channel.',
          `Starting KC submissions and drop proofs from you in this channel will be processed until you run \`/kc end\` or the session expires in ${sessionDurationMinutes} minutes.`,
          '',
          SUBMISSION_FORMAT_MESSAGE,
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === 'end') {
      if (!config?.enabled) {
        return interaction.reply({
          content: 'Proof intake is not configured right now. Ask an admin to finish the submission intake environment setup first.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const existingSession = getActiveSession(interaction.user.id);
      if (!existingSession) {
        return interaction.reply({
          content: 'You do not have an active proof session right now. Run `/kc start` first.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (existingSession.channelId !== interaction.channelId) {
        return interaction.reply({
          content: `Your active proof session is in <#${existingSession.channelId}>. Run \`/kc end\` there when you are ready to submit the ending KC proof.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      setActiveSession({
        ...existingSession,
        expiresAt: new Date(Date.now() + KC_SESSION_DURATION_MS).toISOString(),
        mode: 'end',
      });

      return interaction.reply({
        content: [
          'Your ending KC session is now active for this channel.',
          `Your next valid ending KC proof message from you in this channel will be processed, then the session will close automatically. This ending session also expires in ${sessionDurationMinutes} minutes.`,
          '',
          SUBMISSION_FORMAT_MESSAGE,
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      content: 'Unknown kc command.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
