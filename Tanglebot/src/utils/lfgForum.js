const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
  ChannelType,
} = require('discord.js');
const {
  buildRoleOptions,
  buildTimeOptions,
  findRoleOption,
  findTimeOption,
  findSizeOption,
  SIZE_OPTIONS,
  buildGroupEmbed,
  buildGroupRow,
  makeGroupId,
} = require('./lfgGroup');

// The Discord Forum Channel where /lfg-forum posts get created as threads.
// Create a Forum Channel in your server, copy its ID, and set this in .env.
const FORUM_CHANNEL_ID = process.env.LFG_FORUM_CHANNEL_ID;

const GROUP_FORMED_CLEANUP_DELAY_MS = 5 * 60 * 1000;

// Separate in-memory state from the regular /lfg command, so both versions
// can run side by side without interfering with each other. Lost on
// restart/redeploy, same caveat as the regular version.
const setupSessions = new Map(); // userId -> { role, time, size }
const activeGroups = new Map(); // groupId -> group state

// ---- Setup UI (identical shape to the regular /lfg command, different customId prefix) ----
function getSession(userId) {
  if (!setupSessions.has(userId)) {
    setupSessions.set(userId, { role: null, time: null, size: null });
  }
  return setupSessions.get(userId);
}

function buildSetupComponents(session) {
  const roleSelect = new StringSelectMenuBuilder()
    .setCustomId('lfgforum:select:role')
    .setPlaceholder('1. Choose an activity')
    .addOptions(
      buildRoleOptions().map((o) => ({
        value: o.value,
        label: o.label,
        default: session.role === o.value,
      }))
    );

  const timeSelect = new StringSelectMenuBuilder()
    .setCustomId('lfgforum:select:time')
    .setPlaceholder('2. Choose a time')
    .addOptions(
      buildTimeOptions().map((o) => ({
        value: o.value,
        label: o.label,
        default: session.time === o.value,
      }))
    );

  const sizeSelect = new StringSelectMenuBuilder()
    .setCustomId('lfgforum:select:size')
    .setPlaceholder('3. Choose group size')
    .addOptions(
      SIZE_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
        default: session.size === o.value,
      }))
    );

  const rows = [
    new ActionRowBuilder().addComponents(roleSelect),
    new ActionRowBuilder().addComponents(timeSelect),
    new ActionRowBuilder().addComponents(sizeSelect),
  ];

  if (session.role && session.time && session.size) {
    const createButton = new ButtonBuilder()
      .setCustomId('lfgforum:create')
      .setLabel('Create Forum Post')
      .setStyle(ButtonStyle.Success);
    rows.push(new ActionRowBuilder().addComponents(createButton));
  }

  return rows;
}

function buildSetupContent(session) {
  const parts = [];
  if (session.role) parts.push(`**Activity:** ${findRoleOption(session.role)?.label ?? '?'}`);
  if (session.time) parts.push(`**Time:** ${findTimeOption(session.time)?.label ?? '?'}`);
  if (session.size) parts.push(`**Size:** ${findSizeOption(session.size)?.label ?? '?'}`);

  const summary = parts.length ? parts.join('  •  ') + '\n\n' : '';
  return `${summary}Pick an activity, a time, and a group size, then hit **Create Forum Post**.\n(This creates a new post in the LFG forum instead of a message here.)`;
}

async function sendSetupMenu(interaction) {
  if (!FORUM_CHANNEL_ID) {
    return interaction.reply({
      content: '⚠️ LFG_FORUM_CHANNEL_ID is not set. Ask an admin to set it in the bot\'s environment variables.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const session = getSession(interaction.user.id);
  await interaction.reply({
    content: buildSetupContent(session),
    components: buildSetupComponents(session),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSetupSelect(interaction, field) {
  const session = getSession(interaction.user.id);
  session[field] = interaction.values[0];
  await interaction.update({
    content: buildSetupContent(session),
    components: buildSetupComponents(session),
  });
}

// ---- Creating the forum post (thread) ----
async function handleCreateButton(interaction) {
  const session = getSession(interaction.user.id);
  if (!session.role || !session.time || !session.size) {
    return interaction.reply({ content: '⚠️ Please pick all three options first.', flags: MessageFlags.Ephemeral });
  }

  const roleOption = findRoleOption(session.role);
  const timeOption = findTimeOption(session.time);
  const sizeOption = findSizeOption(session.size);

  const guildRole = interaction.guild.roles.cache.find((r) => r.name === roleOption.roleName);
  if (!guildRole) {
    return interaction.reply({
      content: `⚠️ The role **${roleOption.roleName}** doesn't exist yet. Ask an admin to create it.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const forumChannel = await interaction.guild.channels.fetch(FORUM_CHANNEL_ID).catch(() => null);
  if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
    return interaction.reply({
      content: '⚠️ LFG_FORUM_CHANNEL_ID doesn\'t point to a valid Forum Channel. Ask an admin to check the setup.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const groupId = makeGroupId();
  const sizeCap = sizeOption.value === 'any' ? Infinity : parseInt(sizeOption.value, 10);

  const group = {
    id: groupId,
    creatorId: interaction.user.id,
    creatorTag: interaction.user.username,
    roleLabel: roleOption.label,
    timeEpoch: parseInt(timeOption.value, 10),
    sizeLabel: sizeOption.label,
    sizeCap,
    members: new Set([interaction.user.id]),
    closed: false,
    threadId: null,
    cleanupTimeoutId: null,
  };
  activeGroups.set(groupId, group);

  const embed = buildGroupEmbed(group);
  const row = buildForumGroupRow(groupId, false);

  // Auto-apply a matching forum tag if one exists with the same name as the role
  // (e.g. a tag literally called "Yama"). Entirely optional — skipped if none matches.
  const matchingTag = forumChannel.availableTags?.find(
    (t) => t.name.toLowerCase() === roleOption.roleName.toLowerCase()
  );

  const thread = await forumChannel.threads.create({
    name: `${roleOption.label} — ${timeOption.label} — ${sizeOption.label}`,
    appliedTags: matchingTag ? [matchingTag.id] : [],
    message: {
      content: `<@&${guildRole.id}>`,
      embeds: [embed],
      components: [row],
    },
  });

  group.threadId = thread.id;

  scheduleForumGroupCleanup(interaction.client, group, Math.max(group.timeEpoch * 1000 - Date.now(), 0));
  setupSessions.delete(interaction.user.id);

  await interaction.update({ content: `✅ Your LFG forum post has been created: ${thread}`, components: [] });
  setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);
}

function buildForumGroupRow(groupId, closed) {
  const button = new ButtonBuilder()
    .setCustomId(`lfgforumgroup:join:${groupId}`)
    .setLabel(closed ? 'Group Full' : 'Join Group')
    .setStyle(closed ? ButtonStyle.Secondary : ButtonStyle.Success)
    .setDisabled(closed);
  return new ActionRowBuilder().addComponents(button);
}

async function handleJoinButton(interaction, groupId) {
  const group = activeGroups.get(groupId);
  if (!group) {
    return interaction.reply({ content: '⚠️ This group no longer exists.', flags: MessageFlags.Ephemeral });
  }
  if (group.closed) {
    return interaction.reply({ content: '⚠️ This group is already full.', flags: MessageFlags.Ephemeral });
  }
  if (group.members.has(interaction.user.id)) {
    return interaction.reply({ content: 'You\'re already in this group.', flags: MessageFlags.Ephemeral });
  }

  group.members.add(interaction.user.id);
  const justFilled = group.sizeCap !== Infinity && group.members.size >= group.sizeCap;
  if (justFilled) {
    group.closed = true;
  }

  const embed = buildGroupEmbed(group);
  const row = buildForumGroupRow(groupId, group.closed);

  await interaction.update({ embeds: [embed], components: [row] });
  await interaction.followUp({ content: '✅ You joined the group!', flags: MessageFlags.Ephemeral });

  if (justFilled) {
    const mentions = [...group.members].map((id) => `<@${id}>`).join(' ');
    await interaction.channel.send({ content: `${mentions}\n🎉 **Group formed, Good luck!**` });

    // Group is done — delete the whole forum post in 5 minutes instead of
    // waiting for the original event time.
    scheduleForumGroupCleanup(interaction.client, group, GROUP_FORMED_CLEANUP_DELAY_MS);
  }
}

function scheduleForumGroupCleanup(client, group, delayMs) {
  if (group.cleanupTimeoutId) {
    clearTimeout(group.cleanupTimeoutId);
  }

  group.cleanupTimeoutId = setTimeout(async () => {
    try {
      const thread = await client.channels.fetch(group.threadId);
      await thread.delete(); // deletes the entire forum post, no need to remove messages individually
    } catch (err) {
      console.error(`Could not delete expired LFG forum post ${group.id}:`, err.message);
    }
    activeGroups.delete(group.id);
  }, delayMs);
}

// ---- Entry points called from eventHandler.js ----
async function handleLfgForumSelectInteraction(interaction) {
  const field = interaction.customId.split(':')[2]; // "lfgforum:select:<field>"
  if (!['role', 'time', 'size'].includes(field)) return;
  return handleSetupSelect(interaction, field);
}

async function handleLfgForumButtonInteraction(interaction) {
  if (interaction.customId === 'lfgforum:create') {
    return handleCreateButton(interaction);
  }
}

async function handleLfgForumGroupButtonInteraction(interaction) {
  const [, , groupId] = interaction.customId.split(':'); // "lfgforumgroup:join:<groupId>"
  return handleJoinButton(interaction, groupId);
}

module.exports = {
  sendSetupMenu,
  handleLfgForumSelectInteraction,
  handleLfgForumButtonInteraction,
  handleLfgForumGroupButtonInteraction,
};
