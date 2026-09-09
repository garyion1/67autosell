require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  AttachmentBuilder,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

const PREFIX = ',';
const ENV_STAFF_ROLE = process.env.STAFF_ROLE_ID;
const ENV_TICKET_PANEL_CHANNEL = process.env.TICKET_PANEL_CHANNEL_ID;
const ENV_TICKETS_CATEGORY = process.env.TICKETS_CATEGORY_ID;

// Add lowercase words/phrases here to have automod delete messages containing them.
const BAD_WORDS = [];

// ============ PERSISTENCE ============

const DATA_FILE = path.join(__dirname, 'data.json');

const ticketsDB = new Map();
const warningsDB = new Map();
const modLogsDB = new Map();
const ticketPriorityDB = new Map();
const automodDB = new Map();
const automodExemptDB = new Map(); // guildId -> Set<channelId>
const ticketClaimDB = new Map(); // channelId -> staffUserId
const ticketStatsDB = new Map(); // guildId -> { opened, closed, totalCloseMs }
const transcriptChannelDB = new Map(); // guildId -> channelId
const messageLogChannelDB = new Map(); // guildId -> channelId
const guildConfigDB = new Map(); // guildId -> { staffRoleId, ticketsCategoryId }
const remindersDB = new Map(); // reminderId -> { userId, text, fireAt }
const giveawaysDB = new Map(); // messageId -> { channelId, guildId, prize, winnerCount, endsAt, hostTag, ended, winners }

// Transient, not persisted (fine to reset on restart)
const ticketActivityDB = new Map(); // channelId -> lastActivityTimestamp
const ticketWarnedDB = new Set(); // channelId already warned for inactivity
const spamTrackerDB = new Map(); // userId -> { content, count, last }
const automodViolationsDB = new Map(); // userId -> [timestamps]

let dirty = false;
function markDirty() {
  dirty = true;
}

function serialize() {
  return {
    tickets: Object.fromEntries(ticketsDB),
    warnings: Object.fromEntries(warningsDB),
    modLogs: Object.fromEntries(modLogsDB),
    ticketPriority: Object.fromEntries(ticketPriorityDB),
    automod: Object.fromEntries(automodDB),
    automodExempt: Object.fromEntries(Array.from(automodExemptDB.entries()).map(([k, v]) => [k, Array.from(v)])),
    ticketClaim: Object.fromEntries(ticketClaimDB),
    ticketStats: Object.fromEntries(ticketStatsDB),
    transcriptChannel: Object.fromEntries(transcriptChannelDB),
    messageLogChannel: Object.fromEntries(messageLogChannelDB),
    guildConfig: Object.fromEntries(guildConfigDB),
    reminders: Object.fromEntries(remindersDB),
    giveaways: Object.fromEntries(giveawaysDB),
  };
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    for (const [k, v] of Object.entries(raw.tickets || {})) ticketsDB.set(k, v);
    for (const [k, v] of Object.entries(raw.warnings || {})) warningsDB.set(k, v);
    for (const [k, v] of Object.entries(raw.modLogs || {})) modLogsDB.set(k, v);
    for (const [k, v] of Object.entries(raw.ticketPriority || {})) ticketPriorityDB.set(k, v);
    for (const [k, v] of Object.entries(raw.automod || {})) automodDB.set(k, v);
    for (const [k, v] of Object.entries(raw.automodExempt || {})) automodExemptDB.set(k, new Set(v));
    for (const [k, v] of Object.entries(raw.ticketClaim || {})) ticketClaimDB.set(k, v);
    for (const [k, v] of Object.entries(raw.ticketStats || {})) ticketStatsDB.set(k, v);
    for (const [k, v] of Object.entries(raw.transcriptChannel || {})) transcriptChannelDB.set(k, v);
    for (const [k, v] of Object.entries(raw.messageLogChannel || {})) messageLogChannelDB.set(k, v);
    for (const [k, v] of Object.entries(raw.guildConfig || {})) guildConfigDB.set(k, v);
    for (const [k, v] of Object.entries(raw.reminders || {})) remindersDB.set(k, v);
    for (const [k, v] of Object.entries(raw.giveaways || {})) giveawaysDB.set(k, v);
  } catch (e) {
    console.error('Failed to load data.json:', e);
  }
}

function saveData() {
  if (!dirty) return;
  dirty = false;
  fs.writeFileSync(DATA_FILE, JSON.stringify(serialize(), null, 2));
}

loadData();
setInterval(saveData, 15000);
process.on('SIGINT', () => { saveData(); process.exit(0); });
process.on('SIGTERM', () => { saveData(); process.exit(0); });

function getStaffRoleId(guildId) {
  return guildConfigDB.get(guildId)?.staffRoleId || ENV_STAFF_ROLE;
}

function getTicketsCategoryId(guildId) {
  return guildConfigDB.get(guildId)?.ticketsCategoryId || ENV_TICKETS_CATEGORY;
}

function findTicketOwner(channelId) {
  return Array.from(ticketsDB.entries()).find(([, id]) => id === channelId)?.[0];
}

function logModAction(userId, type, reason, moderatorTag) {
  if (!modLogsDB.has(userId)) modLogsDB.set(userId, []);
  modLogsDB.get(userId).push({ type, reason, moderator: moderatorTag, timestamp: Date.now() });
  markDirty();
}

function bumpTicketStat(guildId, type, extraMs) {
  const stats = ticketStatsDB.get(guildId) || { opened: 0, closed: 0, totalCloseMs: 0 };
  if (type === 'opened') stats.opened += 1;
  if (type === 'closed') {
    stats.closed += 1;
    stats.totalCloseMs += extraMs || 0;
  }
  ticketStatsDB.set(guildId, stats);
  markDirty();
}

async function confirmAction(message, promptText) {
  const prompt = await message.reply(`${promptText}\nReact with ✅ to confirm or ❌ to cancel (15s).`);
  await prompt.react('✅').catch(() => {});
  await prompt.react('❌').catch(() => {});

  const collected = await prompt
    .awaitReactions({
      filter: (reaction, user) => ['✅', '❌'].includes(reaction.emoji.name) && user.id === message.author.id,
      max: 1,
      time: 15000,
    })
    .catch(() => null);

  prompt.delete().catch(() => {});
  if (!collected || collected.size === 0) return false;
  return collected.first().emoji.name === '✅';
}

function scheduleReminder(id, reminder) {
  const delay = reminder.fireAt - Date.now();
  const fire = async () => {
    try {
      const user = await client.users.fetch(reminder.userId);
      await user.send(`⏰ Reminder: ${reminder.text}`);
    } catch (e) {
      console.log('Could not deliver reminder DM');
    }
    remindersDB.delete(id);
    markDirty();
  };
  if (delay <= 0) fire();
  else setTimeout(fire, delay);
}

function pickRandomWinners(entrants, count) {
  const pool = [...entrants];
  const winners = [];
  while (pool.length > 0 && winners.length < count) {
    const index = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(index, 1)[0]);
  }
  return winners;
}

async function endGiveaway(messageId) {
  const giveaway = giveawaysDB.get(messageId);
  if (!giveaway || giveaway.ended) return;

  const channel = client.channels.cache.get(giveaway.channelId) || (await client.channels.fetch(giveaway.channelId).catch(() => null));
  if (!channel) {
    giveaway.ended = true;
    markDirty();
    return;
  }

  const giveawayMessage = await channel.messages.fetch(messageId).catch(() => null);
  if (!giveawayMessage) {
    giveaway.ended = true;
    markDirty();
    return;
  }

  const reaction = giveawayMessage.reactions.cache.get('🎉');
  const reactedUsers = reaction ? await reaction.users.fetch().catch(() => new Map()) : new Map();
  const entrants = Array.from(reactedUsers.values()).filter((u) => !u.bot);

  const winners = pickRandomWinners(entrants, giveaway.winnerCount);
  giveaway.ended = true;
  giveaway.winners = winners.map((w) => w.id);
  markDirty();

  const embed = new EmbedBuilder()
    .setColor('#F04747')
    .setTitle(`🎉 Giveaway Ended: ${giveaway.prize}`)
    .setDescription(
      winners.length > 0
        ? `Winner${winners.length > 1 ? 's' : ''}: ${winners.map((w) => `<@${w.id}>`).join(', ')}`
        : 'No valid entries — no winner.'
    )
    .setFooter({ text: `Hosted by ${giveaway.hostTag}` })
    .setTimestamp();

  await giveawayMessage.edit({ embeds: [embed] }).catch(() => {});

  if (winners.length > 0) {
    channel.send(`🎉 Congratulations ${winners.map((w) => `<@${w.id}>`).join(', ')}! You won **${giveaway.prize}**!`).catch(() => {});
  } else {
    channel.send(`😔 No valid entries for **${giveaway.prize}** — no winner could be determined.`).catch(() => {});
  }
}

function scheduleGiveawayEnd(messageId, giveaway) {
  const delay = giveaway.endsAt - Date.now();
  const fire = () => endGiveaway(messageId).catch(() => {});
  if (delay <= 0) fire();
  else setTimeout(fire, delay);
}

// ============ EVENTS ============

client.on('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  client.user.setActivity(',help | Moderation & Tickets', { type: 'WATCHING' });

  for (const [id, reminder] of remindersDB.entries()) {
    scheduleReminder(id, reminder);
  }

  for (const [id, giveaway] of giveawaysDB.entries()) {
    if (!giveaway.ended) scheduleGiveawayEnd(id, giveaway);
  }
});

client.on('guildMemberAdd', async (member) => {
  try {
    await member.send('👋 Welcome to **67autosell**!');
  } catch (e) {
    console.log('Could not DM new member');
  }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!newMessage.guild) return;
  if (newMessage.author?.bot) return;
  if (oldMessage.partial || newMessage.partial) return;
  if (oldMessage.content === newMessage.content) return;

  const logChannelId = messageLogChannelDB.get(newMessage.guild.id);
  if (!logChannelId) return;
  const logChannel = newMessage.guild.channels.cache.get(logChannelId);
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setColor('#FAA61A')
    .setTitle('✏️ Message Edited')
    .setThumbnail(newMessage.author.displayAvatarURL())
    .addFields(
      { name: 'Author', value: `${newMessage.author.tag}`, inline: true },
      { name: 'Channel', value: `${newMessage.channel}`, inline: true },
      { name: 'Before', value: (oldMessage.content || '*empty*').slice(0, 1024) },
      { name: 'After', value: (newMessage.content || '*empty*').slice(0, 1024) }
    )
    .setTimestamp();

  logChannel.send({ embeds: [embed] }).catch(() => {});
});

client.on('messageDelete', async (message) => {
  if (!message.guild) return;
  if (message.author?.bot) return;
  if (message.partial) return;

  const logChannelId = messageLogChannelDB.get(message.guild.id);
  if (!logChannelId) return;
  const logChannel = message.guild.channels.cache.get(logChannelId);
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setColor('#F04747')
    .setTitle('🗑️ Message Deleted')
    .setThumbnail(message.author ? message.author.displayAvatarURL() : null)
    .addFields(
      { name: 'Author', value: message.author ? `${message.author.tag}` : 'Unknown', inline: true },
      { name: 'Channel', value: `${message.channel}`, inline: true },
      { name: 'Content', value: (message.content || '*empty*').slice(0, 1024) }
    )
    .setTimestamp();

  logChannel.send({ embeds: [embed] }).catch(() => {});
});

const TICKET_INACTIVITY_WARN_MS = 24 * 60 * 60 * 1000;
const TICKET_INACTIVITY_CLOSE_MS = 25 * 60 * 60 * 1000;

setInterval(async () => {
  const now = Date.now();
  for (const [userId, channelId] of Array.from(ticketsDB.entries())) {
    const lastActivity = ticketActivityDB.get(channelId) || now;
    const idleFor = now - lastActivity;
    if (idleFor < TICKET_INACTIVITY_WARN_MS) continue;

    const channel = client.channels.cache.get(channelId);
    if (!channel) {
      ticketsDB.delete(userId);
      markDirty();
      continue;
    }

    if (idleFor >= TICKET_INACTIVITY_CLOSE_MS) {
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('🎫 Ticket Closed')
        .setDescription('This ticket was auto-closed due to inactivity.\nChannel will be deleted in 5 seconds.');
      await channel.send({ embeds: [embed] }).catch(() => {});
      await closeTicketChannel(channel, userId, 'Auto-close (inactivity)', 'Closed automatically due to inactivity.');
      ticketWarnedDB.delete(channelId);
    } else if (!ticketWarnedDB.has(channelId)) {
      ticketWarnedDB.add(channelId);
      channel
        .send('⚠️ This ticket has been inactive for 24 hours. It will auto-close in 1 hour without activity.')
        .catch(() => {});
    }
  }
}, 30 * 60 * 1000);

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.guild && automodDB.get(message.guild.id)) {
    const handled = await runAutomod(message).catch(() => false);
    if (handled) return;
  }

  if (message.guild && findTicketOwner(message.channelId)) {
    ticketActivityDB.set(message.channelId, Date.now());
  }

  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  try {
    if (command === 'help') handleHelp(message);
    else if (command === 'warn') handleWarn(message, args);
    else if (command === 'warnings') handleWarnings(message, args);
    else if (command === 'clearwarnings') handleClearWarnings(message, args);
    else if (command === 'delwarn') handleDelWarn(message, args);
    else if (command === 'history') handleHistory(message, args);
    else if (command === 'kick') handleKick(message, args);
    else if (command === 'ban') handleBan(message, args);
    else if (command === 'unban') handleUnban(message, args);
    else if (command === 'softban') handleSoftban(message, args);
    else if (command === 'masskick') handleMassKick(message, args);
    else if (command === 'massban') handleMassBan(message, args);
    else if (command === 'mute') handleMute(message, args);
    else if (command === 'unmute') handleUnmute(message, args);
    else if (command === 'mutewarn') handleMuteWarn(message, args);
    else if (command === 'modlogs') handleModlogs(message, args);
    else if (command === 'timeouts') handleTimeouts(message);
    else if (command === 'purge') handlePurge(message, args);
    else if (command === 'slowmode') handleSlowmode(message, args);
    else if (command === 'lock') handleLock(message);
    else if (command === 'unlock') handleUnlock(message);
    else if (command === 'nickname') handleNickname(message, args);
    else if (command === 'role') handleRole(message, args);
    else if (command === 'automod') handleAutomod(message, args);
    else if (command === 'panel') handlePanel(message);
    else if (command === 'tokenpanel') handleTokenPanel(message);
    else if (command === 'close') handleCloseTicket(message, args);
    else if (command === 'adduser') handleAddUser(message, args);
    else if (command === 'removeuser') handleRemoveUser(message, args);
    else if (command === 'rename') handleRename(message, args);
    else if (command === 'transcript') handleTranscript(message, args);
    else if (command === 'logs') handleLogs(message, args);
    else if (command === 'priority') handlePriority(message, args);
    else if (command === 'claim') handleClaim(message);
    else if (command === 'ticketstats') handleTicketStats(message);
    else if (command === 'userinfo') handleUserinfo(message, args);
    else if (command === 'serverinfo') handleServerinfo(message);
    else if (command === 'avatar') handleAvatar(message, args);
    else if (command === 'stats') handleStats(message);
    else if (command === 'poll') handlePoll(message, args);
    else if (command === 'remindme') handleRemindMe(message, args);
    else if (command === 'giveaway') handleGiveaway(message, args);
    else if (command === 'eo') handleEmojiCopy(message, args);
    else if (command === 'config') handleConfig(message, args);
    else if (command === 'say') handleSay(message, args);
    else if (command === 'setup') handleSetup(message, args);
  } catch (error) {
    console.error(`Error executing command: ${error}`);
    message.reply('❌ Something went wrong executing that command.').catch(() => {});
  }
});

client.on('interactionCreate', async (interaction) => {
  const { user, guild } = interaction;

  if (interaction.isStringSelectMenu()) {
    const category = interaction.values[0];
    if (interaction.customId === 'ticket_select') {
      if (category === 'buy' || category === 'sell') {
        await showTicketDetailsModal(interaction, category);
      } else {
        await createTicketChannel(interaction, user, guild, category);
      }
    } else if (interaction.customId === 'tokenticket_select') {
      await createTokenTicketChannel(interaction, user, guild, category);
    } else if (interaction.customId === 'ticket_priority_select') {
      await handleTicketPrioritySelect(interaction);
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'ticket_rename_modal') {
      await handleTicketRenameModal(interaction);
    } else if (interaction.customId.startsWith('ticket_details_modal:')) {
      await handleTicketDetailsModal(interaction);
    }
    return;
  }

  if (!interaction.isButton()) return;

  if (interaction.customId === 'close_ticket') {
    await handleCloseTicket(interaction);
  } else if (interaction.customId === 'ticket_claim') {
    await handleTicketClaimButton(interaction);
  } else if (interaction.customId === 'ticket_rename') {
    await handleTicketRenameButton(interaction);
  } else if (interaction.customId === 'ticket_ping_owner') {
    await handleTicketPingOwnerButton(interaction);
  }
});

// ============ MODERATION COMMANDS ============

async function handleHelp(message) {
  const modEmbed = new EmbedBuilder()
    .setColor('#2f3136')
    .setTitle('📋 Moderation Commands')
    .addFields(
      { name: ',warn <user> [reason]', value: 'Warn a user', inline: true },
      { name: ',warnings <user>', value: 'Check warnings', inline: true },
      { name: ',clearwarnings <user>', value: 'Reset a user\'s warnings', inline: true },
      { name: ',delwarn <user> <#>', value: 'Remove a single warning', inline: true },
      { name: ',history <user> [page]', value: 'Full moderation history, paginated', inline: true },
      { name: ',kick <user> [reason]', value: 'Kick a user (with confirmation)', inline: true },
      { name: ',ban <user> [reason]', value: 'Ban a user (with confirmation)', inline: true },
      { name: ',unban <user_id>', value: 'Unban a user', inline: true },
      { name: ',softban <user> [reason]', value: 'Ban+unban to purge messages', inline: true },
      { name: ',masskick <user1> <user2>...', value: 'Kick multiple users', inline: true },
      { name: ',massban <user1> <user2>...', value: 'Ban multiple users', inline: true },
      { name: ',mute <user> <time>', value: 'Mute user (5m, 1h, etc)', inline: true },
      { name: ',unmute <user>', value: 'Unmute a user', inline: true },
      { name: ',mutewarn <user> [reason]', value: 'Warn a user quietly (DM only)', inline: true },
      { name: ',modlogs <user>', value: 'Full moderation history for a user', inline: true },
      { name: ',timeouts', value: 'List active mutes', inline: true },
      { name: ',purge <count>', value: 'Bulk-delete messages', inline: true },
      { name: ',slowmode <seconds>', value: 'Set channel slowmode', inline: true },
      { name: ',lock / ,unlock', value: 'Lock or unlock the channel', inline: true },
      { name: ',nickname <user> <name>', value: 'Force-change a nickname', inline: true },
      { name: ',role <add|remove> <user> <@role>', value: 'Add/remove a role', inline: true },
      { name: ',automod <on|off>', value: 'Toggle automod', inline: true },
      { name: ',automod exempt <#channel|here>', value: 'Toggle automod exemption for a channel', inline: true }
    );

  const ticketEmbed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🎫 Ticket Commands')
    .addFields(
      { name: ',panel', value: 'Create ticket panel', inline: true },
      { name: ',tokenpanel', value: 'Create Minecraft token purchase panel', inline: true },
      { name: ',close [reason]', value: 'Close current ticket', inline: true },
      { name: ',claim', value: 'Claim the current ticket as staff', inline: true },
      { name: ',adduser <user>', value: 'Add a user to the ticket', inline: true },
      { name: ',removeuser <user>', value: 'Remove a user from the ticket', inline: true },
      { name: ',rename <name>', value: 'Rename the ticket channel', inline: true },
      { name: ',priority <low|medium|high>', value: 'Tag the ticket\'s urgency', inline: true },
      { name: ',transcript', value: 'Export the current ticket\'s history', inline: true },
      { name: ',transcript channel #channel', value: 'Set the channel where closed tickets auto-log', inline: true },
      { name: ',ticketstats', value: 'Ticket volume & average close time', inline: true }
    );

  const utilEmbed = new EmbedBuilder()
    .setColor('#43B581')
    .setTitle('🛠️ Utility Commands')
    .addFields(
      { name: ',userinfo [user]', value: 'View user info', inline: true },
      { name: ',serverinfo', value: 'View server info', inline: true },
      { name: ',avatar [user]', value: 'View an avatar full-size', inline: true },
      { name: ',stats', value: 'Bot uptime & ping', inline: true },
      { name: ',poll <question> | <opt1> | <opt2>', value: 'Reaction poll (up to 10 options)', inline: true },
      { name: ',remindme <time> <text>', value: 'DM you a reminder later', inline: true },
      { name: ',giveaway <start|end|reroll|list>', value: 'Run a reaction giveaway', inline: true },
      { name: ',eo <emoji> [name]', value: 'Copy an emoji into this server', inline: true },
      { name: ',config view', value: 'View server config (staff role, ticket category)', inline: true },
      { name: ',logs channel #channel', value: 'Log message edits/deletes there', inline: true },
      { name: ',say <text>', value: 'Post a message as the bot', inline: true },
      { name: ',setup @StaffRole [#Category]', value: 'One-command ticket system setup', inline: true }
    )
    .setFooter({ text: 'Prefix: ,' });

  message.reply({ embeds: [modEmbed, ticketEmbed, utilEmbed] });
}

async function handleWarn(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return message.reply('❌ You need moderation permissions.');
  }

  const user = message.mentions.users.first();
  if (!user) return message.reply('❌ Specify a user to warn.');

  const reason = args.slice(1).join(' ') || 'No reason provided';
  const userId = user.id;

  if (!warningsDB.has(userId)) warningsDB.set(userId, []);
  warningsDB.get(userId).push({ reason, timestamp: Date.now(), moderator: message.author.tag });
  markDirty();
  logModAction(userId, 'Warn', reason, message.author.tag);

  const warnCount = warningsDB.get(userId).length;

  const embed = new EmbedBuilder()
    .setColor('#FFA500')
    .setTitle('⚠️ User Warned')
    .addFields(
      { name: 'User', value: `${user.tag}`, inline: true },
      { name: 'Reason', value: reason, inline: true },
      { name: 'Warnings', value: `${warnCount}`, inline: true }
    );

  message.reply({ embeds: [embed] });

  try {
    await user.send(`⚠️ You've been warned in ${message.guild.name} for: ${reason}`);
  } catch (e) {
    console.log('Could not DM user');
  }
}

async function handleWarnings(message, args) {
  const user = message.mentions.users.first();
  if (!user) return message.reply('❌ Specify a user.');

  const warnings = warningsDB.get(user.id) || [];
  if (warnings.length === 0) return message.reply(`✅ ${user.tag} has no warnings.`);

  let warningList = warnings.map((w, i) => `**${i + 1}.** ${w.reason} (by ${w.moderator})`).join('\n');

  const embed = new EmbedBuilder()
    .setColor('#FFA500')
    .setTitle(`⚠️ Warnings for ${user.tag}`)
    .setDescription(warningList);

  message.reply({ embeds: [embed] });
}

async function handleClearWarnings(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return message.reply('❌ You need moderation permissions.');
  }

  const user = message.mentions.users.first();
  if (!user) return message.reply('❌ Specify a user.');

  const hadWarnings = (warningsDB.get(user.id) || []).length > 0;
  warningsDB.delete(user.id);
  markDirty();

  if (!hadWarnings) return message.reply(`✅ ${user.tag} had no warnings.`);
  message.reply(`✅ Cleared all warnings for ${user.tag}.`);
}

async function handleDelWarn(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return message.reply('❌ You need moderation permissions.');
  }

  const user = message.mentions.users.first();
  const index = parseInt(args[1], 10);
  if (!user || !index) {
    return message.reply('❌ Usage: `,delwarn <user> <warning#>` (see `,warnings <user>` for numbers)');
  }

  const warnings = warningsDB.get(user.id) || [];
  if (index < 1 || index > warnings.length) return message.reply('❌ Invalid warning number.');

  const [removed] = warnings.splice(index - 1, 1);
  warningsDB.set(user.id, warnings);
  markDirty();

  message.reply(`✅ Removed warning #${index} for ${user.tag}: "${removed.reason}"`);
}

async function handleHistory(message, args) {
  const user = message.mentions.users.first();
  if (!user) return message.reply('❌ Specify a user.');

  const logs = modLogsDB.get(user.id) || [];
  if (logs.length === 0) return message.reply(`✅ ${user.tag} has no moderation history.`);

  const page = Math.max(1, parseInt(args[1], 10) || 1);
  const perPage = 10;
  const totalPages = Math.ceil(logs.length / perPage);
  const pageLogs = logs.slice((page - 1) * perPage, page * perPage);

  const list = pageLogs
    .map((l, i) => `**${(page - 1) * perPage + i + 1}.** [${l.type}] ${l.reason} — by ${l.moderator} (<t:${Math.floor(l.timestamp / 1000)}:R>)`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor('#2f3136')
    .setTitle(`📁 History for ${user.tag}`)
    .setDescription(list)
    .setFooter({ text: `Page ${page}/${totalPages} — ,history @user <page>` });

  message.reply({ embeds: [embed] });
}

async function handleKick(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) {
    return message.reply('❌ You need kick permissions.');
  }

  const user = message.mentions.users.first();
  if (!user) return message.reply('❌ Specify a user.');

  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return message.reply('❌ User not found.');

  const reason = args.slice(1).join(' ') || 'No reason';

  const confirmed = await confirmAction(message, `⚠️ Confirm kicking **${user.tag}** for: ${reason}`);
  if (!confirmed) return message.reply('❌ Kick cancelled.');

  await member.kick(reason).catch((e) => {
    message.reply(`❌ Could not kick: ${e.message}`);
  });
  logModAction(user.id, 'Kick', reason, message.author.tag);

  const embed = new EmbedBuilder()
    .setColor('#FF0000')
    .setTitle('👢 User Kicked')
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${user.tag}`, inline: true },
      { name: 'User ID', value: user.id, inline: true },
      { name: 'Moderator', value: message.author.tag, inline: true },
      { name: 'Reason', value: reason, inline: false }
    )
    .setTimestamp();

  message.channel.send({ embeds: [embed] });
}

async function handleBan(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) {
    return message.reply('❌ You need ban permissions.');
  }

  const user = message.mentions.users.first();
  if (!user) return message.reply('❌ Specify a user.');

  const reason = args.slice(1).join(' ') || 'No reason provided';

  const confirmed = await confirmAction(message, `⚠️ Confirm banning **${user.tag}** for: ${reason}`);
  if (!confirmed) return message.reply('❌ Ban cancelled.');

  let dmSent = true;
  try {
    await user.send(`🔨 You have been banned from **${message.guild.name}** for: ${reason}`);
  } catch (e) {
    dmSent = false;
  }

  await message.guild.bans.create(user.id, { reason }).catch((e) => {
    message.reply(`❌ Could not ban: ${e.message}`);
  });
  logModAction(user.id, 'Ban', reason, message.author.tag);

  const embed = new EmbedBuilder()
    .setColor('#8B0000')
    .setTitle('🔨 User Banned')
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${user.tag}`, inline: true },
      { name: 'User ID', value: user.id, inline: true },
      { name: 'Moderator', value: message.author.tag, inline: true },
      { name: 'Notified', value: dmSent ? '✅ DM sent' : '⚠️ Could not DM user', inline: true },
      { name: 'Reason', value: reason, inline: false }
    )
    .setTimestamp();

  message.channel.send({ embeds: [embed] });
}

async function handleUnban(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) {
    return message.reply('❌ You need ban permissions.');
  }

  const userId = args[0];
  if (!userId || !/^\d{17,20}$/.test(userId)) {
    return message.reply('❌ Usage: `,unban <user_id>`');
  }

  const ban = await message.guild.bans.fetch(userId).catch(() => null);
  if (!ban) return message.reply('❌ That user is not banned.');

  await message.guild.bans.remove(userId, `Unbanned by ${message.author.tag}`).catch((e) => {
    message.reply(`❌ Could not unban: ${e.message}`);
  });
  logModAction(userId, 'Unban', 'N/A', message.author.tag);

  const embed = new EmbedBuilder()
    .setColor('#43B581')
    .setTitle('✅ User Unbanned')
    .setThumbnail(ban.user.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${ban.user.tag}`, inline: true },
      { name: 'User ID', value: userId, inline: true },
      { name: 'Moderator', value: message.author.tag, inline: true }
    )
    .setTimestamp();

  message.reply({ embeds: [embed] });
}

async function handleSoftban(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) {
    return message.reply('❌ You need ban permissions.');
  }

  const user = message.mentions.users.first();
  if (!user) return message.reply('❌ Specify a user.');

  const reason = args.slice(1).join(' ') || 'No reason provided';

  await message.guild.bans.create(user.id, { reason, deleteMessageSeconds: 86400 }).catch((e) => {
    message.reply(`❌ Could not softban: ${e.message}`);
  });
  await message.guild.bans.remove(user.id).catch((e) => {
    message.reply(`❌ Could not complete softban unban step: ${e.message}`);
  });
  logModAction(user.id, 'Softban', reason, message.author.tag);

  const embed = new EmbedBuilder()
    .setColor('#8B0000')
    .setTitle('🔨 User Softbanned')
    .setThumbnail(user.displayAvatarURL())
    .setDescription('Last 24h of their messages were purged. They are not permanently banned.')
    .addFields(
      { name: 'User', value: `${user.tag}`, inline: true },
      { name: 'User ID', value: user.id, inline: true },
      { name: 'Moderator', value: message.author.tag, inline: true },
      { name: 'Reason', value: reason, inline: false }
    )
    .setTimestamp();

  message.reply({ embeds: [embed] });
}

async function handleMassKick(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) {
    return message.reply('❌ You need kick permissions.');
  }

  const users = Array.from(message.mentions.users.values());
  if (users.length === 0) return message.reply('❌ Mention at least one user.');

  const results = [];
  for (const user of users) {
    try {
      const member = await message.guild.members.fetch(user.id);
      await member.kick('Mass kick');
      logModAction(user.id, 'Kick', 'Mass kick', message.author.tag);
      results.push(`✅ ${user.tag}`);
    } catch (e) {
      results.push(`❌ ${user.tag} — ${e.message}`);
    }
  }

  message.reply(`👢 Mass kick results:\n${results.join('\n')}`);
}

async function handleMassBan(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) {
    return message.reply('❌ You need ban permissions.');
  }

  const users = Array.from(message.mentions.users.values());
  if (users.length === 0) return message.reply('❌ Mention at least one user.');

  const results = [];
  for (const user of users) {
    try {
      await message.guild.bans.create(user.id, { reason: 'Mass ban' });
      logModAction(user.id, 'Ban', 'Mass ban', message.author.tag);
      results.push(`✅ ${user.tag}`);
    } catch (e) {
      results.push(`❌ ${user.tag} — ${e.message}`);
    }
  }

  message.reply(`🔨 Mass ban results:\n${results.join('\n')}`);
}

async function handleMute(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return message.reply('❌ You need moderation permissions.');
  }

  const user = message.mentions.users.first();
  const time = args[1];

  if (!user || !time) return message.reply('❌ Usage: ,mute <user> <time> (5m, 1h, 1d)');

  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return message.reply('❌ User not found.');

  const timeMs = parseTime(time);
  if (!timeMs) return message.reply('❌ Invalid time format.');

  await member.timeout(timeMs, `Muted by ${message.author.tag}`).catch((e) => {
    message.reply(`❌ Could not mute: ${e.message}`);
  });
  logModAction(user.id, 'Mute', `Duration: ${time}`, message.author.tag);

  const expiresAt = Math.floor((Date.now() + timeMs) / 1000);
  const embed = new EmbedBuilder()
    .setColor('#FFA500')
    .setTitle('🔇 User Muted')
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${user.tag}`, inline: true },
      { name: 'User ID', value: user.id, inline: true },
      { name: 'Moderator', value: message.author.tag, inline: true },
      { name: 'Duration', value: time, inline: true },
      { name: 'Expires', value: `<t:${expiresAt}:R>`, inline: true }
    )
    .setTimestamp();

  message.reply({ embeds: [embed] });
}

async function handleUnmute(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return message.reply('❌ You need moderation permissions.');
  }

  const user = message.mentions.users.first();
  if (!user) return message.reply('❌ Specify a user.');

  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return message.reply('❌ User not found.');

  await member.timeout(null).catch((e) => {
    message.reply(`❌ Could not unmute: ${e.message}`);
  });

  message.reply(`🔊 ${user.tag} has been unmuted.`);
}

async function handleMuteWarn(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return message.reply('❌ You need moderation permissions.');
  }

  const user = message.mentions.users.first();
  if (!user) return message.reply('❌ Specify a user to warn.');

  const reason = args.slice(1).join(' ') || 'No reason provided';

  if (!warningsDB.has(user.id)) warningsDB.set(user.id, []);
  warningsDB.get(user.id).push({ reason, timestamp: Date.now(), moderator: message.author.tag });
  markDirty();
  logModAction(user.id, 'Warn (quiet)', reason, message.author.tag);

  let dmSent = true;
  try {
    await user.send(`⚠️ You've been warned in ${message.guild.name} for: ${reason}`);
  } catch (e) {
    dmSent = false;
  }

  await message.react(dmSent ? '✅' : '⚠️').catch(() => {});
}

async function handleModlogs(message, args) {
  const user = message.mentions.users.first();
  if (!user) return message.reply('❌ Specify a user.');

  const logs = modLogsDB.get(user.id) || [];
  if (logs.length === 0) return message.reply(`✅ ${user.tag} has no moderation history.`);

  const logList = logs
    .map((l, i) => `**${i + 1}.** [${l.type}] ${l.reason} — by ${l.moderator} (<t:${Math.floor(l.timestamp / 1000)}:R>)`)
    .join('\n')
    .slice(0, 4000);

  const embed = new EmbedBuilder()
    .setColor('#2f3136')
    .setTitle(`📁 Moderation History for ${user.tag}`)
    .setDescription(logList);

  message.reply({ embeds: [embed] });
}

async function handleTimeouts(message) {
  if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return message.reply('❌ You need moderation permissions.');
  }

  await message.guild.members.fetch().catch(() => {});
  const now = Date.now();
  const active = message.guild.members.cache.filter(
    (m) => m.communicationDisabledUntilTimestamp && m.communicationDisabledUntilTimestamp > now
  );

  if (active.size === 0) return message.reply('✅ No active mutes.');

  const list = active
    .map((m) => `${m.user.tag} — expires <t:${Math.floor(m.communicationDisabledUntilTimestamp / 1000)}:R>`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor('#FFA500')
    .setTitle('🔇 Active Mutes')
    .setDescription(list);

  message.reply({ embeds: [embed] });
}

async function handlePurge(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
    return message.reply('❌ You need Manage Messages permission.');
  }

  const count = parseInt(args[0], 10);
  if (!count || count < 1 || count > 100) {
    return message.reply('❌ Usage: `,purge <count>` (1-100)');
  }

  const deleted = await message.channel.bulkDelete(count + 1, true).catch((e) => {
    message.reply(`❌ Could not purge: ${e.message}`);
    return null;
  });

  if (!deleted) return;

  const notice = await message.channel.send(`🧹 Deleted ${deleted.size - 1} messages.`).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), 5000);
}

async function handleSlowmode(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return message.reply('❌ You need Manage Channels permission.');
  }

  const seconds = parseInt(args[0], 10);
  if (isNaN(seconds) || seconds < 0 || seconds > 21600) {
    return message.reply('❌ Usage: `,slowmode <seconds>` (0-21600)');
  }

  await message.channel.setRateLimitPerUser(seconds).catch((e) => {
    message.reply(`❌ Could not set slowmode: ${e.message}`);
  });

  message.reply(seconds === 0 ? '✅ Slowmode disabled.' : `✅ Slowmode set to ${seconds}s.`);
}

async function handleLock(message) {
  if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return message.reply('❌ You need Manage Channels permission.');
  }

  await message.channel.permissionOverwrites.edit(message.guild.id, { SendMessages: false }).catch((e) => {
    message.reply(`❌ Could not lock channel: ${e.message}`);
  });

  message.reply('🔒 Channel locked.');
}

async function handleUnlock(message) {
  if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return message.reply('❌ You need Manage Channels permission.');
  }

  await message.channel.permissionOverwrites.edit(message.guild.id, { SendMessages: null }).catch((e) => {
    message.reply(`❌ Could not unlock channel: ${e.message}`);
  });

  message.reply('🔓 Channel unlocked.');
}

async function handleNickname(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ManageNicknames)) {
    return message.reply('❌ You need Manage Nicknames permission.');
  }

  const user = message.mentions.users.first();
  if (!user) return message.reply('❌ Usage: `,nickname <user> <name>`');

  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return message.reply('❌ User not found.');

  const newNick = args.slice(1).join(' ') || null;

  await member.setNickname(newNick).catch((e) => {
    message.reply(`❌ Could not change nickname: ${e.message}`);
  });

  message.reply(newNick ? `✅ Nickname for ${user.tag} set to **${newNick}**.` : `✅ Nickname for ${user.tag} reset.`);
}

async function handleRole(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return message.reply('❌ You need Manage Roles permission.');
  }

  const action = (args[0] || '').toLowerCase();
  if (action !== 'add' && action !== 'remove') {
    return message.reply('❌ Usage: `,role <add|remove> <user> <@role>`');
  }

  const user = message.mentions.users.first();
  const role = message.mentions.roles.first();
  if (!user || !role) return message.reply('❌ Usage: `,role <add|remove> <user> <@role>`');

  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return message.reply('❌ User not found.');

  if (action === 'add') {
    await member.roles.add(role).catch((e) => message.reply(`❌ Could not add role: ${e.message}`));
    message.reply(`✅ Added **${role.name}** to ${user.tag}.`);
  } else {
    await member.roles.remove(role).catch((e) => message.reply(`❌ Could not remove role: ${e.message}`));
    message.reply(`✅ Removed **${role.name}** from ${user.tag}.`);
  }
}

async function handleAutomod(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return message.reply('❌ Only admins can configure automod.');
  }

  const sub = (args[0] || '').toLowerCase();

  if (sub === 'on' || sub === 'off') {
    automodDB.set(message.guild.id, sub === 'on');
    markDirty();
    return message.reply(`✅ Automod is now **${sub === 'on' ? 'enabled' : 'disabled'}**.`);
  }

  if (sub === 'exempt') {
    const channel = message.mentions.channels.first() || (args[1] === 'here' ? message.channel : null);
    if (!channel) return message.reply('❌ Usage: `,automod exempt <#channel|here>`');

    const exemptSet = automodExemptDB.get(message.guild.id) || new Set();
    if (exemptSet.has(channel.id)) {
      exemptSet.delete(channel.id);
      automodExemptDB.set(message.guild.id, exemptSet);
      markDirty();
      return message.reply(`✅ ${channel} is no longer exempt from automod.`);
    }
    exemptSet.add(channel.id);
    automodExemptDB.set(message.guild.id, exemptSet);
    markDirty();
    return message.reply(`✅ ${channel} is now exempt from automod.`);
  }

  return message.reply('❌ Usage: `,automod <on|off>` or `,automod exempt <#channel|here>`');
}

async function runAutomod(message) {
  const exemptSet = automodExemptDB.get(message.guild.id);
  if (exemptSet && exemptSet.has(message.channel.id)) return false;

  const inviteRegex = /(discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i;
  const massMention = message.mentions.users.size + message.mentions.roles.size > 5;
  const hasInvite = inviteRegex.test(message.content);
  const contentLower = message.content.toLowerCase();
  const hasBadWord = BAD_WORDS.some((w) => contentLower.includes(w));

  let isSpam = false;
  const tracker = spamTrackerDB.get(message.author.id);
  if (tracker && tracker.content === message.content && Date.now() - tracker.last < 10000) {
    tracker.count += 1;
    tracker.last = Date.now();
    if (tracker.count >= 3) isSpam = true;
  } else {
    spamTrackerDB.set(message.author.id, { content: message.content, count: 1, last: Date.now() });
  }

  if (!massMention && !hasInvite && !hasBadWord && !isSpam) return false;

  const reason = isSpam
    ? 'Repeated spam messages'
    : massMention
    ? 'Mass mention spam'
    : hasInvite
    ? 'Posted an invite link'
    : 'Used a filtered word';

  await message.delete().catch(() => {});
  const notice = await message.channel.send(`🛡️ ${message.author}, your message was removed: ${reason}`).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), 5000);
  logModAction(message.author.id, 'Automod', reason, 'Automod');

  const violations = (automodViolationsDB.get(message.author.id) || []).filter((t) => Date.now() - t < 60000);
  violations.push(Date.now());
  automodViolationsDB.set(message.author.id, violations);

  if (violations.length >= 3) {
    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (member) {
      await member.timeout(10 * 60 * 1000, 'Repeated automod violations').catch(() => {});
      logModAction(message.author.id, 'Mute', 'Repeated automod violations (auto)', 'Automod');
      message.channel.send(`🔇 ${message.author} was timed out for repeated violations.`).catch(() => {});
    }
    automodViolationsDB.delete(message.author.id);
  }

  return true;
}

// ============ TICKET SYSTEM ============

const TICKET_CATEGORY_EMOJIS = { buy: '💰', sell: '📦', support: '🆘' };

async function handlePanel(message) {
  if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return message.reply('❌ Only admins can create the ticket panel.');
  }

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🎫 Support Tickets')
    .setDescription('Select a ticket type below to create a new ticket.')
    .setFooter({ text: 'Only you and staff can see your ticket' });

  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket_select')
    .setPlaceholder('Select a ticket type')
    .addOptions(
      { label: 'Buy', value: 'buy', emoji: TICKET_CATEGORY_EMOJIS.buy },
      { label: 'Sell', value: 'sell', emoji: TICKET_CATEGORY_EMOJIS.sell },
      { label: 'Support', value: 'support', emoji: TICKET_CATEGORY_EMOJIS.support }
    );

  const row = new ActionRowBuilder().addComponents(menu);

  await message.channel.send({ embeds: [embed], components: [row] });
  message.reply('✅ Panel created!').then(m => m.delete().catch(() => {}));
}

async function handleTokenPanel(message) {
  if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return message.reply('❌ Only admins can create the token panel.');
  }

  const embed = new EmbedBuilder()
    .setColor('#F1C40F')
    .setTitle('🪙 Buy Minecraft Tokens')
    .setDescription('Select an option below to open a ticket for your token purchase.')
    .setFooter({ text: 'Only you and staff can see your ticket' });

  const menu = new StringSelectMenuBuilder()
    .setCustomId('tokenticket_select')
    .setPlaceholder('Select a purchase type')
    .addOptions(
      { label: 'Buy 1 Token', value: 'single', emoji: '🪙' },
      { label: 'Buy Multiple Tokens', value: 'multi', emoji: '🪙' },
      { label: 'Bulk Buy', value: 'bulk', emoji: '📦' }
    );

  const row = new ActionRowBuilder().addComponents(menu);

  await message.channel.send({ embeds: [embed], components: [row] });
  message.reply('✅ Token panel created!').then(m => m.delete().catch(() => {}));
}

async function openTicketChannel(guild, user, { slug, label, description }) {
  const existingTicket = ticketsDB.get(user.id);
  if (existingTicket) {
    const channel = guild.channels.cache.get(existingTicket);
    if (channel) return { status: 'exists', channelId: existingTicket };
    ticketsDB.delete(user.id);
    markDirty();
  }

  const staffRoleId = getStaffRoleId(guild.id);
  const staffRole = guild.roles.cache.get(staffRoleId);
  if (!staffRole) return { status: 'no_staff_role' };

  const channel = await guild.channels.create({
    name: `${slug}-${user.username}`,
    type: ChannelType.GuildText,
    parent: getTicketsCategoryId(guild.id),
    permissionOverwrites: [
      {
        id: guild.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      },
      {
        id: staffRole.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      },
    ],
  });

  ticketsDB.set(user.id, channel.id);
  markDirty();

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle(`🎫 ${label}`)
    .setDescription(description || `Ticket created by ${user}\n\nStaff will be with you shortly. Use \`,close\` to close this ticket.`)
    .setTimestamp();

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim').setEmoji('🙋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ticket_rename').setLabel('Rename').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket_ping_owner').setLabel('Ping').setEmoji('📣').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
  );

  const priorityRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('ticket_priority_select')
      .setPlaceholder('Set priority')
      .addOptions(
        { label: 'Low', value: 'low', emoji: '🟢' },
        { label: 'Medium', value: 'medium', emoji: '🟡' },
        { label: 'High', value: 'high', emoji: '🔴' }
      )
  );

  await channel.send({
    content: `<@&${staffRoleId}>`,
    embeds: [embed],
    components: [actionRow, priorityRow],
    allowedMentions: { roles: [staffRoleId] },
  });

  bumpTicketStat(guild.id, 'opened');
  ticketActivityDB.set(channel.id, Date.now());

  return { status: 'created', channel };
}

async function createTicketChannel(interaction, user, guild, category) {
  await interaction.deferReply({ ephemeral: true });

  const emoji = TICKET_CATEGORY_EMOJIS[category] || '🎫';
  const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1);

  const result = await openTicketChannel(guild, user, { slug: `ticket-${category}`, label: `${emoji} ${categoryLabel} Ticket` }).catch((error) => {
    console.error('Error creating ticket:', error);
    return { status: 'error' };
  });

  if (result.status === 'exists') return interaction.editReply(`❌ You already have an open ticket: <#${result.channelId}>`);
  if (result.status === 'no_staff_role') return interaction.editReply('❌ Staff role not configured.');
  if (result.status === 'error') return interaction.editReply('❌ Could not create ticket.');

  await interaction.editReply(`✅ Ticket created: <#${result.channel.id}>`);
}

async function showTicketDetailsModal(interaction, category) {
  const emoji = TICKET_CATEGORY_EMOJIS[category] || '🎫';
  const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1);

  const modal = new ModalBuilder()
    .setCustomId(`ticket_details_modal:${category}`)
    .setTitle(`${emoji} ${categoryLabel} Ticket`);

  const qtyInput = new TextInputBuilder()
    .setCustomId('token_qty')
    .setLabel('How many tokens?')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(50);

  const moneyInput = new TextInputBuilder()
    .setCustomId('money_amount')
    .setLabel(category === 'buy' ? 'How much money are you spending?' : 'How much money do you want?')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(50);

  const methodInput = new TextInputBuilder()
    .setCustomId('payment_method')
    .setLabel('Payment method (PayPal, CashApp, etc)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(50);

  modal.addComponents(
    new ActionRowBuilder().addComponents(qtyInput),
    new ActionRowBuilder().addComponents(moneyInput),
    new ActionRowBuilder().addComponents(methodInput)
  );

  await interaction.showModal(modal);
}

async function handleTicketDetailsModal(interaction) {
  const category = interaction.customId.split(':')[1];
  const tokenQty = interaction.fields.getTextInputValue('token_qty');
  const moneyAmount = interaction.fields.getTextInputValue('money_amount');
  const paymentMethod = interaction.fields.getTextInputValue('payment_method');

  await interaction.deferReply({ ephemeral: true });

  const emoji = TICKET_CATEGORY_EMOJIS[category] || '🎫';
  const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1);

  const description = [
    `Ticket created by ${interaction.user}`,
    '',
    `**Tokens:** ${tokenQty}`,
    `**Money:** ${moneyAmount}`,
    `**Payment Method:** ${paymentMethod}`,
    '',
    'Staff will be with you shortly. Use `,close` to close this ticket.',
  ].join('\n');

  const result = await openTicketChannel(interaction.guild, interaction.user, {
    slug: `ticket-${category}`,
    label: `${emoji} ${categoryLabel} Ticket`,
    description,
  }).catch((error) => {
    console.error('Error creating ticket:', error);
    return { status: 'error' };
  });

  if (result.status === 'exists') return interaction.editReply(`❌ You already have an open ticket: <#${result.channelId}>`);
  if (result.status === 'no_staff_role') return interaction.editReply('❌ Staff role not configured.');
  if (result.status === 'error') return interaction.editReply('❌ Could not create ticket.');

  await interaction.editReply(`✅ Ticket created: <#${result.channel.id}>`);
}

const TOKEN_TICKET_TYPES = {
  single: { slug: 'token-single', label: '🪙 Buy 1 Token' },
  multi: { slug: 'token-multi', label: '🪙 Buy Multiple Tokens' },
  bulk: { slug: 'token-bulk', label: '📦 Bulk Buy Tokens' },
};

async function createTokenTicketChannel(interaction, user, guild, category) {
  await interaction.deferReply({ ephemeral: true });

  const type = TOKEN_TICKET_TYPES[category] || { slug: 'token', label: '🪙 Token Purchase' };
  const result = await openTicketChannel(guild, user, type).catch((error) => {
    console.error('Error creating token ticket:', error);
    return { status: 'error' };
  });

  if (result.status === 'exists') return interaction.editReply(`❌ You already have an open ticket: <#${result.channelId}>`);
  if (result.status === 'no_staff_role') return interaction.editReply('❌ Staff role not configured.');
  if (result.status === 'error') return interaction.editReply('❌ Could not create ticket.');

  await interaction.editReply(`✅ Ticket created: <#${result.channel.id}>`);
}

async function generateTranscriptBuffer(channel) {
  const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!fetched) return null;

  const sorted = Array.from(fetched.values()).reverse();
  const lines = sorted.map((m) => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content}`);
  return Buffer.from(lines.join('\n') || 'No messages.', 'utf-8');
}

async function dmTicketClosedNotice(guild, userId, reason, transcriptUrl, transcriptBuffer, channelName) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return;

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🎫 Your Ticket Has Been Closed')
    .setDescription(`Your ticket in **${guild.name}** has been closed.`)
    .addFields(
      { name: 'Reason', value: reason || 'No reason provided.' },
      { name: 'Transcript', value: transcriptUrl ? `[View Transcript](${transcriptUrl})` : 'Attached below.' }
    )
    .setTimestamp();

  const payload = { embeds: [embed] };
  if (!transcriptUrl && transcriptBuffer) {
    payload.files = [new AttachmentBuilder(transcriptBuffer, { name: `transcript-${channelName}.txt` })];
  }

  await user.send(payload).catch(() => {});
}

async function closeTicketChannel(channel, userId, closedByTag, reason) {
  const durationMs = Date.now() - channel.createdTimestamp;
  bumpTicketStat(channel.guild.id, 'closed', durationMs);

  const buffer = await generateTranscriptBuffer(channel);
  let transcriptUrl = null;

  const logChannelId = transcriptChannelDB.get(channel.guild.id);
  const logChannel = logChannelId ? channel.guild.channels.cache.get(logChannelId) : null;

  if (logChannel && buffer) {
    const attachment = new AttachmentBuilder(buffer, { name: `transcript-${channel.name}.txt` });
    const sent = await logChannel
      .send({ content: `📄 Transcript for **${channel.name}** (closed by ${closedByTag})`, files: [attachment] })
      .catch(() => null);
    if (sent) transcriptUrl = sent.url;
  }

  await dmTicketClosedNotice(channel.guild, userId, reason, transcriptUrl, buffer, channel.name);

  ticketsDB.delete(userId);
  ticketPriorityDB.delete(channel.id);
  ticketClaimDB.delete(channel.id);
  ticketActivityDB.delete(channel.id);
  ticketWarnedDB.delete(channel.id);
  markDirty();

  setTimeout(() => {
    channel.delete().catch(() => {});
  }, 5000);
}

async function handleCloseTicket(messageOrInteraction, args) {
  const channelId = messageOrInteraction.channelId;
  const userId = findTicketOwner(channelId);

  if (!userId) {
    const reply = messageOrInteraction.reply.bind(messageOrInteraction);
    return reply({ content: '❌ This is not a ticket channel.', ephemeral: true }).catch(() => reply('❌ This is not a ticket channel.'));
  }

  const authorTag = messageOrInteraction.author?.tag || messageOrInteraction.user?.tag || 'a staff member';
  const reason = args && args.length > 0 ? args.join(' ') : null;

  const embed = new EmbedBuilder()
    .setColor('#FF0000')
    .setTitle('🎫 Ticket Closed')
    .setDescription(`This ticket has been closed by ${authorTag}.\nChannel will be deleted in 5 seconds.`);

  if (messageOrInteraction.reply) {
    await messageOrInteraction.reply({ embeds: [embed] }).catch(() => {});
  }

  await closeTicketChannel(messageOrInteraction.channel, userId, authorTag, reason);
}

async function handleAddUser(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return message.reply('❌ You need moderation permissions.');
  }

  const ownerId = findTicketOwner(message.channelId);
  if (!ownerId) return message.reply('❌ This is not a ticket channel.');

  const user = message.mentions.users.first();
  if (!user) return message.reply('❌ Specify a user to add.');

  await message.channel.permissionOverwrites.edit(user.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  }).catch((e) => {
    message.reply(`❌ Could not add user: ${e.message}`);
  });

  message.reply(`✅ Added ${user.tag} to this ticket.`);
}

async function handleRemoveUser(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return message.reply('❌ You need moderation permissions.');
  }

  const ownerId = findTicketOwner(message.channelId);
  if (!ownerId) return message.reply('❌ This is not a ticket channel.');

  const user = message.mentions.users.first();
  if (!user) return message.reply('❌ Specify a user to remove.');
  if (user.id === ownerId) return message.reply('❌ Cannot remove the ticket owner.');

  await message.channel.permissionOverwrites.delete(user.id).catch((e) => {
    message.reply(`❌ Could not remove user: ${e.message}`);
  });

  message.reply(`✅ Removed ${user.tag} from this ticket.`);
}

async function handleRename(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return message.reply('❌ You need moderation permissions.');
  }

  const ownerId = findTicketOwner(message.channelId);
  if (!ownerId) return message.reply('❌ This is not a ticket channel.');

  const newName = args.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!newName) return message.reply('❌ Usage: `,rename <name>`');

  await message.channel.setName(newName).catch((e) => {
    message.reply(`❌ Could not rename channel: ${e.message}`);
  });

  message.reply(`✅ Ticket renamed to **${newName}**.`);
}

function buildPriorityAnnouncement(level) {
  const colors = { low: '#43B581', medium: '#FAA61A', high: '#F04747' };
  const emojis = { low: '🟢', medium: '🟡', high: '🔴' };
  return new EmbedBuilder().setColor(colors[level]).setDescription(`${emojis[level]} Priority set to **${level.toUpperCase()}**`);
}

async function handlePriority(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return message.reply('❌ You need moderation permissions.');
  }

  const ownerId = findTicketOwner(message.channelId);
  if (!ownerId) return message.reply('❌ This is not a ticket channel.');

  const level = (args[0] || '').toLowerCase();
  if (!['low', 'medium', 'high'].includes(level)) {
    return message.reply('❌ Usage: `,priority <low|medium|high>`');
  }

  ticketPriorityDB.set(message.channelId, level);
  markDirty();
  await message.channel.setTopic(`Priority: ${level}`).catch(() => {});

  message.reply({ embeds: [buildPriorityAnnouncement(level)] });
}

async function handleTicketPrioritySelect(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return interaction.reply({ content: '❌ You need moderation permissions.', ephemeral: true });
  }

  const ownerId = findTicketOwner(interaction.channelId);
  if (!ownerId) return interaction.reply({ content: '❌ This is not a ticket channel.', ephemeral: true });

  const level = interaction.values[0];
  ticketPriorityDB.set(interaction.channelId, level);
  markDirty();
  await interaction.channel.setTopic(`Priority: ${level}`).catch(() => {});

  await interaction.reply({ embeds: [buildPriorityAnnouncement(level)] });
}

async function handleTranscript(message, args) {
  if ((args[0] || '').toLowerCase() === 'channel') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      return message.reply('❌ You need moderation permissions.');
    }
    const channel = message.mentions.channels.first();
    if (!channel) return message.reply('❌ Usage: `,transcript channel #channel`');

    transcriptChannelDB.set(message.guild.id, channel.id);
    markDirty();
    return message.reply(`✅ Ticket transcripts will now be logged to ${channel} when a ticket closes.`);
  }

  const ownerId = findTicketOwner(message.channelId);
  if (!ownerId) return message.reply('❌ This is not a ticket channel.');

  const buffer = await generateTranscriptBuffer(message.channel);
  if (!buffer) return message.reply('❌ Could not fetch messages.');

  const attachment = new AttachmentBuilder(buffer, { name: `transcript-${message.channel.name}.txt` });
  await message.channel.send({ content: '📄 Ticket transcript:', files: [attachment] });
}

async function claimTicket(guild, channelId, actingUser) {
  const ownerId = findTicketOwner(channelId);
  if (!ownerId) return { status: 'not_ticket' };

  if (ticketClaimDB.has(channelId)) {
    const claimerId = ticketClaimDB.get(channelId);
    if (claimerId === actingUser.id) return { status: 'already_you' };
    const claimer = await guild.members.fetch(claimerId).catch(() => null);
    return { status: 'already_other', claimerTag: claimer ? claimer.user.tag : 'another staff member' };
  }

  ticketClaimDB.set(channelId, actingUser.id);
  markDirty();
  const channel = guild.channels.cache.get(channelId);
  if (channel) await channel.setTopic(`Claimed by ${actingUser.tag}`).catch(() => {});

  return { status: 'claimed' };
}

async function handleClaim(message) {
  if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return message.reply('❌ You need moderation permissions.');
  }

  const result = await claimTicket(message.guild, message.channelId, message.author);
  if (result.status === 'not_ticket') return message.reply('❌ This is not a ticket channel.');
  if (result.status === 'already_you') return message.reply('✅ You already claimed this ticket.');
  if (result.status === 'already_other') return message.reply(`❌ Already claimed by ${result.claimerTag}.`);

  message.reply(`🙋 ${message.author.tag} claimed this ticket.`);
}

async function handleTicketClaimButton(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return interaction.reply({ content: '❌ You need moderation permissions.', ephemeral: true });
  }

  const result = await claimTicket(interaction.guild, interaction.channelId, interaction.user);
  if (result.status === 'not_ticket') return interaction.reply({ content: '❌ This is not a ticket channel.', ephemeral: true });
  if (result.status === 'already_you') return interaction.reply({ content: '✅ You already claimed this ticket.', ephemeral: true });
  if (result.status === 'already_other') return interaction.reply({ content: `❌ Already claimed by ${result.claimerTag}.`, ephemeral: true });

  await interaction.reply(`🙋 ${interaction.user.tag} claimed this ticket.`);
}

async function handleTicketRenameButton(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return interaction.reply({ content: '❌ You need moderation permissions.', ephemeral: true });
  }

  const ownerId = findTicketOwner(interaction.channelId);
  if (!ownerId) return interaction.reply({ content: '❌ This is not a ticket channel.', ephemeral: true });

  const modal = new ModalBuilder().setCustomId('ticket_rename_modal').setTitle('Rename Ticket');
  const input = new TextInputBuilder()
    .setCustomId('new_name')
    .setLabel('New channel name')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(90);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleTicketRenameModal(interaction) {
  const ownerId = findTicketOwner(interaction.channelId);
  if (!ownerId) return interaction.reply({ content: '❌ This is not a ticket channel.', ephemeral: true });

  const newName = interaction.fields.getTextInputValue('new_name').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!newName) return interaction.reply({ content: '❌ Invalid name.', ephemeral: true });

  await interaction.channel.setName(newName).catch(() => {});
  await interaction.reply(`✅ Ticket renamed to **${newName}**.`);
}

async function handleTicketPingOwnerButton(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return interaction.reply({ content: '❌ You need moderation permissions.', ephemeral: true });
  }

  const ownerId = findTicketOwner(interaction.channelId);
  if (!ownerId) return interaction.reply({ content: '❌ This is not a ticket channel.', ephemeral: true });

  await interaction.reply({ content: `<@${ownerId}>`, allowedMentions: { users: [ownerId] } });
}

async function handleTicketStats(message) {
  const stats = ticketStatsDB.get(message.guild.id) || { opened: 0, closed: 0, totalCloseMs: 0 };
  const avgMs = stats.closed > 0 ? stats.totalCloseMs / stats.closed : 0;
  const avgMinutes = Math.round(avgMs / 60000);

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🎫 Ticket Stats')
    .addFields(
      { name: 'Opened', value: `${stats.opened}`, inline: true },
      { name: 'Closed', value: `${stats.closed}`, inline: true },
      { name: 'Avg Close Time', value: stats.closed > 0 ? `${avgMinutes}m` : 'N/A', inline: true }
    );

  message.reply({ embeds: [embed] });
}

// ============ UTILITY COMMANDS ============

async function handleUserinfo(message, args) {
  const user = message.mentions.users.first() || message.author;
  const member = await message.guild.members.fetch(user.id).catch(() => null);
  const warnCount = (warningsDB.get(user.id) || []).length;
  const roles = member
    ? member.roles.cache.filter((r) => r.id !== message.guild.id).map((r) => r.toString()).join(', ') || 'None'
    : 'N/A';

  const embed = new EmbedBuilder()
    .setColor('#2f3136')
    .setTitle(`👤 ${user.tag}`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'User ID', value: user.id, inline: true },
      { name: 'Account Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:D>`, inline: true },
      { name: 'Joined Server', value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>` : 'N/A', inline: true },
      { name: 'Warnings', value: `${warnCount}`, inline: true },
      { name: 'Roles', value: roles, inline: false }
    );

  message.reply({ embeds: [embed] });
}

async function handleServerinfo(message) {
  const guild = message.guild;
  const owner = await guild.fetchOwner().catch(() => null);

  const embed = new EmbedBuilder()
    .setColor('#2f3136')
    .setTitle(`🏠 ${guild.name}`)
    .setThumbnail(guild.iconURL())
    .addFields(
      { name: 'Server ID', value: guild.id, inline: true },
      { name: 'Owner', value: owner ? owner.user.tag : 'Unknown', inline: true },
      { name: 'Members', value: `${guild.memberCount}`, inline: true },
      { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true },
      { name: 'Boost Tier', value: `${guild.premiumTier}`, inline: true },
      { name: 'Boosts', value: `${guild.premiumSubscriptionCount || 0}`, inline: true }
    );

  message.reply({ embeds: [embed] });
}

async function handleAvatar(message, args) {
  const user = message.mentions.users.first() || message.author;

  const embed = new EmbedBuilder()
    .setColor('#2f3136')
    .setTitle(`${user.tag}'s Avatar`)
    .setImage(user.displayAvatarURL({ size: 1024 }));

  message.reply({ embeds: [embed] });
}

async function handleStats(message) {
  const uptimeSec = Math.floor(client.uptime / 1000);
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;

  const embed = new EmbedBuilder()
    .setColor('#2f3136')
    .setTitle('📊 Bot Stats')
    .addFields(
      { name: 'Uptime', value: `${h}h ${m}m ${s}s`, inline: true },
      { name: 'Servers', value: `${client.guilds.cache.size}`, inline: true },
      { name: 'Ping', value: `${client.ws.ping}ms`, inline: true }
    );

  message.reply({ embeds: [embed] });
}

async function handlePoll(message, args) {
  const parts = args
    .join(' ')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length < 2) {
    return message.reply('❌ Usage: `,poll <question> | <option1> | <option2> ...` (up to 10 options)');
  }

  const question = parts[0];
  const options = parts.slice(1, 11);
  const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  const description = options.map((o, i) => `${numberEmojis[i]} ${o}`).join('\n');

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle(`📊 ${question}`)
    .setDescription(description)
    .setFooter({ text: `Poll by ${message.author.tag}` });

  const pollMessage = await message.channel.send({ embeds: [embed] });
  for (let i = 0; i < options.length; i++) {
    await pollMessage.react(numberEmojis[i]).catch(() => {});
  }

  message.delete().catch(() => {});
}

async function handleRemindMe(message, args) {
  const time = args[0];
  const text = args.slice(1).join(' ');

  if (!time || !text) return message.reply('❌ Usage: `,remindme <time> <text>` (e.g. 10m, 1h, 1d)');

  const ms = parseTime(time);
  if (!ms) return message.reply('❌ Invalid time format.');

  const id = `${message.author.id}-${Date.now()}`;
  const fireAt = Date.now() + ms;
  const reminder = { userId: message.author.id, text, fireAt };

  remindersDB.set(id, reminder);
  markDirty();
  scheduleReminder(id, reminder);

  message.reply(`⏰ I'll remind you <t:${Math.floor(fireAt / 1000)}:R>.`);
}

async function handleLogs(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return message.reply('❌ Only admins can configure logs.');
  }

  const sub = (args[0] || '').toLowerCase();
  if (sub !== 'channel') return message.reply('❌ Usage: `,logs channel #channel`');

  const channel = message.mentions.channels.first();
  if (!channel) return message.reply('❌ Usage: `,logs channel #channel`');

  messageLogChannelDB.set(message.guild.id, channel.id);
  markDirty();
  message.reply(`✅ Message edits and deletes will now be logged to ${channel}.`);
}

async function handleConfig(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return message.reply('❌ Only admins can change config.');
  }

  const sub = (args[0] || '').toLowerCase();
  const guildId = message.guild.id;
  const config = guildConfigDB.get(guildId) || {};

  if (sub === 'view') {
    const embed = new EmbedBuilder()
      .setColor('#2f3136')
      .setTitle('⚙️ Server Config')
      .addFields(
        { name: 'Staff Role', value: config.staffRoleId ? `<@&${config.staffRoleId}>` : `<@&${ENV_STAFF_ROLE}> (default)`, inline: true },
        { name: 'Tickets Category', value: config.ticketsCategoryId ? `\`${config.ticketsCategoryId}\`` : `\`${ENV_TICKETS_CATEGORY}\` (default)`, inline: true },
        { name: 'Transcript Log Channel', value: transcriptChannelDB.get(guildId) ? `<#${transcriptChannelDB.get(guildId)}>` : 'Not set', inline: true }
      );
    return message.reply({ embeds: [embed] });
  }

  if (sub === 'staffrole') {
    const role = message.mentions.roles.first();
    if (!role) return message.reply('❌ Usage: `,config staffrole @role`');
    config.staffRoleId = role.id;
    guildConfigDB.set(guildId, config);
    markDirty();
    return message.reply(`✅ Staff role set to ${role}.`);
  }

  if (sub === 'ticketcategory') {
    const categoryId = args[1];
    if (!categoryId || !/^\d{17,20}$/.test(categoryId)) return message.reply('❌ Usage: `,config ticketcategory <category_id>`');
    config.ticketsCategoryId = categoryId;
    guildConfigDB.set(guildId, config);
    markDirty();
    return message.reply(`✅ Tickets category set to \`${categoryId}\`.`);
  }

  return message.reply('❌ Usage: `,config <view|staffrole|ticketcategory>`');
}

async function handleSay(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return message.reply('❌ Only admins can use this.');
  }

  const text = args.join(' ');
  if (!text) return message.reply('❌ Usage: `,say <text>`');

  await message.delete().catch(() => {});
  await message.channel.send(text);
}

async function handleSetup(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return message.reply('❌ Only admins can run setup.');
  }

  const role = message.mentions.roles.first();
  if (!role) {
    return message.reply(
      '❌ Usage: `,setup @StaffRole [#TicketsCategory]`\nMention your staff role, and optionally an existing category for tickets (one named **Tickets** will be created if you omit it).'
    );
  }

  let category = message.mentions.channels.find((c) => c.type === ChannelType.GuildCategory);

  if (!category) {
    category = await message.guild.channels.create({ name: 'Tickets', type: ChannelType.GuildCategory }).catch((e) => {
      message.reply(`❌ Could not create tickets category: ${e.message}`);
      return null;
    });
    if (!category) return;
  }

  const config = guildConfigDB.get(message.guild.id) || {};
  config.staffRoleId = role.id;
  config.ticketsCategoryId = category.id;
  guildConfigDB.set(message.guild.id, config);
  markDirty();

  const embed = new EmbedBuilder()
    .setColor('#43B581')
    .setTitle('✅ Ticket System Configured')
    .addFields(
      { name: 'Staff Role', value: `${role}`, inline: true },
      { name: 'Tickets Category', value: `${category.name}`, inline: true }
    )
    .setDescription('Run `,panel` in any channel to post the ticket panel.');

  message.reply({ embeds: [embed] });
}

async function handleGiveaway(message, args) {
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'start') return handleGiveawayStart(message, args.slice(1));
  if (sub === 'end') return handleGiveawayEnd(message, args.slice(1));
  if (sub === 'reroll') return handleGiveawayReroll(message, args.slice(1));
  if (sub === 'list') return handleGiveawayList(message);

  return message.reply('❌ Usage: `,giveaway start <time> <winners> <prize>` (or `,giveaway <end|reroll|list>`)');
}

async function handleGiveawayStart(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return message.reply('❌ You need Manage Server permission to start a giveaway.');
  }

  const duration = args[0];
  const winnerCount = parseInt(args[1], 10);
  const prize = args.slice(2).join(' ');

  if (!duration || !winnerCount || winnerCount < 1 || !prize) {
    return message.reply('❌ Usage: `,giveaway start <time> <winners> <prize>` (e.g. `,giveaway start 1h 1 Discord Nitro`)');
  }

  const ms = parseTime(duration);
  if (!ms) return message.reply('❌ Invalid time format. Use e.g. 30m, 1h, 1d.');

  const endsAt = Date.now() + ms;

  const embed = new EmbedBuilder()
    .setColor('#F1C40F')
    .setTitle(`🎉 Giveaway: ${prize}`)
    .setDescription(`React with 🎉 to enter!\nWinners: **${winnerCount}**\nEnds: <t:${Math.floor(endsAt / 1000)}:R>`)
    .setFooter({ text: `Hosted by ${message.author.tag}` });

  const giveawayMessage = await message.channel.send({ embeds: [embed] });
  await giveawayMessage.react('🎉').catch(() => {});

  const giveaway = {
    channelId: message.channel.id,
    guildId: message.guild.id,
    prize,
    winnerCount,
    endsAt,
    hostTag: message.author.tag,
    ended: false,
  };

  giveawaysDB.set(giveawayMessage.id, giveaway);
  markDirty();
  scheduleGiveawayEnd(giveawayMessage.id, giveaway);

  message.delete().catch(() => {});
}

async function handleGiveawayEnd(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return message.reply('❌ You need Manage Server permission to end a giveaway.');
  }

  const messageId = args[0];
  const giveaway = messageId ? giveawaysDB.get(messageId) : null;
  if (!giveaway) return message.reply('❌ Usage: `,giveaway end <message_id>` (see `,giveaway list`)');
  if (giveaway.ended) return message.reply('❌ That giveaway already ended.');

  await endGiveaway(messageId);
  message.reply('✅ Giveaway ended early.');
}

async function handleGiveawayReroll(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return message.reply('❌ You need Manage Server permission to reroll a giveaway.');
  }

  const messageId = args[0];
  const giveaway = messageId ? giveawaysDB.get(messageId) : null;
  if (!giveaway) return message.reply('❌ Usage: `,giveaway reroll <message_id>`');
  if (!giveaway.ended) return message.reply('❌ That giveaway hasn\'t ended yet.');

  const channel = client.channels.cache.get(giveaway.channelId);
  if (!channel) return message.reply('❌ Could not find the giveaway channel.');

  const giveawayMessage = await channel.messages.fetch(messageId).catch(() => null);
  if (!giveawayMessage) return message.reply('❌ Could not find the giveaway message.');

  const reaction = giveawayMessage.reactions.cache.get('🎉');
  const reactedUsers = reaction ? await reaction.users.fetch().catch(() => new Map()) : new Map();
  const entrants = Array.from(reactedUsers.values()).filter((u) => !u.bot);

  const winners = pickRandomWinners(entrants, giveaway.winnerCount);
  if (winners.length === 0) return message.reply('❌ No valid entries to reroll from.');

  giveaway.winners = winners.map((w) => w.id);
  markDirty();

  channel.send(`🎉 New winner${winners.length > 1 ? 's' : ''} for **${giveaway.prize}**: ${winners.map((w) => `<@${w.id}>`).join(', ')}!`);
}

async function handleGiveawayList(message) {
  const active = Array.from(giveawaysDB.entries()).filter(([, g]) => g.guildId === message.guild.id && !g.ended);

  if (active.length === 0) return message.reply('✅ No active giveaways.');

  const list = active
    .map(([id, g]) => `**${g.prize}** — <#${g.channelId}> — ends <t:${Math.floor(g.endsAt / 1000)}:R> — \`${id}\``)
    .join('\n');

  const embed = new EmbedBuilder().setColor('#F1C40F').setTitle('🎉 Active Giveaways').setDescription(list);
  message.reply({ embeds: [embed] });
}

async function handleEmojiCopy(message, args) {
  if (!message.member.permissions.has(PermissionFlagsBits.ManageGuildExpressions)) {
    return message.reply('❌ You need Manage Emojis and Stickers permission.');
  }

  const match = (args[0] || '').match(/^<(a?):(\w+):(\d+)>$/);
  if (!match) return message.reply('❌ Usage: `,eo <custom emoji> [new name]` (paste the actual emoji, not its name)');

  const [, animatedFlag, originalName, emojiId] = match;
  const animated = animatedFlag === 'a';
  const url = `https://cdn.discordapp.com/emojis/${emojiId}.${animated ? 'gif' : 'png'}`;

  const customName = args.slice(1).join('').replace(/[^a-zA-Z0-9_]/g, '');
  const name = (customName || originalName).slice(0, 32) || 'emoji';

  try {
    const emoji = await message.guild.emojis.create({ attachment: url, name });
    message.reply(`✅ Added ${emoji} as \`:${emoji.name}:\``);
  } catch (e) {
    message.reply(`❌ Could not add emoji: ${e.message}`);
  }
}

// ============ UTILITIES ============

function parseTime(timeStr) {
  const regex = /^(\d+)([smhd])$/;
  const match = timeStr.match(regex);

  if (!match) return null;

  const amount = parseInt(match[1]);
  const unit = match[2];

  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return amount * multipliers[unit];
}

// ============ CONTROL API (for the local dashboard) ============

const apiApp = express();
apiApp.use(express.json());

apiApp.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'http://localhost:4000');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.header('Access-Control-Allow-Methods', 'GET,POST');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

apiApp.use((req, res, next) => {
  const key = req.header('X-API-Key');
  if (!process.env.DASHBOARD_API_KEY || key !== process.env.DASHBOARD_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

apiApp.get('/status', (req, res) => {
  res.json({
    online: client.isReady(),
    tag: client.user ? client.user.tag : null,
    uptimeMs: client.uptime || 0,
    guilds: client.guilds.cache.size,
    ping: client.ws.ping,
    openTickets: ticketsDB.size,
    activeGiveaways: Array.from(giveawaysDB.values()).filter((g) => !g.ended).length,
  });
});

apiApp.get('/guilds', (req, res) => {
  res.json(client.guilds.cache.map((g) => ({ id: g.id, name: g.name, memberCount: g.memberCount })));
});

apiApp.get('/guilds/:guildId/channels', (req, res) => {
  const guild = client.guilds.cache.get(req.params.guildId);
  if (!guild) return res.status(404).json({ error: 'Guild not found' });
  const channels = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildText)
    .map((c) => ({ id: c.id, name: c.name }));
  res.json(channels);
});

apiApp.post('/say', async (req, res) => {
  const { channelId, text } = req.body;
  if (!channelId || !text) return res.status(400).json({ error: 'channelId and text are required' });
  const channel = client.channels.cache.get(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  await channel.send(text).catch((e) => res.status(500).json({ error: e.message }));
  res.json({ ok: true });
});

apiApp.get('/warnings/:userId', (req, res) => {
  res.json(warningsDB.get(req.params.userId) || []);
});

apiApp.post('/warnings/:userId/clear', (req, res) => {
  warningsDB.delete(req.params.userId);
  markDirty();
  res.json({ ok: true });
});

apiApp.get('/modlogs/:userId', (req, res) => {
  res.json(modLogsDB.get(req.params.userId) || []);
});

apiApp.get('/giveaways', (req, res) => {
  res.json(Array.from(giveawaysDB.entries()).map(([id, g]) => ({ id, ...g })));
});

apiApp.post('/giveaways/start', async (req, res) => {
  const { channelId, time, winners, prize } = req.body;
  if (!channelId || !time || !winners || !prize) {
    return res.status(400).json({ error: 'channelId, time, winners, prize are required' });
  }
  const channel = client.channels.cache.get(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const ms = parseTime(time);
  if (!ms) return res.status(400).json({ error: 'Invalid time format' });

  const endsAt = Date.now() + ms;
  const embed = new EmbedBuilder()
    .setColor('#F1C40F')
    .setTitle(`🎉 Giveaway: ${prize}`)
    .setDescription(`React with 🎉 to enter!\nWinners: **${winners}**\nEnds: <t:${Math.floor(endsAt / 1000)}:R>`)
    .setFooter({ text: 'Hosted via dashboard' });

  const giveawayMessage = await channel.send({ embeds: [embed] });
  await giveawayMessage.react('🎉').catch(() => {});

  const giveaway = {
    channelId,
    guildId: channel.guild.id,
    prize,
    winnerCount: parseInt(winners, 10),
    endsAt,
    hostTag: 'Dashboard',
    ended: false,
  };

  giveawaysDB.set(giveawayMessage.id, giveaway);
  markDirty();
  scheduleGiveawayEnd(giveawayMessage.id, giveaway);

  res.json({ ok: true, messageId: giveawayMessage.id });
});

apiApp.post('/giveaways/:messageId/end', async (req, res) => {
  const giveaway = giveawaysDB.get(req.params.messageId);
  if (!giveaway) return res.status(404).json({ error: 'Giveaway not found' });
  if (giveaway.ended) return res.status(400).json({ error: 'Already ended' });
  await endGiveaway(req.params.messageId);
  res.json({ ok: true });
});

apiApp.get('/config/:guildId', (req, res) => {
  const config = guildConfigDB.get(req.params.guildId) || {};
  res.json({
    staffRoleId: config.staffRoleId || ENV_STAFF_ROLE || null,
    ticketsCategoryId: config.ticketsCategoryId || ENV_TICKETS_CATEGORY || null,
    transcriptChannelId: transcriptChannelDB.get(req.params.guildId) || null,
  });
});

apiApp.post('/config/:guildId', (req, res) => {
  const { staffRoleId, ticketsCategoryId } = req.body;
  const config = guildConfigDB.get(req.params.guildId) || {};
  if (staffRoleId) config.staffRoleId = staffRoleId;
  if (ticketsCategoryId) config.ticketsCategoryId = ticketsCategoryId;
  guildConfigDB.set(req.params.guildId, config);
  markDirty();
  res.json({ ok: true });
});

apiApp.get('/tickets', (req, res) => {
  res.json(Array.from(ticketsDB.entries()).map(([userId, channelId]) => ({ userId, channelId })));
});

apiApp.get('/has-role/:userId', async (req, res) => {
  for (const guild of client.guilds.cache.values()) {
    const member = await guild.members.fetch(req.params.userId).catch(() => null);
    if (member) {
      const staffRoleId = getStaffRoleId(guild.id);
      return res.json({ hasRole: member.roles.cache.has(staffRoleId), guildId: guild.id, tag: member.user.tag });
    }
  }
  res.json({ hasRole: false, guildId: null, tag: null });
});

const dashboardPort = process.env.DASHBOARD_PORT || 4001;
apiApp.listen(dashboardPort, '127.0.0.1', () => {
  console.log(`🎛️  Control API listening on http://127.0.0.1:${dashboardPort}`);
});

// ============ LOGIN ============

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
