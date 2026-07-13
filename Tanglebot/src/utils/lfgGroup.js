const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');
const { CATEGORIES } = require('./roleMenu');

// The time dropdown covers the next few hours in half-hour increments,
// starting from the next half-hour boundary after "now".
const SLOT_INTERVAL_MINUTES = 30;
const SLOT_WINDOW_HOURS = 4;

// Optional: set LFG_TIMEZONE in .env (e.g. "America/New_York") to control
// how the time dropdown's OWN labels are displayed while picking. This has
// no effect on the final posted time — that always auto-converts to each
// viewer's own timezone via Discord's <t:...> timestamp format. Defaults to
// Pacific Time; override with LFG_TIMEZONE if your community's primary
// timezone is different.
const DROPDOWN_TIMEZONE = process.env.LFG_TIMEZONE || 'America/Los_Angeles';

const SIZE_OPTIONS = [
  { value: '2', label: 'Duo (2 players)' },
  { value: '3', label: 'Trio (3 players)' },
  { value: '4', label: '4 Man (4 players)' },
  { value: '5', label: '5 Man (5 players)' },
  { value: 'any', label: 'Any (no limit)' },
];

// In-memory state. Both of these are lost on a restart/redeploy — fine for
// same-day LFG posts, but worth knowing if the bot redeploys mid-event.
const setupSessions = new Map(); // userId -> { role, time, size }
const activeGroups = new Map(); // groupId -> group state

// ---- Building the role dropdown from roleMenu.js's CATEGORIES ----
function buildRoleOptions() {
  const options = [];
  for (const cat of Object.values(CATEGORIES)) {
    for (const r of cat.roles) {
      options.push({
        value: `${cat.key}:${r.value}`,
        label: `${cat.buttonLabel}: ${r.label}`,
        roleName: r.roleName,
      });
    }
  }
  return options;
}

function findRoleOption(value) {
  return buildRoleOptions().find((o) => o.value === value);
}

// ---- Building the time dropdown: next 4 hours, 30-minute increments ----
function buildTimeOptions() {
  const now = new Date();
  const start = new Date(now);
  start.setSeconds(0, 0);
  const remainder = start.getMinutes() % SLOT_INTERVAL_MINUTES;
  start.setMinutes(start.getMinutes() + (SLOT_INTERVAL_MINUTES - remainder)); // next half-hour boundary

  const fmt = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: DROPDOWN_TIMEZONE,
  });

  const totalSlots = (SLOT_WINDOW_HOURS * 60) / SLOT_INTERVAL_MINUTES;
  const options = [];
  for (let i = 0; i < totalSlots; i++) {
    const slotStart = new Date(start.getTime() + i * SLOT_INTERVAL_MINUTES * 60 * 1000);
    const slotEnd = new Date(slotStart.getTime() + SLOT_INTERVAL_MINUTES * 60 * 1000);
    const label = `${fmt.format(slotStart)} - ${fmt.format(slotEnd)}`;
    const epochSeconds = Math.floor(slotStart.getTime() / 1000);
    options.push({ value: String(epochSeconds), label });
  }
  return options;
}

function findTimeOption(value) {
  return buildTimeOptions().find((o) => o.value === value);
}

function findSizeOption(value) {
  return SIZE_OPTIONS.find((o) => o.value === value);
}

// ---- Setup UI (the private "build your LFG post" menu) ----
function getSession(userId) {
  if (!setupSessions.has(userId)) {
    setupSessions.set(userId, { role: null, time: null, size: null });
  }
  return setupSessions.get(userId);
}

function buildSetupComponents(session) {
  const roleSelect = new StringSelectMenuBuilder()
    .setCustomId('lfg:select:role')
    .setPlaceholder('1. Choose an activity')
    .addOptions(
      buildRoleOptions().map((o) => ({
        value: o.value,
        label: o.label,
        default: session.role === o.value,
      }))
    );

  const timeSelect = new StringSelectMenuBuilder()
    .setCustomId('lfg:select:time')
    .setPlaceholder('2. Choose a time')
    .addOptions(
      buildTimeOptions().map((o) => ({
        value: o.value,
        label: o.label,
        default: session.time === o.value,
      }))
    );

  const sizeSelect = new StringSelectMenuBuilder()
    .setCustomId('lfg:select:size')
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
      .setCustomId('lfg:create')
      .setLabel('Create LFG Post')
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
  return `${summary}Pick an activity, a time, and a group size, then hit **Create LFG Post**.`;
}

async function sendSetupMenu(interaction) {
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

// ---- Posting the public LFG group message ----
function makeGroupId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function buildGroupRow(groupId, closed) {
  const button = new ButtonBuilder()
    .setCustomId(`lfggroup:join:${groupId}`)
    .setLabel(closed ? 'Group Full' : 'Join Group')
    .setStyle(closed ? ButtonStyle.Secondary : ButtonStyle.Success)
    .setDisabled(closed);
  return new ActionRowBuilder().addComponents(button);
}

function buildGroupEmbed(group) {
  const capDisplay = group.sizeCap === Infinity ? '∞' : String(group.sizeCap);
  const memberLines = [...group.members].map((id) => `<@${id}>`).join('\n');

  return new EmbedBuilder()
    .setTitle(group.closed ? '🔒 Looking For Group — Full' : '🔍 Looking For Group')
    .setDescription(
      `**Activity:** ${group.roleLabel}\n` +
      `**Time:** <t:${group.timeEpoch}:t> (<t:${group.timeEpoch}:R>)\n` +
      `**Group Size:** ${group.sizeLabel}\n\n` +
      `**Members (${group.members.size}/${capDisplay}):**\n${memberLines}`
    )
    .setColor(group.closed ? 0x2ecc71 : 0xc2a24c)
    .setFooter({ text: `Started by ${group.creatorTag}` });
}

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
    channelId: null,
    messageId: null,
  };
  activeGroups.set(groupId, group);

  const embed = buildGroupEmbed(group);
  const row = buildGroupRow(groupId, false);

  const publicMessage = await interaction.channel.send({
    content: `<@&${guildRole.id}>`,
    embeds: [embed],
    components: [row],
  });

  group.channelId = publicMessage.channelId;
  group.messageId = publicMessage.id;

  scheduleGroupCleanup(interaction.client, group);
  setupSessions.delete(interaction.user.id);

  await interaction.update({ content: '✅ Your LFG post has been created below!', components: [] });
  setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);
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
  if (group.sizeCap !== Infinity && group.members.size >= group.sizeCap) {
    group.closed = true;
  }

  const embed = buildGroupEmbed(group);
  const row = buildGroupRow(groupId, group.closed);

  await interaction.update({ embeds: [embed], components: [row] });
  await interaction.followUp({ content: '✅ You joined the group!', flags: MessageFlags.Ephemeral });
}

function scheduleGroupCleanup(client, group) {
  const delay = Math.max(group.timeEpoch * 1000 - Date.now(), 0);
  setTimeout(async () => {
    try {
      const channel = await client.channels.fetch(group.channelId);
      const message = await channel.messages.fetch(group.messageId);
      await message.delete();
    } catch (err) {
      console.error(`Could not delete expired LFG post ${group.id}:`, err.message);
    }
    activeGroups.delete(group.id);
  }, delay);
}

// ---- Entry points called from eventHandler.js ----
async function handleLfgSelectInteraction(interaction) {
  const field = interaction.customId.split(':')[2]; // "lfg:select:<field>"
  if (!['role', 'time', 'size'].includes(field)) return;
  return handleSetupSelect(interaction, field);
}

async function handleLfgButtonInteraction(interaction) {
  if (interaction.customId === 'lfg:create') {
    return handleCreateButton(interaction);
  }
}

async function handleLfgGroupButtonInteraction(interaction) {
  const [, , groupId] = interaction.customId.split(':'); // "lfggroup:join:<groupId>"
  return handleJoinButton(interaction, groupId);
}

module.exports = {
  sendSetupMenu,
  handleLfgSelectInteraction,
  handleLfgButtonInteraction,
  handleLfgGroupButtonInteraction,
};
