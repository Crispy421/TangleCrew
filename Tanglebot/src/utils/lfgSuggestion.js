const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');
const { CATEGORY_OPTIONS, findCategoryOption, getActivityOptions, findActivityOption } = require('./lfgGroup');
const { notifyAdminLog, replyEphemeral, isValidColor, isValidEmoji, normalizeEmojiInput } = require('./roleMenu');

// Suggestions aren't an operational alert like the rest of the LFG admin log traffic — yellow
// signals "review this" rather than notifyAdminLog's default red "something's broken".
const SUGGESTION_EMBED_COLOR = 0xf1c40f;

// customIds for the two modals — named once and reused at both construction (setCustomId) and
// routing (handleLfgSuggestionModalSubmit) so they can't drift apart from each other.
const NEW_MODAL_ID = 'lfgsuggestion:modal:new';
const EDIT_MODAL_ID = 'lfgsuggestion:modal:edit';

// Shared text input label — identical on both the new-activity and edit-activity modals.
const SIZE_FIELD_LABEL = 'Max players (add "mass" for a Mass option)';

// Reused across both submit handlers' admin-log embeds and reply messages.
const NEEDS_LOOK_FIELD_NAME = '⚠️ Needs a look before merging';
const SESSION_EXPIRED_MESSAGE = '⚠️ Something went wrong — please run /lfg-suggestion again.';
const SUGGESTION_SENT_MESSAGE = '✅ Thanks! Your suggestion has been sent to the admins.';

// In-memory state, lost on restart/redeploy — fine here since a suggestion is a one-shot flow,
// same tradeoff lfgPost.js makes for its own setup sessions.
// userId -> { mode: 'new' | 'edit', category, activity }
const sessions = new Map();

// The select-menu steps guard against a missing/expired session by aborting in place (the user
// is still looking at the previous ephemeral message, so update it rather than send a new one).
function abortSessionExpired(interaction) {
  return interaction.update({ content: SESSION_EXPIRED_MESSAGE, components: [] });
}

// ---- Size <-> text round-trip, e.g. sizeOptions for max 5 with a Mass option <-> "5 mass" ----
function suggestedSizeText(sizeOptions) {
  const numeric = sizeOptions.filter((o) => /^\d+$/.test(o.value)).map((o) => parseInt(o.value, 10));
  const hasMass = sizeOptions.some((o) => o.value === 'mass');
  const max = numeric.length ? Math.max(...numeric) : '?';
  return hasMass ? `${max} mass` : `${max}`;
}

function parseSuggestedSize(text) {
  const match = (text ?? '').trim().match(/^(\d+)\s*(mass)?$/i);
  if (!match) return null;
  const max = parseInt(match[1], 10);
  const hasMass = Boolean(match[2]);
  return { code: hasMass ? `sizeRangeWithMass(${max})` : `sizeRange(${max})` };
}

// Falls back to a placeholder (rather than throwing) when the suggester's size text isn't a
// parseable number — e.g. a typo like "olmpet". Matches PUT_EMOJI_ID_HERE's approach: a valid,
// copy-pasteable placeholder with the original text kept alongside it, not a bare `sizeRange(?)`
// call (which isn't valid JS on its own and would break pasting the line as-is).
function resolveSizeCode(size, sizeText) {
  return size ? size.code : `'PUT_SIZE_HERE' /* suggested: "${sizeText}" */`;
}

// ---- Step 1: /lfg-suggestion type:new|edit -> category picker ----
async function sendCategoryPicker(interaction, mode) {
  sessions.set(interaction.user.id, { mode, category: null, activity: null });

  const select = new StringSelectMenuBuilder()
    .setCustomId('lfgsuggestion:select:category')
    .setPlaceholder('Choose a category')
    .addOptions(CATEGORY_OPTIONS.map((o) => ({ value: o.key, label: o.label })));

  const verb = mode === 'edit' ? 'suggest changes to' : 'suggest a new activity in';
  await interaction.reply({
    content: `Which category would you like to ${verb}?`,
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

// ---- Step 2 (edit only): category picked -> activity picker ----
// (new mode has nothing left to pick, so it opens the modal directly instead)
async function handleCategorySelect(interaction) {
  const session = sessions.get(interaction.user.id);
  if (!session) {
    return abortSessionExpired(interaction);
  }
  session.category = interaction.values[0];

  if (session.mode === 'new') {
    return interaction.showModal(buildNewActivityModal());
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('lfgsuggestion:select:activity')
    .setPlaceholder('Choose an activity')
    .addOptions(getActivityOptions(session.category).map((r) => ({ value: r.value, label: r.label })));

  await interaction.update({
    content: 'Which activity would you like to suggest changes for?',
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

// ---- Step 3 (edit only): activity picked -> modal, prefilled with its current values ----
async function handleActivitySelect(interaction) {
  const session = sessions.get(interaction.user.id);
  if (!session) {
    return abortSessionExpired(interaction);
  }
  session.activity = interaction.values[0];

  const activityOption = findActivityOption(session.category, session.activity);
  return interaction.showModal(buildEditActivityModal(activityOption));
}

async function handleLfgSuggestionSelectInteraction(interaction) {
  const field = interaction.customId.split(':')[2]; // "lfgsuggestion:select:<field>"
  if (field === 'category') return handleCategorySelect(interaction);
  if (field === 'activity') return handleActivitySelect(interaction);
}

// Every field a role entry can have, in template order (label, emoji, color, size) — capped at
// Discord's 5-input-per-modal limit, with a free-text reason as the 5th.
function addSuggestionFields(modal, { label, size, color, emoji }) {
  modal.addComponents(
    new ActionRowBuilder().addComponents(label),
    new ActionRowBuilder().addComponents(size),
    new ActionRowBuilder().addComponents(color),
    new ActionRowBuilder().addComponents(emoji),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Why? (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(500)
    )
  );
  return modal;
}

function buildNewActivityModal() {
  const modal = new ModalBuilder().setCustomId(NEW_MODAL_ID).setTitle('Suggest a New Activity');
  return addSuggestionFields(modal, {
    label: new TextInputBuilder()
      .setCustomId('label')
      .setLabel('Activity name')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100)
      .setPlaceholder('e.g. Araxxor'),
    size: new TextInputBuilder()
      .setCustomId('size')
      .setLabel(SIZE_FIELD_LABEL)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(20)
      .setPlaceholder('e.g. 5 or 10 mass'),
    color: new TextInputBuilder()
      .setCustomId('color')
      .setLabel('Color (hex, optional)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(10)
      .setPlaceholder('#006400'),
    emoji: new TextInputBuilder()
      .setCustomId('emoji')
      .setLabel('Emoji (optional)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(60)
      .setPlaceholder('Paste a copied emoji, or type its ID (unicode emoji works too)'),
  });
}

function buildEditActivityModal(activityOption) {
  const modal = new ModalBuilder()
    .setCustomId(EDIT_MODAL_ID)
    .setTitle(`Edit: ${activityOption.label}`.slice(0, 45));
  return addSuggestionFields(modal, {
    label: new TextInputBuilder()
      .setCustomId('label')
      .setLabel('Activity name')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100)
      .setValue(activityOption.label),
    size: new TextInputBuilder()
      .setCustomId('size')
      .setLabel(SIZE_FIELD_LABEL)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(20)
      .setValue(suggestedSizeText(activityOption.sizeOptions)),
    color: new TextInputBuilder()
      .setCustomId('color')
      .setLabel('Color (hex)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(10)
      .setValue(activityOption.color),
    emoji: new TextInputBuilder()
      .setCustomId('emoji')
      .setLabel('Emoji (paste one to change it)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(60)
      .setValue(activityOption.emoji),
  });
}

// Builds the copy/paste-ready roleMenu.js CATEGORIES role-entry line matching the template format.
function buildSuggestedLine(label, emoji, color, sizeCode) {
  return `{ label: '${label.replace(/'/g, "\\'")}', emoji: '${emoji}', color: '${color}', sizeOptions: ${sizeCode} },`;
}

// Fields an admin should double-check before copying the suggestion in — invalid color/emoji
// format, or a size we couldn't parse — flagged rather than silently accepted or defaulted,
// consistent with how roleMenu.js itself treats missing/invalid color and emoji.
function unresolvedFields(color, emoji, size) {
  const flags = [];
  if (!isValidColor(color)) flags.push('color');
  if (!isValidEmoji(emoji)) flags.push('emoji');
  if (!size) flags.push('size');
  return flags;
}

async function handleNewActivitySubmit(interaction) {
  const session = sessions.get(interaction.user.id);
  if (!session?.category) {
    return replyEphemeral(interaction, SESSION_EXPIRED_MESSAGE);
  }

  const label = interaction.fields.getTextInputValue('label').trim();
  const sizeText = interaction.fields.getTextInputValue('size').trim();
  const color = interaction.fields.getTextInputValue('color').trim() || '#006400';
  const emoji = normalizeEmojiInput(interaction.fields.getTextInputValue('emoji')) || 'PUT_EMOJI_ID_HERE';
  const reason = interaction.fields.getTextInputValue('reason').trim();

  const size = parseSuggestedSize(sizeText);
  const categoryOption = findCategoryOption(session.category);
  const flags = unresolvedFields(color, emoji, size);
  const line = buildSuggestedLine(label, emoji, color, resolveSizeCode(size, sizeText));
  const categoryLabel = categoryOption?.label ?? session.category;

  const fields = [
    { name: 'Suggested By', value: `<@${interaction.user.id}>`, inline: true },
    { name: 'Category', value: categoryLabel, inline: true },
    { name: `Suggested Line (CATEGORIES → ${session.category} → roles)`, value: `\`\`\`js\n${line}\n\`\`\`` },
  ];
  if (flags.length) fields.push({ name: NEEDS_LOOK_FIELD_NAME, value: flags.join(', ') });
  if (reason) fields.push({ name: 'Notes', value: reason });

  await notifyAdminLog(
    interaction.client,
    '💡 LFG Suggestion: New Activity',
    `New activity suggested for **${categoryLabel}**.`,
    fields,
    SUGGESTION_EMBED_COLOR
  );
  sessions.delete(interaction.user.id);

  return replyEphemeral(interaction, SUGGESTION_SENT_MESSAGE);
}

async function handleEditActivitySubmit(interaction) {
  const session = sessions.get(interaction.user.id);
  const activityOption = session && findActivityOption(session.category, session.activity);
  if (!activityOption) {
    return replyEphemeral(interaction, SESSION_EXPIRED_MESSAGE);
  }

  const label = interaction.fields.getTextInputValue('label').trim();
  const sizeText = interaction.fields.getTextInputValue('size').trim();
  const color = interaction.fields.getTextInputValue('color').trim();
  const emoji = normalizeEmojiInput(interaction.fields.getTextInputValue('emoji'));
  const reason = interaction.fields.getTextInputValue('reason').trim();

  const size = parseSuggestedSize(sizeText);
  const originalSizeText = suggestedSizeText(activityOption.sizeOptions);

  const changes = [];
  if (label !== activityOption.label) changes.push(`Label: **${activityOption.label}** → **${label}**`);
  if (sizeText !== originalSizeText) changes.push(`Size: **${originalSizeText}** → **${sizeText}**`);
  if (color !== activityOption.color) changes.push(`Color: **${activityOption.color}** → **${color}**`);
  if (emoji !== activityOption.emoji) changes.push(`Emoji: **${activityOption.emoji}** → **${emoji}**`);

  const categoryOption = findCategoryOption(session.category);
  const flags = unresolvedFields(color, emoji, size);
  const line = buildSuggestedLine(label, emoji, color, resolveSizeCode(size, sizeText));
  const categoryLabel = categoryOption?.label ?? session.category;

  const fields = [
    { name: 'Suggested By', value: `<@${interaction.user.id}>`, inline: true },
    { name: 'Activity', value: `${categoryLabel} → ${activityOption.label}`, inline: true },
    { name: 'Changes', value: changes.length ? changes.map((c) => `• ${c}`).join('\n') : '_No fields were changed._' },
    { name: `Suggested Line (replaces CATEGORIES → ${session.category} → roles)`, value: `\`\`\`js\n${line}\n\`\`\`` },
  ];
  if (flags.length) fields.push({ name: NEEDS_LOOK_FIELD_NAME, value: flags.join(', ') });
  if (reason) fields.push({ name: 'Notes', value: reason });

  await notifyAdminLog(
    interaction.client,
    '💡 LFG Suggestion: Edit Activity',
    `Suggested changes for **${categoryLabel} → ${activityOption.label}**.`,
    fields,
    SUGGESTION_EMBED_COLOR
  );
  sessions.delete(interaction.user.id);

  return replyEphemeral(interaction, SUGGESTION_SENT_MESSAGE);
}

async function handleLfgSuggestionModalSubmit(interaction) {
  if (interaction.customId === NEW_MODAL_ID) return handleNewActivitySubmit(interaction);
  if (interaction.customId === EDIT_MODAL_ID) return handleEditActivitySubmit(interaction);
}

module.exports = {
  sendCategoryPicker,
  handleLfgSuggestionSelectInteraction,
  handleLfgSuggestionModalSubmit,
};
