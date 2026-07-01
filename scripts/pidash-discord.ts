/**
 * Discord bot for pidash — bridges Discord DMs to pi sessions.
 *
 * Extracted from pidash-server.ts. Enable by setting DISCORD_BOT_TOKEN
 * (and optionally DISCORD_ALLOWED_USERS) in ~/.pi/discord.env.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
export function setupDiscordBot(opts: {
  piClients: Map<string, any>;
  piEventHooks: Array<(sessionId: string, event: any) => void>;
  getActiveSessions: () => any[];
  log: (msg: string) => void;
}): void {
  const { piClients, piEventHooks, getActiveSessions, log } = opts;
  const _require = createRequire(import.meta.url);

  const homeDir = process.env.HOME;
  if (!homeDir) {
    log("[discord] HOME not set — Discord bot disabled (cannot store credentials securely)");
    return;
  }

  const DISCORD_ENV_FILE = path.join(homeDir, ".pi", "discord.env");
  try {
    for (const line of fs.readFileSync(DISCORD_ENV_FILE, "utf-8").split("\n")) {
      const m = line.match(/^(\w+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}

  if (process.env.DISCORD_BOT_TOKEN) {
    const discordToken = process.env.DISCORD_BOT_TOKEN;
    const discordAllowedUsers = new Set(
      (process.env.DISCORD_ALLOWED_USERS || "").split(",").map((s: string) => s.trim()).filter(Boolean),
    );

    let discordAvailable = false;
    try {
      _require.resolve("discord.js");
      discordAvailable = true;
    } catch {
      log("[discord] discord.js not installed — run: npm install -g discord.js");
    }

    if (discordAvailable) {
      const {
        Client: DiscordClient, GatewayIntentBits, Partials,
        REST, Routes, SlashCommandBuilder,
        ActionRowBuilder, ButtonBuilder, ButtonStyle,
      } = _require("discord.js");

      const discord = new DiscordClient({
        intents: [
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel, Partials.Message],
      });

      // Track prompts that originated from Discord DMs (to suppress USER echo)
      const discordOriginatedPrompts = new Set<string>();

      // Per-user state — persisted to disk
      const DISCORD_STATE_FILE = path.join(homeDir, ".pi", "discord-state.json");

      interface DiscordUserState {
        watchedSessionId: string | null;
        responseChannelId: string | null;
        pendingAskUser: { id: string; sessionId: string } | null;
      }
      const discordUserStates = new Map<string, DiscordUserState>();

      function loadDiscordState() {
        try {
          const data = JSON.parse(fs.readFileSync(DISCORD_STATE_FILE, "utf-8"));
          for (const [k, v] of Object.entries(data)) discordUserStates.set(k, v as DiscordUserState);
        } catch {}
      }
      function saveDiscordState() {
        try {
          const obj: Record<string, any> = {};
          for (const [k, v] of discordUserStates) {
            const clean: any = { ...v };
            delete clean._typingInterval;
            delete clean._typingSafetyTimer;
            delete clean._lastText;
            obj[k] = clean;
          }
          fs.writeFileSync(DISCORD_STATE_FILE, JSON.stringify(obj));
        } catch {}
      }
      loadDiscordState();

      function getDiscordState(userId: string): DiscordUserState {
        let state = discordUserStates.get(userId);
        if (!state) {
          state = {
            watchedSessionId: null,
            responseChannelId: null,
            pendingAskUser: null,
          };
          discordUserStates.set(userId, state);
        }
        return state;
      }

      function getSessionName(sessionId: string | null): string {
        if (!sessionId) return "none";
        const client = piClients.get(sessionId);
        if (!client) return "unknown";
        return client.session.cwd.split("/").pop() || client.session.cwd;
      }

      // Discord text chunking (2000 char limit)
      function chunkDiscordText(text: string): string[] {
        if (text.length <= 2000) return [text];
        const chunks: string[] = [];
        let rest = text;
        while (rest.length > 2000) {
          let cut = rest.lastIndexOf("\n", 2000);
          if (cut < 1000) cut = 2000;
          chunks.push(rest.slice(0, cut));
          rest = rest.slice(cut).replace(/^\n+/, "");
        }
        if (rest) chunks.push(rest);
        return chunks;
      }

      async function sendDiscordDM(channelId: string, text: string) {
        try {
          const channel = await discord.channels.fetch(channelId);
          if (!channel || !channel.isTextBased()) return;
          for (const chunk of chunkDiscordText(text)) {
            await channel.send(chunk);
          }
        } catch (e: any) {
          log(`[discord] send error: ${e.message}`);
        }
      }

      // Forward pi events to Discord users watching that session
      function forwardToDiscord(sessionId: string, ev: any) {
        if (discordUserStates.size === 0) return;
        // Skip replay events — only forward live events
        const client = piClients.get(sessionId);
        if (client?.replaying) return;

        for (const [, state] of discordUserStates) {
          if (state.watchedSessionId !== sessionId || !state.responseChannelId) continue;

          // Show user messages from TUI in Discord
          if (ev.type === "message_start" && ev.message?.role === "user") {
            const content = ev.message.content;
            if (Array.isArray(content)) {
              const text = content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
              // Skip echo if this message originated from Discord
              if (text && discordOriginatedPrompts.has(text)) {
                discordOriginatedPrompts.delete(text);
                // Don't send — user already sees their own message in Discord
              } else if (text) {
                sendDiscordDM(state.responseChannelId!, `───
▶ **USER:** ${text}`);
              }
            }
          }

          // Typing indicator when AI is working
          if (ev.type === "agent_start" && state.responseChannelId) {
            // Clear any existing typing interval and safety timer
            if ((state as any)._typingInterval) clearInterval((state as any)._typingInterval);
            if ((state as any)._typingSafetyTimer) clearTimeout((state as any)._typingSafetyTimer);
            const chId = state.responseChannelId;
            const sendTyping = async () => {
              try {
                const ch = await discord.channels.fetch(chId);
                if (ch?.sendTyping) await ch.sendTyping();
              } catch {}
            };
            sendTyping();
            (state as any)._typingInterval = setInterval(sendTyping, 8000);
            // Auto-clear after 5 minutes (safety net for leaked intervals)
            (state as any)._typingSafetyTimer = setTimeout(() => {
              if ((state as any)._typingInterval) {
                clearInterval((state as any)._typingInterval);
                (state as any)._typingInterval = null;
              }
              (state as any)._typingSafetyTimer = null;
            }, 5 * 60 * 1000);
          }
          if (ev.type === "agent_end") {
            if ((state as any)._typingInterval) {
              clearInterval((state as any)._typingInterval);
              (state as any)._typingInterval = null;
            }
            if ((state as any)._typingSafetyTimer) {
              clearTimeout((state as any)._typingSafetyTimer);
              (state as any)._typingSafetyTimer = null;
            }
          }

          // Capture streaming text deltas from assistant
          if (ev.type === "message_update") {
            const ame = ev.assistantMessageEvent;
            if (ame?.type === "text_delta" && ame.delta) {
              (state as any)._lastText = ((state as any)._lastText || "") + ame.delta;
            }
          }

          // Send captured text when assistant message completes
          if (ev.type === "message_end" && ev.message?.role === "assistant") {
            const text = (state as any)._lastText || "";
            (state as any)._lastText = "";
            if (text) sendDiscordDM(state.responseChannelId!, text);
          }

          // Ask user dialogs
          if (ev.type === "extension_ui_request" && ev.id && ev.title) {
            state.pendingAskUser = { id: ev.id, sessionId };
            let msg = `**${ev.title}**\n`;
            if (ev.options && ev.options.length > 0) {
              msg += ev.options.map((o: string, i: number) => `${i + 1}. ${o}`).join("\n");
              msg += "\n\nReply with the number or text.";
            } else {
              msg += "Type your response:";
            }
            sendDiscordDM(state.responseChannelId, msg);
          }
        }
      }

      // Hook into pi event forwarding
      piEventHooks.push(forwardToDiscord);

      // Register slash commands (guild-scoped for instant availability)
      async function registerDiscordCommands(clientId: string) {
        const commands = [
          new SlashCommandBuilder()
            .setName("sessions")
            .setDescription("List pi sessions — tap a button to watch one"),
          new SlashCommandBuilder()
            .setName("status")
            .setDescription("Show current watched session info"),
          new SlashCommandBuilder()
            .setName("stop")
            .setDescription("Stop/interrupt the current agent (like Esc in terminal)"),
        ];

        const rest = new REST().setToken(discordToken);
        for (const guild of discord.guilds.cache.values()) {
          try {
            await rest.put(Routes.applicationGuildCommands(clientId, (guild as any).id), {
              body: commands.map((c: any) => c.toJSON()),
            });
            log(`[discord] slash commands registered for guild: ${(guild as any).name}`);
          } catch (e: any) {
            log(`[discord] failed to register commands for guild ${(guild as any).name}: ${e.message}`);
          }
        }
      }

      // Handle slash commands
      discord.on("interactionCreate", async (interaction: any) => {
        const safeReply = async (data: any) => {
          try { await interaction.reply(data); } catch (e: any) {
            log(`[discord] reply failed: ${e.message}`);
          }
        };

        // Handle button clicks (session selection)
        if (interaction.isButton()) {
          if (discordAllowedUsers.size > 0 && !discordAllowedUsers.has(interaction.user.id)) {
            await safeReply({ content: "Not authorized.", ephemeral: true }).catch(() => {});
            return;
          }
          if (interaction.customId === "unwatch") {
            const state = getDiscordState(interaction.user.id);
            state.watchedSessionId = null;
            saveDiscordState();
            try { discord.user.setActivity(""); } catch {}
            try {
              await interaction.update({ content: "Disconnected from all sessions.", components: [] });
            } catch {}
            return;
          }
          const match = interaction.customId.match(/^watch:(.+)$/);
          if (match) {
            const targetSessionId = match[1];
            const client = piClients.get(targetSessionId);
            if (!client) {
              await safeReply({ content: "Session no longer available.", ephemeral: true }).catch(() => {});
              return;
            }
            const session = client.session;
            const state = getDiscordState(interaction.user.id);
            state.watchedSessionId = session.sessionId;

            const name = session.cwd.split("/").pop() || session.cwd;

            // Get the user's DM channel for responses — only set after successful creation
            try {
              const dmChannel = await interaction.user.createDM();
              state.responseChannelId = dmChannel.id;
            } catch {
              // DM creation failed — keep existing responseChannelId (may be from previous DM)
              log(`[discord] Failed to create DM for user ${interaction.user.username}`);
            }

            try {
              await interaction.update({
                content: `Now watching: **${name}** (${session.model || "—"})`,
                components: [],
              });
            } catch (e: any) {
              log(`[discord] button update failed: ${e.message}`);
            }

            // Update bot activity to show current session
            try {
              discord.user.setActivity(`${name} (${session.model || "—"})`, { type: 3 }); // type 3 = Watching
            } catch {}

            saveDiscordState();
            log(`[discord] user ${interaction.user.username} watching: ${session.sessionId}`);
          }
          return;
        }

        if (!interaction.isChatInputCommand()) return;
        if (discordAllowedUsers.size > 0 && !discordAllowedUsers.has(interaction.user.id)) {
          await safeReply({ content: "Not authorized.", ephemeral: true });
          return;
        }

        const state = getDiscordState(interaction.user.id);
        const cmd = interaction.commandName;

        if (cmd === "sessions") {
          try {
            const allSessions = getActiveSessions();
            if (allSessions.length === 0) {
              await safeReply("No active sessions.");
              return;
            }

            // Build buttons for each session
            const rows: any[] = [];
            let currentRow = new ActionRowBuilder();
            for (let i = 0; i < Math.min(allSessions.length, 25); i++) {
              const s = allSessions[i];
              const name = (s.cwd.split("/").pop() || s.cwd).slice(0, 80);
              const isWatched = s.sessionId === state.watchedSessionId;
              currentRow.addComponents(
                new ButtonBuilder()
                  .setCustomId(`watch:${s.sessionId}`)
                  .setLabel(name)
                  .setStyle(isWatched ? ButtonStyle.Success : (s.active ? ButtonStyle.Primary : ButtonStyle.Secondary))
              );
              if ((i + 1) % 5 === 0 || i === Math.min(allSessions.length, 25) - 1) {
                rows.push(currentRow);
                currentRow = new ActionRowBuilder();
              }
            }

            // Add unwatch button if watching something
            if (state.watchedSessionId) {
              const unwatchRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId("unwatch")
                  .setLabel("Disconnect")
                  .setStyle(ButtonStyle.Danger)
              );
              rows.push(unwatchRow);
            }

            const lines = allSessions.map((s, i) => {
              const name = s.cwd.split("/").pop() || s.cwd;
              const status = s.active ? (s.working ? "[active] " : "[idle] ") : "[idle] ";
              const watched = s.sessionId === state.watchedSessionId ? " **← watching**" : "";
              return `${status} **${i + 1}.** ${name} — ${s.model || "—"} ${s.branch ? `(${s.branch})` : ""}${watched}`;
            });

            await safeReply({
              content: `**Sessions (${allSessions.length}):**\n${lines.join("\n")}`,
              components: rows,
            });
          } catch (e: any) {
            log(`[discord] /sessions error: ${e.message}`);
            try { await safeReply(`Error: ${e.message}`); } catch {}
          }
          return;
        }

        if (cmd === "status") {
          if (!state.watchedSessionId) {
            await safeReply("Not watching any session. Use `/sessions` and tap a button.");
            return;
          }
          const client = piClients.get(state.watchedSessionId);
          if (!client) {
            await safeReply("Watched session no longer active.");
            state.watchedSessionId = null;
            saveDiscordState();
            return;
          }
          const s = client.session;
          const name = s.cwd.split("/").pop() || s.cwd;
          const status = s.active ? (s.working ? "[active]" : "[idle]") : "[idle]";
          await safeReply([
            `**Session:** ${name}`,
            `**Model:** ${s.model || "—"}`,
            `**Branch:** ${s.branch || "—"}`,
            `**Status:** ${status}`,
            `**CWD:** ${s.cwd}`,
            s.container ? "**Container:** 📦" : "",
          ].filter(Boolean).join("\n"));
          return;
        }

        if (cmd === "stop") {
          if (!state.watchedSessionId) {
            await safeReply("Not watching any session.");
            return;
          }
          const client = piClients.get(state.watchedSessionId);
          if (client?.ws) {
            client.ws.send(JSON.stringify({ type: "pidash-command", command: "abort" }));
          }
          await safeReply("⏹️ Stop signal sent.");
          return;
        }
      });

      // Download Discord attachment and convert to base64
      async function downloadAttachment(url: string): Promise<{ data: string; mimeType: string } | null> {
        try {
          const response = await fetch(url);
          if (!response.ok) return null;
          const buffer = Buffer.from(await response.arrayBuffer());
          const contentType = response.headers.get("content-type") || "application/octet-stream";
          return { data: buffer.toString("base64"), mimeType: contentType };
        } catch (e: any) {
          log(`[discord] attachment download error: ${e.message}`);
          return null;
        }
      }

      // Handle DM messages (prompts + ask_user responses)
      discord.on("raw", async (event: any) => {
        if (event.t !== "MESSAGE_CREATE") return;
        const d = event.d;
        if (d.author?.bot) return;
        if (discordAllowedUsers.size > 0 && !discordAllowedUsers.has(d.author?.id)) return;
        if (d.guild_id) return; // Only DMs

        const text = (d.content || "").trim();
        if (!text && (!d.attachments || d.attachments.length === 0)) return;

        const userId = d.author.id;
        const channelId = d.channel_id;
        const state = getDiscordState(userId);
        state.responseChannelId = channelId;

        log(`[discord] DM from ${d.author.username}: ${text.slice(0, 80)} (watched=${getSessionName(state.watchedSessionId)})`);

        // Handle /stop in DM text
        if (text.toLowerCase() === "/stop") {
          if (state.watchedSessionId) {
            const client = piClients.get(state.watchedSessionId);
            if (client?.ws) {
              client.ws.send(JSON.stringify({ type: "pidash-command", command: "abort" }));
              await sendDiscordDM(channelId, "⏹️ Stop signal sent.");
            } else {
              await sendDiscordDM(channelId, "Watched session is disconnected.");
            }
          } else {
            await sendDiscordDM(channelId, "Not watching any session.");
          }
          return;
        }

        // Handle pending ask_user response
        if (state.pendingAskUser) {
          const ask = state.pendingAskUser;
          state.pendingAskUser = null;
          const client = piClients.get(ask.sessionId);
          if (client?.ws) {
            client.ws.send(JSON.stringify({
              type: "extension_ui_response",
              id: ask.id,
              value: text,
            }));
          }
          return;
        }

        // Check if watching a session
        if (!state.watchedSessionId) {
          await sendDiscordDM(channelId, "Not watching any session. Use `/sessions` and tap a button.");
          return;
        }

        // Forward prompt to pi session
        const client = piClients.get(state.watchedSessionId);
        if (!client?.ws) {
          await sendDiscordDM(channelId, "Watched session is disconnected.");
          return;
        }

        // Process attachments (images, text files)
        const attachments = d.attachments || [];
        const images: Array<{ data: string; mimeType: string; filename: string }> = [];
        const fileContents: string[] = [];

        if (attachments.length > 0) {
          for (const att of attachments) {
            const isImage = att.content_type?.startsWith("image/");
            const isText = att.content_type?.startsWith("text/") ||
              /\.(txt|log|md|json|yaml|yml|toml|csv|xml|html|css|js|ts|py|sh|go|java|rs|rb|c|cpp|h|hpp)$/i.test(att.filename || "");

            if (isImage) {
              const downloaded = await downloadAttachment(att.url);
              if (downloaded) {
                images.push({ ...downloaded, filename: att.filename || "image" });
              }
            } else if (isText && att.size < 100000) { // <100KB text files
              try {
                const response = await fetch(att.url);
                if (response.ok) {
                  const content = await response.text();
                  fileContents.push(`--- ${att.filename} ---\n${content}`);
                }
              } catch (e: any) {
                log(`[discord] text file download error: ${e.message}`);
              }
            } else {
              // Binary or large file — just mention it
              fileContents.push(`[Attached file: ${att.filename} (${att.content_type}, ${(att.size / 1024).toFixed(1)}KB) — binary file not included]`);
            }
          }
        }

        // Build the prompt with any text file contents appended
        const fullText = fileContents.length > 0
          ? (text ? text + "\n\n" : "") + fileContents.join("\n\n")
          : text;

        if (!fullText && images.length === 0) return; // Nothing to send

        discordOriginatedPrompts.add(fullText || text);
        setTimeout(() => discordOriginatedPrompts.delete(fullText || text), 30000);
        client.ws.send(JSON.stringify({
          type: "prompt",
          text: fullText || "",
          images: images.length > 0 ? images : undefined,
        }));
      });

      discord.once("ready", async (c: any) => {
        log(`[discord] bot connected as ${c.user.tag}`);
        if (discordAllowedUsers.size > 0) {
          log(`[discord] allowed users: ${[...discordAllowedUsers].join(", ")}`);
        } else {
          log("[discord] WARNING: no DISCORD_ALLOWED_USERS set — all DMs accepted");
        }
        await registerDiscordCommands(c.user.id);

        // Restore activity from persisted state
        for (const [, state] of discordUserStates) {
          if (state.watchedSessionId) {
            const name = getSessionName(state.watchedSessionId);
            if (name !== "unknown" && name !== "none") {
              try { discord.user.setActivity(name, { type: 3 }); } catch {}
            }
          }
        }
      });

      discord.on("error", (e: any) => log(`[discord] error: ${e.message}`));

      discord.login(discordToken).catch((e: any) => {
        log(`[discord] login failed: ${e.message}`);
      });
    }
  } else {
    log("[discord] no DISCORD_BOT_TOKEN — Discord bot disabled");
  }
}
