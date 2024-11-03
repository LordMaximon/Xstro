import { downloadContentFromMessage, getContentType, generateForwardMessageContent, generateWAMessageFromContent } from "baileys";
import { decodeJid, parsedJid, createInteractiveMessage, ensureBuffer, detectMimeType, getBuffer } from "./utils.js";
import { writeExifImg, videoToWebp, imageToWebp, writeExifVid } from "./sticker.js";
import fs from "fs/promises";
import { fileTypeFromBuffer } from "file-type";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { STICKER_PACK } from "../config.js";

ffmpeg.setFfmpegPath(ffmpegPath.path);

class Message {
	#client;
	#mediaTypes = {
		image: "imageMessage",
		video: "videoMessage",
		sticker: "stickerMessage",
		document: "documentMessage",
		audio: "audioMessage",
		location: "locationMessage",
		contact: "contactMessage",
		product: "productMessage",
	};

	constructor(client, data) {
		this.#client = client;
		if (data) this._patch(data);
	}

	get client() {
		return this.#client;
	}

	_patch(data) {
		const { key, isGroup, pushName, sender, messageTimestamp, body, type, message, quoted } = data;

		Object.assign(this, {
			data,
			key,
			id: key.id,
			jid: key.remoteJid,
			isGroup,
			fromMe: key.fromMe,
			pushName,
			participant: parsedJid(sender)?.[0],
			user: decodeJid(this.#client.user.id),
			timestamp: typeof messageTimestamp === "object" ? messageTimestamp.low : messageTimestamp,
			text: body || "",
			type: type ? type.replace("Message", "").toLowerCase() : "baileysEmit",
			isViewOnce: Boolean(message?.viewOnceMessage || message?.viewOnceMessageV2),
			isEphemeral: Boolean(message?.ephemeralMessage),
			hasQuotedMessage: Boolean(message?.extendedTextMessage?.contextInfo?.quotedMessage),
			hasMentions: Boolean(message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0),
		});

		if (type) this[this.type] = message[type];
		this.mention = message?.extendedTextMessage?.contextInfo?.mentionedJid || false;
		this.quoted = quoted ? this._createQuotedObject(quoted) : false;
		this.reply_message = this._processReplyMessage(message);

		return this;
	}

	_createQuotedObject(quoted) {
		return {
			data: quoted,
			message: quoted.message,
			sender: parsedJid(quoted.sender)?.[0],
			key: quoted.key,
			pushName: quoted.pushName,
			mentionedJids: quoted.message?.extendedTextMessage?.contextInfo?.mentionedJid || [],
			viewonce: Boolean(quoted.message?.viewOnceMessage || quoted.message?.viewOnceMessageV2),
			ephemeral: Boolean(quoted.message?.ephemeralMessage),
		};
	}

	_processReplyMessage(message) {
		const contextInfo = message?.extendedTextMessage?.contextInfo;
		if (!contextInfo?.quotedMessage) return null;

		const quotedMessage = contextInfo.quotedMessage;
		return {
			message: quotedMessage,
			sender: parsedJid(contextInfo.participant)?.[0],
			stanzaId: contextInfo.stanzaId,
			image: Boolean(quotedMessage.imageMessage),
			video: Boolean(quotedMessage.videoMessage),
			audio: Boolean(quotedMessage.audioMessage),
			document: Boolean(quotedMessage.documentMessage),
			mentionJid: contextInfo.mentionedJid || [],
			viewonce: Boolean(quotedMessage?.viewOnceMessage || quotedMessage?.viewOnceMessageV2),
			ephemeral: Boolean(quotedMessage?.ephemeralMessage),
		};
	}

	async edit(message) {
		const messageContent = typeof message === "string" ? { text: message } : message;
		return this.#client.sendMessage(this.jid, { ...messageContent, edit: this.key || this.quoted.key });
	}

	async sendReply(content, options = {}) {
		const messageContent = typeof content === "string" ? { text: content } : content;
		return this.#client.sendMessage(this.jid, { ...messageContent, ...options }, { quoted: this.data });
	}

	async forward(jid, content, options = {}) {
		if (options.readViewOnce) {
			content = content?.ephemeralMessage?.message || content;
			const viewOnceKey = Object.keys(content)[0];
			delete content?.ignore;
			delete content?.viewOnceMessage?.message?.[viewOnceKey]?.viewOnce;
			content = { ...content?.viewOnceMessage?.message };
		}

		const forwardContent = generateForwardMessageContent(content, !!options.force);
		const contentType = getContentType(forwardContent);

		const forwardOptions = {
			...options,
			contextInfo: {
				...(options.contextInfo || {}),
				...(options.mentions ? { mentionedJid: options.mentions } : {}),
				...forwardContent[contentType]?.contextInfo,
			},
		};

		const waMessage = generateWAMessageFromContent(jid, forwardContent, forwardOptions);
		return this.#client.relayMessage(jid, waMessage.message, {
			messageId: waMessage.key.id,
		});
	}

	async download() {
		const msg = this.quoted.message;
		const mediaType = Object.values(this.#mediaTypes).find((type) => msg[type]);
		const stream = await downloadContentFromMessage(msg[mediaType], mediaType.replace("Message", ""));
		const chunks = [];
		for await (const chunk of stream) chunks.push(chunk);
		return Buffer.concat(chunks);
	}

	async saveNForward(jid, content, opts = {}) {
		if (!this.quoted) throw new Error("No Quoted Message found!");
		await this.#client.sendMessage(jid, { forward: content, contextInfo: { forwardingScore: 1, isForwarded: true }, ...opts }, { quoted: this.quoted });
	}

	async send(content, options = {}) {
		const jid = options.jid || this.jid;
		const quoted = options.quoted || this.data;
		const sendOptions = {
			caption: options.caption,
			contextInfo: options.contextInfo,
			...options,
		};

		if ((typeof content === "object" && content !== null && !Buffer.isBuffer(content)) || options.type === "button") {
			const defaultContent = {
				header: { title: "xsᴛʀᴏ", subtitle: "sɪᴍᴘʟᴇ ᴡʜᴀᴛsᴀᴘᴘ ʙᴏᴛ" },
				footer: { text: "ᴏᴘᴇɴ sᴏᴜʀᴄᴇ" },
				body: { text: "sᴍᴀʟʟ, sɪᴍᴘʟᴇ ғᴀsᴛ & ʟɪɢʜᴛᴡᴇɪɢʜᴛ" },
			};
			const finalContent = {
				...defaultContent,
				...content,
				header: { ...defaultContent.header, ...content.header },
				footer: { ...defaultContent.footer, ...content.footer },
				body: { ...defaultContent.body, ...content.body },
			};

			const genMessage = createInteractiveMessage(finalContent);
			return this.#client.relayMessage(jid, genMessage.message, {
				messageId: genMessage.key.id,
			});
		}

		const sendMessage = async (type, buffer, opts) => {
			const messageOptions = { [type]: buffer, ...opts };
			return this.#client.sendMessage(jid, messageOptions, { quoted });
		};

		const sendSticker = async (buffer, opts) => {
			const fileType = await fileTypeFromBuffer(buffer);
			let stickerBuffer;
			if (fileType?.mime === "image/webp") {
				stickerBuffer = await writeExifImg(buffer, opts);
			} else {
				stickerBuffer = await imageToWebp(buffer);
				stickerBuffer = await writeExifImg(stickerBuffer, opts);
			}
			if (typeof stickerBuffer === "string") stickerBuffer = await fs.readFile(stickerBuffer);
			return sendMessage("sticker", stickerBuffer, opts);
		};

		const sendVideoAsAudio = async (buffer, opts) => {
			const audioBuffer = await toAudio(buffer);
			return sendMessage("audio", audioBuffer, opts);
		};

		const sendVideoAsSticker = async (buffer, opts) => {
			const fileType = await fileType.fromBuffer(buffer);
			let stickerBuffer;
			if (fileType?.mime === "image/webp") {
				stickerBuffer = await writeExifVid(buffer, opts);
			} else {
				stickerBuffer = await videoToWebp(buffer);
				stickerBuffer = await writeExifVid(stickerBuffer, opts);
			}
			if (typeof stickerBuffer === "string") stickerBuffer = await fs.readFile(stickerBuffer);
			return sendMessage("sticker", stickerBuffer, opts);
		};

		let buffer;
		let mimeType;

		if (typeof content === "string" && content.startsWith("http")) {
			buffer = await ensureBuffer(content);
			mimeType = await detectMimeType(buffer);
		} else {
			buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
			mimeType = "text/plain";
		}
		const contentType = options.type || mimeType.split("/")[0];
		switch (contentType) {
			case "text":
				return sendMessage("text", buffer.toString(), sendOptions);
			case "image":
				return options.asSticker ? sendSticker(buffer, sendOptions) : sendMessage("image", buffer, sendOptions);
			case "video":
				if (options.asSticker) return sendVideoAsSticker(buffer, sendOptions);
				if (options.asAudio) return sendVideoAsAudio(buffer, sendOptions);
				return sendMessage("video", buffer, sendOptions);
			case "audio":
				return sendMessage("audio", buffer, { mimetype: "audio/mp4", ...sendOptions });
			case "document":
				return sendMessage("document", buffer, {
					mimetype: options.mimetype || "application/octet-stream",
					fileName: options.filename || "file",
					...sendOptions,
				});
			case "sticker":
				return sendSticker(buffer, sendOptions);
			default:
				return sendMessage("document", buffer, { ...sendOptions, mimetype: mimeType });
		}
	}
}

export default Message;